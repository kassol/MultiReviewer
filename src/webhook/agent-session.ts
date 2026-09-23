/**
 * Agent 会话的运行时(issue #333):登记表、投递、落库与广播。
 *
 * 与 HTTP handler 分开放:handler 只做门禁与形状校验,「这个会话此刻在不在跑、子进程在哪、
 * 记录怎么落、谁收到广播」全在这里。子进程那一侧只订阅并转发(`reviewer/session-worker.ts`),
 * 判断都在这一层(ADR 0017 同律)。
 *
 * 一会话一子进程,建起来就常驻。生命周期也在这一层(issue #335):空闲十分钟回收、常驻数
 * 有全局上限(满了先回收最久空闲的,全在跑时发消息回 409)、执行中连续静默五分钟判死、
 * 排空时立即中止并按时退出、重启后人下次发消息才从记录表惰性重建。登记表是进程内的一张
 * 表,进程重启后它空着——「在跑」因此不落库,而排队中的消息要落库,不然重建时就丢了。
 *
 * 排队、插话、停止与流式帧(issue #334)也在这一层:队列的真身在 Pi 那边,登记表上记一份
 * 镜像供读接口与面板看;流式 delta 按 100ms 合并一次,经瞬时帧走同一个频道,不落库。
 *
 * 图片附件(issue #336)在这一层只做两件事:把文件引用随 `prompt` 指令发下去(base64 由
 * 子进程自己读文件填),以及落库前把镜像回来的 base64 图片块换回文件引用。落盘、缩放与
 * 互换都在 `reviewer/session-images.ts`。
 *
 * 库一律异步读写(spec #445):方法调用
 * 前加 `await`,拼写一字不改。底下仍是同一条同步连接——**方法体在调用那一刻就跑完了,只有
 * 返回值裹进 Promise**,不等它的调用方(计时器、`reclaim`)因此照样看得到落库的效果;等的
 * 那些(排空、重建)顺序也不变。四个仍是同步的导出见各自的注释。
 */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ThinkingLevel } from "../config.ts";
import type { Forge } from "../forge/forge.ts";
import { defaultBranchHead, prepareWorktree, type Worktree } from "../git/worktree.ts";
import type { ReviewerUsage } from "../review/finding.ts";
import { scopesOverlap } from "../review/run.ts";
import {
  type AgentSessionBaseline,
  type AgentSessionEntryLink,
  type AgentSessionRecord,
  type AgentSessionStatus,
  type ProductKnowledgeEntry,
  type ProductRepoRecord,
  type RepoFindingQuery,
  type Store,
} from "../review/store/index.ts";
import {
  agentSessionChannel,
  publishAgentSessionRecord,
  publishTransientTrace,
} from "../review/trace.ts";
import { MODEL_API_KEY_ENV, reviewerEnv } from "../reviewer/env.ts";
import type { RuntimeModel } from "../reviewer/model-service-runtime.ts";
import { FINDING_QUERY_LIMIT } from "../reviewer/session-finding-tool.ts";
import { deflateImageBlocks, type AgentSessionImageRef } from "../reviewer/session-images.ts";
import {
  AGENT_SESSION_BASELINE_UPDATE_CUSTOM_TYPE,
  SYSTEM_MESSAGE_ENTRY,
  type AgentSessionMessageMode,
  type SessionCommand,
  type SessionKnowledgeEntries,
  type SessionKnowledgeQuery,
  type SessionKnowledgeWrite,
  type SessionProductKnowledge,
  type SessionRepoInput,
  type SessionWorkerMessage,
  type TrackerRequest,
} from "../reviewer/session-protocol.ts";
import type { SessionSubagentRun } from "../reviewer/session-subagent.ts";
import { realSilenceTimer, type SilenceTimer } from "../reviewer/subprocess.ts";
import { runTrackerRequest } from "./product-tracker.ts";

const WORKER_PATH = fileURLToPath(new URL("../reviewer/session-worker.ts", import.meta.url));

/** 运行时要的那几样。`forge` 取 Gitea 那一个(ADR 0014)。 */
export type AgentSessionRuntimeDeps = {
  store: Store;
  cacheDir: string;
  forge: Forge;
  now: () => number;
  /** 空闲回收的门槛(毫秒),默认 `IDLE_RECLAIM_MS`。只该测试注入。 */
  idleReclaimMs?: number;
  /**
   * 静默闸的时钟(issue #399),默认真实的 `setTimeout`。只该测试注入:判死按真实时间验
   * 就得等满一个明显宽于子进程准备时间的门槛(这一段里子进程一条 IPC 都不发),而判据
   * 本来只是「闸响了会怎样」。与 Reviewer 那套子进程的 `silenceTimer` 同一档(issue #397)。
   */
  silenceTimer?: SilenceTimer;
};

/**
 * 往记录表里落一条要的那两样(issue #337)。主进程自己落的那几条(基点更新、tracker 的
 * 请求-回应)不起子进程、不取代码,因此不要整份运行时依赖——没配 Forge 的部署里它们照样
 * 落得下去。
 */
export type AgentSessionRecordDeps = Pick<AgentSessionRuntimeDeps, "store" | "now">;

/** 这次开跑用的辅助模型(ADR 0029)。解析在 server.ts 那一处,运行时只认结论。 */
export type AgentSessionModel = {
  runtimeModel: RuntimeModel;
  credential: string;
  thinkingLevel?: ThinkingLevel;
};

/**
 * 排队中的一条消息(issue #334):模式与正文。Pi 不支持单条撤回,因此没有标识这一格。
 * `images` 是它带的那几张图的文件引用(issue #336);接口回给面板的那一份不带它——路径是
 * 服务端的事。
 */
export type AgentSessionQueuedMessage = {
  mode: AgentSessionMessageMode;
  text: string;
  images?: readonly AgentSessionImageRef[];
};

/** 流式帧合并的间隔。一条 delta 一帧会把 SSE 打满,人眼也看不出差别。 */
const STREAM_FRAME_MS = 100;

/** 瞬时帧的类型名(issue #334)。帧不落库,因此没有 seq,SSE 帧也就不带 `id`。 */
export const AGENT_SESSION_STREAM_FRAME = "agent_session_stream";

/**
 * 空闲多久回收子进程(issue #335)。空闲 = 没在跑、也没有排着的消息。常量不做配置
 * (spec #329):这个数要改是因为内存画像变了,那时改代码重新发版,不是运维现场调的旋钮。
 */
const IDLE_RECLAIM_MS = 10 * 60 * 1000;

/**
 * 执行中连续静默多久判死(issue #335)。与 Reviewer 那套子进程同一个数与同一条理由
 * (`reviewer/subprocess.ts`):健康的会话 IPC 常鸣——条目、流式 delta 与节流心跳隔几秒
 * 就一条,真正的卡死表现为彻底沉默。**空闲时不计时**:空闲着一条 IPC 都没有是正常的,
 * 那一档由上面的回收闸管。
 */
const SILENCE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 同时常驻的会话子进程上限(issue #335)。
 *
 * 取 4:一个子进程是一套 Pi 运行时加产品里每个仓库一棵工作树,内存与磁盘都按会话数线性涨,
 * 而审查本身还要在同一台机器上跑满 `maxParallelBatches` 个 Reviewer 子进程。4 是「一个小组
 * 同时有几个人在拆需求」的量,再多的那一个人等几秒拿到「名额已满」比整机换页好。满了先回收
 * 最久空闲的那个(它的上下文在库里,下一条消息照样续得上),全都在跑时新的发消息回 409。
 */
const MAX_RESIDENT_SESSIONS = 4;

/** 排空时留给子进程中止并退出的时间。超过就强杀:发版不等一个退不掉的子进程。 */
const DRAIN_EXIT_GRACE_MS = 5000;

/** 执行中静默超时那一条系统消息(ADR 0031)。不进模型上下文。 */
const SILENCE_ABORTED =
  "执行中静默超时,会话已中止。下次发消息时会从记录重建,接着这里续谈。";

/** 子进程起不来那一条系统消息(评审复核)。后面接 boot 抛出来的原因。 */
const BOOT_FAILED = "会话子进程启动失败:";

/** 被排空中止那一条系统消息(spec #329 的部署人员那几条)。 */
const DRAIN_ABORTED = "服务在发版排空,这一轮被中止。下次发消息时会从记录重建,接着这里续谈。";

/**
 * 登记表上的一个会话。`child` 在建出会话根之后当场 fork,与准备工作树并行;`open` 做成之前
 * 它还不认指令,`opened` 为假时指令一律先攒在 `pending` 里。
 */
type RuntimeEntry = {
  /**
   * 这个子进程当初是用哪份依赖起的。回收、判死与排空都要落库与记日志,而它们由计时器与
   * 进程信号触发,手上没有请求——依赖因此记在登记表上,不从调用方再传一遍。
   */
  deps: AgentSessionRuntimeDeps;
  status: AgentSessionStatus;
  /** 最后一次活动的时刻。空闲回收与「满了回收最久空闲的那个」都按它判(issue #335)。 */
  lastActiveAt: number;
  /**
   * 这个子进程此刻用的辅助模型(`modelKey`,ADR 0029)。每次开跑按现有解析取当前值,与这一格
   * 不同即落一条系统消息、回收这个子进程、用新模型重建(issue #335)。
   */
  modelKey: string;
  /**
   * 执行中是静默闸、空闲是回收闸,两档共用这一格:同一时刻只有一种在计时,而「换档」正是
   * 状态变化那一刻要做的事(`rearm`)。
   */
  /** 撤掉当前排着的那一个闸(空闲回收或静默判死)。 */
  cancelTimer: (() => void) | undefined;
  child: ChildProcess | undefined;
  /**
   * 正在跑的那一次 `boot`(评审复核)。收拢与 `letGo` 先等它落定:备工作树那段里删会话根,
   * `git worktree add` 还在往里写,`rmSync` 报 ENOTEMPTY;fork 撞上已删的 cwd 则起不来。
   */
  booting: Promise<unknown> | undefined;
  sessionRoot: string | undefined;
  worktrees: Worktree[];
  /**
   * 排队列表的镜像(issue #334)。真队列在 Pi 那边,这一份供读接口与面板看:子进程每次报
   * `queue_update` 就按它对齐。停止时 Pi 那边被清空而这一份留着——排队消息因此不随停止丢掉,
   * 下次开跑时从这里投递。
   */
  queue: AgentSessionQueuedMessage[];
  /**
   * 已发出的最后一条 prompt 的序号(评审复核),从 0 起。子进程报的 `queue` 带的序号小于它即
   * 过期:镜像在那之后已记上新入队的一条,按过期现状对齐会把它抹掉——紧接着停止的话,
   * 那一条就从镜像与 Pi 两边一起丢了。
   */
  queueSeq: number;
  /**
   * 子进程的 Pi 会话建好了(`open` 做成)。在那之前子进程虽已 fork,发给它的 `prompt` / `stop`
   * 会撞在一个还没有会话的进程上;排空也不必给它下 `drain`——它手上没有可中止的回合。
   */
  opened: boolean;
  /** 子进程的 Pi 会话建好之前攒下的指令。建好之后按顺序补发,一条都不丢。 */
  pending: SessionCommand[];
  /**
   * 已经投出去、还没在镜像回来的条目里认领的那几张图(issue #336)。顺序即投递顺序:镜像
   * 回来的用户消息里第 k 个 base64 图片块配第 k 个引用,落库前换过去。回合结束即清空——
   * 模型那一侧把图丢了的话,这几张不该串到下一回合的消息上。
   */
  imageRefs: AgentSessionImageRef[];
  /**
   * 已经收拢过。`disposeAgentSessions` 可能正赶上这个会话在备工作树:子进程已经 fork、收拢
   * 当场杀掉它,而 boot 还在等工作树备完——这一格让它备完之后不再往下发 `open`、直接收场。
   */
  disposed: boolean;
  /**
   * 落条目的那条链(spec #445)。落库转异步之后 `child.on("message")` 这个同步回调等不了它,
   * 而条目的会话内序号由落库那一刻定:一批里顺序落、两批之间也不交错,靠的就是把每一批接在
   * 这条链后面,而不是各自 `void` 出去。
   */
  recording: Promise<void>;
  /** 这一次合并窗口里攒下的流式帧内容。`timer` 不为空即窗口开着。 */
  stream: {
    text: string;
    tool: string | undefined;
    /** 正在跑的那几个会话子代理(issue #358)。后一份整份盖掉前一份:它是现状,不是增量。 */
    subagent: readonly SessionSubagentRun[] | undefined;
    timer: NodeJS.Timeout | undefined;
  };
};

/**
 * 在跑的会话子进程。进程内一张表,与轨迹的订阅者同律:服务是单进程单实例(Docker)。
 * 进程重启后它是空的,所以没有任何会话是「在跑」——状态因此不落库。
 */
const registry = new Map<number, RuntimeEntry>();

/** 这个会话此刻的状态。没有子进程即空闲:读接口拿它覆盖库里那一列。 */
export function agentSessionStatus(sessionId: number): AgentSessionStatus {
  return registry.get(sessionId)?.status ?? "idle";
}

/**
 * 这个会话此刻排着哪几条消息(issue #334)。
 *
 * 有子进程时队列是进程内的镜像。**没有子进程不等于没有排队消息**:回收与排空都把镜像落进
 * `agent_session_pending_message`,下次发消息时一并投递(issue #335)——只读登记表的话面板
 * 看不到它们,人也就清不掉,而它们照样会投出去。
 *
 */
export async function agentSessionQueue(
  store: Store,
  sessionId: number,
): Promise<readonly AgentSessionQueuedMessage[]> {
  const entry = registry.get(sessionId);
  if (entry !== undefined) return entry.queue;
  return (await store.listAgentSessionPendingMessages(sessionId)).map(queuedMessage);
}

/** 库里那一行排队消息换成运行时的形状。模式那一格在库里是字符串,在这里收口。 */
function queuedMessage(message: {
  mode: string;
  text: string;
  images?: string;
}): AgentSessionQueuedMessage {
  return {
    mode: message.mode === "steer" ? "steer" : "followUp",
    text: message.text,
    ...(message.images === undefined
      ? {}
      : { images: JSON.parse(message.images) as AgentSessionImageRef[] }),
  };
}

/**
 * agent 读得到的仓库:产品当前仓库 ∩ 创建者当前仓库分配(spec #329)。系统管理员不受限,
 * 拿到的是产品的全部仓库。产品没了或创建者的账号没了即空集。
 *
 * 只认会话的三格,不要整条记录:建会话端点在会话还不存在时就要按这一份判人选的基点在不在
 * 里面(issue #352)。
 *
 */
export async function agentSessionRepos(
  store: Store,
  session: Pick<AgentSessionRecord, "productId" | "createdBy" | "purpose">,
): Promise<ProductRepoRecord[]> {
  const product = await store.getProduct(session.productId);
  if (product === undefined) return [];
  // 产品梳理读产品的全部仓库(CONTEXT.md 产品梳理):梳理的正是这个产品整体是什么、它的
  // 仓库之间怎么协作,少一个仓库这一场就看不全。开这一场要的是产品里的一个仓库分配,不是
  // 每一个仓库的分配(`server.ts` 的那道门禁)。
  if (session.purpose === "product-survey") return product.repos;
  const user = (await store.listPanelUsers()).find((row) => row.username === session.createdBy);
  if (user === undefined) return [];
  if (user.isSystemAdmin) return product.repos;
  const assigned = new Set(user.repoIds);
  return product.repos.filter((repo) => assigned.has(repo.repoId));
}

/** 仓库 id → `<owner>/<repo>`:产品知识的仓库集合交给子进程与模型时都要这一步。 */
function repoNameById(repos: readonly ProductRepoRecord[]): Map<number, string> {
  return new Map(repos.map((repo) => [repo.repoId, `${repo.owner}/${repo.repo}`]));
}

/** `<owner>/<repo>` → 仓库 id:模型报回来的仓库名换回库里的键。 */
function repoIdByName(repos: readonly ProductRepoRecord[]): Map<string, number> {
  return new Map(repos.map((repo) => [`${repo.owner}/${repo.repo}`, repo.repoId]));
}

/**
 * 这个会话挂的那个产品进系统提示的那一格:名字(issue #341)。与仓库集合和知识集同律在
 * `boot` 里现算:改名在下次重建时生效。产品没了即空串——那时会话一个仓库也读不到,消息
 * 根本发不出来。
 */
async function productHeading(store: Store, productId: number): Promise<string> {
  return (await store.getProduct(productId))?.name ?? "";
}

/**
 * 一条产品知识交给子进程的那一份(CONTEXT.md 产品知识,issue #360)。**出处附注留在库里**:
 * 附注只在产品页展示,不进任何提示(ADR 0035)。
 */
function toSessionKnowledge(entry: ProductKnowledgeEntry): SessionProductKnowledge {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    body: entry.body,
    topic: entry.topic,
    avoided: entry.avoided,
    options: entry.options,
    consequences: entry.consequences,
    supersededBy: entry.supersededBy,
  };
}

/**
 * 这个产品此刻的产品知识,交给子进程的那一份(CONTEXT.md 产品知识,issue #345、#360)。与
 * 产品名同律在 `boot` 里现算:一轮里刚写下的一条,下次重建就看得到。
 */
async function activeProductKnowledge(
  store: Store,
  productId: number,
): Promise<SessionProductKnowledge[]> {
  return (await store.listProductKnowledge(productId)).map(toSessionKnowledge);
}

/**
 * 这个产品此刻有没有一场没谈完的产品梳理(CONTEXT.md 产品梳理,issue #365)。
 *
 * 判据是库里那一格完成时刻,不是「在跑」:访谈里 agent 抛出一轮题就转空闲等人答,按在跑判
 * 会让人在等答题的间隙又开起第二场,两场问的是同一批问题、写的是同一批条目。
 *
 */
export async function productSurveyIncomplete(store: Store, productId: number): Promise<boolean> {
  return (await store.listAgentSessions(productId, null)).some(
    (session) => session.purpose === "product-survey" && session.completedAt === null,
  );
}

/**
 * 记下这一场产品梳理谈完了(CONTEXT.md 产品梳理,issue #365)。
 *
 * 访谈的产出一路经 `write_knowledge` 落好了,这一步只动会话上那一格完成时刻:同一个产品的
 * 下一场梳理因此开得起来,而这一场照旧读得到、创建者照旧续得了。
 */
export async function completeProductSurvey(
  deps: AgentSessionRecordDeps,
  session: AgentSessionRecord,
): Promise<void> {
  const store = deps.store;
  await store.completeAgentSession(session.id, new Date(deps.now()).toISOString());
}

/**
 * 一条 Pi 条目的用量,与 `getSessionStats()` 同口径(ADR 0031):assistant 与 toolResult 挂在
 * `message.usage` 上,compaction 与 branch_summary 挂在条目自己的 `usage` 上,其余条目没有
 * 用量。总数是四项之和,与 Review Run 那一列的算法逐字相同。
 */
export function agentSessionEntryUsage(entry: unknown): ReviewerUsage {
  const row = entry as { usage?: unknown; message?: { usage?: unknown } } | null;
  const usage = (row?.message?.usage ?? row?.usage) as
    | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    | undefined;
  const inputTokens = usage?.input ?? 0;
  const outputTokens = usage?.output ?? 0;
  const cacheReadTokens = usage?.cacheRead ?? 0;
  const cacheWriteTokens = usage?.cacheWrite ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
  };
}

/** 条目的类型与时间,从那份原样 JSON 里抄出来作索引列。认不出来时落空串。 */
function entryIndex(entry: unknown): { type: string; at: string } {
  const row = entry as { type?: unknown; timestamp?: unknown } | null;
  return {
    type: typeof row?.type === "string" ? row.type : "",
    at: typeof row?.timestamp === "string" ? row.timestamp : "",
  };
}

/** 落一条记录并广播。落库失败只记日志:一条记录落不下去不该把整个回合掀掉。 */
async function recordEntry(store: Store, sessionId: number, entry: unknown): Promise<void> {
  try {
    const record = await store.appendAgentSessionEntry(sessionId, {
      ...entryIndex(entry),
      entry,
      usage: agentSessionEntryUsage(entry),
    });
    publishAgentSessionRecord(agentSessionChannel(sessionId), record);
  } catch (error) {
    console.error(
      `[agent-session] 会话 ${sessionId} 的记录落库失败:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * 把攒下的流式帧广播出去(issue #334)。瞬时帧不落库、没有 seq,断线重连因此不回放它;
 * 没有在线订阅者时 `publishTransientTrace` 是空操作。
 */
function flushStream(sessionId: number, entry: RuntimeEntry): void {
  const { text, tool, subagent, timer } = entry.stream;
  if (timer !== undefined) clearTimeout(timer);
  entry.stream = { text: "", tool: undefined, subagent: undefined, timer: undefined };
  if (text === "" && tool === undefined && subagent === undefined) return;
  publishTransientTrace(agentSessionChannel(sessionId), {
    kind: AGENT_SESSION_STREAM_FRAME,
    // 正在生成的文字、正在跑的工具与正在跑的子代理分三格:页面要把它们摊成三样东西。
    payload: {
      text,
      ...(tool === undefined ? {} : { tool }),
      ...(subagent === undefined ? {} : { subagent }),
    },
  });
}

/** 攒一段流式帧内容,窗口没开就开一个。 */
function collectStream(
  sessionId: number,
  entry: RuntimeEntry,
  part: { text?: string; tool?: string; subagent?: readonly SessionSubagentRun[] },
): void {
  entry.stream.text += part.text ?? "";
  if (part.tool !== undefined) entry.stream.tool = part.tool;
  if (part.subagent !== undefined) entry.stream.subagent = part.subagent;
  if (entry.stream.timer !== undefined) return;
  entry.stream.timer = setTimeout(() => flushStream(sessionId, entry), STREAM_FRAME_MS);
}

/**
 * 把排队镜像对齐到子进程报来的队列现状。插话排在排队之前:Pi 在回合边界先取插话,排队的
 * 那些要等 agent 本来要停的那一刻,这就是它们实际的投递顺序。
 */
function syncQueue(
  entry: RuntimeEntry,
  reported: { steering: readonly string[]; followUp: readonly string[] },
): void {
  // Pi 报的是文本;图片引用在这一侧,按模式与文本认回去(issue #336)。Pi 自己摘队列也是按
  // 文本全等摘的,两条同文的消息因此可能换了张图——停止之后重投时图不会凭空消失,这就够了。
  const previous = entry.queue;
  const carried = (mode: AgentSessionMessageMode, text: string): AgentSessionQueuedMessage => {
    const at = previous.findIndex((old) => old.mode === mode && old.text === text);
    return at === -1 ? { mode, text } : previous.splice(at, 1)[0]!;
  };
  entry.queue = [
    ...reported.steering.map((text) => carried("steer", text)),
    ...reported.followUp.map((text) => carried("followUp", text)),
  ];
}

/** 投一条指令给子进程。它还没 fork 出来时先攒着,建好之后按顺序补发。 */
function sendCommand(entry: RuntimeEntry, command: SessionCommand): void {
  if (!entry.opened || entry.child === undefined) entry.pending.push(command);
  else entry.child.send(command);
}

/**
 * 这次开跑用的辅助模型的指纹(ADR 0029,issue #335)。模型与思考档位都算在内:同一个模型换了
 * 档位就是另一种跑法,上下文里的思考痕迹对不上。它同时是系统消息里的那个名字,存两份就会漂。
 */
function modelKey(model: AgentSessionModel): string {
  return `${model.runtimeModel.provider}:${model.runtimeModel.id}(思考 ${model.thinkingLevel ?? "off"})`;
}

/**
 * 落一条系统消息(ADR 0031,issue #335):判死、被排空中止与辅助模型切换走它。
 *
 * 由主进程自己落而不是交给子进程:这三下的子进程正要没了,再等一次镜像往返就是赌时序。
 * `custom` 条目不进模型上下文,这正是要的——它是给人看的。
 */
/** 不等落库的那几条系统消息:写不进去只记日志,不让一次 unhandled rejection 带走进程。 */
function logSystemMessageFailure(error: unknown): void {
  console.error("[agent-session] 系统消息落库失败:", error);
}

async function recordSystemMessage(
  deps: AgentSessionRecordDeps,
  sessionId: number,
  text: string,
): Promise<void> {
  await recordEntry(deps.store, sessionId, {
    ...(await ownEntryBase(deps, sessionId)),
    type: "custom",
    customType: SYSTEM_MESSAGE_ENTRY,
    data: { text },
  });
}

/**
 * 这段记录重建之后,前面有几条进不了模型上下文(ADR 0031,issue #335)。
 *
 * Pi 从数组末条当叶子、顺 `parentId` 上行拼上下文,指空了就静默停下;`compaction` 的
 * `firstKeptEntryId` 指不到条目时,压缩点之前一条不留。两种都不报错,因此自检只能自己做:
 * 从末条往上走,走不通就停,停在哪之前的那些就是不在上下文里的条目数。
 *
 * 完整的记录走到根,回 0——**正常压缩过的会话也回 0**:被压缩掉的那段有摘要顶着,不是缺损。
 */
export function agentSessionContextGap(links: readonly AgentSessionEntryLink[]): number {
  const byId = new Map<string, AgentSessionEntryLink>();
  for (const link of links) if (link.id !== null) byId.set(link.id, link);
  let walked = 0;
  let cursor = links.at(-1);
  while (cursor !== undefined) {
    walked += 1;
    // 压缩点的引用丢了:Pi 从这一条起往前一条都不留。
    if (cursor.firstKeptEntryId !== null && !byId.has(cursor.firstKeptEntryId)) break;
    if (cursor.parentId === null) break;
    cursor = byId.get(cursor.parentId);
  }
  return links.length - walked;
}

/**
 * 这个会话的记录重建后有几条进不了上下文。读接口按它给面板那道横幅。
 *
 */
export async function agentSessionDroppedFromContext(
  store: Store,
  sessionId: number,
): Promise<number> {
  return agentSessionContextGap(await store.agentSessionEntryLinks(sessionId));
}


/** 这个会话的两个计时器都停掉:生命周期那一档与流式合并窗口。 */
function clearTimers(entry: RuntimeEntry): void {
  entry.cancelTimer?.();
  entry.cancelTimer = undefined;
  if (entry.stream.timer !== undefined) clearTimeout(entry.stream.timer);
  entry.stream.timer = undefined;
}

/**
 * 按当前状态重排这个会话的闸:执行中是静默判死,空闲是回收。**空闲且排着消息时两个都不排**
 * ——那几条还等着人回来让它接着跑,回收会把这个会话的「下一步」悄悄推到重建之后。
 */
function rearm(sessionId: number, entry: RuntimeEntry): void {
  entry.cancelTimer?.();
  entry.cancelTimer = undefined;
  if (entry.disposed) return;
  if (entry.status === "running") {
    const arm = entry.deps.silenceTimer ?? realSilenceTimer;
    entry.cancelTimer = arm(() => void silenceDeath(sessionId, entry), SILENCE_TIMEOUT_MS);
    return;
  }
  if (entry.queue.length > 0) return;
  const idle = entry.deps.idleReclaimMs ?? IDLE_RECLAIM_MS;
  entry.cancelTimer = realSilenceTimer(() => void reclaimIdle(sessionId, entry), idle);
}

/** 记一次活动:最后活动时刻往前推,闸重排。每条子进程回传都是活着的证据。 */
function touch(sessionId: number, entry: RuntimeEntry): void {
  entry.lastActiveAt = entry.deps.now();
  rearm(sessionId, entry);
}

/**
 * 把还没投出去的排队消息落库(issue #335)。回收与排空都在收掉子进程之前调它:镜像随进程走,
 * 落库的这一份等下次发消息重建时一并投递。空队列不写:那一次 DELETE 什么也换不掉。
 */
async function persistQueue(sessionId: number, entry: RuntimeEntry): Promise<void> {
  if (entry.queue.length === 0) return;
  const store = entry.deps.store;
  try {
    await store.putAgentSessionPendingMessages(
      sessionId,
      // 图片引用跟着它那一条落库(issue #336):重建补投的还是人当初发的那一条,少了图就不是了。
      entry.queue.map((message) => ({
        mode: message.mode,
        text: message.text,
        ...(message.images === undefined ? {} : { images: JSON.stringify(message.images) }),
      })),
    );
  } catch (error) {
    console.error(
      `[agent-session] 会话 ${sessionId} 的排队消息落库失败:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** 上一次回收或排空时落库的排队消息,取出即删(issue #335)。 */
async function takePendingQueue(
  deps: AgentSessionRuntimeDeps,
  sessionId: number,
): Promise<AgentSessionQueuedMessage[]> {
  const store = deps.store;
  return (await store.takeAgentSessionPendingMessages(sessionId)).map(queuedMessage);
}

/** 放掉这个会话占的磁盘:每棵一次性工作树各自释放,再删会话根(它下面只剩空目录)。 */
async function letGo(entry: RuntimeEntry): Promise<void> {
  // 备到一半的那一次先让它备完:boot 自己会看到 `disposed` 把子进程收掉,这里只等目录不再有人写。
  await entry.booting?.catch(() => {});
  const worktrees = entry.worktrees.splice(0, entry.worktrees.length);
  for (const worktree of worktrees) await worktree.release();
  const sessionRoot = entry.sessionRoot;
  entry.sessionRoot = undefined;
  if (sessionRoot !== undefined) rmSync(sessionRoot, { recursive: true, force: true });
}

/**
 * 回收一个会话的子进程(issue #335):登记表摘掉、计时器停掉、排队消息落库、杀进程、释放
 * 工作树与会话根。**回收不是终结**——会话的全部记录在库里,人下次发消息时从那里惰性重建。
 *
 * 释放磁盘那一段是异步的,不等它:调用方都在同步路径上(计时器、发消息、取名额)。
 *
 * `persist: false` 是删会话那一条路(`reclaimAgentSession`):那个会话的全部行正要被删掉,
 * 把镜像落进一张马上清空的表没有意义。
 */
/**
 * 强杀一个子进程。`pid` 为空即 spawn 已经同步失败(cwd 在它起来之前被收拢删掉那一种):Node 的
 * 句柄里 pid 是 0,这时再 `kill` 就成了 `kill(0)`——信号发给整个进程组,编排进程自己一起倒。
 * 失败那一次 Node 会异步抛 `error`,不必再杀。
 */
export function killChild(child: ChildProcess | undefined): void {
  if (child?.pid !== undefined) child.kill("SIGKILL");
}

async function reclaim(sessionId: number, entry: RuntimeEntry, persist = true): Promise<void> {
  if (registry.get(sessionId) === entry) registry.delete(sessionId);
  entry.disposed = true;
  clearTimers(entry);
  // 等它落完再往下走(spec #445):库换成真异步之后,不等就会在收掉子进程之后才写这几条。
  // 失败由 `persistQueue` 自己记日志,不往外抛。
  if (persist) await persistQueue(sessionId, entry);
  killChild(entry.child);
  if (!persist) {
    // 删会话那一条路(issue #462):已经排上链的条目落完再让调用方删行,管道里还没读出来的那几批
    // 不再收——否则它们落在删行之后,外键拦下整笔删除。Pi 0.87 在模型请求发出之后才回传这一回合
    // 的头几条条目,删会话于是常撞上它们还在落库。
    entry.child?.removeAllListeners("message");
    await entry.recording;
  }
  void letGo(entry).catch((error: unknown) => {
    console.error(
      `[agent-session] 会话 ${sessionId} 的会话根没清干净:`,
      error instanceof Error ? error.message : String(error),
    );
  });
}

/**
 * 这个会话的子进程不要了(评审复核):删会话与删产品级联在删库里那一行之前调它。
 *
 * 常驻子进程不随库里那一行消失:留着它会挂着一棵没人要的工作树,静默闸与回收闸还会往一张
 * 已经没有的会话上写系统消息。排队消息不落库——`agent_session_pending_message` 的行正要跟着
 * 这个会话一起删掉。没有子进程的会话调它是空操作。
 */
export async function reclaimAgentSession(sessionId: number): Promise<void> {
  const entry = registry.get(sessionId);
  if (entry !== undefined) await reclaim(sessionId, entry, false);
}

/** 空闲满门槛:回收。上下文在库里,下一条消息自然重建(issue #335)。 */
async function reclaimIdle(sessionId: number, entry: RuntimeEntry): Promise<void> {
  const minutes = (entry.deps.idleReclaimMs ?? IDLE_RECLAIM_MS) / 60_000;
  console.log(`[agent-session] 会话 ${sessionId} 空闲满 ${minutes} 分钟,回收子进程`);
  await reclaim(sessionId, entry);
}

/**
 * 执行中连续静默满门槛:判死(issue #335)。杀进程、登记表摘掉,再以系统消息记下这一条
 * ——会话记录里得留着这一轮为什么断了,不然人只看到对话突然停住。
 */
function silenceDeath(sessionId: number, entry: RuntimeEntry): void {
  const minutes = SILENCE_TIMEOUT_MS / 60_000;
  console.error(`[agent-session] 会话 ${sessionId} 执行中连续 ${minutes} 分钟静默,判死`);
  void reclaim(sessionId, entry);
  // 接在这个会话还没落完的条目后面:这一条的 `parentId` 指的是最后一条记录,插到它们前面
  // 会让重建时算出一段旁支。
  void entry.recording
    .then(() => recordSystemMessage(entry.deps, sessionId, SILENCE_ABORTED))
    .catch(logSystemMessageFailure);
}

/**
 * 这个会话此刻有没有常驻名额(issue #335)。已经常驻着的、以及还没满上限的都有;满了就回收
 * 最久空闲的那一个腾出来(它的上下文在库里),一个可回收的都没有时回 false——接口据此回 409。
 *
 * 空闲的定义与空闲回收闸同一份(spec #329):**没在跑、也没有排着的消息**。排着消息的那个
 * 会话还等着人回来让它接着跑,把它回收掉就是把别人的下一步推到重建之后(`rearm` 因此也不为
 * 它排回收闸)。
 */
export async function agentSessionSlot(sessionId: number): Promise<boolean> {
  if (registry.has(sessionId)) return true;
  if (registry.size < MAX_RESIDENT_SESSIONS) return true;
  let idlest: { sessionId: number; entry: RuntimeEntry } | undefined;
  for (const [id, entry] of registry) {
    if (entry.status !== "idle" || entry.queue.length > 0) continue;
    if (idlest === undefined || entry.lastActiveAt < idlest.entry.lastActiveAt) {
      idlest = { sessionId: id, entry };
    }
  }
  if (idlest === undefined) return false;
  console.log(
    `[agent-session] 常驻名额已满,回收最久空闲的会话 ${idlest.sessionId} 给会话 ${sessionId} 腾位置`,
  );
  await reclaim(idlest.sessionId, idlest.entry);
  return true;
}

/**
 * 主进程自己往记录表里落一条 Pi 条目时,它的那三格底子(issue #337)。
 *
 * `parentId` 接在此刻最后一条记录上:重建时 Pi 顺着 `parentId` 上行,指空了就静默丢掉断点
 * 之前的全部历史(ADR 0031)。一次全量读记录在这里付得起——一个会话里主进程自己落记录只有
 * 几次,而面板每打开一次读的就是同一份。
 */
async function ownEntryBase(
  deps: AgentSessionRecordDeps,
  sessionId: number,
): Promise<{ id: string; parentId: string | null; timestamp: string }> {
  const store = deps.store;
  const last = (await store.listAgentSessionEntries(sessionId)).at(-1)?.entry as
    | { id?: unknown }
    | undefined;
  return {
    id: randomUUID(),
    parentId: typeof last?.id === "string" ? last.id : null,
    timestamp: new Date(deps.now()).toISOString(),
  };
}

/**
 * 基点更新之后的那两步(ADR 0034,issue #356):回收子进程,再落一条基点更新。调用方已经把会话
 * 基点换成新 sha、并判过会话空闲。
 *
 * **先回收再落**:活着的子进程要经 IPC 才接得上 Pi 内存里的链,而它马上要被杀掉,交给它的这一条
 * 可能来不及镜像回库。回收之后登记表上没有它,由主进程直接落库、`parentId` 接最后一条记录;
 * 下一条消息从记录惰性重建,工作树按新基点检出,这一条随整段记录进模型上下文。
 */
export async function recordAgentSessionBaselineUpdate(
  deps: AgentSessionRecordDeps,
  sessionId: number,
  update: { owner: string; repo: string; branch: string; from: string; to: string },
): Promise<void> {
  const entry = registry.get(sessionId);
  if (entry !== undefined) await reclaim(sessionId, entry);
  // 刚收拢的那个子进程还没落完的条目先落完:这一条要接在最后一条记录后面。
  await entry?.recording.catch(() => {});
  const repo = `${update.owner}/${update.repo}`;
  await recordEntry(deps.store, sessionId, {
    ...(await ownEntryBase(deps, sessionId)),
    type: "custom_message",
    customType: AGENT_SESSION_BASELINE_UPDATE_CUSTOM_TYPE,
    content: `${repo} 的会话基点从 ${update.from.slice(0, 7)} 更新到 ${update.to.slice(0, 7)}(分支 ${update.branch})。此前读过的这个仓库的代码已经换了,以新 commit 为准。`,
    details: { repo, branch: update.branch, from: update.from, to: update.to },
    display: true,
  });
}

/**
 * 回一次历史 Finding 查询(issue #338)。查询在这一侧做:子进程没有库连接,判断与落库都在
 * 这一层(ADR 0017 同律)。
 *
 * **恒回一条**——查不动时带上原因。子进程那边的工具调用在等这条消息,少回一次它就永远等
 * 下去。仓库在不在会话根内由子进程判(它手里就是那份清单),这里只查它问的那一个。
 */
async function answerFindingQuery(
  store: Store,
  child: ChildProcess,
  requestId: string,
  query: RepoFindingQuery,
): Promise<void> {
  let result: SessionCommand;
  try {
    result = {
      kind: "finding-query-result",
      requestId,
      findings: await store.listRepoFindings(query, FINDING_QUERY_LIMIT),
    };
  } catch (error) {
    result = {
      kind: "finding-query-result",
      requestId,
      findings: [],
      failure: error instanceof Error ? error.message : String(error),
    };
  }
  child.send(result);
}

/**
 * 这个仓库生效知识集里两型各有多少条(issue #344)。进系统提示的目录那一行——陈述本身由
 * `query_knowledge` 按任务的范围取,子进程因此连这些文字都拿不到。
 */
async function repoKnowledgeCounts(
  store: Store,
  repoId: number,
): Promise<{ ruleCount: number; factCount: number }> {
  const entries = (await store.getRuleSet(repoId))?.rules ?? [];
  return {
    ruleCount: entries.filter((entry) => entry.type === "rule").length,
    factCount: entries.filter((entry) => entry.type === "fact").length,
  };
}

/**
 * 一次知识查询要回的两层条目(issue #344、#360)。
 *
 * 产品层按**名字**取:问到的术语名与决策标题各回整条,`relationships` 为真时仓库关系整段
 * 回——产品知识说的是这个产品是什么,没有仓库范围可收窄。仓库层取问到的那几个仓库的生效
 * 知识集,按作用范围与查询 glob 重叠筛(`scopesOverlap`)。
 *
 * 仓库层封顶在 `FINDING_QUERY_LIMIT`:与历史 Finding 查询同一个常量。产品层不封顶:它按
 * 名字取,问几个回几条(ADR 0035)。问到的仓库名不在这个会话的仓库里就当没问(子进程那一
 * 侧已经打回过)。
 */
export async function sessionKnowledge(
  store: Store,
  productId: number,
  repos: readonly ProductRepoRecord[],
  query: SessionKnowledgeQuery,
): Promise<SessionKnowledgeEntries> {
  const idByName = repoIdByName(repos);
  const askedIds = (query.repos ?? [])
    .map((name) => idByName.get(name))
    .filter((id): id is number => id !== undefined);
  const names = new Set(query.names ?? []);
  const nameById = repoNameById(repos);
  const nameOf = async (id: number): Promise<string> => {
    const known = nameById.get(id);
    if (known !== undefined) return known;
    const row = await store.getRepo(id);
    const name = row === undefined ? `#${id}` : `${row.owner}/${row.repo}`;
    nameById.set(id, name);
    return name;
  };
  const product = (await store.listProductKnowledge(productId))
    .filter((entry) =>
      entry.kind === "relationship" ? query.relationships === true : names.has(entry.name),
    )
    .map(toSessionKnowledge);
  // 问到的仓库按顺序取,与 `flatMap` 那一版同序:后面那道封顶砍的是末尾,顺序变了砍掉的
  // 就换了一批。
  const repoEntries: SessionKnowledgeEntries["repo"][number][] = [];
  for (const repoId of askedIds) {
    const matched = ((await store.getRuleSet(repoId))?.rules ?? []).filter((entry) =>
      scopesOverlap(entry.scope, query.pathGlob),
    );
    if (matched.length === 0) continue;
    const repo = await nameOf(repoId);
    for (const entry of matched) {
      repoEntries.push({
        repo,
        type: entry.type === "fact" ? ("fact" as const) : ("rule" as const),
        scope: entry.scope,
        statement: entry.statement,
      });
    }
  }
  return { product, repo: repoEntries.slice(0, FINDING_QUERY_LIMIT) };
}

/**
 * 写下、改写或撤回一条产品知识(issue #360)。形状在子进程那一侧判完,这里落库并把落库之后
 * 的那一条回给它——id 要回去,agent 之后按它改写或撤回。
 *
 * 改写与取代的目标不在这个产品下时回一句理由:那是 agent 抄错了 id,不是这一次写不进去。
 */
export async function writeSessionKnowledge(
  deps: AgentSessionRecordDeps,
  session: AgentSessionRecord,
  write: SessionKnowledgeWrite,
): Promise<{ entry?: SessionProductKnowledge; failure?: string }> {
  const store = deps.store;
  try {
    const entry = await store.writeProductKnowledge({
      productId: session.productId,
      kind: write.kind,
      name: write.kind === "relationship" ? "" : write.name,
      body: write.body,
      topic: write.kind === "term" ? write.topic : null,
      avoided: write.kind === "term" ? write.avoided : [],
      options: write.kind === "decision" ? write.options : null,
      consequences: write.kind === "decision" ? write.consequences : null,
      annotations: write.annotations,
      at: new Date(deps.now()).toISOString(),
      sessionId: session.id,
      ...(write.id === undefined ? {} : { id: write.id }),
      ...(write.supersedes === undefined ? {} : { supersedes: write.supersedes }),
    });
    return entry === undefined
      ? { failure: "no entry of this product has that id; read the ids back with query_knowledge" }
      : { entry: toSessionKnowledge(entry) };
  } catch (error) {
    // 同名那一条已经在(唯一索引)是 agent 唯一撞得到的那一档,换成它改得动的一句话;
    // 别的落库失败原样说出来。
    const message = error instanceof Error ? error.message : String(error);
    return {
      failure: message.includes("UNIQUE")
        ? `this product already has a ${write.kind} named ${write.name}; pass its entryId to rewrite it, or pick another name`
        : message,
    };
  }
}

/** 撤回一条产品知识(issue #360)。这个产品下没有这一条即一句理由。 */
export async function withdrawSessionKnowledge(
  deps: AgentSessionRecordDeps,
  session: AgentSessionRecord,
  entryId: number,
): Promise<{ failure?: string }> {
  const store = deps.store;
  return (await store.withdrawProductKnowledge(session.productId, entryId))
    ? {}
    : { failure: `no entry of this product has id ${entryId}; nothing was withdrawn` };
}

/**
 * 回一次知识查询(issue #344)。与历史 Finding 那一次同律:查询在这一侧做,**恒回一条**
 * ——查不动时带上原因,不然子进程那边的工具调用永远等下去。
 */
async function answerKnowledgeQuery(
  deps: { store: Store },
  child: ChildProcess,
  productId: number,
  repos: readonly ProductRepoRecord[],
  requestId: string,
  query: SessionKnowledgeQuery,
): Promise<void> {
  let result: SessionCommand;
  try {
    result = {
      kind: "knowledge-query-result",
      requestId,
      entries: await sessionKnowledge(deps.store, productId, repos, query),
    };
  } catch (error) {
    result = {
      kind: "knowledge-query-result",
      requestId,
      entries: { product: [], repo: [] },
      failure: error instanceof Error ? error.message : String(error),
    };
  }
  child.send(result);
}

/**
 * 回一次产品 tracker 的读写(issue #361)。与上两对同律:判定、落库与措辞都在这一侧,
 * **恒回一条**——做不成时把原因说给模型,不然子进程那边的工具调用永远等下去。
 */
async function answerTrackerRequest(
  deps: AgentSessionRecordDeps,
  child: ChildProcess,
  session: AgentSessionRecord,
  requestId: string,
  request: TrackerRequest,
): Promise<void> {
  let text: string;
  const store = deps.store;
  try {
    text = await runTrackerRequest(
      store,
      session.productId,
      session.id,
      request,
      new Date((deps.now ?? Date.now)()).toISOString(),
    );
  } catch (error) {
    text = `could not reach this product's tracker: ${error instanceof Error ? error.message : String(error)}`;
  }
  child.send({ kind: "tracker-result", requestId, text } satisfies SessionCommand);
}

/** 这个仓库设置的默认分支(CONTEXT.md 默认分支,issue #350)。没设即 null。 */
async function configuredDefaultBranch(store: Store, repoId: number): Promise<string | null> {
  return (await store.getRepo(repoId))?.defaultBranch ?? null;
}

/**
 * 在会话根下按 `<owner>/<repo>` 各挂一棵一次性工作树。位置即工具面的判据——路径前缀就是
 * 仓库,圈根就是圈这个目录。会话根本身由 `boot` 先建:子进程拿它作 cwd,与这里并行起。
 *
 * 停在哪个 commit 由会话自己记的那一份说(issue #352):建会话时人按仓库选过基点,那一份
 * 就是这里检出的目标,空闲回收后重备因此停在同一个 commit 上,面板头部显示的与 agent 读的
 * 是同一份。会话上没记过的仓库(这一票之前建的会话)读生效的默认分支最新
 * (issue #350),读完一并记下来(issue #351):人与 agent 因此指得出读的是哪一份代码。
 *
 * **各仓库并行准备,等全部落定再判成败**(`allSettled` 而不是 `all`):一个仓库先失败时其余
 * 几棵可能还在检出,`all` 提前抛出之后才建出来的那几棵就没人收了。每棵建出来当场登记进
 * `entry.worktrees`,失败那条路上的 `letGo` 等 boot 落定之后一并放掉。
 */
async function prepareSessionRepos(
  deps: AgentSessionRuntimeDeps,
  session: AgentSessionRecord,
  repos: readonly ProductRepoRecord[],
  entry: RuntimeEntry,
  sessionRoot: string,
): Promise<{ repos: SessionRepoInput[] }> {
  const recorded = new Map(
    session.baselines.map((one) => [`${one.owner}/${one.repo}`, one] as const),
  );
  const prepareOne = async (repo: ProductRepoRecord) => {
    const ref = { owner: repo.owner, repo: repo.repo };
    const [repository, credentials] = await Promise.all([
      deps.forge.getRepository(ref),
      deps.forge.cloneCredentials(ref),
    ]);
    const clone = {
      cacheDir: deps.cacheDir,
      ref,
      cloneUrl: repository.cloneUrl,
      credentials,
    };
    // 没记过的仓库读生效默认分支的 head,来源种类因此是分支(issue #355)。
    const existing = recorded.get(`${repo.owner}/${repo.repo}`);
    let branch: string;
    let headSha: string;
    let kind: AgentSessionBaseline["kind"];
    if (existing !== undefined) {
      ({ branch, sha: headSha, kind } = existing);
    } else {
      const head = await defaultBranchHead(
        clone,
        repository,
        await configuredDefaultBranch(deps.store, repo.repoId),
      );
      branch = head.branch;
      headSha = head.sha;
      kind = "branch";
    }
    const worktree = await prepareWorktree({
      ...clone,
      headSha,
      baseSha: headSha,
      path: join(sessionRoot, repo.owner, repo.repo),
    });
    entry.worktrees.push(worktree);
    return {
      input: {
        ...ref,
        role: repo.role,
        headSha,
        ...(await repoKnowledgeCounts(deps.store, repo.repoId)),
      } satisfies SessionRepoInput,
      baseline: { ...ref, sha: headSha, branch, kind } satisfies AgentSessionBaseline,
    };
  };
  const settled = await Promise.allSettled(repos.map(prepareOne));
  // 按输入顺序收:系统提示里的仓库清单顺序不变,报的是排在最前的那个失败原因。
  const done: Awaited<ReturnType<typeof prepareOne>>[] = [];
  for (const one of settled) {
    if (one.status === "rejected") throw one.reason;
    done.push(one.value);
  }
  // 整列一次写完:备到一半失败的那一次不落半份清单,下一条消息重试时从头再备一遍。
  const store = deps.store;
  await store.setAgentSessionBaselines(
    session.id,
    done.map((one) => one.baseline),
  );
  return { repos: done.map((one) => one.input) };
}

/**
 * 这个会话此前的全部记录,喂回子进程重建 Pi 会话用(ADR 0031,issue #335);另带上自检结论。
 *
 * 喂的是**全量**,不是「进上下文的那些」:`getSessionStats()` 按全部条目累加,只喂上下文视图
 * 会让用量在每次重建后从压缩点重新起算。链不完整时照样喂——Pi 按它自己的规则截断,会话上那个
 * 「前 N 条不在上下文」由读接口算给面板,不拒绝续谈。
 */
async function storedSession(
  store: Store,
  sessionId: number,
): Promise<{ entries: unknown[]; gap: number }> {
  return {
    entries: (await store.listAgentSessionEntries(sessionId)).map((record) => record.entry),
    gap: agentSessionContextGap(await store.agentSessionEntryLinks(sessionId)),
  };
}

/** 起这个会话的常驻子进程,建好 Pi 会话之后兑现。 */
async function boot(
  deps: AgentSessionRuntimeDeps,
  session: AgentSessionRecord,
  model: AgentSessionModel,
  repos: readonly ProductRepoRecord[],
  entry: RuntimeEntry,
): Promise<ChildProcess> {
  // 会话根先建、随即 fork:子进程加载 Pi 模块的那两秒与下面准备仓库的那几秒重叠。子进程在
  // 收到 `open` 之前什么都不做(不读 cwd),而 IPC 消息在它挂上监听之前由 Node 缓着,`open`
  // 等仓库备好再发不会丢。
  const sessionRoot = mkdtempSync(join(tmpdir(), "multireviewer-session-root-"));
  entry.sessionRoot = sessionRoot;
  const child = fork(WORKER_PATH, {
    // cwd 是会话根。只设 Pi 的 cwd 不够:模型会拼出相对于编排进程目录的路径。
    cwd: sessionRoot,
    env: reviewerEnv(process.env, { [MODEL_API_KEY_ENV]: model.credential }),
    // 不继承父进程的 execArgv:worker 是普通脚本,在 `node --test` 下会被当成测试文件启动。
    execArgv: [],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  // 当场登记:准备仓库那几秒里收拢(删会话、排空、抢名额)要杀得到它。
  entry.child = child;

  let ready: (() => void) | undefined;
  let failed: ((error: Error) => void) | undefined;
  const opened = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  // 准备仓库那几秒里子进程就可能退出或 spawn 失败:那时还没人 await 它,不接住就是 unhandled
  // rejection。失败原因不丢——下面的 `await opened` 照样拿到它。
  opened.catch(() => {});

  child.on("message", (message: SessionWorkerMessage) => {
    // 每条回传都是活着的证据:静默闸从头再来(issue #335)。
    touch(session.id, entry);
    switch (message.kind) {
      case "ready":
        ready?.();
        return;
      case "entries": {
        // 图片块在这一步换成文件引用(issue #336):库里不存 base64,记录表因此不随图片长大。
        // **换在收到那一刻,不在落库那一刻**:`imageRefs` 是按投递顺序排的,而 `turn-end` 会
        // 把它清空——推迟到落库时换,这一批的图就被下一回合的消息认走了。
        const batch = message.entries.map((one) => deflateImageBlocks(one, entry.imageRefs));
        // 接在这条链后面(spec #445):一批里顺序落,两批之间也不交错——条目的会话内序号由
        // 落库那一刻定,各自 `void` 出去就乱了。
        entry.recording = entry.recording
          .then(async () => {
            for (const one of batch) await recordEntry(deps.store, session.id, one);
          })
          // 链断了就接不上下一批:`.then` 对一个已拒绝的 promise 直接跳过,这一条之后的条目
          // 会一条不落地全丢掉。`recordEntry` 自己兜住落库失败,这里兜的是它之外的(开库就
          // 开不起来),兜完让链回到可用。
          .catch((error: unknown) => {
            console.error(
              `[agent-session] 会话 ${session.id} 的记录链断了:`,
              error instanceof Error ? error.message : String(error),
            );
          });
        return;
      }
      case "survey-complete":
        void completeProductSurvey(deps, session).catch((error: unknown) =>
          console.error(`[agent-session] 会话 ${session.id} 记完成时刻失败:`, error),
        );
        return;
      case "queue":
        if (message.seq < entry.queueSeq) {
          console.debug(
            `[agent-session] 会话 ${session.id} 丢弃过期的队列现状(序号 ${message.seq} < ${entry.queueSeq})`,
          );
          return;
        }
        syncQueue(entry, message);
        return;
      case "delta":
        collectStream(session.id, entry, { text: message.text });
        return;
      case "tool":
        collectStream(session.id, entry, { tool: message.tool });
        return;
      case "subagent":
        collectStream(session.id, entry, { subagent: message.runs });
        return;
      // 下面这几对请求-回应各自带 `requestId`,互相之间没有顺序:各走各的那一条链,不排队。
      case "finding-query":
        void answerFindingQuery(deps.store, child, message.requestId, message.query);
        return;
      case "knowledge-query":
        void answerKnowledgeQuery(
          deps,
          child,
          session.productId,
          repos,
          message.requestId,
          message.query,
        );
        return;
      case "knowledge-write":
        // 落库在这一侧(issue #360),与查询同律恒回一条:回不去的话那次工具调用永远等下去。
        void writeSessionKnowledge(deps, session, message.write).then((result) => {
          child.send({
            kind: "knowledge-write-result",
            requestId: message.requestId,
            ...result,
          });
        });
        return;
      case "knowledge-withdraw":
        void withdrawSessionKnowledge(deps, session, message.entryId).then((result) => {
          child.send({
            kind: "knowledge-write-result",
            requestId: message.requestId,
            ...result,
          });
        });
        return;
      case "tracker-request":
        void answerTrackerRequest(deps, child, session, message.requestId, message.request);
        return;
      case "turn-end":
        // 接在记录链后面(spec #445 第二段):置成空闲的那一刻起下一条消息就开跑,而这一回合
        // 最后那一批条目还排在链上等着落库。库是异步的之后这两件事会真撞上——下一回合的条目
        // 会抢在上一回合前面拿到序号。
        entry.recording = entry.recording.then(() => {
          entry.status = "idle";
          // 这一回合投出去的图都该被认领过了。没认领的不留到下一回合:那只会把图串到别的消息上。
          entry.imageRefs.length = 0;
          // 闸换档:执行中计静默,空闲计回收(issue #335)。
          rearm(session.id, entry);
          // 这一回合的最后一截流式内容该出去了:下一次开跑之前不会再有帧把窗口推开。
          flushStream(session.id, entry);
          if (message.failure !== undefined) {
            console.error(`[agent-session] 会话 ${session.id} 这一回合失败:${message.failure}`);
          }
        });
        return;
      case "failed":
        failed?.(new Error(message.failure));
        return;
      case "heartbeat":
        return;
    }
  });
  child.on("error", (error) => failed?.(error));
  child.on("exit", (code, signal) => {
    // 子进程没了就从登记表上摘掉:下一条消息从记录表惰性重建一个(issue #335)。
    if (registry.get(session.id) === entry) registry.delete(session.id);
    clearTimers(entry);
    failed?.(
      new Error(
        signal === null ? `子进程退出,退出码 ${code}` : `子进程被信号 ${signal} 终止`,
      ),
    );
  });

  const prepared = await prepareSessionRepos(deps, session, repos, entry, sessionRoot);
  // 备工作树那段时间里这个会话被收拢了:这一个子进程没人再用得上。会话根与工作树由收拢那一路
  // 的 `letGo` 放掉(它等 boot 落定再动手)。监听早已挂上,`error` 不会成 uncaughtException。
  if (entry.disposed) {
    killChild(child);
    throw new Error("会话已经收拢");
  }

  // 重建:整段记录原样喂回去(issue #335)。新会话那一次是空数组,与不给等价。
  const stored = await storedSession(deps.store, session.id);
  const productName = await productHeading(deps.store, session.productId);
  if (stored.gap > 0) {
    console.warn(
      `[agent-session] 会话 ${session.id} 的记录有缺损,重建后前 ${stored.gap} 条不在上下文里`,
    );
  }
  const command: SessionCommand = {
    kind: "open",
    request: {
      sessionRoot,
      productName,
      purpose: session.purpose,
      repos: prepared.repos,
      productKnowledge: await activeProductKnowledge(deps.store, session.productId),
      runtimeModel: model.runtimeModel,
      ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel }),
      ...(stored.entries.length === 0 ? {} : { entries: stored.entries }),
    },
  };
  child.send(command, (error) => {
    if (error !== null) failed?.(new Error(`无法向子进程投递任务: ${error.message}`));
  });
  await opened;
  return child;
}

/**
 * 把这个会话的子进程起出来并开跑。
 *
 * `queue` 里留存的那些先投递(上一次停止留下的,issue #334),再投这一条:子进程侧第一条
 * 立刻开跑、后面的进 Pi 的队列,顺序因此就是人当初写下它们的顺序。留存的那几条交出去之后
 * 从镜像里摘掉——排着的定义是「还没投出去」;进了 Pi 队列的那些由它的 `queue_update` 报回来。
 *
 * `first` 是提问轮次的答案那一档(issue #406):它排在留存的那几条**前面**。这一轮以提问卡
 * 收尾时留存的消息还排着,让它先投等于用一条更新的用户消息把这张卡片顶成过期——而人紧接着
 * 交上来的答案随后照样送达,卡片上的话与事实相反。留存的那几条仍按原顺序跟在答案后面。
 */
function startRun(
  sessionId: number,
  entry: RuntimeEntry,
  last: AgentSessionQueuedMessage,
  first = false,
): void {
  entry.status = "running";
  // 闸换档:这一刻起计的是执行中的连续静默(issue #335)。
  touch(sessionId, entry);
  const retained = entry.queue.splice(0, entry.queue.length);
  for (const message of first ? [last, ...retained] : [...retained, last]) {
    sendCommand(entry, {
      kind: "prompt",
      text: message.text,
      mode: message.mode,
      ...(message.images === undefined ? {} : { images: message.images }),
      seq: ++entry.queueSeq,
    });
    entry.imageRefs.push(...(message.images ?? []));
  }
}

/**
 * 会话空闲时把一条消息投出去并开跑。**同步登记「在跑」**:接口已经回了 202,而下一条消息要
 * 在这一刻就看得到它在跑——登记晚一拍,两条消息就会同时开跑。
 *
 * 子进程还没起来的那一次连带把它起出来(回收过、判死过与服务刚重启都走这一条,issue #335):
 * 起的那段时间里到的消息先攒着(`sendCommand`),建好之后按顺序补发;上一次回收或排空时落库
 * 的排队消息先回到镜像里,跟着这一条一起投出去。空闲时两种模式都等同直接开跑,`mode` 只在
 * 执行中才有分别(spec #329)。
 *
 * 辅助模型每次开跑都取当前值(ADR 0029):与子进程此刻用的那一个不同时,落一条系统消息、
 * 回收它、用新模型重建——一个会话的上下文可以续,模型不能半路换着跑。
 */
export function deliverAgentSessionMessage(
  deps: AgentSessionRuntimeDeps,
  session: AgentSessionRecord,
  text: string,
  mode: AgentSessionMessageMode,
  model: AgentSessionModel,
  repos: readonly ProductRepoRecord[],
  /** 这条消息带的那几张图(issue #336)。省略即没带图。 */
  images: readonly AgentSessionImageRef[] = [],
  /** 这一条是等着人答的那一轮提问的答案(issue #406):它排在留存的排队消息前面。 */
  first = false,
): void {
  const message: AgentSessionQueuedMessage = {
    mode,
    text,
    ...(images.length === 0 ? {} : { images }),
  };
  const key = modelKey(model);
  const existing = registry.get(session.id);
  if (existing !== undefined && existing.modelKey === key) {
    startRun(session.id, existing, message, first);
    return;
  }
  // 换模型那一条系统消息要在重建**之前**落库:`boot` 把整段记录喂回去,晚一步它就进不了
  // 这一次的上下文。接在刚收拢那个子进程还没落完的条目后面,`parentId` 才指得对。
  let switched: Promise<void> | undefined;
  if (existing !== undefined) {
    // 收拢不等在这里:这个函数得同步登记「在跑」。登记表的摘除在 `reclaim` 第一个 `await`
    // 之前就跑完了,下面那一句 `registry.set` 因此仍是「先删后设」。
    switched = reclaim(session.id, existing)
      .then(() => existing.recording)
      .catch(() => {})
      .then(() =>
        recordSystemMessage(
          deps,
          session.id,
          `辅助模型从 ${existing.modelKey} 换成 ${key},会话已用新模型重建。`,
        ),
      );
  }
  const entry: RuntimeEntry = {
    deps,
    status: "running",
    lastActiveAt: deps.now(),
    modelKey: key,
    cancelTimer: undefined,
    child: undefined,
    booting: undefined,
    sessionRoot: undefined,
    worktrees: [],
    // 留存的那几条在下面那条链里补进来(取它要读库)。
    queue: [],
    queueSeq: 0,
    opened: false,
    pending: [],
    imageRefs: [],
    disposed: false,
    recording: Promise.resolve(),
    stream: { text: "", tool: undefined, subagent: undefined, timer: undefined },
  };
  // **登记仍是同步的**:接口已经回了 202,下一条消息要在这一刻就看得到它在跑(状态在字面量
  // 里就是 `running`)。读库那几步排在下面那条链上——它们只欠一个微任务,而微任务在事件循环
  // 回到 I/O 之前就排空了,下一个 HTTP 请求插不进来。
  registry.set(session.id, entry);
  const booting = (async () => {
    await switched;
    // 上一次回收或排空时落库的那几条:它们排在这一条之前,顺序就是人当初写下的顺序。
    // `unshift` 而不是整列赋值——万一这一个微任务里有谁往镜像里加了消息,不把它抹掉。
    const pendingQueue = await takePendingQueue(deps, session.id);
    entry.queue.unshift(...pendingQueue);
    startRun(session.id, entry, message, first);
    return boot(deps, session, model, repos, entry);
  })();
  entry.booting = booting;
  void booting
    .then((child) => {
      entry.opened = true;
      const pending = entry.pending.splice(0, entry.pending.length);
      for (const command of pending) child.send(command);
    })
    .catch((error: unknown) => {
      // 起不来就把登记摘掉,下一条消息重试。已经备出来的工作树与会话根照样要放掉——备到一半
      // 失败的那一次留下的目录没人再来收。
      if (registry.get(session.id) === entry) registry.delete(session.id);
      clearTimers(entry);
      killChild(entry.child);
      void letGo(entry).catch(() => {
        // 放不掉就留着:这一条路上已经有一个失败原因要报,再盖一层只会把它埋掉。
      });
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[agent-session] 会话 ${session.id} 的子进程起不来:`, reason);
      // 以系统消息记下这一条(与静默判死同一个写法):接口早在 202 那一刻就回了,失败原因
      // 只进日志的话,人看到的是一条发出去却永远没有回音的消息。**排空那一路不记**:那一下
      // 起不来是收拢本身,「被排空中止」已经说了同一件事。
      if (!entry.disposed) {
        void recordSystemMessage(deps, session.id, `${BOOT_FAILED}${reason}`).catch(
          logSystemMessageFailure,
        );
      }
    });
}

/**
 * 执行中把一条消息按模式排进队列(issue #334)。镜像先记上:接口已经回了 202,面板紧接着读
 * 排队列表就该看得到它,子进程的 `queue_update` 到了再对齐。
 *
 * 这一条不解析仓库与辅助模型:子进程已经开着,那两样是开跑时取的值。会话不在跑时不会走到
 * 这里——接口按状态分流。
 */
export function queueAgentSessionMessage(
  sessionId: number,
  text: string,
  mode: AgentSessionMessageMode,
  at: number,
  /** 这条消息带的那几张图(issue #336)。省略即没带图。 */
  images: readonly AgentSessionImageRef[] = [],
): void {
  const entry = registry.get(sessionId);
  if (entry === undefined) return;
  entry.lastActiveAt = at;
  const attached = images.length === 0 ? {} : { images };
  // 插话排在排队之前,与子进程报来的队列同一个次序(`syncQueue`):Pi 在回合边界先取插话,
  // 排队的要等 agent 本来要停的那一刻,这就是它们实际的投递顺序。
  const firstFollowUp = entry.queue.findIndex((queued) => queued.mode === "followUp");
  if (mode === "steer" && firstFollowUp !== -1) {
    entry.queue.splice(firstFollowUp, 0, { mode, text, ...attached });
  } else {
    entry.queue.push({ mode, text, ...attached });
  }
  sendCommand(entry, { kind: "prompt", text, mode, ...attached, seq: ++entry.queueSeq });
  entry.imageRefs.push(...images);
}

/**
 * 整队清空(issue #334)。Pi 不支持单条撤回,因此只有这一个动作。
 *
 * 子进程已经被回收的那一档清的是落库的那一份(issue #335):不清它,下次发消息时这几条照样
 * 投出去,而人刚刚明明点了清空。
 *
 * 不等它的调用方照样看得到清空的效果(spec #445):清那一下在第一个 `await` 之前就跑完了
 * ——`server.ts` 紧接着同步读一次排队列表回给人,读到的是清完的那一份。
 */
export async function clearAgentSessionQueue(store: Store, sessionId: number): Promise<void> {
  const entry = registry.get(sessionId);
  if (entry === undefined) {
    await store.putAgentSessionPendingMessages(sessionId, []);
    return;
  }
  // 清掉的那几条带的图也不再等着被认领(issue #336):留着会被这一回合后面那条消息的图片块
  // 认走,对话里就配错了图。
  const dropped = new Set(entry.queue.flatMap((queued) => queued.images ?? []));
  entry.imageRefs = entry.imageRefs.filter((ref) => !dropped.has(ref));
  entry.queue = [];
  // 队列空了:空闲着的这个会话从此刻起计回收(issue #335)。
  rearm(sessionId, entry);
  sendCommand(entry, { kind: "clear-queue" });
}

/**
 * 停止(issue #334):只中止当前这一步。排队消息留在镜像里,下次开跑时投递;被中止的回复与
 * 「人点了停止」那条系统消息由子进程落进会话记录。
 *
 * 回 false 即空操作——会话空闲时没有「当前这一步」可中止,那不是错误,接口照样回 200。
 */
export function stopAgentSession(sessionId: number): boolean {
  const entry = registry.get(sessionId);
  if (entry === undefined || entry.status !== "running") return false;
  sendCommand(entry, { kind: "stop" });
  return true;
}

/** 等这个子进程退出,或等到上限。回 true 即它自己退了。 */
function exited(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * 排空:停掉全部会话子进程并释放它们占的磁盘(issue #335)。SIGTERM 那一处与测试收尾都调它。
 *
 * 在跑的那些**立即中止**:经 IPC 下一条排空指令,子进程中止当前这一步、把被中止的回复镜像
 * 出来就退出;等它退出(有宽限期,退不掉就强杀),再落一条「被排空中止」的系统消息——发版不
 * 该被一段长对话拖住,而人第二天回来要看得见这一轮为什么断了。排着的消息先落库,重启后人
 * 下次发消息时一并投递。
 *
 * 子进程不随父进程退出:它的 IPC 通道会让父进程的事件循环活着,留着不收会让退出挂住。
 */
export async function disposeAgentSessions(): Promise<void> {
  const entries = [...registry.entries()];
  registry.clear();
  for (const [sessionId, entry] of entries) {
    entry.disposed = true;
    clearTimers(entry);
    await persistQueue(sessionId, entry);
    const child = entry.child;
    // 还没 `open` 的子进程手上没有回合可中止,直接强杀(与它还没 fork 时的收拢同一结局)。
    if (entry.status === "running" && entry.opened && child !== undefined) {
      child.send({ kind: "drain" } satisfies SessionCommand, () => {
        // 通道已经断了:下面的强杀兜住它。
      });
      if (!(await exited(child, DRAIN_EXIT_GRACE_MS))) {
        console.warn(`[agent-session] 会话 ${sessionId} 的子进程没按时退出,强杀`);
      }
      // 子进程临走前镜像回来的那几条先落完:这一条是这一轮的最后一条记录,插到它们前面会让
      // 重建时算出一段旁支。
      await entry.recording.catch(() => {});
      await recordSystemMessage(entry.deps, sessionId, DRAIN_ABORTED);
    }
    killChild(child);
    await letGo(entry);
  }
}
