/**
 * Agent 会话的运行时(issue #333):登记表、投递、落库与广播。
 *
 * 与 HTTP handler 分开放:handler 只做门禁与形状校验,「这个会话此刻在不在跑、子进程在哪、
 * 记录怎么落、谁收到广播」全在这里。子进程那一侧只订阅并转发(`reviewer/session-worker.ts`),
 * 判断都在这一层(ADR 0017 同律)。
 *
 * 一会话一子进程。这一票建起来就常驻:回收、全局上限、静默判死、排空与重启后的惰性重建
 * 都在 issue #335。留给它的位置是登记表上的两格——状态与最后活动时刻。
 *
 * 排队、插话、停止与流式帧(issue #334)也在这一层:队列的真身在 Pi 那边,登记表上记一份
 * 镜像供读接口与面板看;流式 delta 按 100ms 合并一次,经瞬时帧走同一个频道,不落库。
 *
 * 图片附件(issue #336)在这一层只做两件事:把文件引用随 `prompt` 指令发下去(base64 由
 * 子进程自己读文件填),以及落库前把镜像回来的 base64 图片块换回文件引用。落盘、缩放与
 * 互换都在 `reviewer/session-images.ts`。
 */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ThinkingLevel } from "../config.ts";
import type { Forge } from "../forge/forge.ts";
import { defaultBranchHead, prepareWorktree, type Worktree } from "../git/worktree.ts";
import type { ProjectFact, ReviewRule, ReviewerUsage } from "../review/finding.ts";
import {
  openStore,
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
import { deflateImageBlocks, type AgentSessionImageRef } from "../reviewer/session-images.ts";
import {
  AGENT_SESSION_NOTE_CUSTOM_TYPE,
  AGENT_SESSION_OUTPUT_CUSTOM_TYPE,
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

/** 登记表上的一个会话。`child` 在准备会话根与工作树那段时间里还没 fork。 */
type RuntimeEntry = {
  status: AgentSessionStatus;
  /** 最后一次活动的时刻。空闲回收(issue #335)按它判。 */
  lastActiveAt: number;
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
   * 已经投出去、还没在镜像回来的条目里认领的那几张图(issue #336)。顺序即投递顺序:镜像
   * 回来的用户消息里第 k 个 base64 图片块配第 k 个引用,落库前换过去。回合结束即清空——
   * 模型那一侧把图丢了的话,这几张不该串到下一回合的消息上。
   */
  imageRefs: AgentSessionImageRef[];
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
  if (entry.child === undefined) entry.pending.push(command);
  else entry.child.send(command);
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
    throw new Error("会话已经收拢");
  }

  let ready: (() => void) | undefined;
  let failed: ((error: Error) => void) | undefined;
  const opened = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });

  child.on("message", (message: SessionWorkerMessage) => {
    entry.lastActiveAt = deps.now();
    switch (message.kind) {
      case "ready":
        ready?.();
        return;
      case "entries":
        // 图片块在这一步换成文件引用(issue #336):库里不存 base64,记录表因此不随图片长大。
        for (const one of message.entries) {
          recordEntry(deps.dbPath, session.id, deflateImageBlocks(one, entry.imageRefs));
        }
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
        // 这一回合投出去的图都该被认领过了。没认领的不留到下一回合:那只会把图串到别的消息上。
        entry.imageRefs.length = 0;
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
    // 子进程没了就从登记表上摘掉:下一条消息重新起一个。判死与惰性重建在 issue #335。
    if (registry.get(session.id) === entry) registry.delete(session.id);
    failed?.(
      new Error(
        signal === null ? `子进程退出,退出码 ${code}` : `子进程被信号 ${signal} 终止`,
      ),
    );
  });

  const command: SessionCommand = {
    kind: "open",
    request: {
      sessionRoot: prepared.sessionRoot,
      purpose: session.purpose,
      repos: prepared.repos,
      runtimeModel: model.runtimeModel,
      ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel }),
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
  deps: AgentSessionRuntimeDeps,
  entry: RuntimeEntry,
  last: AgentSessionQueuedMessage,
): void {
  entry.status = "running";
  entry.lastActiveAt = deps.now();
  const retained = entry.queue.splice(0, entry.queue.length);
  for (const message of [...retained, last]) {
    sendCommand(entry, {
      kind: "prompt",
      text: message.text,
      mode: message.mode,
      ...(message.images === undefined ? {} : { images: message.images }),
    });
    entry.imageRefs.push(...(message.images ?? []));
  }
}

/**
 * 会话空闲时把一条消息投出去并开跑。**同步登记「在跑」**:接口已经回了 202,而下一条消息要
 * 在这一刻就看得到它在跑——登记晚一拍,两条消息就会同时开跑。
 *
 * 子进程还没起来的那一次连带把它起出来;起的那段时间里到的消息先攒着(`sendCommand`),建好
 * 之后按顺序补发。空闲时两种模式都等同直接开跑,`mode` 只在执行中才有分别(spec #329)。
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
): void {
  const message: AgentSessionQueuedMessage = {
    mode,
    text,
    ...(images.length === 0 ? {} : { images }),
  };
  const existing = registry.get(session.id);
  if (existing !== undefined) {
    startRun(deps, existing, message);
    return;
  }
  const entry: RuntimeEntry = {
    status: "running",
    lastActiveAt: deps.now(),
    child: undefined,
    sessionRoot: undefined,
    worktrees: [],
    queue: [],
    pending: [],
    imageRefs: [],
    disposed: false,
    stream: { text: "", tool: undefined, timer: undefined },
  };
  registry.set(session.id, entry);
  startRun(deps, entry, message);
  void boot(deps, session, model, repos, entry)
    .then((child) => {
      const pending = entry.pending.splice(0, entry.pending.length);
      for (const command of pending) child.send(command);
    })
    .catch((error: unknown) => {
      // 起不来就把登记摘掉,下一条消息重试。这一票不落系统消息:它的写入口随判死那一票
      // 接入(issue #335)。
      if (registry.get(session.id) === entry) registry.delete(session.id);
      entry.child?.kill("SIGKILL");
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
  sendCommand(entry, { kind: "prompt", text, mode, ...attached });
  entry.imageRefs.push(...images);
}

/** 整队清空(issue #334)。Pi 不支持单条撤回,因此只有这一个动作。 */
export function clearAgentSessionQueue(sessionId: number): void {
  const entry = registry.get(sessionId);
  if (entry === undefined) return;
  // 清掉的那几条带的图也不再等着被认领(issue #336):留着会被这一回合后面那条消息的图片块
  // 认走,对话里就配错了图。
  const dropped = new Set(entry.queue.flatMap((queued) => queued.images ?? []));
  entry.imageRefs = entry.imageRefs.filter((ref) => !dropped.has(ref));
  entry.queue = [];
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

/**
 * 停掉全部会话子进程并释放它们的工作树。进程收尾与测试收尾用它:子进程的 IPC 通道会让
 * 父进程的事件循环活着,留着不收会让退出挂住。回收与排空的正式形态在 issue #335。
 */
export async function disposeAgentSessions(): Promise<void> {
  const entries = [...registry.values()];
  registry.clear();
  for (const entry of entries) {
    entry.disposed = true;
    if (entry.stream.timer !== undefined) clearTimeout(entry.stream.timer);
    entry.child?.kill("SIGKILL");
    for (const worktree of entry.worktrees) await worktree.release();
  }
}
