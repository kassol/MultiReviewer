import type { ReviewRunReviewerPin } from "../config.ts";
import type {
  ExistingReviewComment,
  Forge,
  PublishedReviewComment,
  PullRequestRef,
  ReviewCommentDraft,
} from "../forge/forge.ts";
import {
  pinRunCommits,
  prepareWorktree,
  readLineAuthors,
  readRangeCommits,
  readRangeDiff,
  type LineAuthor,
} from "../git/worktree.ts";
import {
  DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
  DEFAULT_MAX_FILES_PER_BATCH,
  DEFAULT_MAX_PARALLEL_BATCHES,
  mergeBatchOutcomes,
  splitIntoBatches,
  type TimedOutcome,
} from "./batch.ts";
import {
  dedupeFindings,
  mergeByProposal,
  sameContent,
  type FindingAttribution,
  type MergeAgent,
  type MergedFinding,
} from "./dedupe.ts";
import type {
  Category,
  Disposition,
  Finding,
  HistoryFinding,
  ReviewIntent,
  Reviewer,
  ReviewerOutcome,
  ReviewerUsage,
  ProjectFact,
  ReviewRule,
  Severity,
} from "./finding.ts";
import {
  contentFingerprint,
  fileFingerprints,
  fingerprintAnchor,
  parseFingerprintAnchors,
} from "./fingerprint.ts";
import { changedLinesByFile, isInDiff, parseDiffRanges, type DiffRanges } from "./position.ts";
import {
  openStore,
  type ContinuationCandidate,
  type DispositionUpdate,
  type FindingCommentRef,
  type FindingPlacement,
  type FindingRecord,
  type OutcomeRecord,
  type VerdictRecord,
} from "./store.ts";
import {
  beginTrace,
  createTraceRecorder,
  endTrace,
  runChannel,
  type TraceRecorder,
} from "./trace.ts";

export type PullRequestEvent = PullRequestRef;

/**
 * 一轮 Review Run 在首批开始前固定的运行计划。Reviewer 已各自绑定模型运行参数与自家
 * provider 的凭据;批次只复用这份列表与同一个分批上限,不再接触可变配置。
 */
export type ReviewRunPlan = Readonly<{
  reviewers: readonly Reviewer[];
  maxChangedLinesPerBatch: number;
  /** 一批最多多少个文件(issue #230)。与改动行上限双重装箱,任一超限即封箱。 */
  maxFilesPerBatch: number;
  /** 同时在跑的批次数上限(issue #230)。批次受限并行按它开闸(issue #232)。 */
  maxParallelBatches: number;
  reviewerPins: readonly ReviewRunReviewerPin[];
  /** 本轮冻结的知识集版本(issue #204)。仓库还没确认过知识集时为 null。 */
  ruleSetVersion: number | null;
  /** 那一版的生效评审规则全体,按批次路由前的全集。 */
  rules: readonly ReviewRule[];
  /** 那一版的生效项目事实全体(issue #221),同样是路由前的全集。 */
  facts: readonly ProjectFact[];
  /**
   * 本轮的合并 agent(issue #228)。取配置序第一个 Reviewer 的模型快照与凭据建出来,
   * 那一项跑不了(缺凭据或缺运行模型)即缺席,这一轮的合并走算法档。
   */
  mergeAgent?: MergeAgent;
}>;

/** 从启动时的配置快照生成一次运行计划。复制 Reviewer 列表,使组合的后续改动只影响下一轮。 */
export function createReviewRunPlan(
  reviewers: readonly Reviewer[],
  /** 本轮冻结的三项分批上限(issue #230)。三项同形,一起取一起冻。 */
  batchLimits: {
    maxChangedLinesPerBatch: number;
    maxFilesPerBatch: number;
    maxParallelBatches: number;
  },
  reviewerPins: readonly ReviewRunReviewerPin[],
  /**
   * 本轮冻结的知识集(issue #204)。两型一体冻结(issue #221):同一个版本、同一次读取,
   * 与模型服务版本同律,一并在开跑前定死。
   */
  ruleSet: {
    version: number | null;
    rules: readonly ReviewRule[];
    facts?: readonly ProjectFact[];
  } = {
    version: null,
    rules: [],
  },
  /** 本轮的合并 agent(issue #228)。不给即这一轮只有算法合并。 */
  mergeAgent?: MergeAgent,
): ReviewRunPlan {
  return Object.freeze({
    reviewers: Object.freeze([...reviewers]),
    ...batchLimits,
    reviewerPins: Object.freeze([...reviewerPins]),
    ruleSetVersion: ruleSet.version,
    rules: Object.freeze([...ruleSet.rules]),
    facts: Object.freeze([...(ruleSet.facts ?? [])]),
    ...(mergeAgent === undefined ? {} : { mergeAgent }),
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
  /** 一批最多多少个文件(issue #230)。不传取 `DEFAULT_MAX_FILES_PER_BATCH`。 */
  maxFilesPerBatch?: number;
  /** 同时在跑的批次数上限。不传取 `DEFAULT_MAX_PARALLEL_BATCHES`。 */
  maxParallelBatches?: number;
  /** 本轮固定的非秘密模型服务审计快照。 */
  reviewerPins?: readonly ReviewRunReviewerPin[];
  /** 手动重跑的调用者用户名快照;自动投递不传。 */
  triggeredBy?: string;
  /** 这一轮归属的范围审查;PR 触发不传(ADR 0012)。 */
  rangeReviewId?: number;
  /** 本轮冻结的知识集版本(issue #204)。不传即这一轮没有规则可依。 */
  ruleSetVersion?: number | null;
  /** 本轮冻结的那一版规则全体。不传即空知识集,注入与这一票之前逐字一致。 */
  rules?: readonly ReviewRule[];
  /** 本轮冻结的那一版项目事实全体(issue #221)。不传即没有事实可依。 */
  facts?: readonly ProjectFact[];
  /**
   * 本轮指令(CONTEXT.md,issue #225):发起重审时评审方附的一次性要求。不传即没有。
   * 它随这一轮落库、注入这一轮的每个 Reviewer,下一轮由调用方决定要不要再给一次——
   * 编排层不从库里读上一轮的,那正是「只作用于那一轮」的实现。
   */
  directive?: string;
  /**
   * 本轮的合并 agent(issue #228)。不传即这一轮的合并只有算法档,与这一票之前逐字一致;
   * 传了而它失败、超时或分组方案没过验收时同样退回算法档,并在轨迹记一条回退事件。
   */
  mergeAgent?: MergeAgent;
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
};

/** 上一轮已提出、本轮匹配上的 Finding。它不再发行级评论,折进 review 正文。 */
type CarriedFinding = {
  finding: MergedFinding;
  /** 上一轮那条评论是否已被 resolve。 */
  resolved: boolean;
};

/**
 * 评论是给开发者看的最终结果:等级、标题,然后按模型分段的问题、影响、建议。
 *
 * 一条评论承载的是同一处问题的全部说法(ADR 0015):同一轮里几个 Reviewer 报同一处
 * 合成一条,正文每个模型一段并带模型标识,谁都不被丢掉。只有一个模型报出时同样带标识
 * ——同一条 Finding 的评论不该因为这一轮有几个模型认同而换个形状。
 */
/** `**[P0] 标题**`。标题空缺时只留等级,不留空尾巴。 */
function findingHeading(finding: MergedFinding): string {
  return finding.title === ""
    ? `**[${finding.severity}]**`
    : `**[${finding.severity}] ${finding.title}**`;
}

/** 一个模型的一段:模型标识,加它自己的问题 / 影响 / 建议。空段整段跳过。 */
function attributionSection(said: FindingAttribution): string[] {
  const lines = ["", `**${said.model}**`, "", `**问题**:${said.description}`];
  if (said.impact !== "") lines.push("", `**影响**:${said.impact}`);
  if (said.suggestion !== "") lines.push("", `**建议**:${said.suggestion}`);
  return lines;
}

/** 全部归属按首报先后分段。 */
function findingSections(finding: MergedFinding): string[] {
  return finding.attributions.flatMap(attributionSection);
}

/**
 * 延续的那一句(CONTEXT.md 已延续):这条评论承接的是旧位置那条 Finding,不是新提出的
 * 一条。带链接是为了让人一眼跳回去看当初的讨论与处置备注——库里的继承看不见,评论上
 * 这一句是 Forge 那侧唯一能说明「同一个问题换了位置」的地方。
 */
function continuedNote(commentHtmlUrl: string): string {
  return `延续自 [上一处评论](${commentHtmlUrl}):这处代码已改写,复核判定同一个问题仍在。`;
}

function findingBody(
  finding: MergedFinding,
  fingerprint: string | undefined,
  continuedFrom: string | undefined,
): string {
  const lines = [findingHeading(finding), ...findingSections(finding)];

  if (continuedFrom !== undefined) lines.push("", continuedNote(continuedFrom));

  // 锚点是下一轮认出这条评论的唯一凭据,指纹算不出时就没有跨轮次匹配可言。
  if (fingerprint !== undefined) lines.push("", fingerprintAnchor(fingerprint));

  return lines.join("\n");
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
 * 口径是「本轮结论总数」而非「本轮新增」——行级评论与折叠的两类全算。折叠的那些是本轮
 * 仍然成立的问题,读者要判断的是这个 PR 眼下的轻重。两类恰好覆盖去重合并后的每一条,
 * 总数即 `findings.length`。
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
): PriorDisposition | undefined {
  for (const offset of MATCH_OFFSETS) {
    const line = finding.line + offset;
    if (line < 1) continue;
    const fingerprint = contentFingerprint(worktreePath, finding.file, line);
    if (fingerprint === undefined) continue;
    const entry = prior.get(`${finding.file}\n${fingerprint}`);
    if (entry !== undefined) return entry;
  }
  return undefined;
}

/**
 * 复核判已修的那些历史 Finding(ADR 0016)。
 *
 * 一条的最终结论由本轮全部 Reviewer 的结论合成:任一判仍在则仍在,否则全部判已修才
 * 是已修,其余(含无法判断与漏给结论)都是无法判断。三档只有已修驱动自动处置——冲突
 * 时仍在优先,沉默不是证据。
 *
 * 判据不含指纹:代码原样不动的修法(在上游加判空)同样算已修,代码改了而复核判仍在
 * 的不算(ADR 0016 取代 0013)。跑失败的 Reviewer 不在这些结论里,它根本没复核。
 */
function fixedFindingIds(verdicts: readonly VerdictRecord[]): number[] {
  const allFixed = new Map<number, boolean>();
  for (const record of verdicts) {
    allFixed.set(
      record.findingId,
      (allFixed.get(record.findingId) ?? true) && record.verdict === "fixed",
    );
  }
  return [...allFixed].filter(([, fixed]) => fixed).map(([findingId]) => findingId);
}

/**
 * 复核判仍在的那些历史 Finding(ADR 0016)。合成规则与 `fixedFindingIds` 同源:任一
 * Reviewer 判仍在,这条的最终结论就是仍在。它是延续的第一个条件。
 *
 * 升序返回,配对因此不受结论落库顺序影响。
 */
function presentFindingIds(verdicts: readonly VerdictRecord[]): number[] {
  const present = new Set(
    verdicts.filter((record) => record.verdict === "present").map((record) => record.findingId),
  );
  return [...present].sort((a, b) => a - b);
}

/**
 * 复核判仍在时模型一并给出的新位置(issue #170)。行号在子进程里已经过 snippet 锚定
 * 核对,这里只管配对。
 */
type PresentPosition = {
  line: number;
  /** 给出这个位置的模型。据它合成出来的那条 Finding 归属它。 */
  model: string;
  /** 严重度与分类取历史条目自己的:合成出来的是同一条 Finding 换了位置,不是新的一条。 */
  severity: Severity;
  category: Category;
};

/**
 * 每条历史 Finding 的新位置。模型对同一条给出多个位置时取本轮配置顺序里靠前那个模型的
 * ——`deps.reviewers` 的顺序在一轮里固定,结果因此与谁先跑完无关。
 *
 * 只收未处置历史条目上的「仍在」结论:已处置的本来就不要结论,已修与无法判断没有可承接
 * 的位置。失败的 Reviewer 不算,它根本没复核。
 */
function presentPositions(
  history: readonly HistoryFinding[],
  outcomes: readonly ReviewerOutcome[],
): Map<number, PresentPosition> {
  const open = new Map(
    history
      .filter((entry) => entry.disposition === "unresolved" || entry.disposition === "unknown")
      .map((entry) => [entry.id, entry]),
  );
  const positions = new Map<number, PresentPosition>();
  for (const outcome of outcomes) {
    if (outcome.failure !== undefined) continue;
    for (const verdict of outcome.verdicts ?? []) {
      if (verdict.verdict !== "present" || verdict.line === undefined) continue;
      if (positions.has(verdict.findingId)) continue;
      const entry = open.get(verdict.findingId);
      // 升级前的历史行没有严重度与分类,合成不出一条完整的 Finding,这一条只能等重报。
      if (entry?.severity === undefined || entry.category === undefined) continue;
      positions.set(verdict.findingId, {
        line: verdict.line,
        model: outcome.model,
        severity: entry.severity,
        category: entry.category,
      });
    }
  }
  return positions;
}

/**
 * 按历史条目的标题、正文、严重度与分类,在模型给出的新位置合成本轮的一条 Finding
 * (issue #170)。它归属给出这个位置的模型:那个模型确实说了「这个问题此刻在这一行」。
 *
 * 影响与建议留空——旧条目的这两段没有进注入,呈现层本来就跳过空段。
 */
function continuedFinding(
  candidate: ContinuationCandidate,
  position: PresentPosition,
): MergedFinding {
  const said = {
    model: position.model,
    severity: position.severity,
    category: position.category,
    title: candidate.title,
    description: candidate.description,
    impact: "",
    suggestion: "",
  };
  return {
    file: candidate.file,
    line: position.line,
    severity: position.severity,
    category: position.category,
    title: candidate.title,
    description: candidate.description,
    impact: "",
    suggestion: "",
    attributions: [said],
  };
}

/**
 * 本轮的一个合并组:合并后的 Finding、它在本轮 head 上的内容指纹,以及它折叠到的那条
 * 历史评论(没折叠即 undefined)。合并组序号就是它在本轮那个数组里的下标。
 *
 * 三样东西同属一个合并组,就放在同一项里(issue #186):分开成三个平行数组时,合成的
 * 延续要三处同步追加,只要有人在配对与分派之间再插一次数组操作,「延续自」的链接就会挂
 * 到另一条评论上。
 */
type ReviewGroup = {
  finding: MergedFinding;
  fingerprint: string | undefined;
  match: PriorDisposition | undefined;
};

/** 一次延续:旧 Finding 与本轮承接它的那个合并组。 */
type Continuation = {
  candidate: ContinuationCandidate;
  groupIndex: number;
};

/**
 * 配对延续(CONTEXT.md 已延续,issue #167):复核判仍在、旧指纹在本轮 head 上算不出的
 * 那些历史 Finding,交给本轮在新位置报出的一条承接同一个 Identity。
 *
 * 两个条件缺一不可。「仍在」由调用方按复核结论筛过;「代码已改写」的判据是
 * `fileFingerprints`——旧指纹落在这个文件此刻算得出的全部指纹里,那处代码就还在原样,
 * 不论它被上下挪了多少行,这时本轮报出的是另一条,不是同一条换了位置。
 *
 * 「本轮在新位置报出」要同时满足四条:同一个文件、是本轮**新报**的(没有折叠到任何历史
 * 评论上——折叠上的那些自己就是另一条 Identity)、讲的是同一回事(`dedupe.ts` 的
 * `sameContent`,判据与阈值同跨模型去重那一道,不另立一套),且新位置落在 diff 之内。
 * diff 那一道在锚定收敛(issue #224)之后由 Reviewer 与编排层各把过一次,这里再判一次是
 * 兜底:承接一条接不住的新位置等于旧评论被 resolve 掉、问题从此没有载体。内容这一道也不能
 * 省:少了它,
 * 同文件里任意一条无关的新 Finding 都会被拿来承接,旧评论就此 resolve,那条问题从此活在
 * 错的位置上——比不承接更糟。也不给「行号相同」留豁免:跨模型去重那边两个模型读的是同
 * 一份代码,行号相同是硬证据;这里旧位置的代码已经被改写,行号跨轮之间证明不了什么。
 *
 * 三条都过的候选有多个时取行号离旧位置最近的一条;同距取行号小的,再同取合并组序号小
 * 的。三级排序让结果与模型报出的顺序无关,同一份输入永远给同一个答案。行距本身不设
 * 上限——复核已经说了这个问题仍在,内容也对得上,再加一道行距阈值只会让改动大的那些
 * 延续不上。一条新 Finding 至多承接一条旧 Identity——先来的那条(id 小的)拿走它。
 *
 * 本轮一条都没报出、而复核结论自带新位置的(issue #170),按历史条目在那个位置合成一条
 * (`synthesized`,连指纹与「本轮新报」一起作一个合并组,序号接在本轮之后)。合成的那条
 * 同样要过 diff 那一道,理由与上面一样。
 * 「代码已改写」这道判据在合成之前就走完了:旧指纹还算得出就说明那处代码原样还在,
 * 这时模型给的新位置一并忽略,不做假延续。模型自己重报了同内容的一条时上面那一步已经挑
 * 中它,不再合成——重报的那条带着模型本轮的措辞,比抄旧正文更贴近现在的代码。
 */
function planContinuations(
  candidates: readonly ContinuationCandidate[],
  groups: readonly ReviewGroup[],
  diffRanges: DiffRanges,
  worktreePath: string,
  positions: ReadonlyMap<number, PresentPosition>,
): { plans: Continuation[]; synthesized: ReviewGroup[] } {
  const byFile = new Map<string, Set<string>>();
  const claimed = new Set<number>();
  const plans: Continuation[] = [];
  const synthesized: ReviewGroup[] = [];

  for (const candidate of candidates) {
    let fingerprints = byFile.get(candidate.file);
    if (fingerprints === undefined) {
      fingerprints = fileFingerprints(worktreePath, candidate.file);
      byFile.set(candidate.file, fingerprints);
    }
    if (fingerprints.has(candidate.fingerprint)) continue;

    const pick = groups
      .flatMap(({ finding, match }, groupIndex) =>
        match !== undefined ||
        claimed.has(groupIndex) ||
        finding.file !== candidate.file ||
        !isInDiff(diffRanges, finding.file, finding.line) ||
        !sameContent(candidate, finding)
          ? []
          : [{ finding, groupIndex }],
      )
      .sort(
        (a, b) =>
          Math.abs(a.finding.line - candidate.line) -
            Math.abs(b.finding.line - candidate.line) ||
          a.finding.line - b.finding.line ||
          a.groupIndex - b.groupIndex,
      )[0];
    if (pick === undefined) {
      const position = positions.get(candidate.findingId);
      if (position === undefined) continue;
      if (!isInDiff(diffRanges, candidate.file, position.line)) continue;
      const finding = continuedFinding(candidate, position);
      plans.push({
        candidate,
        groupIndex: groups.length + synthesized.length,
      });
      synthesized.push({
        finding,
        fingerprint: contentFingerprint(worktreePath, finding.file, finding.line),
        // 它是本轮新报的一条,不折叠到任何历史评论上。
        match: undefined,
      });
      continue;
    }

    claimed.add(pick.groupIndex);
    plans.push({ candidate, groupIndex: pick.groupIndex });
  }

  return { plans, synthesized };
}

/**
 * 把配好的延续写到 Forge 上:旧评论 resolve。写在建评论正文之前——新评论里那句「延续
 * 自」得是真的,resolve 没成就不该说这话。单条失败只记日志并放弃这一条延续:旧行留在
 * 未处置,本轮那条按新 Finding 正常提出,少一次位置交接不该让整轮审查白跑。
 */
async function applyContinuations(
  forge: Forge,
  event: PullRequestEvent,
  plans: readonly Continuation[],
): Promise<Continuation[]> {
  const applied: Continuation[] = [];
  for (const plan of plans) {
    try {
      await forge.resolveComment(
        { owner: event.owner, repo: event.repo },
        plan.candidate.commentId,
      );
    } catch (error) {
      console.error(
        "[review] 「已延续」的旧评论 resolve 失败,这一条不延续:",
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }
    applied.push(plan);
  }
  return applied;
}

/** 要判行作者的一处位置:在哪个 revision 上、哪个文件的哪一行。 */
export type LineAuthorQuery = {
  /** 判定所依据的 commit,即这条 Finding 所属那一轮的 head。 */
  revision: string;
  file: string;
  line: number;
};

/**
 * 逐条判行作者(CONTEXT.md),与传入的顺序一一对应,判不出来的那些是 undefined。
 *
 * 每轮按自己的 head 判,不沿用上一轮:延续过来的 Finding 行号已经漂移,抄上一轮的
 * 结果会把这一行记到别人头上。因此按「revision + 文件」分组,一组合成一次
 * `git blame`——逐条起一个 git 进程的话,一轮几十条 Finding 就是几十次进程启动。
 *
 * 判定失败只记日志、留空:行作者是给人看的归属信息,取不到不该让整轮审查白跑。失败以
 * 组为单位,那一组的这几条一起留空,下次读取时在阶段汇总里再补(issue #199)。
 */
export async function findingLineAuthors(
  repoPath: string,
  queries: readonly LineAuthorQuery[],
): Promise<(LineAuthor | undefined)[]> {
  const byRevisionAndFile = new Map<string, number[]>();
  for (const [index, query] of queries.entries()) {
    const key = `${query.revision}\n${query.file}`;
    const indexes = byRevisionAndFile.get(key);
    if (indexes === undefined) byRevisionAndFile.set(key, [index]);
    else indexes.push(index);
  }
  const authors: (LineAuthor | undefined)[] = queries.map(() => undefined);
  for (const indexes of byRevisionAndFile.values()) {
    const first = queries[indexes[0]!]!;
    try {
      const found = await readLineAuthors(
        repoPath,
        first.revision,
        first.file,
        indexes.map((index) => queries[index]!.line),
      );
      for (const index of indexes) authors[index] = found.get(queries[index]!.line);
    } catch (error) {
      console.error(
        `[review] ${first.file} 在 ${first.revision} 上的行作者判定失败,这几条留空:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return authors;
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
  findingIds: readonly number[],
): Promise<void> {
  const pending = store.pendingAutoDispositions(findingIds);
  for (const candidate of pending) {
    try {
      await forge.resolveComment({ owner: event.owner, repo: event.repo }, candidate.commentId);
    } catch (error) {
      console.error(
        "[review] 「已修复」自动处置写 Forge 失败,这一条留给人处置:",
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

/**
 * 本轮各 Reviewer 的复核结论,逐条落库(ADR 0016)。
 *
 * 只对未处置的历史条目要结论——已处置的注入只是背景。漏给结论的按「无法判断」照样
 * 落一行并标 `missing`:沉默不是证据,而「这个模型压根没复核」得数得出来。失败的
 * Reviewer 不记:那不是漏复核,是它根本没跑。这批记录同时是自动处置的裁决输入。
 */
function verdictRecords(
  history: readonly HistoryFinding[],
  outcomes: readonly ReviewerOutcome[],
): VerdictRecord[] {
  const open = history.filter(
    (entry) => entry.disposition === "unresolved" || entry.disposition === "unknown",
  );
  if (open.length === 0) return [];

  return outcomes
    .filter((outcome) => outcome.failure === undefined)
    .flatMap((outcome) => {
      // 编出来的 id 不在本轮注入的历史里,不落库:它对应不到任何一条 Finding。
      const given = new Map((outcome.verdicts ?? []).map((v) => [v.findingId, v.verdict]));
      return open.map((entry) => {
        const verdict = given.get(entry.id);
        return {
          model: outcome.model,
          findingId: entry.id,
          verdict: verdict ?? ("unclear" as const),
          missing: verdict === undefined,
        };
      });
    });
}

/**
 * 每个 Reviewer 跑完之后的收尾事件(issue #171):失败的记失败原因与退出码,跑完的记
 * Finding 条数、两种被拒次数与用量。
 *
 * 记在全部批次合并之后:一个 Reviewer 一轮只有一条收尾,分批是它的内部构造。
 */
function recordReviewerOutcomes(
  trace: TraceRecorder,
  outcomes: readonly ReviewerOutcome[],
): void {
  for (const outcome of outcomes) {
    if (outcome.failure !== undefined) {
      trace.reviewer(outcome.model, "reviewer_failed", {
        failure: outcome.failure,
        exitCode: outcome.exitCode ?? null,
      });
      continue;
    }
    trace.reviewer(outcome.model, "reviewer_finished", {
      findings: outcome.findings.length,
      rejectedToolCalls: outcome.rejectedToolCalls,
      anchorRejections: outcome.anchorRejections,
      usage: outcome.usage ?? null,
    });
  }
}

/**
 * 每一组真的合并过的 Finding 一条事件(issue #171 的用户故事 9):成员来自哪个
 * Reviewer、各自的行号与标题,以及这一组的合并判据。
 *
 * 没有合并的组不发事件——一条 Finding 一个组是常态,给它们各发一条只会把轨迹淹掉。
 */
function recordFindingMerges(
  trace: TraceRecorder,
  findings: readonly MergedFinding[],
): void {
  for (const finding of findings) {
    const merge = finding.merge;
    if (merge === undefined) continue;
    trace.run("finding_merged", {
      file: finding.file,
      line: finding.line,
      members: merge.members.map((member) => ({
        reviewer: member.model,
        line: member.line,
        title: member.title,
      })),
      // 判据整个作一个对象:`same_line` 那一档没有数可给,`distance` 那一档带行距与
      // 相似度(0 到 1 的 Jaccard 原值,面板自己换算成百分比)。
      criteria: merge.criterion,
    });
  }
}

/**
 * 合并 agent 的会话事件在轨迹里占的名字(issue #228)。它不是 Reviewer,因此不用模型
 * 标识——用模型标识会与配置序第一个 Reviewer 撞名,两边的过程就混进同一个块里。
 */
export const MERGE_AGENT_TRACE_NAME = "合并 agent";

/**
 * 本轮的去重合并(issue #228)。有合并 agent 时由它给分组方案,代码验收三条硬性质;
 * 没有它、它失败、它超时或方案没过验收,一律整体退回 `dedupeFindings`——最坏情况恒等于
 * 算法档的行为,一次辅助判断的故障不该让整轮审查白跑。
 *
 * 不足两条时不派:一条 Finding 分不出组,派出去只是白花一次子进程与一份 token。
 */
async function mergeFindings(
  trace: TraceRecorder,
  agent: MergeAgent | undefined,
  findings: readonly Finding[],
  worktreePath: string,
): Promise<{ merged: MergedFinding[]; usage?: ReviewerUsage }> {
  if (agent === undefined || findings.length < 2) return { merged: dedupeFindings(findings) };

  const fallback = (reason: string, usage?: ReviewerUsage) => {
    trace.run("merge_fallback", { reason });
    return { merged: dedupeFindings(findings), ...(usage === undefined ? {} : { usage }) };
  };

  let result;
  try {
    result = await agent({
      findings,
      worktreePath,
      onEvent: (event) => {
        const { kind, ...payload } = event;
        trace.reviewer(MERGE_AGENT_TRACE_NAME, kind, payload);
      },
    });
  } catch (error) {
    // 注入边界上的实现抛异常也只是这一次合并没跑成,不该掀掉整轮审查。
    return fallback(error instanceof Error ? error.message : String(error));
  }

  trace.run("merge_agent_finished", {
    groups: result.groups.length,
    usage: result.usage ?? null,
  });
  if (result.failure !== undefined) return fallback(result.failure, result.usage);

  // 验收自身抛异常也走回退:「最坏情况恒等于今天」这条承诺不允许任何一条路径把
  // 整轮审查掀掉,哪怕是验收代码自己的缺陷。
  let outcome;
  try {
    outcome = mergeByProposal(findings, result.groups);
  } catch (error) {
    return fallback(error instanceof Error ? error.message : String(error), result.usage);
  }
  if ("rejected" in outcome) return fallback(outcome.rejected, result.usage);
  return { merged: outcome.merged, ...(result.usage === undefined ? {} : { usage: result.usage }) };
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
 * 意图上下文的两道截断(issue #201)。正文保头部:作者把这次改动要做什么写在开头,
 * 越往后越是复现步骤与截图。commit 列表保最新的几条:早期那些多半已被后来的改写覆盖。
 * 两个阈值都取整,超出的部分对判断规格保真度的边际价值远低于它占掉的上下文。
 */
export const INTENT_BODY_CHARS = 4000;
export const INTENT_COMMIT_LIMIT = 30;

/**
 * 这一轮声称要做的事(issue #201)。
 *
 * commit 列表读本地 clone,读不出来只记日志、给一份没有 commit 的意图:少一份意图
 * 上下文是小事,一次审查因此白跑不是。
 */
async function readIntent(
  worktreePath: string,
  range: { baseSha: string; headSha: string },
  source: { title: string; body?: string },
): Promise<ReviewIntent> {
  let all: string[] = [];
  try {
    all = await readRangeCommits(worktreePath, range.baseSha, range.headSha);
  } catch (error) {
    console.error(
      "[review] 读这一轮的 commit 列表失败,审查照常:",
      error instanceof Error ? error.message : String(error),
    );
  }
  const body =
    source.body !== undefined && source.body.length > INTENT_BODY_CHARS
      ? `${source.body.slice(0, INTENT_BODY_CHARS)}…`
      : source.body;
  return {
    title: source.title,
    ...(body === undefined || body === "" ? {} : { body }),
    commits: all.slice(0, INTENT_COMMIT_LIMIT),
    omittedCommits: Math.max(0, all.length - INTENT_COMMIT_LIMIT),
  };
}

/**
 * 作用范围的 glob 编译成正则。语义只有两个通配符,面板侧将来按同一套解释:
 *
 * - `*` 匹配一段路径内的任意字符,不跨目录分隔符;
 * - `**` 匹配任意层目录,后面紧跟目录分隔符时那一层可以为零层。写作
 *   `src/`+`**`+`/*.ts` 的规则因此也命中 `src/a.ts`——不这样处理的话最常见的那种
 *   写法反而漏掉直接子文件。
 *
 * 其余字符一律按字面量,正则元字符先转义:作用范围是人手写的路径,不是正则。
 */
function scopePattern(scope: string): RegExp {
  let source = "";
  for (let index = 0; index < scope.length; ) {
    const char = scope[index]!;
    if (char !== "*") {
      source += char.replace(/[.*+?^${}()|[\]\\]/, "\\$&");
      index += 1;
      continue;
    }
    if (scope[index + 1] !== "*") {
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (scope[index + 2] === "/") {
      source += "(?:.*/)?";
      index += 3;
      continue;
    }
    source += ".*";
    index += 2;
  }
  return new RegExp(`^${source}$`);
}

/**
 * 这一批要注入的知识条目(issue #204、#221):作用范围命中该批任一文件的,加上全仓库
 * 条目。评审规则与项目事实各调一次,两型同一条路由口径。
 *
 * 全仓库条目不看文件:空作用范围就是「这个仓库的每一处都算」,末批为空文件集时同样给。
 * 保持传入顺序,条目在各批之间的呈现次序因此稳定。
 */
export function knowledgeForBatch<T extends { scope: string }>(
  entries: readonly T[],
  files: readonly string[],
): readonly T[] {
  return entries.filter((entry) => {
    if (entry.scope === "") return true;
    const pattern = scopePattern(entry.scope);
    return files.some((file) => pattern.test(file));
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

  // 这份工作树只属于这一轮,读完就删:同一个仓库上并发的另一轮、一次重探索或一次
  // 处置反哺各有各的一份,谁都不会把别人正在读的文件换掉(issue #212)。
  try {
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
    // 可评论行区间在 Reviewer 之前算好:它随请求交给每个 Reviewer 做锚定校验(issue #224),
    // 编排层收结论时再用同一份判一次。
    const diffRanges = parseDiffRanges(diff);
    const batches = splitIntoBatches(
      range.files,
      changedLines,
      deps.maxChangedLinesPerBatch ?? DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
      deps.maxFilesPerBatch ?? DEFAULT_MAX_FILES_PER_BATCH,
    );

    // 句柄的存活期覆盖整段审查(时长没有总上限,兜底的是子进程那道连续静默闸,
    // 见 `reviewer/subprocess.ts`),中途出错必须归还:webhook 服务是长跑进程,
    // 泄漏的连接会一次次攒下来。
    const store = openStore(deps.dbPath);
    const runId = store.startRun({
      owner: event.owner,
      repo: event.repo,
      pullNumber: event.number,
      headSha: pullRequest.headSha,
      // 范围审查那一档不记标题:这里读到的是容器 PR 的标题,由本工具自己拼出,
      // 那个阶段的名字来自范围审查自身(issue #173)。
      title: deps.rangeReviewId === undefined ? pullRequest.title : null,
      startedAt: startedAt.toISOString(),
      triggeredBy: deps.triggeredBy ?? null,
      rangeReviewId: deps.rangeReviewId ?? null,
      changedFiles: range.files.length,
      changedLines: [...changedLines.values()].reduce((sum, n) => sum + n, 0),
      batchCount: batches.length,
      reviewerPins: deps.reviewerPins ?? [],
      // 知识集版本在这里定死(issue #204):这一轮之后的规则变更追不上已经开跑的它,
      // 回看历史轮次时也就知道当时按的是哪一版。
      ruleSetVersion: deps.ruleSetVersion ?? null,
      // 本轮指令随这一轮落库(issue #225):轮次详情要能回答「那一轮是按什么要求跑的」。
      directive: deps.directive ?? null,
    });

    // 一有 runId 就可以接受订阅(ADR 0017):面板打开进行中的轮次时要能接上实时推送,
    // 而第一条编排事件紧接着就发出来了。
    beginTrace(runChannel(runId));
    const trace = createTraceRecorder(store, runId);

    try {
      // 工作副本在 startRun 之前就备好了,轨迹的第一条因此是它——面板据此知道这一轮
      // 审的是哪两端(issue #171 的用户故事 1)。
      trace.run("worktree_ready", {
        baseSha: worktree.mergeBaseSha,
        headSha: pullRequest.headSha,
      });

      // 两端一有 runId 就钉在本地 clone 上(issue #161):这一轮结束后远端的分支会被删,
      // 不钉住的话 gc 一跑,这一轮的 diff 就再也打不开。
      // 钉不住只记日志:少一轮历史 diff 是小事,一次审查因此白跑不是。
      try {
        await pinRunCommits(worktree.path, runId, {
          baseSha: pullRequest.baseSha,
          headSha: pullRequest.headSha,
        });
      } catch (error) {
        console.error(
          "[review] 钉住这一轮的两端失败,审查照常:",
          error instanceof Error ? error.message : String(error),
        );
      }

      // 本阶段已经报过的 Finding,注入给这一轮的每个 Reviewer(ADR 0016)。读在开跑之前:
      // 本轮自己的 Finding 还没落库,这份历史因此正是「上一轮为止」的那些。
      const history = store.stageHistory(
        deps.rangeReviewId === undefined
          ? { owner: event.owner, repo: event.repo, pullNumber: event.number }
          : { rangeReviewId: deps.rangeReviewId },
      );

      // 这一轮声称要做的事(issue #201)。范围审查的标题来自它自己,不是容器 PR 的标题
      // ——那个标题与正文都由本工具拼出(`range-review.ts`),不含任何作者意图。
      const rangeReview =
        deps.rangeReviewId === undefined ? undefined : store.getRangeReview(deps.rangeReviewId);
      const intent = await readIntent(
        worktree.path,
        { baseSha: worktree.mergeBaseSha, headSha: pullRequest.headSha },
        deps.rangeReviewId === undefined
          ? {
              title: pullRequest.title,
              ...(pullRequest.body === undefined ? {} : { body: pullRequest.body }),
            }
          : { title: rangeReview?.title ?? "" },
      );

      // 跑一批:批内的 Reviewer 全部并行。
      const runBatch = async (index: number): Promise<TimedOutcome[]> => {
        const files = batches[index]!;
        // 批次序号从 1 起,直接呈现给看轨迹的人,与 `incompleteCoverage` 同一口径。
        const batch = { index: index + 1, total: batches.length, files };
        // 知识条目按作用范围路由到批次(issue #204):只管某个目录的条目不进不含那个
        // 目录的批次,批内每个 Reviewer 拿到的是同一份。两型同一条口径(issue #221)。
        const rules = knowledgeForBatch(deps.rules ?? [], files);
        const facts = knowledgeForBatch(deps.facts ?? [], files);
        trace.run("batch_started", batch);
        const timedOutcomes = await Promise.all(
          deps.reviewers.map(async (reviewer) => {
            const startedAt = Date.now();
            // 工作副本每批都是同一份完整的 head commit:Reviewer 要能读到其他批次
            // 改动后的代码,否则会报出"这个新函数没有调用者"这类因分批而来的误报。
            // 历史每批都给同一份:它说的是这个阶段的历史,与本批审哪些文件无关。
            const outcome = await reviewer.review({
              range: { ...range, files },
              worktreePath: worktree.path,
              // 可评论行区间给整个 Review Range 的那一份,不按批次裁剪(issue #224)。
              commentable: diffRanges,
              history,
              intent,
              rules,
              facts,
              // 本轮指令每批都给同一份:它说的是这一轮的要求,与本批审哪些文件无关。
              ...(deps.directive === undefined ? {} : { directive: deps.directive }),
              onEvent: (event) => {
                const { kind, ...payload } = event;
                // 事件带上批次序号(issue #232):批次并行之后同一个模型几批的事件在
                // 轨迹里交错到达,不标批次就读不出哪条属于哪一批。
                trace.reviewer(reviewer.model, kind, { ...payload, batch: batch.index });
              },
            });
            return { outcome, startedAt, durationMs: Date.now() - startedAt };
          }),
        );
        trace.run("batch_finished", batch);
        return timedOutcomes;
      };

      // 批次受限并行(issue #232):开「并发上限」条取号线,每条取下一个还没跑的批次,
      // 跑完再取下一个。不设闸会一次开满「批数 × 模型数」个子进程,对宿主机不友好。
      // 结果按批次序号写回,与各批的完成顺序无关——汇总、失败记第几批与复核结论谁作数
      // 都按序号,不按谁先回。
      const perBatch: TimedOutcome[][] = [];
      let nextBatch = 0;
      const parallel = Math.min(
        deps.maxParallelBatches ?? DEFAULT_MAX_PARALLEL_BATCHES,
        batches.length,
      );
      await Promise.all(
        Array.from({ length: parallel }, async () => {
          while (nextBatch < batches.length) {
            const index = nextBatch++;
            perBatch[index] = await runBatch(index);
          }
        }),
      );
      // 汇总在全部批次跑完之后做一次:一次 Review Run 只发一次 review。
      const timed = deps.reviewers.map((_, index) =>
        mergeBatchOutcomes(perBatch.map((batch) => batch[index]!)),
      );
      const outcomes = timed.map((t) => t.outcome);

      const absent = outcomes.filter((outcome) => outcome.failure !== undefined);
      const partial = outcomes.filter((o) => o.incompleteCoverage !== undefined);
      // 全部失败时零 Finding 不代表代码没问题,发一条空 review 会把失败读成通过。
      const failed = outcomes.length > 0 && absent.length === outcomes.length;

      recordReviewerOutcomes(trace, outcomes);

      // 锚定收敛的最后一道(issue #224):落点不在本轮 diff 里的丢弃,轨迹留一条被拒记录。
      // Reviewer 那侧已经打回过一次并请模型重锚,到这里还在外面的就是重锚也没锚进的那些。
      // 丢弃而不是退化进 review 正文:正文里的条目没有 resolve 载体,不进处置率,只会攒成
      // 没人处置的暗债(ADR 0006 的 2026-08-31 修订附记)。
      // 合并每轮做一次,在全部批次跑完之后(issue #228);diff 终筛仍排在合并之后。
      const { merged: allMerged, usage: mergeUsage } = await mergeFindings(
        trace,
        deps.mergeAgent,
        outcomes.filter((o) => o.failure === undefined).flatMap((o) => o.findings),
        worktree.path,
      );
      const merged = allMerged.filter((finding) => {
        if (isInDiff(diffRanges, finding.file, finding.line)) return true;
        trace.run("finding_discarded", {
          file: finding.file,
          line: finding.line,
          title: finding.title,
          reviewers: finding.attributions.map((said) => said.model),
        });
        return false;
      });
      recordFindingMerges(trace, merged);

      const prior = priorDispositions(priorComments, priorBodies);

      // 顺手回写(ADR 0006):这批读回的 resolve 状态本来用完即弃,现在覆盖到这个 PR
      // 名下全部历史 finding 上。以 Forge 最新状态为准——resolve 后又 unresolve,跟着改。
      store.backfillDispositions(event.owner, event.repo, event.number, backfillUpdates(prior));

      // 本轮的合并组:Finding、它的指纹与它折叠到的历史评论同属一项(issue #186)。指纹在
      // 新 head commit 的工作副本下重算,代码没变则与上一轮的锚点相同;跨轮匹配整批先算出
      // 来——延续要在建评论正文之前知道哪些是本轮新报的。
      const groups: ReviewGroup[] = merged.map((finding) => ({
        finding,
        fingerprint: contentFingerprint(worktree.path, finding.file, finding.line),
        match: priorMatch(prior, worktree.path, finding),
      }));

      // 本轮的复核结论。裁决与落库用同一批记录,面板上看到的与自动处置依据的是同一件事。
      const verdicts = verdictRecords(history, outcomes);

      // 「已修复」自动处置(ADR 0016),PR 触发与范围审查走的是同一段代码。全部 Reviewer
      // 都失败时不做:那一轮一条结论都没有,没有证据就不动。延续同理。
      if (!failed) {
        await autoDispose(forge, event, store, fixedFindingIds(verdicts));
      }

      // 复核判仍在、旧指纹在本轮 head 上算不出的那些,由本轮在新位置报出的一条承接同一条
      // Finding Identity(CONTEXT.md 已延续,issue #167)。旧评论在这里就被 resolve 掉,
      // 新评论的正文随后带上它的链接;落库要等本轮的行插进去之后。
      // 模型只回了复核结论、没有重报的那些,按它给出的新位置合成本轮的一条(issue #170)。
      // 合成的连指纹与跨轮匹配一起作一个合并组,接在本轮之后——只追加这一处。
      const plan = failed
        ? { plans: [], synthesized: [] }
        : planContinuations(
            store.continuationCandidates(presentFindingIds(verdicts)),
            groups,
            diffRanges,
            worktree.path,
            presentPositions(history, outcomes),
          );
      groups.push(...plan.synthesized);
      const continuations = failed ? [] : await applyContinuations(forge, event, plan.plans);
      const continuedFrom = new Map(
        continuations.map((plan) => [plan.groupIndex, plan.candidate.commentHtmlUrl]),
      );

      const comments: ReviewCommentDraft[] = [];
      // 与 `comments` 同序:每条草稿属于哪个合并组。发布之后按它把评论标识记回去。
      const commentGroups: number[] = [];
      const carried: CarriedFinding[] = [];
      // 按合并组下标记住处置结论与来源类型,落库时组内每条来源都取它。
      const dispositions: Disposition[] = [];
      const placements: FindingPlacement[] = [];
      // 折叠的那些记历史评论;本轮新发的要等发布之后才有 id,这里先留空。
      const groupComments: (PriorDisposition | undefined)[] = [];

      for (const [groupIndex, { finding, fingerprint, match }] of groups.entries()) {
        if (match !== undefined) {
          carried.push({ finding, resolved: match.resolved });
          dispositions.push(match.resolved ? "resolved" : "unresolved");
          // 折叠的这条沿用它历史上的载体:有行级评论即有 resolve 载体,进统计;只活在
          // 正文里的没有,排除(ADR 0006)。
          placements.push(match.fromInline ? "inline" : "body");
          groupComments.push(match);
          continue;
        }

        dispositions.push("unknown");
        groupComments.push(undefined);
        // 本轮新报的一律是行级评论:锚定收敛之后落点必在 diff 内(issue #224)。
        placements.push("inline");
        comments.push({
          path: finding.file,
          line: finding.line,
          body: findingBody(finding, fingerprint, continuedFrom.get(groupIndex)),
        });
        commentGroups.push(groupIndex);
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

      // 行作者(CONTEXT.md)在本轮 head 上判定,与 Finding 一起落库:统计不该依赖有人
      // 打开过侧滑。
      const lineAuthors = await findingLineAuthors(
        worktree.path,
        groups.map((group) => ({
          revision: pullRequest.headSha,
          file: group.finding.file,
          line: group.finding.line,
        })),
      );

      // 一条 Finding 一行,报出它的每个模型一条归属(ADR 0015):Finding Identity 不含
      // 模型,同一处问题不论几个模型报出都是同一条。指纹取合并组代表行的那一个——评论
      // 锚点埋的就是它,resolve 载体是整组共享的一条评论。
      const findingRecords: FindingRecord[] = groups.map(({ finding, fingerprint }, groupIndex) => {
        // 匹配上历史评论的记那一条:折叠之后本轮不再发新评论,处置的载体仍是它。
        const comment = groupComments[groupIndex];
        return {
          file: finding.file,
          line: finding.line,
          title: finding.title,
          severity: finding.severity,
          category: finding.category,
          description: finding.description,
          attributions: finding.attributions.map((said) => ({
            model: said.model,
            severity: said.severity,
            category: said.category,
            description: said.description,
          })),
          groupIndex,
          disposition: dispositions[groupIndex]!,
          placement: placements[groupIndex]!,
          ...(fingerprint === undefined ? {} : { fingerprint }),
          ...(comment?.commentId === undefined ? {} : { commentId: comment.commentId }),
          ...(comment?.commentHtmlUrl === undefined
            ? {}
            : { commentHtmlUrl: comment.commentHtmlUrl }),
          ...(lineAuthors[groupIndex] === undefined
            ? {}
            : { lineAuthor: lineAuthors[groupIndex] }),
          // 命中规则只落库(issue #204):不进指纹、不进评论正文,合并组取组内首个自报的。
          ...(finding.ruleId === undefined ? {} : { ruleId: finding.ruleId }),
        };
      });

      // 先落库再发布:发布失败不该把这次 Review Run 的过程记录一并丢掉。
      store.finishRun(runId, {
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        failed,
        outcomes: outcomeRecords,
        findings: findingRecords,
        verdicts,
        // 合并 agent 的用量进本轮总量,不并进任何一个 Reviewer(issue #228)。
        ...(mergeUsage === undefined ? {} : { mergeUsage }),
      });

      // 延续落库要等本轮的行插进去:旧行的备注、处置人与处置时刻随 Identity 抄到承接它的
      // 那一行上,旧行改记「已延续」。
      for (const plan of continuations) {
        store.recordContinuation({
          owner: event.owner,
          repo: event.repo,
          pullNumber: event.number,
          runId,
          groupIndex: plan.groupIndex,
          candidate: plan.candidate,
        });
      }

      // review 正文、计数与返回值只关心每个合并组的那条 Finding。
      const findings = groups.map((group) => group.finding);

      // 有缺席或覆盖不全的模型时即便零 Finding 也要发:读者需要知道这次审查覆盖面
      // 打了折扣。
      const hasSomethingToSay =
        findings.length > 0 || absent.length > 0 || partial.length > 0;
      if (!failed && hasSomethingToSay) {
        const published = await forge.createReview(event, {
          body: reviewBody(findings, absent, partial, carried),
          commitSha: pullRequest.headSha,
          comments,
        });
        store.recordFindingComments(runId, commentRefs(comments, commentGroups, published));
        trace.run("review_posted", { findingCount: findings.length });
      }

      // 跑成功却什么都没发现时,这次审查在 PR 上本来一点痕迹都不会留,与「审查根本
      // 没跑」无从区分。这个赞就是那条痕迹。
      if (!failed && !hasSomethingToSay) {
        await tryReaction(() => forge.addReaction(event, "+1"));
      }

      trace.run("run_finished", { failed, findingCount: findings.length });

      return {
        headSha: pullRequest.headSha,
        findings,
        outcomes,
        failed,
        inlineCount: comments.length,
      };
    } finally {
      // 订阅者一定要收到结束信号:成功、失败、中途抛异常都要,否则页面会一直等下去。
      // 抛异常那一档没有 `run_finished` 落库——这一轮确实没跑完,轨迹照实停在崩溃前。
      endTrace(runChannel(runId));
      store.close();
      // 「正在审查」一定要撤掉:成功、失败、中途抛异常都要。留着它 PR 上会永远挂着
      // 一只眼睛,看起来像审查卡死了。
      await tryReaction(() => forge.removeReaction(event, "eyes"));
    }
  } finally {
    await worktree.release();
  }
}
