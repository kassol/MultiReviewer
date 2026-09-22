/**
 * Agent 会话真实链路那几个测试文件的公用 harness(issue #333、#399):起假模型服务与面板
 * harness、建产品与会话,再加上「等到外部事实出现」的那几个轮询。
 *
 * 一条用例一套 harness、一个真的子进程,因此每条都按秒计;拆成 `agent-session-subprocess`
 * (主链路、图片、排队插话停止流式)、`agent-session-purposes`(用途与工具面)、
 * `agent-session-reclaim`(空闲回收与常驻名额)与 `agent-session-rebuild`(判死、换模型与
 * 重建)四个文件之后它们并行跑,壁钟由最长的那一个说(issue #399)。断言一格未动。
 */
import assert from "node:assert/strict";

import type { ReviewerUsage } from "../../src/review/finding.ts";
import { openStore } from "../../src/review/store/index.ts";
import {
  GITEA_REPO,
  HARNESS_SPEC,
  scopedUser,
  seedAvailableModelService,
  seedRepo,
  startPanelHarness,
  type PanelHarness,
  type PanelHarnessOptions,
} from "./panel-harness.ts";
import { seedReviewRule } from "./store-seed.ts";
import { startModelStub, type StubRequest, type StubTurn } from "./model-stub.ts";

const PASSWORD = "agent-session-harness-password";

/**
 * 等外部事实出现的那几个轮询:间隔与总预算(issue #399)。间隔短一点,每一次等都少压一截
 * 空转——一条用例等好几次,100 毫秒的间隔攒起来就是几百毫秒。总预算仍是 30 秒。
 */
export const POLL_MS = 25;
export const POLL_ATTEMPTS = 30_000 / POLL_MS;

/** 永不放行的那一次响应(issue #397 的写法):这一轮挂在模型那一侧,等着被中止。 */
export const NEVER: Promise<never> = new Promise(() => {});
export const AT = "2026-09-12T00:00:00.000Z";

/** 知识集里的两条。陈述不进提示(issue #344),断言因此落在那一行条数上。 */
export const RULE = "每个导出函数都要有 JSDoc 注释";
export const FACT = "这个仓库的持久化只用 node:sqlite";

/** 发给 agent 的那句话。同样独一无二。 */
export const MESSAGE = "把「报销单可以撤回」拆成可实现的条目";

export type Record = {
  seq: number;
  type: string;
  entry: { type: string; message?: { role: string; content: unknown } };
  usage: ReviewerUsage;
};

/** 起 harness 时可以拨动的那几样(issue #335)。省略即取服务默认值。 */
export type SessionHarnessOptions = {
  /** 这个会话的用途。省略即需求拆分;开放对话那几例(issue #364)另给。 */
  purpose?: string;
  /** 空闲回收门槛(毫秒)。验「回收后再发消息从记录重建」的用例拨到毫秒级。 */
  idleReclaimMs?: number;
  /** 静默闸的时钟。省略即真实时间;验判死的用例自己说了算,不等满门槛。 */
  silenceTimer?: PanelHarnessOptions["agentSessionSilenceTimer"];
  /** 这个模型服务上的模型。省略即只有 harness 那一个;验模型切换的用例给两个。 */
  models?: readonly string[];
  /** 模型声明的字段。验 compaction 的用例给一个小上下文窗口。 */
  fields?: { contextWindow?: number };
  /** 这个产品下再建几个会话(验常驻名额上限用)。 */
  extraSessions?: number;
  /** 模型目录声明的输入能力(issue #336)。省略即只有文本,图片用例传含 image 的那一份。 */
  input?: readonly ("text" | "image")[];
  /** 换一份 Forge(评审复核):备会话根要经它取仓库,造「子进程起不来」用它。 */
  wrapForge?: PanelHarnessOptions["wrapForge"];
  /**
   * 产品下再归入一个仓库(issue #345)。产品梳理要产品有两个以上仓库;内存 Forge 对每个
   * 仓库都回同一份夹具仓库,两棵工作树因此都备得出来。
   */
  extraRepo?: { repoId: number; owner: string; repo: string };
};

/**
 * 起一套指向假模型服务的 harness:注册 harness 那个仓库、建产品、给创建者 agent:chat,
 * 回会话 id 与创建者的 cookie。模型服务的地址就是假服务的地址,因此解析出的辅助模型
 * (生效组合首个)打到它上面。
 */
export async function startSessionHarness(
  turns: readonly StubTurn[],
  options: SessionHarnessOptions = {},
): Promise<{
  h: PanelHarness;
  cookie: string;
  sessionId: number;
  /** 这个产品下另外几个会话的 id(`extraSessions` 给了才有),按建立顺序。 */
  extraSessionIds: number[];
  productId: number;
  requests: Awaited<Awaited<ReturnType<typeof startModelStub>>>["requests"];
  close: () => Promise<void>;
}> {
  const stub = await startModelStub(turns);
  const h = await startPanelHarness({
    ...(options.idleReclaimMs === undefined
      ? {}
      : { agentSessionIdleReclaimMs: options.idleReclaimMs }),
    ...(options.silenceTimer === undefined
      ? {}
      : { agentSessionSilenceTimer: options.silenceTimer }),
    ...(options.wrapForge === undefined ? {} : { wrapForge: options.wrapForge }),
  });
  await seedAvailableModelService(
    h,
    HARNESS_SPEC.provider,
    options.models ?? [HARNESS_SPEC.model],
    {
      ...(options.fields ?? {}),
      ...(options.input === undefined ? {} : { input: [...options.input] }),
    },
    stub.baseUrl,
  );
  assert.equal(
    (await h.api("POST", "/repos", { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo })).status,
    201,
  );
  await seedReviewRule(h.db.url, GITEA_REPO.id, { type: "rule", scope: "", statement: RULE });
  await seedReviewRule(h.db.url, GITEA_REPO.id, { type: "fact", scope: "src", statement: FACT });

  const created = await h.api("POST", "/products", { name: "报销系统" });
  assert.equal(created.status, 201);
  const { product } = (await created.json()) as { product: { id: number } };
  assert.equal((await h.api("PUT", `/products/${product.id}/repos/${GITEA_REPO.id}`)).status, 204);
  if (options.extraRepo !== undefined) {
    const extra = options.extraRepo;
    await seedRepo(h, extra.repoId, extra.owner, extra.repo);
    // 第二个仓库直接落归属行:走归入端点会自己开一场梳理(issue #347),而这几例要的是它们
    // 自己投的那一条消息,不是那一场。
    const store = openStore(h.db.url);
    try {
      assert.equal(await store.attachProductRepo(product.id, extra.repoId, AT), "attached");
    } finally {
      await store.close();
    }
  }
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const response = await fetch(`${h.serverUrl}/api/products/${product.id}/sessions`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ purpose: options.purpose ?? "requirement-breakdown" }),
  });
  assert.equal(response.status, 201);
  const { session } = (await response.json()) as { session: { id: number } };
  const extraSessionIds: number[] = [];
  for (let more = 0; more < (options.extraSessions ?? 0); more += 1) {
    const another = await fetch(`${h.serverUrl}/api/products/${product.id}/sessions`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ purpose: "requirement-breakdown" }),
    });
    assert.equal(another.status, 201);
    extraSessionIds.push(((await another.json()) as { session: { id: number } }).session.id);
  }
  return {
    h,
    cookie,
    sessionId: session.id,
    extraSessionIds,
    productId: product.id,
    requests: stub.requests,
    close: stub.close,
  };
}

export function send(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
  clientMessageId: string,
  text: string,
  mode?: "followUp" | "steer",
  /** 这条消息带的图片 id(issue #336)。 */
  images?: readonly string[],
  /** 这一条答的是哪一轮提问(issue #406):那条提问轮次条目的 seq。 */
  answersRound?: number,
): Promise<Response> {
  return fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      clientMessageId,
      text,
      ...(mode === undefined ? {} : { mode }),
      ...(images === undefined ? {} : { images }),
      ...(answersRound === undefined ? {} : { answersRound }),
    }),
  });
}

/** 这个会话此刻排着哪几条(issue #334)。排队列表跟着读会话一起回。 */
export async function queueOf(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
): Promise<{ mode: string; text: string }[]> {
  const response = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { queue: { mode: string; text: string }[] }).queue;
}

/** 一次请求里所有消息的正文拼起来。断言「这句话进了 / 没进这一次请求」用它。 */
export function bodyOf(request: StubRequest): string {
  return request.messages.map((message) => message.content).join("\n");
}

/** 等到假模型服务至少收到这么多次请求。等的是它那一侧的事实,不猜子进程的时序。 */
export async function requestsAtLeast(requests: readonly StubRequest[], count: number): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    if (requests.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  assert.fail(`等了 30 秒,假模型服务还没收到 ${count} 次请求`);
}

export async function records(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
): Promise<Record[]> {
  const response = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/records`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { records: Record[] }).records;
}

/** 记录里的消息条目各是什么角色。会话起头那两条 model_change / thinking_level_change 不算。 */
export function messageRoles(landed: readonly Record[]): (string | undefined)[] {
  return landed
    .filter((record) => record.type === "message")
    .map((record) => record.entry.message?.role);
}

/** 等到这个会话至少落了这么多条消息记录。等的是库里的行,不猜子进程的时序。 */
export async function messagesAtLeast(databaseUrl: string, sessionId: number, count: number): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const store = openStore(databaseUrl);
    const landed = (await store.listAgentSessionEntries(sessionId)) as unknown as Record[];
    await store.close();
    if (messageRoles(landed).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  assert.fail(`等了 30 秒,会话 ${sessionId} 还没落到 ${count} 条消息记录`);
}

/** 等到这个会话回到空闲(一个回合跑完)。 */
export async function idle(h: PanelHarness, cookie: string, sessionId: number): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const response = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}`, {
      headers: { cookie },
    });
    const { session } = (await response.json()) as { session: { status: string } };
    if (session.status === "idle") return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  assert.fail(`等了 30 秒,会话 ${sessionId} 还在执行`);
}

/** 停止这个会话当前的这一步。 */
export async function stop(h: PanelHarness, cookie: string, sessionId: number): Promise<void> {
  const stopped = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/stop`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(stopped.status, 200);
}

/** 回收之后才录的那条规则。重建时取的是当下的知识集条数,不是建会话那一刻的。 */
export const LATER_RULE = "撤回只允许在当月内做";

/** 这个会话读接口报的「前 N 条不在上下文」。 */
export async function droppedFromContext(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
): Promise<number> {
  const response = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { droppedFromContext: number }).droppedFromContext;
}

/** 等到记录表里出现一条正文匹配的系统消息(ADR 0031 的 `custom` 条目)。 */
export async function systemMessageMatching(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
  pattern: RegExp,
): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const landed = await records(h, cookie, sessionId);
    const system = landed.filter((record) => record.type === "custom");
    if (system.some((record) => pattern.test(JSON.stringify(record.entry)))) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  assert.fail(`等了 30 秒,会话 ${sessionId} 的记录里还没有匹配 ${String(pattern)} 的系统消息`);
}

