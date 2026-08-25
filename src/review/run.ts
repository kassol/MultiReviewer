import type { ReviewRunReviewerPin } from "../config.ts";
import type {
  ExistingReviewComment,
  Forge,
  PublishedReviewComment,
  PullRequestRef,
  ReviewCommentDraft,
} from "../forge/forge.ts";
import { prepareWorktree, readRangeDiff } from "../git/worktree.ts";
import {
  DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
  mergeBatchOutcomes,
  splitIntoBatches,
  type TimedOutcome,
} from "./batch.ts";
import { dedupeFindings, type MergedFinding } from "./dedupe.ts";
import type { Disposition, Reviewer, ReviewerOutcome, Severity } from "./finding.ts";
import {
  contentFingerprint,
  fileFingerprints,
  fingerprintAnchor,
  parseFingerprintAnchors,
} from "./fingerprint.ts";
import { changedLinesByFile, isInDiff, parseDiffRanges } from "./position.ts";
import {
  openStore,
  type AutoDispositionCandidate,
  type DispositionUpdate,
  type FindingCommentRef,
  type FindingPlacement,
  type FindingRecord,
  type OutcomeRecord,
} from "./store.ts";

export type PullRequestEvent = PullRequestRef;

/**
 * 一轮 Review Run 在首批开始前固定的运行计划。Reviewer 已各自绑定模型运行参数与自家
 * provider 的凭据;批次只复用这份列表与同一个分批上限,不再接触可变配置。
 */
export type ReviewRunPlan = Readonly<{
  reviewers: readonly Reviewer[];
  maxChangedLinesPerBatch: number;
  reviewerPins: readonly ReviewRunReviewerPin[];
}>;

/** 从启动时的配置快照生成一次运行计划。复制 Reviewer 列表,使组合的后续改动只影响下一轮。 */
export function createReviewRunPlan(
  reviewers: readonly Reviewer[],
  maxChangedLinesPerBatch: number,
  reviewerPins: readonly ReviewRunReviewerPin[],
): ReviewRunPlan {
  return Object.freeze({
    reviewers: Object.freeze([...reviewers]),
    maxChangedLinesPerBatch,
    reviewerPins: Object.freeze([...reviewerPins]),
  });
}

export type ReviewRunDeps = {
  forge: Forge;
  reviewers: readonly Reviewer[];
  /** 工作副本的缓存根目录,按仓库分子目录。 */
  cacheDir: string;
  /** SQLite 数据库文件的位置。 */
  dbPath: string;
  /** 一批最多多少改动行。不传取 `DEFAULT_MAX_CHANGED_LINES_PER_BATCH`。 */
  maxChangedLinesPerBatch?: number;
  /** 本轮固定的非秘密模型服务审计快照。 */
  reviewerPins?: readonly ReviewRunReviewerPin[];
  /** 手动重跑的调用者用户名快照;自动投递不传。 */
  triggeredBy?: string;
  /** 这一轮归属的范围审查;PR 触发不传(ADR 0012)。 */
  rangeReviewId?: number;
};

export type ReviewRunResult = {
  headSha: string;
  /** 去重合并后的 Finding。 */
  findings: readonly MergedFinding[];
  /** 每个 Reviewer 的执行结果,含失败原因、异常条目与被拒的工具调用数。 */
  outcomes: readonly ReviewerOutcome[];
  /** 全部 Reviewer 都失败。此时不发布 review——零 Finding 不代表代码没问题。 */
  failed: boolean;
  /** 发布为行级评论的 Finding 条数。 */
  inlineCount: number;
  /** 行号落不到 diff 内、退化为 PR 级评论的 Finding 条数。 */
  fallbackCount: number;
};

/** 上一轮已提出、本轮匹配上的 Finding。它不再发行级评论,折进 review 正文。 */
type CarriedFinding = {
  finding: MergedFinding;
  /** 上一轮那条评论是否已被 resolve。 */
  resolved: boolean;
};

/** 行号落在 diff 之外、退化进 review 正文的 Finding,连同它的指纹。 */
type FallbackFinding = {
  finding: MergedFinding;
  /** 指纹算不出时正文里没有锚点可埋,这条下一轮匹配不上。 */
  fingerprint: string | undefined;
};

/**
 * 评论是给开发者看的最终结果:等级、标题、问题、影响、建议,分段呈现。
 * 模型署名与各家的不同表述一概不进评论——读的人要的是结论,不是评审过程;
 * 哪个模型说的什么落在数据库里,处置率统计从那里拿。
 */
/** `**[P0] 标题**`。标题空缺时只留等级,不留空尾巴。 */
function findingHeading(finding: MergedFinding): string {
  return finding.title === ""
    ? `**[${finding.severity}]**`
    : `**[${finding.severity}] ${finding.title}**`;
}

/** 问题 / 影响 / 建议三段,段间空行分隔。空段整段跳过,不留一个空标签。 */
function findingSections(finding: MergedFinding): string[] {
  const lines = ["", `**问题**:${finding.description}`];
  if (finding.impact !== "") lines.push("", `**影响**:${finding.impact}`);
  if (finding.suggestion !== "") lines.push("", `**建议**:${finding.suggestion}`);
  return lines;
}

function findingBody(finding: MergedFinding, fingerprint: string | undefined): string {
  const lines = [findingHeading(finding), ...findingSections(finding)];

  // 锚点是下一轮认出这条评论的唯一凭据,指纹算不出时就没有跨轮次匹配可言。
  if (fingerprint !== undefined) lines.push("", fingerprintAnchor(fingerprint));

  return lines.join("\n");
}

/** diff 外的 Finding 没有行级评论承载,正文里的这一块就是它的完整呈现。 */
function fallbackBlock({ finding, fingerprint }: FallbackFinding): string[] {
  const lines = [
    "",
    `\`${finding.file}:${finding.line}\` ${findingHeading(finding)}`,
    ...findingSections(finding),
  ];

  // 这一块同样是本工具的产出,同样要能被下一轮认出来:没有锚点它每轮都会全文重发。
  // 锚点里带上文件路径——正文不像行级评论那样有一个由 API 给出的路径。
  if (fingerprint !== undefined) {
    lines.push("", fingerprintAnchor(fingerprint, finding.file));
  }

  return lines;
}

/** 折叠段里的一条。误匹配时人展开就能看到完整内容,不是只给个条数。 */
function findingLine(finding: MergedFinding): string {
  const title = finding.title === "" ? "" : ` ${finding.title}`;
  return `- \`${finding.file}:${finding.line}\` **[${finding.severity}]${title}** ${finding.description}`;
}

function collapsedSection(summary: string, findings: readonly MergedFinding[]): string[] {
  return [
    "",
    `<details><summary>${summary}</summary>`,
    "",
    ...findings.map(findingLine),
    "",
    "</details>",
  ];
}

/**
 * Reaction 表达的是审查进度,是装饰。发不出去时忍下来——PR 上少一个 emoji 是小事,
 * 一次审查因此白跑不是。缺 `write:issue` 的 bot 令牌走的就是这条路。
 */
async function tryReaction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(
      "[review] reaction 更新失败,审查照常:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** 高的先列,与 `dedupe.ts` 的 SEVERITY_RANK 同序。 */
const SEVERITY_ORDER: readonly Severity[] = ["P0", "P1", "P2"];

/**
 * 首行的概览:本轮 Finding 总数与分级计数,例如 `MultiReviewer:5 条 Finding(P0 3 / P2 2)`。
 *
 * 口径是「本轮结论总数」而非「本轮新增」——行级评论、diff 外的 fallback 与折叠的三类
 * 全算。折叠的那些是本轮仍然成立的问题,读者要判断的是这个 PR 眼下的轻重。三类恰好
 * 覆盖去重合并后的每一条,总数即 `findings.length`。
 *
 * 零 Finding 只在有模型缺席或覆盖不全时才走到这里,写「0 条」会把「没审到」读成「没
 * 问题」,首行因此退回裸标题,缺席由下面那段自己说。
 */
function overviewLine(findings: readonly MergedFinding[]): string {
  if (findings.length === 0) return "MultiReviewer";

  // 为零的档位不列:读者要的是轻重,`P0 0` 只让人多数一个零。
  const counts = SEVERITY_ORDER.map(
    (severity) => [severity, findings.filter((f) => f.severity === severity).length] as const,
  )
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${severity} ${count}`);

  return `MultiReviewer:${findings.length} 条 Finding(${counts.join(" / ")})`;
}

function reviewBody(
  findings: readonly MergedFinding[],
  fallbacks: readonly FallbackFinding[],
  absent: readonly ReviewerOutcome[],
  partial: readonly ReviewerOutcome[],
  carried: readonly CarriedFinding[],
): string {
  const sections: string[] = [overviewLine(findings)];

  // 只写模型名,不贴厂商返回的错误原文。原文对读 PR 的作者没有可行动信息,而它常带
  // endpoint、request id、配额与账号提示——贴进 PR 就是把运维细节发给所有能看这个
  // 仓库的人。完整原因落在库里,从管理面板的评审记录看。
  if (absent.length > 0) {
    sections.push(
      "",
      "以下模型本次缺席,审查覆盖面因此打了折扣(失败原因见管理面板):",
      "",
      ...absent.map((o) => `- ${o.model}`),
    );
  }

  // 与缺席分开呈现:这些模型的 Finding 照常发布了,只是没审完全部文件。
  if (partial.length > 0) {
    sections.push(
      "",
      "以下模型本次覆盖不全,只有部分批次的文件被审查(失败原因见管理面板):",
      "",
      ...partial.map((o) => {
        const coverage = o.incompleteCoverage!;
        const failures = coverage.failures
          .map((f) => `第 ${f.batchIndex} 批`)
          .join("、");
        return `- ${o.model}:共 ${coverage.batchCount} 批,${failures}失败`;
      }),
    );
  }

  if (fallbacks.length > 0) {
    sections.push(
      "",
      "以下 Finding 的行号落在本次 Review Range 的 diff 之外,无法作为行级评论呈现:",
      ...fallbacks.flatMap(fallbackBlock),
    );
  }

  // 旧评论还挂在 PR 上,再发一模一样的一条就是重复打扰,因此两种匹配成功的情形都折叠。
  const resolved = carried.filter((c) => c.resolved).map((c) => c.finding);
  if (resolved.length > 0) {
    sections.push(
      ...collapsedSection(
        `曾被处置、代码未变的 Finding(${resolved.length} 条)`,
        resolved,
      ),
    );
  }

  const unresolved = carried.filter((c) => !c.resolved).map((c) => c.finding);
  if (unresolved.length > 0) {
    sections.push(
      ...collapsedSection(
        `已在上一轮提出,尚未处置的 Finding(${unresolved.length} 条)`,
        unresolved,
      ),
    );
  }

  return sections.join("\n");
}

/** 上一轮某一处 Finding 的已知状态。`fromInline` 标记有没有行级评论作 resolve 的载体。 */
export type PriorDisposition = {
  resolved: boolean;
  /** 至少有一条行级评论承载它。false 即只活在 review 正文里,没有 resolve 状态可读。 */
  fromInline: boolean;
  /** 承载它的那条历史行级评论的 id。本轮匹配上就折叠,记的是这一条,不是新发的。 */
  commentId?: string;
  /** 那条历史评论在 Forge 页面上的地址。 */
  commentHtmlUrl?: string;
};

/**
 * 上一轮由本工具提出的 Finding,按 `文件 + 指纹` 索引到它的 resolve 状态。
 *
 * 两个来源:行级评论,以及本工具历史 review 的正文——diff 外的 Finding 没有行级评论
 * 承载,只活在正文里,不读它这类 Finding 每轮都全文重发。
 *
 * 只认带锚点的那些:带锚点的是本工具发的,人写的评论与 review 正文都不参与匹配。
 * 指纹与文件一起做键,单看指纹会让不同文件里同样的 7 行代码互相误匹配。
 */
export function priorDispositions(
  comments: readonly ExistingReviewComment[],
  bodies: readonly string[],
): Map<string, PriorDisposition> {
  const byKey = new Map<string, PriorDisposition>();
  // 同一处若有多条历史记录,任一条被 resolve 即视为已处置。
  const note = (
    file: string,
    fingerprint: string,
    resolved: boolean,
    comment: ExistingReviewComment | undefined,
  ): void => {
    const key = `${file}\n${fingerprint}`;
    const prior = byKey.get(key) ?? { resolved: false, fromInline: false };
    // 评论标识取先遇到的那一条:同一处的多条历史评论承载的是同一个结论,取哪一条
    // 都指得回 Forge 上的原文,换来换去只会让记录在轮次之间跳。
    const commentId = prior.commentId ?? comment?.id;
    const commentHtmlUrl = prior.commentHtmlUrl ?? comment?.htmlUrl;
    byKey.set(key, {
      resolved: prior.resolved || resolved,
      fromInline: prior.fromInline || comment !== undefined,
      ...(commentId === undefined ? {} : { commentId }),
      ...(commentHtmlUrl === undefined ? {} : { commentHtmlUrl }),
    });
  };

  for (const comment of comments) {
    for (const anchor of parseFingerprintAnchors(comment.body)) {
      // 路径以 API 读回的为准:行级评论的锚点里没有它,有也不该盖过评论自己挂的位置。
      note(comment.path, anchor.fingerprint, comment.resolved, comment);
    }
  }

  for (const body of bodies) {
    for (const anchor of parseFingerprintAnchors(body)) {
      // 正文里的锚点自带路径,没带的定不出「文件 + 指纹」这个键,只能放过。
      if (anchor.file === undefined) continue;
      // 正文没有 resolve 状态可读,一律按未处置计,也没有评论 id 可记。
      note(anchor.file, anchor.fingerprint, false, undefined);
    }
  }

  return byKey;
}

/**
 * 把上一轮读回的状态整理成回填更新(ADR 0006)。行级评论承载的条目带 resolve 状态;
 * 正文锚点没有状态可读,不写 disposition——写了等于把「读不到」伪装成「未处置」。
 * 来源类型两类都带:它顺手把升级前被默认值标成 inline 的历史 fallback 行纠正回
 * body,让它们如 ADR 要求的那样被统计排除。
 */
export function backfillUpdates(
  prior: ReadonlyMap<string, PriorDisposition>,
): DispositionUpdate[] {
  return [...prior].map(([key, entry]) => {
    const [file, fingerprint] = key.split("\n") as [string, string];
    return {
      file,
      fingerprint,
      placement: entry.fromInline ? "inline" : "body",
      ...(entry.fromInline
        ? { disposition: entry.resolved ? ("resolved" as const) : ("unresolved" as const) }
        : {}),
    };
  });
}

/**
 * 行号差在 3 行以内视为指向同一处,容差取值与 `dedupe.ts` 的 LINE_TOLERANCE 相同。
 *
 * 相同的只是容差,判据并不同:这里的内容判据是指纹本身——偏移只移动指纹窗口,窗口内
 * 那 7 行原文对不上就不算命中。`dedupe.ts` 那边没有这样的锚,才在行距容差内另加了一道
 * 标题相似度。改其中一个之前先认清动的是哪一边的语义。
 */
const MATCH_OFFSETS = [0, -1, 1, -2, 2, -3, 3];

/**
 * 在上一轮的锚点里找这条 Finding。
 *
 * 只按本行的指纹查会漏:模型两轮对同一个缺陷可能选不同的代表行(一轮指缺陷行,
 * 一轮指函数头,PR #4 实测差 3 行),指纹窗口随行号平移,精确相等就匹配不上,同一个
 * 问题每轮重发一条。因此按行号偏移 ±3 滑动重算指纹,任一命中即视为同一处——与跨
 * 模型去重的行号容差同一语义。偏移由近及远,先信最贴近模型所指的位置。
 */
function priorMatch(
  prior: ReadonlyMap<string, PriorDisposition>,
  worktreePath: string,
  finding: MergedFinding,
): { key: string; entry: PriorDisposition } | undefined {
  for (const offset of MATCH_OFFSETS) {
    const line = finding.line + offset;
    if (line < 1) continue;
    const fingerprint = contentFingerprint(worktreePath, finding.file, line);
    if (fingerprint === undefined) continue;
    const key = `${finding.file}\n${fingerprint}`;
    const entry = prior.get(key);
    if (entry !== undefined) return { key, entry };
  }
  return undefined;
}

/**
 * 本轮该自动处置的那些上一轮 Finding(ADR 0013)。
 *
 * 三个条件同时成立才算:所指代码已改动(它的指纹在本轮 head 上算不出)、本轮没有
 * 同一处 Finding 再被报出、Forge 上还没有人处置过它。
 *
 * 指纹仍算得出却没再报出的不动:那是模型的波动,不是代码的改动。只活在 review 正文
 * 里的不动:正文没有 resolve 载体,无从写回 Forge。
 */
function autoDisposeCandidates(
  prior: ReadonlyMap<string, PriorDisposition>,
  matched: ReadonlySet<string>,
  worktreePath: string,
): AutoDispositionCandidate[] {
  // 一个文件只算一遍全文指纹:同一个文件里常有好几处 Finding。
  const byFile = new Map<string, Set<string>>();
  const candidates: AutoDispositionCandidate[] = [];

  for (const [key, entry] of prior) {
    if (matched.has(key)) continue;
    if (entry.resolved) continue;
    if (entry.commentId === undefined) continue;
    const [file, fingerprint] = key.split("\n") as [string, string];
    let fingerprints = byFile.get(file);
    if (fingerprints === undefined) {
      fingerprints = fileFingerprints(worktreePath, file);
      byFile.set(file, fingerprints);
    }
    if (fingerprints.has(fingerprint)) continue;
    candidates.push({ file, fingerprint, commentId: entry.commentId });
  }

  return candidates;
}

/**
 * 逐条自动处置:先写 Forge 再落库。Disposition 的权威状态在 Forge 上(ADR 0006),
 * 反过来会留下「库里说已处置、Gitea 上没有」,而下一轮回填还会把它改回去。
 *
 * 单条失败只记日志:少一条自动处置是小事,一次审查因此白跑不是。
 */
async function autoDispose(
  forge: Forge,
  event: PullRequestEvent,
  store: ReturnType<typeof openStore>,
  candidates: readonly AutoDispositionCandidate[],
): Promise<void> {
  const pending = store.pendingAutoDispositions(
    event.owner,
    event.repo,
    event.number,
    candidates,
  );
  for (const candidate of pending) {
    try {
      await forge.resolveComment({ owner: event.owner, repo: event.repo }, candidate.commentId);
    } catch (error) {
      console.error(
        "[review] 「已改动」自动处置写 Forge 失败,这一条留给人处置:",
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }
    store.recordAutoDisposition(
      event.owner,
      event.repo,
      event.number,
      candidate,
      new Date().toISOString(),
    );
  }
}

/** 一条行级评论的身份:同一轮里 `路径 + 行号 + 正文` 三者相同的草稿只有一条。 */
function commentKey(comment: { path: string; line: number; body: string }): string {
  return `${comment.path}\n${comment.line}\n${comment.body}`;
}

/**
 * 把发布回来的评论标识对回本轮的合并组。
 *
 * 平台读不回标识(GitHub 已封存,ADR 0014)时返回空数组,那一轮的 Finding 两项留空。
 */
function commentRefs(
  drafts: readonly ReviewCommentDraft[],
  groups: readonly number[],
  published: readonly PublishedReviewComment[],
): FindingCommentRef[] {
  const byKey = new Map(published.map((comment) => [commentKey(comment), comment]));
  return drafts.flatMap((draft, index) => {
    const comment = byKey.get(commentKey(draft));
    if (comment === undefined) return [];
    return [
      {
        groupIndex: groups[index]!,
        commentId: comment.id,
        commentHtmlUrl: comment.htmlUrl,
      },
    ];
  });
}

/**
 * 一次 Review Run:解析 Review Range、准备工作副本、运行 Reviewer、发布 review 评论。
 */
export async function runReview(
  event: PullRequestEvent,
  deps: ReviewRunDeps,
): Promise<ReviewRunResult> {
  const { forge } = deps;
  const startedAt = new Date();
  const pullRequest = await forge.getPullRequest(event);

  // 挂上「正在审查」。同一个 PR 推了新 commit 会再跑一次,上一轮的结论先作废——
  // 否则新代码还没看,PR 上却还挂着上一版的通过标记。
  await tryReaction(() => forge.removeReaction(event, "+1"));
  await tryReaction(() => forge.addReaction(event, "eyes"));

  const [changedFiles, credentials, priorComments, priorBodies] = await Promise.all([
    forge.listChangedFiles(event),
    forge.cloneCredentials(event),
    forge.listReviewComments(event),
    forge.listReviewBodies(event),
  ]);

  const worktree = await prepareWorktree({
    cacheDir: deps.cacheDir,
    ref: event,
    cloneUrl: pullRequest.cloneUrl,
    credentials,
    headSha: pullRequest.headSha,
    baseSha: pullRequest.baseSha,
  });

  const range = {
    baseSha: worktree.mergeBaseSha,
    headSha: pullRequest.headSha,
    files: changedFiles
      .filter((f) => f.status !== "removed")
      .map((f) => f.path),
  };

  // diff 在 Reviewer 之前读:Review Range 的规模要在开跑之前落库,分批也按它切。
  const diff = await readRangeDiff(
    worktree.path,
    worktree.mergeBaseSha,
    pullRequest.headSha,
  );
  const changedLines = changedLinesByFile(diff);
  const batches = splitIntoBatches(
    range.files,
    changedLines,
    deps.maxChangedLinesPerBatch ?? DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
  );

  // 句柄的存活期覆盖整段审查(最长二十分钟),中途出错必须归还:webhook 服务是长跑
  // 进程,泄漏的连接会一次次攒下来。
  const store = openStore(deps.dbPath);
  const runId = store.startRun({
    owner: event.owner,
    repo: event.repo,
    pullNumber: event.number,
    headSha: pullRequest.headSha,
    startedAt: startedAt.toISOString(),
    triggeredBy: deps.triggeredBy ?? null,
    rangeReviewId: deps.rangeReviewId ?? null,
    changedFiles: range.files.length,
    changedLines: [...changedLines.values()].reduce((sum, n) => sum + n, 0),
    batchCount: batches.length,
    reviewerPins: deps.reviewerPins ?? [],
  });

  try {
    // 批次串行,批内 Reviewer 并行:并行跑批会同时开「批数 × 模型数」个子进程。
    const perBatch: TimedOutcome[][] = [];
    for (const files of batches) {
      perBatch.push(
        await Promise.all(
          deps.reviewers.map(async (reviewer) => {
            const begin = Date.now();
            // 工作副本每批都是同一份完整的 head commit:Reviewer 要能读到其他批次
            // 改动后的代码,否则会报出"这个新函数没有调用者"这类因分批而来的误报。
            const outcome = await reviewer.review({ ...range, files }, worktree.path);
            return { outcome, durationMs: Date.now() - begin };
          }),
        ),
      );
    }
    // 汇总在全部批次跑完之后做一次:一次 Review Run 只发一次 review。
    const timed = deps.reviewers.map((_, index) =>
      mergeBatchOutcomes(perBatch.map((batch) => batch[index]!)),
    );
    const outcomes = timed.map((t) => t.outcome);

    const absent = outcomes.filter((outcome) => outcome.failure !== undefined);
    const partial = outcomes.filter((o) => o.incompleteCoverage !== undefined);
    // 全部失败时零 Finding 不代表代码没问题,发一条空 review 会把失败读成通过。
    const failed = outcomes.length > 0 && absent.length === outcomes.length;

    const findings = dedupeFindings(
      outcomes.filter((o) => o.failure === undefined).flatMap((o) => o.findings),
    );

    const diffRanges = parseDiffRanges(diff);
    const prior = priorDispositions(priorComments, priorBodies);

    // 顺手回写(ADR 0006):这批读回的 resolve 状态本来用完即弃,现在覆盖到这个 PR
    // 名下全部历史 finding 上。以 Forge 最新状态为准——resolve 后又 unresolve,跟着改。
    store.backfillDispositions(event.owner, event.repo, event.number, backfillUpdates(prior));

    const comments: ReviewCommentDraft[] = [];
    // 与 `comments` 同序:每条草稿属于哪个合并组。发布之后按它把评论标识记回去。
    const commentGroups: number[] = [];
    const fallbacks: FallbackFinding[] = [];
    const carried: CarriedFinding[] = [];
    // 按合并组下标记住处置结论、来源类型与组指纹,落库时组内每条来源都取它。
    const dispositions: Disposition[] = [];
    const placements: FindingPlacement[] = [];
    const groupFingerprints: (string | undefined)[] = [];
    // 折叠的那些记历史评论;本轮新发的要等发布之后才有 id,这里先留空。
    const groupComments: (PriorDisposition | undefined)[] = [];
    // 本轮又被报出来的那些历史锚点。自动处置只认没落在这里面的(ADR 0013)。
    const matchedKeys = new Set<string>();

    for (const [groupIndex, finding] of findings.entries()) {
      // 指纹在新 head commit 的工作副本下重算:代码没变则与上一轮的锚点相同。
      const fingerprint = contentFingerprint(worktree.path, finding.file, finding.line);
      groupFingerprints.push(fingerprint);
      const match = priorMatch(prior, worktree.path, finding);

      if (match !== undefined) {
        matchedKeys.add(match.key);
        carried.push({ finding, resolved: match.entry.resolved });
        dispositions.push(match.entry.resolved ? "resolved" : "unresolved");
        // 折叠的这条沿用它历史上的载体:有行级评论即有 resolve 载体,进统计;只活在
        // 正文里的没有,排除(ADR 0006)。
        placements.push(match.entry.fromInline ? "inline" : "body");
        groupComments.push(match.entry);
        continue;
      }

      dispositions.push("unknown");
      groupComments.push(undefined);
      if (isInDiff(diffRanges, finding.file, finding.line)) {
        placements.push("inline");
        comments.push({
          path: finding.file,
          line: finding.line,
          body: findingBody(finding, fingerprint),
        });
        commentGroups.push(groupIndex);
      } else {
        placements.push("body");
        fallbacks.push({ finding, fingerprint });
      }
    }

    // 「已改动」自动处置(ADR 0013),PR 触发与范围审查走的是同一段代码。全部
    // Reviewer 都失败时不做:那种情况下「本轮没再报出」只说明什么都没跑,不是证据。
    if (!failed) {
      const candidates = autoDisposeCandidates(prior, matchedKeys, worktree.path);
      await autoDispose(forge, event, store, candidates);
    }

    const outcomeRecords: OutcomeRecord[] = timed.map(({ outcome, durationMs }) => ({
      model: outcome.model,
      findingCount: outcome.findings.length,
      anomalyCount: outcome.anomalies.length,
      rejectedToolCalls: outcome.rejectedToolCalls,
      anchorRejections: outcome.anchorRejections,
      durationMs,
      ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
      ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
    }));

    // 落库的是每一条来源 Finding 而非合并后的那一条:处置率要按提出它的模型统计。
    // `groupIndex` 记住它们被合并成了同一条评论。指纹取合并组代表行的那一个——评论
    // 锚点埋的就是它,resolve 载体是整组共享的一条评论;按各来源自己的行算指纹,
    // 代表行不同的模型的历史行会永远回填不到,处置率恰好惩罚锚行选偏的模型。
    const findingRecords: FindingRecord[] = findings.flatMap((merged, groupIndex) =>
      merged.sources.map((source) => {
        const fingerprint = groupFingerprints[groupIndex];
        // 匹配上历史评论的记那一条:折叠之后本轮不再发新评论,处置的载体仍是它。
        const comment = groupComments[groupIndex];
        return {
          model: source.model,
          file: source.file,
          line: source.line,
          severity: source.severity,
          category: source.category,
          description: source.description,
          groupIndex,
          disposition: dispositions[groupIndex]!,
          placement: placements[groupIndex]!,
          ...(fingerprint === undefined ? {} : { fingerprint }),
          ...(comment?.commentId === undefined ? {} : { commentId: comment.commentId }),
          ...(comment?.commentHtmlUrl === undefined
            ? {}
            : { commentHtmlUrl: comment.commentHtmlUrl }),
        };
      }),
    );

    // 先落库再发布:发布失败不该把这次 Review Run 的过程记录一并丢掉。
    store.finishRun(runId, {
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      failed,
      outcomes: outcomeRecords,
      findings: findingRecords,
    });

    // 有缺席或覆盖不全的模型时即便零 Finding 也要发:读者需要知道这次审查覆盖面
    // 打了折扣。
    const hasSomethingToSay =
      findings.length > 0 || absent.length > 0 || partial.length > 0;
    if (!failed && hasSomethingToSay) {
      const published = await forge.createReview(event, {
        body: reviewBody(findings, fallbacks, absent, partial, carried),
        commitSha: pullRequest.headSha,
        comments,
      });
      store.recordFindingComments(runId, commentRefs(comments, commentGroups, published));
    }

    // 跑成功却什么都没发现时,这次审查在 PR 上本来一点痕迹都不会留,与「审查根本
    // 没跑」无从区分。这个赞就是那条痕迹。
    if (!failed && !hasSomethingToSay) {
      await tryReaction(() => forge.addReaction(event, "+1"));
    }

    return {
      headSha: pullRequest.headSha,
      findings,
      outcomes,
      failed,
      inlineCount: comments.length,
      fallbackCount: fallbacks.length,
    };
  } finally {
    store.close();
    // 「正在审查」一定要撤掉:成功、失败、中途抛异常都要。留着它 PR 上会永远挂着
    // 一只眼睛,看起来像审查卡死了。
    await tryReaction(() => forge.removeReaction(event, "eyes"));
  }
}
