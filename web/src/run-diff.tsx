import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";

import { CheckCircledIcon, ExternalLinkIcon } from "@radix-ui/react-icons";
import { Badge, IconButton, Skeleton, TextField, Tooltip } from "@radix-ui/themes";

import { CommitChip } from "@/components/commit-chip";
import { Button } from "@/components/theme-button";
import { localClock, localDay } from "@/lib/time";

import { api, errorText, fetchJson } from "./api.ts";
import { type RunFinding } from "./runs.tsx";

/** `GET /runs/{id}/diff?file=` 的一个文件的 unified diff。 */
type RunFilePatch = { path: string; patch: string };

type DiffLine = {
  kind: "context" | "add" | "del";
  /** 旧文件一侧的行号;新增行为 null。 */
  oldLine: number | null;
  /** 新文件一侧的行号;删除行为 null。Finding 锚在这个号上。 */
  newLine: number | null;
  text: string;
};

type DiffHunk = { header: string; lines: DiffLine[] };

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * 解析一个文件的 unified diff。
 *
 * 自己解析而不引第三方:要的只是「每一行属于哪一侧、行号是多少」,这正是 hunk 头里
 * 那两个数字加逐行前缀的直接结果,而 Finding 锚定要的也只有新侧行号。
 */
function parseUnifiedDiff(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header !== null) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      current = { header: raw, lines: [] };
      hunks.push(current);
      continue;
    }
    // 第一个 hunk 之前是 `diff --git` 与两条路径行,渲染不需要它们。
    if (current === undefined) continue;
    // `\ No newline at end of file` 不占任何一侧的行。
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) {
      current.lines.push({ kind: "add", oldLine: null, newLine, text: raw.slice(1) });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      current.lines.push({ kind: "del", oldLine, newLine: null, text: raw.slice(1) });
      oldLine += 1;
      continue;
    }
    // 上下文行以一个空格起头;末尾那个空串来自收尾的换行,不是一行代码。
    if (raw === "") continue;
    current.lines.push({ kind: "context", oldLine, newLine, text: raw.slice(1) });
    oldLine += 1;
    newLine += 1;
  }

  return hunks;
}

/** 挑出包含某个新侧行号的那个 hunk,找不到时返回 undefined。 */
function hunkContaining(hunks: readonly DiffHunk[], newLine: number): DiffHunk | undefined {
  return hunks.find((hunk) => hunk.lines.some((line) => line.newLine === newLine));
}

/**
 * 面板处置一条 Finding。写 Forge 与落库都在服务端一次做完,备注为空即保留原有那条。
 */
async function disposeRequest(input: {
  id: number;
  disposition: "resolved" | "unresolved";
  note: string;
}): Promise<void> {
  const note = input.note.trim();
  const response = await api(
    `/findings/${input.id}/${input.disposition === "resolved" ? "resolve" : "unresolve"}`,
    { method: "POST", body: JSON.stringify(note === "" ? {} : { note }) },
  );
  if (!response.ok) throw new Error(await errorText(response));
}

const SEVERITY_COLOR = { P0: "red", P1: "amber", P2: "gray" } as const;

/** 已处置:人工与「已修复」自动处置都算。 */
function findingDisposed(finding: RunFinding): boolean {
  return finding.disposition === "resolved" || finding.disposition === "fixed";
}

/**
 * 行作者(CONTEXT.md):这一行最后一次改动的 git author 与那次提交,「姓名 · 短 sha ·
 * 日期」一行。同名作者靠邮箱区分,邮箱放 Tooltip;判不出来时写明「无法追溯」,免得空
 * 白被读成页面坏了。短 sha 不做链接:本票不引入 Forge 的 commit 页地址。
 */
function LineAuthorLine({ lineAuthor }: { lineAuthor: RunFinding["lineAuthor"] }) {
  if (lineAuthor === null) {
    return <p className="text-sm text-text-secondary">行作者：无法追溯</p>;
  }
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-sm text-text-secondary">
      <span>行作者：</span>
      <Tooltip content={lineAuthor.email}>
        <span tabIndex={0} className="break-all">
          {lineAuthor.name}
        </span>
      </Tooltip>
      <span aria-hidden>·</span>
      <CommitChip sha={lineAuthor.sha} />
      <span aria-hidden>·</span>
      <span className="tabular-nums">{localDay(lineAuthor.authoredAt)}</span>
    </p>
  );
}

/**
 * 一条 Finding 的卡片:正文、严重度、类别、文件与行、跳到 Forge 看原版的链接,加上
 * 行内处置。它挂在 diff 的对应行下面,fallback 那一批则单独成段;阶段汇总把同一张
 * 卡片摆在自己的列表里——同一条 Finding 在两处显示成同一个样子,处置也是同一个动作。
 *
 * 处置成功后让轮次与阶段汇总那几份查询失效,进度条、列表与三个计数跟着一起变——它们
 * 是同一批 finding 行算出来的,只改本地状态会让几个数字对不上。
 */
export function FindingRow({
  finding,
  canDispose,
}: {
  finding: RunFinding;
  canDispose: boolean;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [composing, setComposing] = useState(false);
  // 人工与自动两档都是已处置:划掉正文、给撤回动作。区别只在下面那行署名上。
  const autoDisposed = finding.disposition === "fixed";
  const resolved = findingDisposed(finding);
  const dispose = useMutation({
    mutationFn: disposeRequest,
    onSuccess: () => {
      setComposing(false);
      setNote("");
      // 评审记录列表的行上带阶段汇总三个数,阶段页另读阶段汇总与打开的那一轮,处置改
      // 的是同一批行。
      for (const key of [
        ["stages"],
        ["stage-detail"],
        ["run"],
        ["stage-summary"],
      ]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });

  return (
    <div className="flex flex-col gap-1.5 border-t border-overlay-line px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {resolved ? (
            <CheckCircledIcon className="size-4 shrink-0 text-success" aria-label="已处置" />
          ) : (
            <Badge color={SEVERITY_COLOR[finding.severity]} variant="soft" radius="full">
              {finding.severity}
            </Badge>
          )}
          <Badge color="gray" variant="soft" radius="full">{finding.category}</Badge>
          {/* 一条 Finding 可以由几个模型报出(ADR 0015):归属逐个列出,一个都不藏。 */}
          {finding.models.map((model) => (
            <span
              key={model}
              className="min-w-0 break-all font-mono text-sm text-text-secondary"
            >
              {model}
            </span>
          ))}
        </div>
        {finding.commentHtmlUrl === null ? null : (
          <Tooltip content="在 Forge 查看原始评论">
            <IconButton
              size="1"
              variant="ghost"
              color="gray"
              radius="full"
              className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0"
              asChild
            >
              <a
                href={finding.commentHtmlUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`在 Forge 查看 ${finding.file}:${finding.line} 的原始评论`}
              >
                <ExternalLinkIcon />
              </a>
            </IconButton>
          </Tooltip>
        )}
      </div>

      <p
        className={`text-base leading-relaxed break-words ${
          resolved ? "text-text-secondary line-through" : "text-text-secondary"
        }`}
      >
        {finding.description}
      </p>

      <LineAuthorLine lineAuthor={finding.lineAuthor} />

      {finding.continuedFrom === null ? null : (
        <p className="text-sm text-text-secondary">
          <a
            href={finding.continuedFrom}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-4"
          >
            延续自上一处评论
          </a>
          {" · "}原位置代码已改写；复核判定该 Finding 仍在
        </p>
      )}

      {autoDisposed ? (
        <p className="text-sm text-text-secondary">
          已修复 · 自动处置
          {finding.disposedAt === null ? null : (
            <>
              {" · "}
              <span className="tabular-nums">
                {localDay(finding.disposedAt)} {localClock(finding.disposedAt)}
              </span>
            </>
          )}
        </p>
      ) : finding.disposedBy === null ? null : (
        <p className="text-sm text-text-secondary">
          {resolved ? "已处置" : "撤回处置"} · {finding.disposedBy} ·{" "}
          <span className="tabular-nums">{localDay(finding.disposedAt!)} {localClock(finding.disposedAt!)}</span>
        </p>
      )}
      {finding.note === null ? null : (
        <p className="rounded-lg bg-fill px-2.5 py-1.5 text-sm break-words text-text-secondary">
          备注：{finding.note}
        </p>
      )}

      {/* 正文里的 fallback 没有行级评论承载,Forge 上无从 resolve,面板也就不给动作。 */}
      {finding.commentId === null ? (
        <p className="text-sm text-text-secondary">
          该 Finding 仅发布在 pull request review 正文中，未生成可处置的行级评论。
        </p>
      ) : canDispose ? (
        <div className="flex flex-col gap-2">
          {composing ? (
            <TextField.Root
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={500}
              placeholder="处置备注（可选，只存面板）"
              aria-label="处置备注"
            />
          ) : null}
          <div className="flex items-center gap-2">
            {resolved ? (
              <Button
                variant="soft"
                color="gray"
                size={{ initial: "3", sm: "1" }}
                className="min-h-11 sm:min-h-0"
                highContrast
                disabled={dispose.isPending}
                onClick={() => dispose.mutate({ id: finding.id, disposition: "unresolved", note })}
                aria-label={`撤回 ${finding.file}:${finding.line} 的 Finding 处置`}
              >
                撤回处置
              </Button>
            ) : composing ? (
              <>
                <Button
                  variant="solid"
                  size={{ initial: "3", sm: "1" }}
                  className="min-h-11 sm:min-h-0"
                  disabled={dispose.isPending}
                  onClick={() => dispose.mutate({ id: finding.id, disposition: "resolved", note })}
                  aria-label={`确认处置 ${finding.file}:${finding.line} 的 Finding`}
                >
                  {dispose.isPending ? "处置中…" : "确认处置"}
                </Button>
                <Button
                  variant="ghost"
                  color="gray"
                  size={{ initial: "3", sm: "1" }}
                  className="min-h-11 sm:min-h-0"
                  highContrast
                  onClick={() => { setComposing(false); setNote(""); }}
                  aria-label={`取消处置 ${finding.file}:${finding.line} 的 Finding`}
                >
                  取消
                </Button>
              </>
            ) : (
              <Button
                variant="soft"
                color="gray"
                size={{ initial: "3", sm: "1" }}
                className="min-h-11 sm:min-h-0"
                highContrast
                onClick={() => setComposing(true)}
                aria-label={`处置 ${finding.file}:${finding.line} 的 Finding`}
              >
                处置
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {dispose.isError ? (
        <p role="alert" className="text-sm break-words text-danger">
          {(dispose.error as Error).message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 挂在某一行下面的 Finding 卡片。焦点那一条(打开侧滑时点的那条)加一层浅蓝底,
 * 人一眼看得出滚到的是哪一条。
 */
function FindingCells({
  findings,
  canDispose,
  focusFindingId,
}: {
  findings: readonly RunFinding[];
  canDispose: boolean;
  focusFindingId?: number;
}) {
  return (
    <>
      {findings.map((finding) => (
        <tr key={finding.id}>
          <td
            colSpan={3}
            className={`p-0 ${finding.id === focusFindingId ? "bg-accent-tint" : "bg-surface"}`}
          >
            <FindingRow finding={finding} canDispose={canDispose} />
          </td>
        </tr>
      ))}
    </>
  );
}

/**
 * 一个文件在某一轮 Review Range 里的 unified diff,同一文件的 Finding 各挂在自己锚定的
 * 那一行下面(issue #189 的 Finding 侧滑)。
 *
 * 只取这一个文件:侧滑回答的是「这条 Finding 指的是哪几行代码」,整轮几百个文件的列表
 * 在这里没有用处。锚不上的写明原因——把卡片藏起来等于把一条真实的 Finding 从面板上抹掉:
 * 只在 review 正文里的那些由卡片自己说明,文件不在这次改动里与行号落在 diff 之外的收在
 * 最上面一段。历史轮次的工作副本被清掉时服务端回 409,那句话同样摊在这里。
 *
 * 请求仍拿整个文件的 diff,渲染按 hunk 裁剪:只展开当条 Finding(`focusFindingId`)
 * 所在的那个 hunk,其余折叠在「展开完整差异」按钮之后——大文件几十个 hunk 一次全渲染
 * 会卡顿。当条 Finding 锚不到任何 hunk(按新行号判断)时回退渲染全部,同文件其它
 * Finding 的行内标记逻辑(`byLine`)不受影响,只是折叠时其所在 hunk 未展开就看不到。
 */
export function FilePatch({
  runId,
  path,
  findings,
  canDispose,
  focusFindingId,
}: {
  runId: number;
  path: string;
  /** 这个文件下的全部 Finding,含锚不上的那些。 */
  findings: readonly RunFinding[];
  canDispose: boolean;
  /** 打开侧滑时点的那一条:滚到它锚定的行并高亮它。 */
  focusFindingId?: number;
}) {
  const patch = useQuery({
    queryKey: ["run-diff", runId, path],
    queryFn: () =>
      fetchJson<RunFilePatch>(`/runs/${runId}/diff?file=${encodeURIComponent(path)}`),
  });
  // patch 到手才有行可滚:锚定行是它渲染出来之后才存在的 DOM。
  const focusRow = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    focusRow.current?.scrollIntoView({ block: "center" });
  }, [patch.data]);
  // 「展开完整差异」的一次性开关:侧滑重新打开时组件随 key 一起重挂,天然回到折叠态。
  const [expanded, setExpanded] = useState(false);

  const hunks = patch.data === undefined ? [] : parseUnifiedDiff(patch.data.patch);
  const rendered = new Set(
    hunks.flatMap((hunk) =>
      hunk.lines.flatMap((line) => (line.newLine === null ? [] : [line.newLine])),
    ),
  );
  const byLine = new Map<number, RunFinding[]>();
  for (const finding of findings) {
    if (!rendered.has(finding.line)) continue;
    byLine.set(finding.line, [...(byLine.get(finding.line) ?? []), finding]);
  }
  const unanchored = findings.filter((finding) => !rendered.has(finding.line));
  const focusLine = findings.find((finding) => finding.id === focusFindingId)?.line;
  // 裁剪:大文件的 diff 一次渲染全部 hunk 会卡顿,先只渲染当条 Finding 所在的那一个,
  // 其余折叠。锚不到任何 hunk(按新行号判断)时回退渲染全部,与此前的行为一致。
  const focusHunk = focusLine === undefined ? undefined : hunkContaining(hunks, focusLine);
  const cropped = focusHunk !== undefined && !expanded && hunks.length > 1;
  const displayHunks = cropped ? [focusHunk] : hunks;

  if (patch.isPending) {
    return (
      <div role="status" aria-live="polite">
        <span className="sr-only">正在加载文件代码差异</span>
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (patch.isError) {
    return (
      <div className="overflow-hidden rounded-lg border border-overlay-line bg-surface shadow-control">
        <p className="bg-warning-tint px-3 py-1.5 text-sm text-warning">
          无法读取本轮代码差异：{(patch.error as Error).message}。以下 Finding 无法锚定到代码行。
        </p>
        {findings.map((finding) => (
          <FindingRow key={finding.id} finding={finding} canDispose={canDispose} />
        ))}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-overlay-line bg-surface shadow-control">
      {unanchored.length === 0 ? null : (
        <div className="border-b border-overlay-line">
          <p className="bg-warning-tint px-3 py-1.5 text-sm text-warning">
            {hunks.length === 0
              ? "该文件不在本轮变更范围内，以下 Finding 无法锚定到代码行。"
              : "以下 Finding 指向的代码行不在本轮变更范围内。"}
          </p>
          {unanchored.map((finding) => (
            <FindingRow key={finding.id} finding={finding} canDispose={canDispose} />
          ))}
        </div>
      )}
      {hunks.length === 0 ? null : (
        <div className="min-w-0">
          {cropped ? (
            <div className="flex items-center justify-between gap-2 border-b border-overlay-line px-3 py-1.5 text-sm text-text-secondary">
              <span>只显示这条 Finding 所在的代码段</span>
              <Button
                variant="ghost"
                color="gray"
                highContrast
                size="1"
                onClick={() => setExpanded(true)}
              >
                展开完整差异
              </Button>
            </div>
          ) : null}
          <table className="w-full table-fixed border-collapse font-mono text-xs" aria-label={`${path} 的代码差异`}>
            <colgroup>
              <col className="w-10" />
              <col className="w-10" />
              <col />
            </colgroup>
            <tbody>
              {displayHunks.map((hunk, hunkIndex) => (
                <Fragment key={hunkIndex}>
                  <tr className="bg-sunken">
                    <td colSpan={3} className="px-3 py-1 whitespace-pre-wrap break-words text-text-secondary">
                      {hunk.header}
                    </td>
                  </tr>
                  {hunk.lines.map((line, index) => (
                    <Fragment key={index}>
                      <tr
                        {...(line.newLine !== null && line.newLine === focusLine
                          ? { ref: focusRow }
                          : {})}
                        className={
                          line.kind === "add"
                            ? "bg-success-tint"
                            : line.kind === "del"
                              ? "bg-danger-tint"
                              : ""
                        }
                      >
                        <td className="w-10 px-1.5 text-right align-top tabular-nums text-text-secondary select-none">
                          {line.oldLine ?? ""}
                        </td>
                        <td className="w-10 px-1.5 text-right align-top tabular-nums text-text-secondary select-none">
                          {line.newLine ?? ""}
                        </td>
                        <td className="px-2 align-top whitespace-pre-wrap break-words text-text">
                          <span className="select-none text-text-secondary">
                            {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                          </span>
                          {line.text}
                        </td>
                      </tr>
                      {line.newLine === null ? null : (
                        <FindingCells
                          findings={byLine.get(line.newLine) ?? []}
                          canDispose={canDispose}
                          {...(focusFindingId === undefined ? {} : { focusFindingId })}
                        />
                      )}
                    </Fragment>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
