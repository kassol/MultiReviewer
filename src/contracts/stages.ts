/**
 * 阶段列表(`GET /stages`)与阶段详情(`GET /stages/{stageId}`)的响应契约(issue #426)。
 *
 * 服务端的投影与面板读的是**同一个符号**:此前两边各手抄一份,而 `fetchJson<T>` 是断言
 * 不是校验,任一侧漏一格都没人报错(`missedVerdicts` 服务端一直在回、面板从来没声明过)。
 * 服务端加一格面板照常编译(多一格无害),服务端删一格或改类型时面板当场报错。
 *
 * **这个文件只有类型**:一行运行时代码都不许有(`node:*`、store、Pi 一个都不引)。面板是
 * 独立的包,从 `store/` 引类型会把 `pg` 拖进前端的类型检查;放在这里两边都引得
 * 动。后续端点的契约迁过来就是在 `src/contracts/` 下新开一个同形的文件。
 */

/**
 * 一轮 Review Run 的模式(CONTEXT.md 只复核,issue #242)。
 *
 * `full` 是完整审查:照常报出新问题,顺带复核历史。`verdict-only` 是只复核:这一轮只对
 * 有未处置历史的文件跑,Reviewer 不注册报出工具,只能给复核结论——清历史与找新问题是
 * 两个目标,整段范围每重跑一轮就多几十条新报,一次重跑不该被迫两件事一起做。
 */
export type ReviewRunMode = "full" | "verdict-only";

/**
 * 一轮 Review Run 是被谁开出来的(issue #312)。
 *
 * `delivery` 是 Forge 投递,`panel` 是人在面板上的重跑、发起范围审查与推进比较项,
 * `scheduled` 是每日增量的定时检查(spec #310)。它与调用者用户名快照分开:定时开出的
 * 那一轮没有调用者,「没有用户名」从此不再等于「投递」。升级前的旧行按用户名回填
 * (有即 `panel`,否则 `delivery`)。
 */
export type ReviewTriggerSource = "delivery" | "panel" | "scheduled";

/** 一个审查阶段的来源(CONTEXT.md 审查阶段):pull request 或范围审查。 */
export type StageSource = "pull-request" | "range-review";

/** 一个审查阶段只有这两种状态(CONTEXT.md 审查阶段)。 */
export type StageStatus = "active" | "closed";

/**
 * 最新一轮没跑全(issue #421、#424):评审记录的行据此挂一枚警示,不点进阶段页也看得出
 * 这一轮的结论不完整。
 *
 * 三档分开说,排障方向不同:整轮没跑成的那个模型一条结论都没有,部分批次没跑成的
 * 模型只在那几批的文件上没有结论(`missing_reason = 'batch-failed'`),而收尾失败时
 * Reviewer 都跑成了、结论却没能落到 Forge 上。三样可以同时出现。
 */
export type StageRunAlert = {
  /** 有模型整轮没跑成(`reviewer_outcome.failure` 非空)。 */
  modelFailed: boolean;
  /**
   * 有模型的某几批没跑成。两处证据任一即是:那几批文件上的历史记了 `batch-failed`,或
   * 审查轨迹里有该模型失败的批次收尾事件(issue #408)——失败批上没有未处置历史时
   * (头一轮尤其如此)复核记录一行都没有,只有轨迹说得出来。整轮没跑成的模型不算这一档。
   */
  batchFailed: boolean;
  /**
   * 轮次级失败原因里头一行有内容的(ADR 0026,issue #424、#428),收尾正常即 null;原因
   * 整篇空白时是「未记录原因」,因此非 null 即可直接读给人看。非空本身就是这一档——多
   * 一个布尔说不出别的。只给一行:行上那枚徽章挂得住一句话,挂不住一整段堆栈,要读全文
   * 去阶段页的时间线。
   */
  closingFailure: string | null;
};

/**
 * 评审记录里的一行(issue #174):一个审查阶段,不是一轮 Review Run。同一 pull request
 * 推多少次、同一范围审查推进多少次,这里都只有一行。
 *
 * `stageId` 由来源与键合成(`pr:<owner>/<repo>/<number>` 与 `range:<id>`),阶段详情
 * 的地址用它作路径参数,因此格式要稳定可解析。
 *
 * 范围审查的容器 PR 序号不出现在这里:它对面板用户透明(CONTEXT.md 容器 PR),
 * `pullNumber` 因此只有 pull request 阶段有。两种来源的标题都在这里:pull request 取
 * 最新一轮记下的那个,范围审查取发起时填的那个;升级前的旧行没有,由面板按 `#编号` 显示。
 */
export type StageListItem = {
  stageId: string;
  source: StageSource;
  owner: string;
  repo: string;
  /** pull request 阶段的 PR 号;范围审查阶段为 null。 */
  pullNumber: number | null;
  /** 范围审查阶段的标识;pull request 阶段为 null。 */
  rangeReviewId: number | null;
  /** pull request 阶段取最新一轮记下的标题,范围审查取发起时填的;旧行是 null。 */
  title: string | null;
  status: StageStatus;
  /** 最新一轮 Review Run;范围审查刚发起、一轮都还没跑时为 null。 */
  latestRunId: number | null;
  latestRunAt: string | null;
  /** 最新一轮跑完的时刻;还在跑时为 null,面板据此决定要不要续查。 */
  latestRunFinishedAt: string | null;
  /** 阶段汇总的三个数,口径与 `GET /stage-summary` 完全一致——它们就是从那里来的。 */
  counts: { pending: number; resolved: number; fixed: number };
  /**
   * 最新一轮没跑全时的警示(issue #421)。最新一轮跑得正常、还在跑、或者一轮都还没跑
   * 时为 null;更早的轮次出过问题不算——这一格说的是此刻的结论完不完整。
   */
  latestRunAlert: StageRunAlert | null;
};

/**
 * 时间线里的一轮:这一轮对这个阶段做了什么(issue #168)。
 *
 * - `reported` / `folded` / `continued` 三类互斥,加起来就是这一轮落的 Finding 行数
 *   ——承接旧位置的算已延续,本阶段更早出现过的算折叠,其余是本轮新报出。
 * - `fixed` 是本轮复核判已修、且这一条现在仍记着「已修复」的条数(ADR 0016);人事后
 *   把它改回未处置之后就退出这个数——那一条从此是人工处置。
 * - `missedVerdicts` / `batchFailedVerdicts` / `uncoveredVerdicts` 是没拿到结论的
 *   「Reviewer × 历史 Finding」对数,按由来分三档(issue #412、#413)。
 */
export type StageTimelineEntry = {
  runId: number;
  headSha: string;
  startedAt: string;
  finishedAt: string | null;
  failed: boolean;
  /** 轮次级的失败原因(ADR 0026);null 即收尾正常。 */
  failure: string | null;
  /** 这一轮的模式(CONTEXT.md 只复核,issue #242)。升级前的旧行是完整审查。 */
  mode: ReviewRunMode;
  /** 这一轮是被谁开出来的(issue #312)。时间线据它标出每一轮的来源。 */
  triggerSource: ReviewTriggerSource;
  /** 本轮新报出。 */
  reported: number;
  /** 折叠到本阶段已有的那条上。 */
  folded: number;
  /** 复核判已修、自动记「已修复」。 */
  fixed: number;
  /** 复核判仍在而代码已改写,交接到新位置。 */
  continued: number;
  /**
   * 这个模型跑了那一批却没给结论的条数。升级前的行说不出由来,一律落在这一档,与升级前
   * 那个总数一致。它与本轮全部 `reviewer_batch_finished` 里非失败批的(应给 − 给出)相等。
   */
  missedVerdicts: number;
  /** 那一批根本没跑成,因此没有结论的条数(issue #412)。它说的是模型服务或额度。 */
  batchFailedVerdicts: number;
  /**
   * 本轮没有哪一批读到它那个文件,谁都复核不到的条数(issue #413)。它说的是覆盖缺口:
   * 未处置历史落在本轮 diff 之外、又没被「文件已回退 / 已删除」自动处置掉的那些。
   */
  uncoveredVerdicts: number;
};

/**
 * 阶段详情时间线上的一组轮次(issue #175)。一组就是一次代码推进:pull request 阶段
 * 按 head commit 分,范围审查阶段按比较项分——两边问的都是「这一段代码从哪来」。
 *
 * 比较项是人推上去的,因此多带推的人与时刻;pull request 的 head commit 没有这一层,
 * 两项为 null。
 */
export type StageRunGroup = {
  sha: string;
  recordedBy: string | null;
  recordedAt: string | null;
  /** 这一组里的轮次,新的在前;刚推上去、还没跑过的比较项是空数组。 */
  runs: StageTimelineEntry[];
};

/**
 * 一个审查阶段的详情(issue #175):评审记录里的那一行,加它按代码推进分组的时间线。
 * 两种来源的阶段用同一份形状,详情页因此只有一套。
 *
 * 端点在这之上还回两格由 `server.ts` 拼的:范围审查阶段自己那条记录与生效最低报告等级。
 * 它们不是阶段投影的一部分,由面板那侧自己声明。
 */
export type StageDetail = { stage: StageListItem; groups: StageRunGroup[] };
