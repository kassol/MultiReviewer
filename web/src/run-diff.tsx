import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";

import {
  CheckCircledIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CrossCircledIcon,
  ExternalLinkIcon,
} from "@radix-ui/react-icons";
import { Badge, Callout, IconButton, Select, Skeleton, TextField, Tooltip } from "@radix-ui/themes";

import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/theme-button";
import { localClock, localDay } from "@/lib/time";

import { api, errorText, fetchJson } from "./api.ts";
import { type RunFinding, type RunItem } from "./runs.tsx";

/** 一个文件在 Review Range 内的改动概览。二进制文件的增删行数是 0 并单独标出。 */
export type DiffFile = {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  binary: boolean;
};

/** `GET /runs/{id}/diff` 的文件列表。`baseSha` 是 Review Range 的基准(merge-base)。 */
type RunDiffFiles = { baseSha: string; headSha: string; files: DiffFile[] };

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
 * 一条 Finding 的卡片:正文、严重度、类别、文件与行、跳到 Forge 看原版的链接,加上
 * 行内处置。它挂在 diff 的对应行下面,fallback 那一批则单独成段。
 *
 * 处置成功后让轮次那几份查询失效,进度条与列表跟着一起变——处置进度是同一批 finding
 * 行算出来的,只改本地状态会让两个数字对不上。
 */
function FindingRow({
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
      // 时间流、仓库详情与范围审查详情各读一份轮次投影,处置改的是同一批行。
      for (const key of [["runs"], ["repo-runs"], ["range-review"]]) {
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
              className="min-w-0 break-all font-mono text-sm text-text-muted"
            >
              {model}
            </span>
          ))}
        </div>
        {finding.commentHtmlUrl === null ? null : (
          <Tooltip content="在 Forge 上看这条原评论">
            <IconButton size="1" variant="ghost" color="gray" radius="full" asChild>
              <a href={finding.commentHtmlUrl} target="_blank" rel="noreferrer" aria-label="看 Forge 上的原评论">
                <ExternalLinkIcon />
              </a>
            </IconButton>
          </Tooltip>
        )}
      </div>

      <p
        className={`text-base leading-relaxed break-words ${
          resolved ? "text-text-muted line-through" : "text-text-secondary"
        }`}
      >
        {finding.description}
      </p>

      {autoDisposed ? (
        <p className="text-sm text-text-muted">
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
        <p className="text-sm text-text-muted">
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
        <p className="text-sm text-text-muted">这条只在 review 正文里，没有可处置的评论。</p>
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
                size="1"
                highContrast
                disabled={dispose.isPending}
                onClick={() => dispose.mutate({ id: finding.id, disposition: "unresolved", note })}
              >
                撤回处置
              </Button>
            ) : composing ? (
              <>
                <Button
                  variant="solid"
                  size="1"
                  disabled={dispose.isPending}
                  onClick={() => dispose.mutate({ id: finding.id, disposition: "resolved", note })}
                >
                  {dispose.isPending ? "处置中…" : "确认处置"}
                </Button>
                <Button
                  variant="ghost"
                  color="gray"
                  size="1"
                  highContrast
                  onClick={() => { setComposing(false); setNote(""); }}
                >
                  取消
                </Button>
              </>
            ) : (
              <Button variant="soft" color="gray" size="1" highContrast onClick={() => setComposing(true)}>
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

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
};

/** 一行 Finding 卡片在 diff 表格里占满整行。 */
function FindingCells({
  findings,
  canDispose,
}: {
  findings: readonly RunFinding[];
  canDispose: boolean;
}) {
  return (
    <>
      {findings.map((finding) => (
        <tr key={finding.id}>
          <td colSpan={3} className="bg-surface p-0">
            <FindingRow finding={finding} canDispose={canDispose} />
          </td>
        </tr>
      ))}
    </>
  );
}

/**
 * 一个文件的 diff。展开时才去取那个文件的 patch:一个 Review Range 可以有几百个文件,
 * 一次全取会让详情面板在最需要它的那几次(大改动)打不开。
 */
function FileSection({
  runId,
  file,
  findings,
  canDispose,
  open,
  onToggle,
}: {
  runId: number;
  file: DiffFile;
  /** 这个文件下要显示的 Finding,已按筛选裁过。 */
  findings: readonly RunFinding[];
  canDispose: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const patch = useQuery({
    queryKey: ["run-diff", runId, file.path],
    queryFn: () =>
      fetchJson<RunFilePatch>(`/runs/${runId}/diff?file=${encodeURIComponent(file.path)}`),
    enabled: open,
  });

  const hunks = patch.data === undefined ? [] : parseUnifiedDiff(patch.data.patch);
  const rendered = new Set(
    hunks.flatMap((hunk) => hunk.lines.flatMap((line) => (line.newLine === null ? [] : [line.newLine]))),
  );
  const byLine = new Map<number, RunFinding[]>();
  for (const finding of findings) {
    if (!rendered.has(finding.line)) continue;
    byLine.set(finding.line, [...(byLine.get(finding.line) ?? []), finding]);
  }
  // 锚不上任何一行的那些挂在文件头下面:行号落在 diff 之外时,把卡片藏起来等于把
  // 一条真实的 Finding 从面板上抹掉。
  const unanchored = findings.filter((finding) => !rendered.has(finding.line));

  return (
    <section className="overflow-hidden rounded-lg border border-overlay-line bg-surface shadow-control">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
      >
        {open ? (
          <ChevronDownIcon className="size-4 shrink-0 text-text-faint" aria-hidden />
        ) : (
          <ChevronRightIcon className="size-4 shrink-0 text-text-faint" aria-hidden />
        )}
        <span className="min-w-0 flex-1 break-all font-mono text-base text-text">{file.path}</span>
        {findings.length === 0 ? null : (
          <Badge color="gray" variant="soft" radius="full">
            <span className="font-mono tabular-nums">{findings.length}</span> 项发现
          </Badge>
        )}
        <span className="shrink-0 text-sm text-text-muted">{STATUS_LABEL[file.status]}</span>
        {file.binary ? (
          <span className="shrink-0 text-sm text-text-muted">二进制</span>
        ) : (
          <span className="shrink-0 text-sm tabular-nums">
            <span className="text-success">+{file.additions}</span>{" "}
            <span className="text-danger">−{file.deletions}</span>
          </span>
        )}
      </button>

      {open ? (
        <div className="border-t border-overlay-line">
          {patch.isPending ? (
            <div className="p-3" role="status" aria-live="polite">
              <span className="sr-only">正在加载这个文件的 diff</span>
              <Skeleton className="h-24" />
            </div>
          ) : patch.isError ? (
            <Callout.Root role="alert" color="red" size="1" className="m-3">
              <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
              <Callout.Text>{(patch.error as Error).message}</Callout.Text>
            </Callout.Root>
          ) : hunks.length === 0 ? (
            <>
              <p className="px-3 py-2.5 text-base text-text-muted">
                这个文件没有可显示的行改动。
              </p>
              {unanchored.length === 0 ? null : (
                <div>
                  {unanchored.map((finding) => (
                    <FindingRow key={finding.id} finding={finding} canDispose={canDispose} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              {unanchored.length === 0 ? null : (
                <div className="border-b border-overlay-line">
                  <p className="bg-warning-tint px-3 py-1.5 text-sm text-warning">
                    下面这些 Finding 指向的行不在本次改动里。
                  </p>
                  {unanchored.map((finding) => (
                    <FindingRow key={finding.id} finding={finding} canDispose={canDispose} />
                  ))}
                </div>
              )}
              <table className="w-full border-collapse font-mono text-xs">
                <tbody>
                  {hunks.map((hunk, hunkIndex) => (
                    <Fragment key={hunkIndex}>
                      <tr className="bg-sunken">
                        <td colSpan={3} className="px-3 py-1 break-all text-text-muted">
                          {hunk.header}
                        </td>
                      </tr>
                      {hunk.lines.map((line, index) => (
                        <Fragment key={index}>
                          <tr
                            className={
                              line.kind === "add"
                                ? "bg-success-tint"
                                : line.kind === "del"
                                  ? "bg-danger-tint"
                                  : ""
                            }
                          >
                            <td className="w-10 px-1.5 text-right align-top tabular-nums text-text-faint select-none">
                              {line.oldLine ?? ""}
                            </td>
                            <td className="w-10 px-1.5 text-right align-top tabular-nums text-text-faint select-none">
                              {line.newLine ?? ""}
                            </td>
                            <td className="px-2 align-top break-all whitespace-pre-wrap text-text-secondary">
                              <span className="select-none text-text-faint">
                                {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                              </span>
                              {line.text}
                            </td>
                          </tr>
                          {line.newLine === null ? null : (
                            <FindingCells
                              findings={byLine.get(line.newLine) ?? []}
                              canDispose={canDispose}
                            />
                          )}
                        </Fragment>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

type DispositionFilter = "all" | "pending" | "disposed";

/**
 * Review Run 详情的完整 diff 视图:Review Range 的文件列表加逐文件 diff,Finding 锚在
 * 对应的新侧行号上,行内直接处置。
 *
 * 默认只展开有 Finding 的文件。这一页是来看「模型说了什么、说在哪」的,而一个 Review
 * Range 可以有几百个文件,全部展开等于让人先滚过几千行才看到第一条 Finding。
 */
export function RunDiff({ run, canDispose }: { run: RunItem; canDispose: boolean }) {
  const diff = useQuery({
    queryKey: ["run-diff", run.id],
    queryFn: () => fetchJson<RunDiffFiles>(`/runs/${run.id}/diff`),
  });
  const [filePath, setFilePath] = useState("all");
  const [model, setModel] = useState("all");
  const [disposition, setDisposition] = useState<DispositionFilter>("all");
  // 人手动开合过的文件记在这里,其余按默认规则。
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const matches = (finding: RunFinding): boolean =>
    (model === "all" || finding.models.includes(model)) &&
    (disposition === "all" || (disposition === "disposed") === findingDisposed(finding));

  const files = diff.data?.files ?? [];
  const inDiff = new Set(files.map((file) => file.path));
  // 锚得上的:行级承载、有评论 id、而且它指的文件确实在这次改动里。
  const anchored = run.findings.filter(
    (finding) =>
      finding.placement === "inline" && finding.commentId !== null && inDiff.has(finding.file),
  );
  const fallback = run.findings.filter((finding) => !anchored.includes(finding));

  const byFile = new Map<string, RunFinding[]>();
  for (const finding of anchored.filter(matches)) {
    byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
  }

  // Finding 上的筛选一旦生效,只留还有 Finding 可显示的文件——否则筛完还是整份 diff,
  // 筛选等于没按。
  const narrowed = model !== "all" || disposition !== "all";
  const visible = files.filter(
    (file) =>
      (filePath === "all" || file.path === filePath) &&
      (!narrowed || (byFile.get(file.path) ?? []).length > 0),
  );
  // 文件列表没到手之前不分锚得上与锚不上:那时 inDiff 是空的,每条 Finding 都会被
  // 错当成锚不上,整段先冒出来再跳掉。
  const visibleFallback =
    diff.data === undefined
      ? []
      : fallback.filter(
          (finding) => matches(finding) && (filePath === "all" || finding.file === filePath),
        );

  const down = run.models.filter((entry) => entry.failure !== null);
  // 默认展开有 Finding 的文件;整轮一条 Finding 都没有时展开第一个,免得开屏全是折叠条。
  // 单独筛出一个文件时那个文件也默认展开——筛它就是为了看它。
  const defaultOpen = new Set(
    files
      .filter(
        (file, index) =>
          (byFile.get(file.path) ?? []).length > 0 ||
          file.path === filePath ||
          (anchored.length === 0 && index === 0),
      )
      .map((file) => file.path),
  );
  const isOpen = (path: string): boolean => toggled[path] ?? defaultOpen.has(path);

  return (
    <div className="flex flex-col gap-3">
      {/* 失败原因决定要不要重跑(区域封禁重跑也没用,超时重跑就好),所以整段摊开。 */}
      {down.map((entry) => (
        <Callout.Root key={entry.model} role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>
            <span className="break-all font-mono">{entry.model}</span> 这一轮失败：{entry.failure}
          </Callout.Text>
        </Callout.Root>
      ))}

      {diff.isError ? (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{(diff.error as Error).message}</Callout.Text>
        </Callout.Root>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Select.Root value={filePath} onValueChange={setFilePath} size="1">
          <Select.Trigger aria-label="按文件筛选" />
          <Select.Content>
            <Select.Item value="all">全部文件</Select.Item>
            {files.map((file) => (
              <Select.Item key={file.path} value={file.path}>{file.path}</Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        <Select.Root value={model} onValueChange={setModel} size="1">
          <Select.Trigger aria-label="按模型筛选" />
          <Select.Content>
            <Select.Item value="all">全部模型</Select.Item>
            {run.models.map((entry) => (
              <Select.Item key={entry.model} value={entry.model}>{entry.model}</Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        <Select.Root
          value={disposition}
          onValueChange={(next) => setDisposition(next as DispositionFilter)}
          size="1"
        >
          <Select.Trigger aria-label="按处置状态筛选" />
          <Select.Content>
            <Select.Item value="all">全部处置状态</Select.Item>
            <Select.Item value="pending">未处置</Select.Item>
            <Select.Item value="disposed">已处置</Select.Item>
          </Select.Content>
        </Select.Root>
        {diff.data === undefined ? null : (
          <span className="text-sm text-text-muted">
            <span className="font-mono tabular-nums">{files.length}</span> 个文件
          </span>
        )}
      </div>

      {diff.isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-live="polite">
          <span className="sr-only">正在加载这一轮的 diff</span>
          {[0, 1, 2].map((slot) => <Skeleton key={slot} className="h-12" />)}
        </div>
      ) : null}

      {visible.map((file) => (
        <FileSection
          key={file.path}
          runId={run.id}
          file={file}
          findings={byFile.get(file.path) ?? []}
          canDispose={canDispose}
          open={isOpen(file.path)}
          onToggle={() =>
            setToggled((prev) => ({ ...prev, [file.path]: !isOpen(file.path) }))
          }
        />
      ))}

      {diff.data !== undefined && files.length === 0 ? (
        <EmptyState title="这一轮的 Review Range 里没有改动的文件" className="py-2" />
      ) : null}
      {diff.data !== undefined && files.length > 0 && visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-card-line px-4 py-6 text-center text-text-muted">
          没有符合筛选条件的文件。
        </p>
      ) : null}

      {/* 没有行级评论承载、或者指的文件不在这次改动里的那些单独成段:它们没有可锚的行。 */}
      {visibleFallback.length === 0 ? null : (
        <section className="overflow-hidden rounded-lg border border-overlay-line bg-surface shadow-control">
          <h3 className="px-3 py-2.5 text-2xl font-bold">
            没有对应 diff 行的发现
            <span className="ml-2 font-mono text-base font-normal tabular-nums text-text-muted">
              {visibleFallback.length}
            </span>
          </h3>
          {visibleFallback.map((finding) => (
            <div key={finding.id}>
              <p className="border-t border-overlay-line px-4 pt-2.5 font-mono text-sm break-all text-text-muted">
                {finding.file}:{finding.line}
              </p>
              <FindingRow finding={finding} canDispose={canDispose} />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
