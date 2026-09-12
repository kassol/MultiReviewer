/**
 * Agent 会话的运行时(issue #333):登记表、投递、落库与广播。
 *
 * 与 HTTP handler 分开放:handler 只做门禁与形状校验,「这个会话此刻在不在跑、子进程在哪、
 * 记录怎么落、谁收到广播」全在这里。子进程那一侧只订阅并转发(`reviewer/session-worker.ts`),
 * 判断都在这一层(ADR 0017 同律)。
 *
 * 一会话一子进程。这一票建起来就常驻:回收、全局上限、静默判死、排空与重启后的惰性重建
 * 都在 issue #335。留给它的位置是登记表上的两格——状态与最后活动时刻。
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
  type RepoFindingQuery,
} from "../review/store.ts";
import { agentSessionChannel, publishAgentSessionRecord } from "../review/trace.ts";
import { MODEL_API_KEY_ENV, reviewerEnv } from "../reviewer/env.ts";
import type { RuntimeModel } from "../reviewer/model-service-runtime.ts";
import { FINDING_QUERY_LIMIT } from "../reviewer/session-finding-tool.ts";
import {
  AGENT_SESSION_NOTE_CUSTOM_TYPE,
  AGENT_SESSION_OUTPUT_CUSTOM_TYPE,
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

/** 登记表上的一个会话。`child` 在准备会话根与工作树那段时间里还没 fork。 */
type RuntimeEntry = {
  status: AgentSessionStatus;
  /** 最后一次活动的时刻。空闲回收(issue #335)按它判。 */
  lastActiveAt: number;
  child: ChildProcess | undefined;
  sessionRoot: string | undefined;
  worktrees: Worktree[];
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
 * 子进程活着就交给它:Pi 会话在那个进程的内存里,只写库的话活着的这一轮看不到这条消息。
 * 落库仍由镜像那一条路完成,与别的条目同形。子进程不在就直接落库,下次重建时它随整段记录
 * 回到上下文里。(子进程正在起的那一瞬按「不在」处理:定稿与开跑撞在同一秒才会发生,那一条
 * 也只是晚到下一次重建。)
 */
export function recordAgentSessionCustomMessage(
  deps: AgentSessionRecordDeps,
  sessionId: number,
  text: string,
): void {
  const child = registry.get(sessionId)?.child;
  if (child !== undefined) {
    child.send({ kind: "custom-message", text } satisfies SessionCommand);
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

/**
 * 回一次历史 Finding 查询(issue #338)。查询在这一侧做:子进程没有库连接,判断与落库都在
 * 这一层(ADR 0017 同律)。
 *
 * **恒回一条**——查不动时带上原因。子进程那边的工具调用在等这条消息,少回一次它就永远等
 * 下去。仓库在不在会话根内由子进程判(它手里就是那份清单),这里只查它问的那一个。
 */
function answerFindingQuery(
  dbPath: string,
  child: ChildProcess,
  requestId: string,
  query: RepoFindingQuery,
): void {
  let result: SessionCommand;
  const store = openStore(dbPath);
  try {
    result = {
      kind: "finding-query-result",
      requestId,
      findings: store.listRepoFindings(query, FINDING_QUERY_LIMIT),
    };
  } catch (error) {
    result = {
      kind: "finding-query-result",
      requestId,
      findings: [],
      failure: error instanceof Error ? error.message : String(error),
    };
  } finally {
    store.close();
  }
  child.send(result);
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
        for (const one of message.entries) recordEntry(deps.dbPath, session.id, one);
        return;
      case "output":
        recordAgentSessionOutput(deps, session.id, message.output);
        return;
      case "finding-query":
        answerFindingQuery(deps.dbPath, child, message.requestId, message.query);
        return;
      case "turn-end":
        entry.status = "idle";
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
 * 把一条消息投给这个会话。**同步登记「在跑」**:接口已经回了 202,而下一条消息要在这一刻
 * 就看得到它在跑——登记晚一拍,两条消息就会同时开跑。
 *
 * 会话空闲时立刻开跑;子进程还没起来的那一次连带把它起出来。排队与插话在 issue #334,所以
 * 执行中的那一次由接口挡在外面,这里不会收到。
 */
export function deliverAgentSessionMessage(
  deps: AgentSessionRuntimeDeps,
  session: AgentSessionRecord,
  text: string,
  model: AgentSessionModel,
  repos: readonly ProductRepoRecord[],
): void {
  const existing = registry.get(session.id);
  if (existing !== undefined) {
    existing.status = "running";
    existing.lastActiveAt = deps.now();
    existing.child?.send({ kind: "prompt", text } satisfies SessionCommand);
    return;
  }
  const entry: RuntimeEntry = {
    status: "running",
    lastActiveAt: deps.now(),
    child: undefined,
    sessionRoot: undefined,
    worktrees: [],
  };
  registry.set(session.id, entry);
  void boot(deps, session, model, repos, entry)
    .then((child) => {
      child.send({ kind: "prompt", text } satisfies SessionCommand);
    })
    .catch((error: unknown) => {
      // 起不来就把登记摘掉,下一条消息重试。这一票不落系统消息:它的写入口随排队与判死
      // 那两票接入(issue #334、#335)。
      if (registry.get(session.id) === entry) registry.delete(session.id);
      entry.child?.kill("SIGKILL");
      console.error(
        `[agent-session] 会话 ${session.id} 的子进程起不来:`,
        error instanceof Error ? error.message : String(error),
      );
    });
}

/**
 * 停掉全部会话子进程并释放它们的工作树。进程收尾与测试收尾用它:子进程的 IPC 通道会让
 * 父进程的事件循环活着,留着不收会让退出挂住。回收与排空的正式形态在 issue #335。
 */
export async function disposeAgentSessions(): Promise<void> {
  const entries = [...registry.values()];
  registry.clear();
  for (const entry of entries) {
    entry.child?.kill("SIGKILL");
    for (const worktree of entry.worktrees) await worktree.release();
  }
}
