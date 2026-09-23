import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HLJSApi } from "highlight.js";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { CheckCircledIcon, ChevronDownIcon, ExternalLinkIcon } from "@radix-ui/react-icons";
import { Badge, Skeleton, TextField, Tooltip } from "@radix-ui/themes";
import { Collapsible } from "radix-ui";

import { CommitChip } from "@/components/commit-chip";
import { Statement } from "@/components/statement";
import { Button } from "@/components/theme-button";
import { isAnchorable } from "@/lib/finding-position";
import { languageOf, splitHighlightedLines, splitIndent } from "@/lib/highlight-lines";
import { localClock, localDay } from "@/lib/time";

import { fetchJson, send } from "./api.ts";
/*
 * 这几个组件渲染的一律是阶段汇总里的 Finding(issue #433):两个调用方(阶段汇总的列表
 * 与阶段详情的代码差异侧滑)传进来的都是它,而它带着行作者与 `placedRunId`——轮次自己
 * 那份投影没有这两格。直接引契约,不经 `stage-summary.tsx` 再导出一手:那个文件反过来
 * 引本文件。
 */
import type { StageSummaryFinding as StageFinding } from "../../src/contracts/stage-summary.ts";

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
  await send(
    `/findings/${input.id}/${input.disposition === "resolved" ? "resolve" : "unresolve"}`,
    "POST",
    note === "" ? {} : { note },
  );
}

const GUTTER_TINT = { add: "bg-success-tint", del: "bg-danger-tint", context: "" } as const;
const CODE_TINT = { add: "bg-success-tint/50", del: "bg-danger-tint/50", context: "" } as const;

const SEVERITY_COLOR = { P0: "red", P1: "amber", P2: "gray" } as const;

/** 已处置:人工与「已修复」自动处置都算。 */
function findingDisposed(finding: StageFinding): boolean {
  return finding.disposition === "resolved" || finding.disposition === "fixed";
}

/** 影响或建议有内容:null(升级前没存)与空串(模型没给)都是没有这一段。 */
function hasText(value: string | null): boolean {
  return value !== null && value !== "";
}

/**
 * 一个归属的原文(issue #278):谁说的挂谁的名下,整段留在「各模型原文」折叠区里。
 * 正文只呈现代表段那一份,这里是核对某个模型原话的地方,因此问题那一段照原样列出,
 * 不因为与代表段相同就省掉——省掉会让人以为这个模型没说过问题本身。
 */
function AttributionSaid({ said }: { said: StageFinding["attributions"][number] }) {
  return (
    <div className="flex flex-col gap-0.5 text-sm text-text-secondary">
      <span className="min-w-0 break-all font-mono">{said.model}</span>
      <p className="text-base leading-relaxed break-words">问题：<Statement text={said.description} /></p>
      {hasText(said.impact) ? <p className="text-base leading-relaxed break-words">影响：<Statement text={said.impact ?? ""} /></p> : null}
      {hasText(said.suggestion) ? <p className="text-base leading-relaxed break-words">建议：<Statement text={said.suggestion ?? ""} /></p> : null}
    </div>
  );
}

/**
 * 延续承接来的一段历史说法(issue #267):头一行写明是哪个模型在哪一轮的哪个 head 上说的、
 * 尚未针对新代码重新验证,再是它自己的问题、影响与建议。轮次写 Review Run 的 id:同一个
 * head 可以重跑出多轮,只写 head 定位不到那一轮。它不是本轮的归属,不署给给出新位置的
 * 模型。与 `AttributionSaid` 同一条规则:问题那一段照原样列出,影响与建议两段都没有内容
 * 也照样出块——正文是综合文本时,承接段的问题说法在这里是唯一能核对的原话。
 */
function CarriedSaid({ said }: { said: StageFinding["carried"][number] }) {
  return (
    <div className="flex flex-col gap-0.5 text-sm text-text-secondary">
      <p className="flex flex-wrap items-center gap-1.5">
        <span>沿用</span>
        <span className="min-w-0 break-all font-mono">{said.model}</span>
        <span>在 Review Run #{said.runId} /</span>
        <CommitChip sha={said.headSha} />
        <span>上的说法 · 尚未针对新代码重新验证</span>
      </p>
      <p className="text-base leading-relaxed break-words">问题：<Statement text={said.description} /></p>
      {hasText(said.impact) ? <p className="text-base leading-relaxed break-words">影响：<Statement text={said.impact ?? ""} /></p> : null}
      {hasText(said.suggestion) ? <p className="text-base leading-relaxed break-words">建议：<Statement text={said.suggestion ?? ""} /></p> : null}
    </div>
  );
}

/**
 * 各模型原文(issue #278):全部归属与延续承接来的历史说法,默认折叠。正文只有一份
 * 代表段,要核对某个模型的原话在这里展开。只有一条归属又没有承接段时不给这个入口
 * ——展开与正文逐字相同,是白按一下。
 */
function OriginalSaid({ finding }: { finding: StageFinding }) {
  if (finding.attributions.length <= 1 && finding.carried.length === 0) return null;
  return (
    <Collapsible.Root className="group/said flex flex-col gap-1.5">
      <Collapsible.Trigger
        type="button"
        className="flex cursor-pointer items-center gap-1.5 self-start text-sm text-text-secondary outline-none pointer-coarse:min-h-11 hover:text-text focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span>各模型原文</span>
        <ChevronDownIcon
          aria-hidden
          className="size-4 shrink-0 transition-transform group-data-[state=open]/said:rotate-180"
        />
      </Collapsible.Trigger>
      <Collapsible.Content className="flex flex-col gap-1.5">
        {finding.attributions.map((said, index) => (
          <AttributionSaid key={`${said.model}-${index}`} said={said} />
        ))}
        {finding.carried.map((said, index) => (
          <CarriedSaid key={`carried-${said.runId}-${index}`} said={said} />
        ))}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

/**
 * 行作者(CONTEXT.md):这一行最后一次改动的 git author 与那次提交,「姓名 · 短 sha ·
 * 日期」一行。同名作者靠邮箱区分,邮箱放 Tooltip;判不出来时写明「无法追溯」,免得空
 * 白被读成页面坏了。短 sha 不做链接:本票不引入 Forge 的 commit 页地址。
 *
 * 作者取自相邻改动时在末尾补一句「相邻改动」(issue #241):落点这一行本身这一轮没改,
 * 不说明这一点,读的人会以为责任人指的是这一行。
 */
/**
 * 元信息的一行:左边一格定宽的标签,右边是值。几行标签对齐成一列,读的人先扫标签
 * 再读值,不用逐行找冒号。
 */
function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-sm text-text-secondary">
      <span className="w-14 shrink-0">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 text-text">{children}</div>
    </div>
  );
}

function LineAuthorLine({ lineAuthor }: { lineAuthor: StageFinding["lineAuthor"] }) {
  if (lineAuthor === null) {
    return <MetaRow label="行作者">无法追溯</MetaRow>;
  }
  return (
    <MetaRow label="行作者">
      <Tooltip content={lineAuthor.email}>
        <span tabIndex={0} className="break-all">
          {lineAuthor.name}
        </span>
      </Tooltip>
      <span aria-hidden>·</span>
      <CommitChip sha={lineAuthor.sha} />
      <span aria-hidden>·</span>
      <span className="tabular-nums">{localDay(lineAuthor.authoredAt)}</span>
      {lineAuthor.adjacent ? (
        <>
          <span aria-hidden>·</span>
          <span>相邻改动</span>
        </>
      ) : null}
    </MetaRow>
  );
}

/**
 * 严重度与类别两枚徽章。已处置的那条把严重度换成绿勾:它不再等人排优先级。阶段列表的
 * 卡头与 diff 里的卡片共用这一份。
 */
export function FindingBadges({ finding }: { finding: StageFinding }) {
  return (
    <>
      {findingDisposed(finding) ? (
        <CheckCircledIcon className="size-4 shrink-0 text-success" aria-label="已处置" />
      ) : (
        <Badge color={SEVERITY_COLOR[finding.severity]} variant="soft" radius="full">
          {finding.severity}
        </Badge>
      )}
      <Badge color="gray" variant="soft" radius="full">{finding.category}</Badge>
    </>
  );
}

/**
 * 正文的一段。正文是这张卡的内容,走主文字色;「影响」「建议」两个标签退一档。行宽封在
 * 56rem:内容轨不设上限之后,宽屏上一行一百多个汉字读不回行首。
 */
function BodyPart({
  label,
  text,
  resolved,
  struck = false,
}: {
  label?: string;
  text: string;
  resolved: boolean;
  /** 已处置的划线。只在没有标题可划时落到问题那一段上。 */
  struck?: boolean;
}) {
  return (
    <p
      className={`max-w-4xl text-base leading-relaxed break-words ${
        resolved ? "text-text-secondary" : "text-text"
      } ${struck ? "line-through" : ""}`}
    >
      {label === undefined ? null : (
        <span className="font-medium text-text-secondary">{label}：</span>
      )}
      <Statement text={text} />
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
  heading = true,
}: {
  finding: StageFinding;
  canDispose: boolean;
  /** 徽章与标题由卡片自己画。阶段列表的卡头已经画了这两样,那里传 false。 */
  heading?: boolean;
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
    // 宽卡(阶段列表)正文与元信息左右分栏:正文行宽封在 56rem,右边那半张卡原来是空的,
    // 归属、行作者与处置挪过去,一张卡矮一截,几百条往下扫得更快。窄卡(侧滑里那张)
    // 不到 64rem,照旧上下排。按容器宽度分,不按视口:同一个组件两处宽度差一倍。
    <div className="@container border-t border-overlay-line px-4 py-3">
      <div className="flex flex-col gap-3 @5xl:grid @5xl:grid-cols-[minmax(0,56rem)_minmax(0,1fr)] @5xl:gap-8">
        <div className="flex min-w-0 flex-col gap-1.5">
          {heading ? (
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <FindingBadges finding={finding} />
              </div>
              {finding.title === "" ? null : (
                <p className={`text-lg font-semibold break-words ${resolved ? "text-text-secondary line-through" : ""}`}>
                  {finding.title}
                </p>
              )}
            </div>
          ) : null}

          {/* 正文是代表段那一份问题 / 影响 / 建议(issue #278):几个模型报同一处时人要读的
              是一份说清楚的说法,谁报的退到下面那一行。 */}
          <BodyPart
            text={finding.description}
            resolved={resolved}
            struck={resolved && finding.title === ""}
          />
          {hasText(finding.impact) ? (
            <BodyPart label="影响" text={finding.impact ?? ""} resolved={resolved} />
          ) : null}
          {hasText(finding.suggestion) ? (
            <BodyPart label="建议" text={finding.suggestion ?? ""} resolved={resolved} />
          ) : null}

          <OriginalSaid finding={finding} />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5 @5xl:border-l @5xl:border-overlay-line @5xl:pl-6">
          {/* 归属一行(ADR 0015):报出它的模型全列出来,一个都不藏,但不再抢正文。 */}
          <MetaRow label="报出模型">
            {finding.models.map((model) => (
              <span key={model} className="min-w-0 rounded-chip bg-fill px-1.5 py-0.5 font-mono text-xs break-all">
                {model}
              </span>
            ))}
          </MetaRow>

          <LineAuthorLine lineAuthor={finding.lineAuthor} />

          {finding.continuedFrom === null ? null : (
            <MetaRow label="延续">
              <a
                href={finding.continuedFrom}
                target="_blank"
                rel="noreferrer"
                className="touch-link text-primary underline underline-offset-4"
              >
                延续自上一处评论
              </a>
              <span>原位置代码已改写；复核判定该 Finding 仍在</span>
            </MetaRow>
          )}

          {/* 交接未完成(ADR 0025):旧评论还留在 Forge 上待关闭。摆在处置状态旁,读的人知道
              这条在 Forge 上还有一条打开的旧评论,可以去处置;下一轮收尾会自动重试关闭。 */}
          {finding.handoffPending ? (
            <p className="text-sm text-warning">
              交接未完成 · 旧评论尚未关闭，仍可在 Forge 上处置；下一轮 Review Run 收尾时重试关闭
            </p>
          ) : null}

          {autoDisposed ? (
            <MetaRow label="处置">
              已修复 · 自动处置
              {finding.disposedAt === null ? null : (
                <>
                  {" · "}
                  <span className="tabular-nums">
                    {localDay(finding.disposedAt)} {localClock(finding.disposedAt)}
                  </span>
                </>
              )}
            </MetaRow>
          ) : finding.disposedBy === null ? null : (
            <MetaRow label="处置">
              {resolved ? "已处置" : "撤回处置"} · {finding.disposedBy} ·{" "}
              <span className="tabular-nums">{localDay(finding.disposedAt!)} {localClock(finding.disposedAt!)}</span>
            </MetaRow>
          )}
          {finding.note === null ? null : (
            <MetaRow label="备注">
              <span className="rounded-lg bg-fill px-2.5 py-1.5 break-words">{finding.note}</span>
            </MetaRow>
          )}

          {/* 正文里的 fallback 没有行级评论承载,Forge 上无从 resolve,面板也就不给动作。 */}
          {finding.commentId === null ? (
            <p className="text-sm text-text-secondary">
              该 Finding 仅发布在 pull request review 正文中，未生成可处置的行级评论。
            </p>
          ) : (
            <div className="flex flex-col gap-2 pt-1">
              {canDispose && composing ? (
                <TextField.Root
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={500}
                  placeholder="只写为什么不用改（可选，只存面板）；代码已改的留给下一轮评审自动处置"
                  aria-label="处置备注"
                />
              ) : null}
              <div className="flex items-center gap-2">
                {!canDispose ? null : resolved ? (
                  <Button
                    variant="soft"
                    color="gray"
                    size={{ initial: "3", sm: "1" }}
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
                    highContrast
                    onClick={() => setComposing(true)}
                    aria-label={`处置 ${finding.file}:${finding.line} 的 Finding`}
                  >
                    处置
                  </Button>
                )}
                {/* 原始评论的外链与处置并排:两样都是「对这条 Finding 做点什么」。 */}
                {/* 写出去向:一颗孤零零的外链图标漂在卡片右沿,看不出它通向哪里。 */}
                {finding.commentHtmlUrl === null ? null : (
                  <a
                    href={finding.commentHtmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`在 Forge 查看 ${finding.file}:${finding.line} 的原始评论`}
                    className="touch-link inline-flex items-center gap-1 rounded-sm px-1 text-sm text-text-secondary outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    Forge 评论
                    <ExternalLinkIcon aria-hidden />
                  </a>
                )}
              </div>
            </div>
          )}

          {dispose.isError ? (
            <p role="alert" className="text-sm break-words text-danger">
              {(dispose.error as Error).message}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 一行代码的正文。行首缩进单独一截:窄屏按半宽画(见 `splitIndent`),桌面照原样。
 */
function CodeText({ text, html }: { text: string; html: string | undefined }) {
  const [indent, rest] = splitIndent(html ?? text);
  return (
    <>
      <span className="max-sm:text-[0.5em]">{indent}</span>
      {html === undefined ? (
        rest
      ) : (
        // highlight.js 的产出:源码里的 < > & 已由它转义,标签只有它自己加的 span。
        <span className="diff-code" dangerouslySetInnerHTML={{ __html: rest }} />
      )}
    </>
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
  findings: readonly StageFinding[];
  canDispose: boolean;
  focusFindingId?: number;
}) {
  return (
    <>
      {findings.map((finding) => (
        <tr key={finding.id}>
          {/* 表格是 font-mono text-xs 的代码面,卡片是正文:字体与字号在这一格换回来,
              否则 Finding 的中文正文会被等宽字体撑开。卡片内嵌成一张独立的卡,读的人
              分得清哪里是代码、哪里是评论。 */}
          <td colSpan={3} className="bg-sunken px-3 py-2 max-sm:px-1.5 font-sans text-base whitespace-normal">
            {focusFindingId === undefined || finding.id === focusFindingId ? (
              <div
                className={`overflow-hidden rounded-lg border shadow-control [&>div]:border-t-0 ${
                  finding.id === focusFindingId
                    ? "border-primary bg-accent-tint"
                    : "border-overlay-line bg-surface"
                }`}
              >
                <FindingRow finding={finding} canDispose={canDispose} />
              </div>
            ) : (
              // 同文件的其它 Finding 收成一行(徽章 + 标题):侧滑回答的是「点进来的这一条指
              // 哪几行」,别的几条整张摊开会把代码挤出视野。点开仍是同一张卡,处置照旧行内做。
              <Collapsible.Root className="group/anchored overflow-hidden rounded-lg border border-overlay-line bg-surface shadow-control">
                <Collapsible.Trigger
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-1.5 px-4 py-2 text-left outline-none pointer-coarse:min-h-11 hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <FindingBadges finding={finding} />
                  <span
                    className={`min-w-0 flex-1 truncate pl-1 text-md font-medium ${
                      findingDisposed(finding) ? "text-text-secondary line-through" : ""
                    }`}
                  >
                    {hasText(finding.title) ? finding.title : finding.description}
                  </span>
                  <ChevronDownIcon
                    aria-hidden
                    className="size-4 shrink-0 text-text-secondary transition-transform group-data-[state=open]/anchored:rotate-180"
                  />
                </Collapsible.Trigger>
                <Collapsible.Content>
                  <FindingRow finding={finding} canDispose={canDispose} heading={false} />
                </Collapsible.Content>
              </Collapsible.Root>
            )}
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
 * 整个文件的 diff 一次全渲染,渲染成本按 hunk 隔离:每个 hunk 自成一张表,屏幕外的那些
 * 由浏览器跳过布局与绘制(`content-visibility: auto`)。当条 Finding 所在的那一个不跳过,
 * 它那一行滚到视野正中的落点才准确。
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
  findings: readonly StageFinding[];
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
    // 上一条 / 下一条落在同一个文件里时 patch 不变,变的只有焦点。
  }, [patch.data, focusFindingId]);

  const hunks = useMemo(
    () => (patch.data === undefined ? [] : parseUnifiedDiff(patch.data.patch)),
    [patch.data],
  );
  // 语法高亮:highlight.js 只在认得出语言的文件上按需加载(独立 chunk),到手之前与认不出的
  // 文件一样显示纯文本。一个 hunk 整段高亮再按行拆,跨行注释的第二行起仍是注释;hunk 的
  // 开头若落在一段跨行注释中间,那几行会被当成代码——hunk 之外的内容这里拿不到。
  const language = languageOf(path);
  const [hljs, setHljs] = useState<HLJSApi | null>(null);
  useEffect(() => {
    if (language === undefined) return;
    let live = true;
    void import("highlight.js/lib/common").then((module) => {
      if (live) setHljs(module.default);
    });
    return () => {
      live = false;
    };
  }, [language]);
  const highlighted = useMemo(
    () =>
      hljs === null || language === undefined
        ? null
        : hunks.map((hunk) =>
            // ponytail: 同步高亮,超过 3000 行的 hunk 直接不高亮;要覆盖它得挪进 worker。
            hunk.lines.length > 3000
              ? null
              : splitHighlightedLines(
                  hljs.highlight(hunk.lines.map((line) => line.text).join("\n"), {
                    language,
                    ignoreIllegals: true,
                  }).value,
                ),
          ),
    [hljs, language, hunks],
  );
  const rendered = new Set(
    hunks.flatMap((hunk) =>
      hunk.lines.flatMap((line) => (line.newLine === null ? [] : [line.newLine])),
    ),
  );
  // 可锚定的判据同一份(issue #368 追加修复):行号落在这一轮渲染范围内,且位置就属于
  // 这一轮——位置属于别的轮次时行号即使落在范围内也不算,那是另一轮代码上的巧合。
  const byLine = new Map<number, StageFinding[]>();
  for (const finding of findings) {
    if (!isAnchorable(finding, runId, rendered)) continue;
    byLine.set(finding.line, [...(byLine.get(finding.line) ?? []), finding]);
  }
  const unanchored = findings.filter((finding) => !isAnchorable(finding, runId, rendered));
  // 整个文件都是新增(新文件)时,「哪几行是新的」不携带信息:代码格不铺绿,只留行号槽那
  // 一道,免得一整屏绿底。
  const wholeFileAdded = hunks.every((hunk) => hunk.lines.every((line) => line.kind === "add"));
  // 行号槽的宽度跟着这个文件最大的行号走:定宽 48px 装得下四位,两万多行的文件五位行号
  // 会在槽里折成两行。最少按四位留,小文件之间槽宽不跳。
  const gutterDigits = Math.max(
    4,
    ...hunks.flatMap((hunk) =>
      hunk.lines.map((line) => String(Math.max(line.oldLine ?? 0, line.newLine ?? 0)).length),
    ),
  );
  const focusLine = findings.find((finding) => finding.id === focusFindingId)?.line;

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
        <div
          className="min-w-0"
          role="group"
          aria-label={`${path} 的代码差异`}
          style={{ "--gutter": `calc(${gutterDigits}ch + 0.75rem)` } as React.CSSProperties}
        >
          {hunks.map((hunk, hunkIndex) => {
            const hasFocusLine =
              focusLine !== undefined && hunk.lines.some((line) => line.newLine === focusLine);
            return (
              <div
                key={hunkIndex}
                // 屏幕外的 hunk 由浏览器跳过布局与绘制,滚到时再渲染;预留高度按行数乘一行
                // 的近似高度(text-xs 一行约 20px)估,`auto` 让它渲染过一次后改用实测值。
                // 当条 Finding 所在的这一个不跳过,`scrollIntoView` 的落点才准确。
                style={
                  hasFocusLine
                    ? { contentVisibility: "visible" }
                    : {
                        contentVisibility: "auto",
                        containIntrinsicSize: `auto ${(hunk.lines.length + 1) * 20}px`,
                      }
                }
              >
                {/* 每个 hunk 一张表:一张大表的布局要把全部行算一遍,分表之后跳过的那些
                    不参与。各表共用同一份 colgroup 加 table-fixed,列宽因此对齐。行号列
                    的宽度是外层的 `--gutter`(按这个文件最大行号的位数算),不折行。 */}
                <table className="w-full table-fixed border-collapse font-mono text-xs leading-5">
                  <colgroup>
                    {/* 窄屏收掉旧行号列:390px 上两列行号占掉四分之一,深缩进的代码一行折五六段。
                        Finding 只锚新侧行号,删除行靠红底与 − 认。 */}
                    <col className="w-[var(--gutter)] max-sm:w-0" />
                    <col className="w-[var(--gutter)]" />
                    <col />
                  </colgroup>
                  <tbody>
                    <tr className="bg-sunken">
                      {/* hunk 头拆成两截:`@@ … @@` 的范围是机器读的,次级色;后面那段是 git 给的
                          所在函数或类,人靠它认这一段在哪,走主文字色。 */}
                      <td colSpan={3} className="border-y border-overlay-line px-3 py-1 whitespace-pre-wrap break-words text-text-secondary">
                        {hunk.header.slice(0, hunk.header.indexOf("@@", 2) + 2)}
                        <span className="text-text">{hunk.header.slice(hunk.header.indexOf("@@", 2) + 2)}</span>
                      </td>
                    </tr>
                    {hunk.lines.map((line, index) => (
                      <Fragment key={index}>
                        <tr
                          {...(line.newLine !== null && line.newLine === focusLine
                            ? { ref: focusRow }
                            : {})}
                          // 细指针上悬停的那一行整行提一档:侧滑九百多像素宽,行号与代码隔得远。
                          className="pointer-fine:hover:[&>td]:bg-accent-tint"
                        >
                          {/* 底色分两档:行号槽铺满 tint,代码格减半——改动在哪靠槽认,代码本身
                              保持好读。 */}
                          <td className={`px-1.5 text-right align-top whitespace-nowrap tabular-nums text-text-secondary select-none max-sm:px-0 ${GUTTER_TINT[line.kind]}`}>
                            {/* 列宽收到 0 而不是 display:none:整格拿掉会让后两格各往前挪一列,
                                代码落进 48px 的行号列里。 */}
                            <span className="max-sm:hidden">{line.oldLine ?? ""}</span>
                          </td>
                          {/* 点进来的那条 Finding 锚的就是这一行:行号换主色底,卡片指哪一行不用猜。 */}
                          <td
                            className={`px-1.5 text-right align-top whitespace-nowrap tabular-nums select-none ${
                              line.newLine !== null && line.newLine === focusLine
                                ? "bg-accent-track font-semibold text-primary"
                                : `text-text-secondary ${GUTTER_TINT[line.kind]}`
                            }`}
                          >
                            {line.newLine ?? ""}
                          </td>
                          <td
                            className={`pr-2 pl-[calc(0.5rem+2ch)] -indent-[2ch] align-top whitespace-pre-wrap break-words max-sm:break-all text-text ${
                              wholeFileAdded ? "" : CODE_TINT[line.kind]
                            }`}
                          >
                            <span className="inline-block w-[2ch] indent-0 select-none text-text-secondary">
                              {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                            </span>
                            <CodeText
                              text={line.text}
                              html={highlighted?.[hunkIndex]?.[index]}
                            />
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
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
