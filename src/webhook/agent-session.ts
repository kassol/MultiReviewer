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
import type { ProjectFact, ReviewRule, ReviewerUsage } from "../review/finding.ts";
import {
  openStore,
  type AgentSessionEntryLink,
  type AgentSessionOutputRecord,
  type AgentSessionRecord,
  type AgentSessionStatus,
  type ProductRepoRecord,
} from "../review/store.ts";
import {
  agentSessionChannel,
  publishAgentSessionRecord,
  publishTransientTrace,
} from "../review/trace.ts";
import { MODEL_API_KEY_ENV, reviewerEnv } from "../reviewer/env.ts";
import type { RuntimeModel } from "../reviewer/model-service-runtime.ts";
import {
  AGENT_SESSION_NOTE_CUSTOM_TYPE,
  AGENT_SESSION_OUTPUT_CUSTOM_TYPE,
  SYSTEM_MESSAGE_ENTRY,
  type AgentSessionMessageMode,
  type SessionCommand,
  type SessionOutput,
  type SessionRepoInput,
  type SessionWorkerMessage,
} from "../reviewer/session-protocol.ts";

const WORKER_PATH = fileURLToPath(new URL("../reviewer/session-worker.ts", import.meta.url));

/** 运行时要的那几样。`forge` 取 Gitea 那一个(ADR 0014)。 */
export type AgentSessionRuntimeDeps = {
  dbPath: string;
  cacheDir: string;
  forge: Forge;
  now: () => number;
  /** 空闲回收的门槛(毫秒),默认 `IDLE_RECLAIM_MS`。只该测试注入。 */
  idleReclaimMs?: number;
  /** 执行中静默判死的门槛(毫秒),默认 `SILENCE_TIMEOUT_MS`。只该测试注入。 */
  silenceTimeoutMs?: number;
};

/**
 * 往记录表里落一条要的那两样(issue #337)。产出与定稿不起子进程、不取代码,因此不要整份
 * 运行时依赖——没配 Forge 的部署里定稿照样定得下去。
 */
export type AgentSessionRecordDeps = Pick<AgentSessionRuntimeDeps, "dbPath" | "now">;

/** 这次开跑用的辅助模型(ADR 0029)。解析在 server.ts 那一处,运行时只认结论。 */
export type AgentSessionModel = {
  runtimeModel: RuntimeModel;
  credential: string;
  thinkingLevel?: ThinkingLevel;
};

/** 排队中的一条消息(issue #334):模式与正文。Pi 不支持单条撤回,因此没有标识这一格。 */
export type AgentSessionQueuedMessage = { mode: AgentSessionMessageMode; text: string };

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

/** 被排空中止那一条系统消息(spec #329 的部署人员那几条)。 */
const DRAIN_ABORTED = "服务在发版排空,这一轮被中止。下次发消息时会从记录重建,接着这里续谈。";

/** 登记表上的一个会话。`child` 在准备会话根与工作树那段时间里还没 fork。 */
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
  timer: NodeJS.Timeout | undefined;
  child: ChildProcess | undefined;
  sessionRoot: string | undefined;
  worktrees: Worktree[];
  /**
   * 排队列表的镜像(issue #334)。真队列在 Pi 那边,这一份供读接口与面板看:子进程每次报
   * `queue_update` 就按它对齐。停止时 Pi 那边被清空而这一份留着——排队消息因此不随停止丢掉,
   * 下次开跑时从这里投递。
   */
  queue: AgentSessionQueuedMessage[];
  /** 子进程还没 fork 出来时攒下的指令。建好之后按顺序补发,一条都不丢。 */
  pending: SessionCommand[];
  /**
   * 已经收拢过。`disposeAgentSessions` 可能正赶上这个会话在备工作树:那时还没 fork,杀不到
   * 子进程,而备完之后照样会 fork 出一个——它的 IPC 通道会让进程再也退不出去。这一格让那一下
   * fork 之后当场收掉。
   */
  disposed: boolean;
  /** 这一次合并窗口里攒下的流式帧内容。`timer` 不为空即窗口开着。 */
  stream: { text: string; tool: string | undefined; timer: NodeJS.Timeout | undefined };
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
 * 这个会话此刻排着哪几条消息(issue #334)。队列是进程内的事实,与「在跑」同律不落库:
 * 没有子进程即空队列。
 */
export function agentSessionQueue(sessionId: number): readonly AgentSessionQueuedMessage[] {
  return registry.get(sessionId)?.queue ?? [];
}

/**
 * agent 读得到的仓库:产品当前仓库 ∩ 创建者当前仓库分配(spec #329)。系统管理员不受限,
 * 拿到的是产品的全部仓库。产品没了或创建者的账号没了即空集。
 */
export function agentSessionRepos(
  dbPath: string,
  session: AgentSessionRecord,
): ProductRepoRecord[] {
  const store = openStore(dbPath);
  try {
    const product = store.getProduct(session.productId);
    if (product === undefined) return [];
    const user = store.listPanelUsers().find((row) => row.username === session.createdBy);
    if (user === undefined) return [];
    if (user.isSystemAdmin) return product.repos;
    const assigned = new Set(user.repoIds);
    return product.repos.filter((repo) => assigned.has(repo.repoId));
  } finally {
    store.close();
  }
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
function recordEntry(dbPath: string, sessionId: number, entry: unknown): void {
  const store = openStore(dbPath);
  try {
    const record = store.appendAgentSessionEntry(sessionId, {
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
  } finally {
    store.close();
  }
}

/**
 * 把攒下的流式帧广播出去(issue #334)。瞬时帧不落库、没有 seq,断线重连因此不回放它;
 * 没有在线订阅者时 `publishTransientTrace` 是空操作。
 */
function flushStream(sessionId: number, entry: RuntimeEntry): void {
  const { text, tool, timer } = entry.stream;
  if (timer !== undefined) clearTimeout(timer);
  entry.stream = { text: "", tool: undefined, timer: undefined };
  if (text === "" && tool === undefined) return;
  publishTransientTrace(agentSessionChannel(sessionId), {
    kind: AGENT_SESSION_STREAM_FRAME,
    // 正在生成的文字与正在跑的工具分两格:页面要把它们摊成两样东西。
    payload: { text, ...(tool === undefined ? {} : { tool }) },
  });
}

/** 攒一段流式帧内容,窗口没开就开一个。 */
function collectStream(
  sessionId: number,
  entry: RuntimeEntry,
  part: { text?: string; tool?: string },
): void {
  entry.stream.text += part.text ?? "";
  if (part.tool !== undefined) entry.stream.tool = part.tool;
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
  entry.queue = [
    ...reported.steering.map((text) => ({ mode: "steer" as const, text })),
    ...reported.followUp.map((text) => ({ mode: "followUp" as const, text })),
  ];
}

/** 投一条指令给子进程。它还没 fork 出来时先攒着,建好之后按顺序补发。 */
function sendCommand(entry: RuntimeEntry, command: SessionCommand): void {
  if (entry.child === undefined) entry.pending.push(command);
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
function recordSystemMessage(
  deps: AgentSessionRecordDeps,
  sessionId: number,
  text: string,
): void {
  recordEntry(deps.dbPath, sessionId, {
    ...ownEntryBase(deps, sessionId),
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

/** 这个会话的记录重建后有几条进不了上下文。读接口按它给面板那道横幅。 */
export function agentSessionDroppedFromContext(dbPath: string, sessionId: number): number {
  const store = openStore(dbPath);
  try {
    return agentSessionContextGap(store.agentSessionEntryLinks(sessionId));
  } finally {
    store.close();
  }
}

/** 这个会话的两个计时器都停掉:生命周期那一档与流式合并窗口。 */
function clearTimers(entry: RuntimeEntry): void {
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  entry.timer = undefined;
  if (entry.stream.timer !== undefined) clearTimeout(entry.stream.timer);
  entry.stream.timer = undefined;
}

/**
 * 按当前状态重排这个会话的闸:执行中是静默判死,空闲是回收。**空闲且排着消息时两个都不排**
 * ——那几条还等着人回来让它接着跑,回收会把这个会话的「下一步」悄悄推到重建之后。
 */
function rearm(sessionId: number, entry: RuntimeEntry): void {
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  entry.timer = undefined;
  if (entry.disposed) return;
  if (entry.status === "running") {
    const silence = entry.deps.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS;
    entry.timer = setTimeout(() => silenceDeath(sessionId, entry), silence);
    return;
  }
  if (entry.queue.length > 0) return;
  const idle = entry.deps.idleReclaimMs ?? IDLE_RECLAIM_MS;
  entry.timer = setTimeout(() => reclaimIdle(sessionId, entry), idle);
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
function persistQueue(sessionId: number, entry: RuntimeEntry): void {
  if (entry.queue.length === 0) return;
  const store = openStore(entry.deps.dbPath);
  try {
    store.putAgentSessionPendingMessages(sessionId, entry.queue);
  } catch (error) {
    console.error(
      `[agent-session] 会话 ${sessionId} 的排队消息落库失败:`,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    store.close();
  }
}

/** 上一次回收或排空时落库的排队消息,取出即删(issue #335)。 */
function takePendingQueue(deps: AgentSessionRuntimeDeps, sessionId: number): AgentSessionQueuedMessage[] {
  const store = openStore(deps.dbPath);
  try {
    return store.takeAgentSessionPendingMessages(sessionId).map((message) => ({
      // 库里那一格是字符串(领域类型定在 `reviewer/`,那个目录依赖 `review/`),在这里收口。
      mode: message.mode === "steer" ? ("steer" as const) : ("followUp" as const),
      text: message.text,
    }));
  } finally {
    store.close();
  }
}

/** 放掉这个会话占的磁盘:每棵一次性工作树各自释放,再删会话根(它下面只剩空目录)。 */
async function letGo(entry: RuntimeEntry): Promise<void> {
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
 */
function reclaim(sessionId: number, entry: RuntimeEntry): void {
  if (registry.get(sessionId) === entry) registry.delete(sessionId);
  entry.disposed = true;
  clearTimers(entry);
  persistQueue(sessionId, entry);
  entry.child?.kill("SIGKILL");
  void letGo(entry).catch((error: unknown) => {
    console.error(
      `[agent-session] 会话 ${sessionId} 的会话根没清干净:`,
      error instanceof Error ? error.message : String(error),
    );
  });
}

/** 空闲满门槛:回收。上下文在库里,下一条消息自然重建(issue #335)。 */
function reclaimIdle(sessionId: number, entry: RuntimeEntry): void {
  const minutes = (entry.deps.idleReclaimMs ?? IDLE_RECLAIM_MS) / 60_000;
  console.log(`[agent-session] 会话 ${sessionId} 空闲满 ${minutes} 分钟,回收子进程`);
  reclaim(sessionId, entry);
}

/**
 * 执行中连续静默满门槛:判死(issue #335)。杀进程、登记表摘掉,再以系统消息记下这一条
 * ——会话记录里得留着这一轮为什么断了,不然人只看到对话突然停住。
 */
function silenceDeath(sessionId: number, entry: RuntimeEntry): void {
  const minutes = (entry.deps.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS) / 60_000;
  console.error(`[agent-session] 会话 ${sessionId} 执行中连续 ${minutes} 分钟静默,判死`);
  reclaim(sessionId, entry);
  recordSystemMessage(entry.deps, sessionId, SILENCE_ABORTED);
}

/**
 * 这个会话此刻有没有常驻名额(issue #335)。已经常驻着的、以及还没满上限的都有;满了就回收
 * 最久空闲的那一个腾出来(它的上下文在库里),全都在跑时回 false——接口据此回 409。
 */
export function agentSessionSlot(sessionId: number): boolean {
  if (registry.has(sessionId)) return true;
  if (registry.size < MAX_RESIDENT_SESSIONS) return true;
  let idlest: { sessionId: number; entry: RuntimeEntry } | undefined;
  for (const [id, entry] of registry) {
    if (entry.status !== "idle") continue;
    if (idlest === undefined || entry.lastActiveAt < idlest.entry.lastActiveAt) {
      idlest = { sessionId: id, entry };
    }
  }
  if (idlest === undefined) return false;
  console.log(
    `[agent-session] 常驻名额已满,回收最久空闲的会话 ${idlest.sessionId} 给会话 ${sessionId} 腾位置`,
  );
  reclaim(idlest.sessionId, idlest.entry);
  return true;
}

/**
 * 主进程自己往记录表里落一条 Pi 条目时,它的那三格底子(issue #337)。
 *
 * `parentId` 接在此刻最后一条记录上:重建时 Pi 顺着 `parentId` 上行,指空了就静默丢掉断点
 * 之前的全部历史(ADR 0031)。一次全量读记录在这里付得起——一个会话里交产出与定稿只有
 * 几次,而面板每打开一次读的就是同一份。
 */
function ownEntryBase(
  deps: AgentSessionRecordDeps,
  sessionId: number,
): { id: string; parentId: string | null; timestamp: string } {
  const store = openStore(deps.dbPath);
  try {
    const last = store.listAgentSessionEntries(sessionId).at(-1)?.entry as
      | { id?: unknown }
      | undefined;
    return {
      id: randomUUID(),
      parentId: typeof last?.id === "string" ? last.id : null,
      timestamp: new Date(deps.now()).toISOString(),
    };
  } finally {
    store.close();
  }
}

/**
 * 收下一份会话产出(issue #337):落产出表一个新版本,再在记录表上留一条 `custom` 条目
 * ——对话流里由它长出产出卡片,点开把右栏切到那一版。
 *
 * `custom` 条目不进模型上下文(ADR 0031),这正是要的:产出的内容模型刚刚自己交出来,
 * 再塞回上下文只是同一份东西占两遍窗口。进上下文的只有人做的定稿与换版。
 */
export function recordAgentSessionOutput(
  deps: AgentSessionRecordDeps,
  sessionId: number,
  output: SessionOutput,
): void {
  const store = openStore(deps.dbPath);
  let stored: AgentSessionOutputRecord;
  try {
    stored = store.appendAgentSessionOutput(sessionId, {
      kind: output.kind,
      payload: output.payload,
      toolCallId: output.toolCallId,
      createdAt: new Date(deps.now()).toISOString(),
    });
  } catch (error) {
    console.error(
      `[agent-session] 会话 ${sessionId} 的产出落库失败:`,
      error instanceof Error ? error.message : String(error),
    );
    return;
  } finally {
    store.close();
  }
  recordEntry(deps.dbPath, sessionId, {
    ...ownEntryBase(deps, sessionId),
    type: "custom",
    customType: AGENT_SESSION_OUTPUT_CUSTOM_TYPE,
    data: { kind: stored.kind, version: stored.version },
  });
}

/**
 * 把一条进模型上下文的消息放进会话(issue #337)。定稿与换版走它:agent 下一轮得知道哪一版
 * 定了,不再改已定的方向。
 *
 * 会话在登记表上就交给子进程那一侧:Pi 会话在那个进程的内存里,只写库的话活着的这一轮看不到
 * 这条消息。子进程还在 fork 的路上时这一条先进 `pending`(issue #334),建好之后随别的指令
 * 按顺序补发。落库仍由镜像那一条路完成,与别的条目同形。登记表上没有这个会话就直接落库,
 * 下次重建时它随整段记录回到上下文里。
 */
export function recordAgentSessionCustomMessage(
  deps: AgentSessionRecordDeps,
  sessionId: number,
  text: string,
): void {
  const entry = registry.get(sessionId);
  if (entry !== undefined) {
    sendCommand(entry, { kind: "custom-message", text });
    return;
  }
  recordEntry(deps.dbPath, sessionId, {
    ...ownEntryBase(deps, sessionId),
    type: "custom_message",
    customType: AGENT_SESSION_NOTE_CUSTOM_TYPE,
    content: text,
    display: true,
  });
}

/** 这个仓库生效知识集里的两型条目,按仓库分段注入系统提示(沿用现有格式)。 */
function repoKnowledge(
  dbPath: string,
  repoId: number,
): { rules: ReviewRule[]; facts: ProjectFact[] } {
  const store = openStore(dbPath);
  try {
    const entries = store.getRuleSet(repoId)?.rules ?? [];
    const pick = (type: string): ReviewRule[] =>
      entries
        .filter((entry) => entry.type === type)
        .map((entry) => ({ id: entry.id, scope: entry.scope, statement: entry.statement }));
    return { rules: pick("rule"), facts: pick("fact") };
  } finally {
    store.close();
  }
}

/**
 * 备好会话根:一个临时目录,下面按 `<owner>/<repo>` 各挂一棵一次性工作树,检出默认分支
 * 最新。位置即工具面的判据——路径前缀就是仓库,圈根就是圈这个目录。
 */
async function prepareSessionRoot(
  deps: AgentSessionRuntimeDeps,
  repos: readonly ProductRepoRecord[],
  entry: RuntimeEntry,
): Promise<{ sessionRoot: string; repos: SessionRepoInput[] }> {
  const sessionRoot = mkdtempSync(join(tmpdir(), "multireviewer-session-root-"));
  entry.sessionRoot = sessionRoot;
  const prepared: SessionRepoInput[] = [];
  for (const repo of repos) {
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
    const headSha = await defaultBranchHead(clone, repository);
    const worktree = await prepareWorktree({
      ...clone,
      headSha,
      baseSha: headSha,
      path: join(sessionRoot, repo.owner, repo.repo),
    });
    entry.worktrees.push(worktree);
    prepared.push({ ...ref, ...repoKnowledge(deps.dbPath, repo.repoId) });
  }
  return { sessionRoot, repos: prepared };
}

/**
 * 这个会话此前的全部记录,喂回子进程重建 Pi 会话用(ADR 0031,issue #335);另带上自检结论。
 *
 * 喂的是**全量**,不是「进上下文的那些」:`getSessionStats()` 按全部条目累加,只喂上下文视图
 * 会让用量在每次重建后从压缩点重新起算。链不完整时照样喂——Pi 按它自己的规则截断,会话上那个
 * 「前 N 条不在上下文」由读接口算给面板,不拒绝续谈。
 */
function storedSession(dbPath: string, sessionId: number): { entries: unknown[]; gap: number } {
  const store = openStore(dbPath);
  try {
    return {
      entries: store.listAgentSessionEntries(sessionId).map((record) => record.entry),
      gap: agentSessionContextGap(store.agentSessionEntryLinks(sessionId)),
    };
  } finally {
    store.close();
  }
}

/** 起这个会话的常驻子进程,建好 Pi 会话之后兑现。 */
async function boot(
  deps: AgentSessionRuntimeDeps,
  session: AgentSessionRecord,
  model: AgentSessionModel,
  repos: readonly ProductRepoRecord[],
  entry: RuntimeEntry,
): Promise<ChildProcess> {
  const prepared = await prepareSessionRoot(deps, repos, entry);
  const child = fork(WORKER_PATH, {
    // cwd 是会话根。只设 Pi 的 cwd 不够:模型会拼出相对于编排进程目录的路径。
    cwd: prepared.sessionRoot,
    env: reviewerEnv(process.env, { [MODEL_API_KEY_ENV]: model.credential }),
    // 不继承父进程的 execArgv:worker 是普通脚本,在 `node --test` 下会被当成测试文件启动。
    execArgv: [],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  entry.child = child;
  // 备工作树那段时间里这个会话被收拢了:这一个子进程没人再用得上。
  if (entry.disposed) {
    child.kill("SIGKILL");
    // 那一次收拢放掉的是它当时看到的会话根;这一份是在那之后才备出来的,登记表上重新指上
    // 它,失败那条路上的 `letGo` 才收得到(不然这个目录没人再来收)。
    entry.sessionRoot = prepared.sessionRoot;
    throw new Error("会话已经收拢");
  }

  let ready: (() => void) | undefined;
  let failed: ((error: Error) => void) | undefined;
  const opened = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });

  child.on("message", (message: SessionWorkerMessage) => {
    // 每条回传都是活着的证据:静默闸从头再来(issue #335)。
    touch(session.id, entry);
    switch (message.kind) {
      case "ready":
        ready?.();
        return;
      case "entries":
        for (const one of message.entries) recordEntry(deps.dbPath, session.id, one);
        return;
      case "output":
        recordAgentSessionOutput(deps, session.id, message.output);
        return;
      case "queue":
        syncQueue(entry, message);
        return;
      case "delta":
        collectStream(session.id, entry, { text: message.text });
        return;
      case "tool":
        collectStream(session.id, entry, { tool: message.tool });
        return;
      case "turn-end":
        entry.status = "idle";
        // 闸换档:执行中计静默,空闲计回收(issue #335)。
        rearm(session.id, entry);
        // 这一回合的最后一截流式内容该出去了:下一次开跑之前不会再有帧把窗口推开。
        flushStream(session.id, entry);
        if (message.failure !== undefined) {
          console.error(`[agent-session] 会话 ${session.id} 这一回合失败:${message.failure}`);
        }
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

  // 重建:整段记录原样喂回去(issue #335)。新会话那一次是空数组,与不给等价。
  const stored = storedSession(deps.dbPath, session.id);
  if (stored.gap > 0) {
    console.warn(
      `[agent-session] 会话 ${session.id} 的记录有缺损,重建后前 ${stored.gap} 条不在上下文里`,
    );
  }
  const command: SessionCommand = {
    kind: "open",
    request: {
      sessionRoot: prepared.sessionRoot,
      purpose: session.purpose,
      repos: prepared.repos,
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
 */
function startRun(
  sessionId: number,
  entry: RuntimeEntry,
  last: AgentSessionQueuedMessage,
): void {
  entry.status = "running";
  // 闸换档:这一刻起计的是执行中的连续静默(issue #335)。
  touch(sessionId, entry);
  const retained = entry.queue.splice(0, entry.queue.length);
  for (const message of [...retained, last]) {
    sendCommand(entry, { kind: "prompt", text: message.text, mode: message.mode });
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
): void {
  const key = modelKey(model);
  const existing = registry.get(session.id);
  if (existing !== undefined && existing.modelKey === key) {
    startRun(session.id, existing, { mode, text });
    return;
  }
  if (existing !== undefined) {
    reclaim(session.id, existing);
    recordSystemMessage(
      deps,
      session.id,
      `辅助模型从 ${existing.modelKey} 换成 ${key},会话已用新模型重建。`,
    );
  }
  const entry: RuntimeEntry = {
    deps,
    status: "running",
    lastActiveAt: deps.now(),
    modelKey: key,
    timer: undefined,
    child: undefined,
    sessionRoot: undefined,
    worktrees: [],
    // 上一次回收或排空时落库的那几条:它们排在这一条之前,顺序就是人当初写下的顺序。
    queue: takePendingQueue(deps, session.id),
    pending: [],
    disposed: false,
    stream: { text: "", tool: undefined, timer: undefined },
  };
  registry.set(session.id, entry);
  startRun(session.id, entry, { mode, text });
  void boot(deps, session, model, repos, entry)
    .then((child) => {
      const pending = entry.pending.splice(0, entry.pending.length);
      for (const command of pending) child.send(command);
    })
    .catch((error: unknown) => {
      // 起不来就把登记摘掉,下一条消息重试。不落系统消息:接口那一侧已经把失败原因回给人了,
      // 而这一下连 Pi 会话都没建起来,记录里也就没有「这一轮」。已经备出来的工作树与会话根
      // 照样要放掉——备到一半失败的那一次留下的目录没人再来收。
      if (registry.get(session.id) === entry) registry.delete(session.id);
      clearTimers(entry);
      entry.child?.kill("SIGKILL");
      void letGo(entry).catch(() => {
        // 放不掉就留着:这一条路上已经有一个失败原因要报,再盖一层只会把它埋掉。
      });
      console.error(
        `[agent-session] 会话 ${session.id} 的子进程起不来:`,
        error instanceof Error ? error.message : String(error),
      );
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
): void {
  const entry = registry.get(sessionId);
  if (entry === undefined) return;
  entry.lastActiveAt = at;
  // 插话排在排队之前,与子进程报来的队列同一个次序(`syncQueue`):Pi 在回合边界先取插话,
  // 排队的要等 agent 本来要停的那一刻,这就是它们实际的投递顺序。
  const firstFollowUp = entry.queue.findIndex((queued) => queued.mode === "followUp");
  if (mode === "steer" && firstFollowUp !== -1) {
    entry.queue.splice(firstFollowUp, 0, { mode, text });
  } else {
    entry.queue.push({ mode, text });
  }
  sendCommand(entry, { kind: "prompt", text, mode });
}

/** 整队清空(issue #334)。Pi 不支持单条撤回,因此只有这一个动作。 */
export function clearAgentSessionQueue(sessionId: number): void {
  const entry = registry.get(sessionId);
  if (entry === undefined) return;
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
    persistQueue(sessionId, entry);
    const child = entry.child;
    if (entry.status === "running" && child !== undefined) {
      child.send({ kind: "drain" } satisfies SessionCommand, () => {
        // 通道已经断了:下面的强杀兜住它。
      });
      if (!(await exited(child, DRAIN_EXIT_GRACE_MS))) {
        console.warn(`[agent-session] 会话 ${sessionId} 的子进程没按时退出,强杀`);
      }
      recordSystemMessage(entry.deps, sessionId, DRAIN_ABORTED);
    }
    child?.kill("SIGKILL");
    await letGo(entry);
  }
}
