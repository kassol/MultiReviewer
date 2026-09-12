/**
 * 面板流程测试的公用 harness:真服务 + 假 Gitea + 内存 Forge + 临时库,登录拿好
 * cookie。注册/移除(issue #31)与轮转/核对(issue #32)两组测试共用。
 *
 * 投递一律用「从假 Gitea 读回的 hook secret 与 ?k=」来签——面板写进 hook 的 Key 与
 * 准入认的 Key 必须是同一把,这条链路本身就是被测行为。
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";

import type { ReviewerRuntimePlan, ReviewerSpec } from "../../src/config.ts";
import type { Drain } from "../../src/drain.ts";
import type { Forge, PullRequestRef } from "../../src/forge/forge.ts";
import { disposeAgentSessions } from "../../src/webhook/agent-session.ts";
import {
  createWebhookServer,
  type NormalizedEvent,
  type WebhookServerDeps,
} from "../../src/webhook/server.ts";
import { hashPassword } from "../../src/panel/password.ts";
import { encryptCredential } from "../../src/panel/credential-crypto.ts";
import type { PanelPermission } from "../../src/panel/permissions.ts";
import type { DiscoveredModel } from "../../src/reviewer/model-service-runtime.ts";
import {
  modelServiceTargetFingerprint,
  openStore,
  type ScheduledCheckResult,
} from "../../src/review/store.ts";
import { startFakeGitea, type FakeGitea } from "./fake-gitea.ts";
import {
  confirmEmptyRuleSet,
  makeCacheDir,
  makeDbPath,
  makeRepo,
  testCleanups,
  type RepoFixture,
} from "./git-fixture.ts";
import { memoryForge, scriptedReviewer, type MemoryForge } from "./memory-forge.ts";

export const PANEL_ADMIN_USERNAME = "panel-admin";
export const PANEL_ADMIN_PASSWORD = "panel-harness-password";
const PANEL_ADMIN_PASSWORD_HASH = await hashPassword(PANEL_ADMIN_PASSWORD);
export const PANEL_BASE_URL = "https://reviewer.example.test";

export const GITEA_REPO = { id: 4242, owner: "acme", repo: "widgets" };
export const HARNESS_PR: PullRequestRef = {
  owner: GITEA_REPO.owner,
  repo: GITEA_REPO.repo,
  number: 7,
};
/** 被审 pull request 的标题。评审记录里那一行的名字就是它。 */
export const HARNESS_PR_TITLE = "把登录超时改回三十秒";

export type PanelHarness = {
  /** 服务的根地址。未登录调用要自己发请求,不能走带 cookie 的 `api()`。 */
  serverUrl: string;
  /** 登录之后的会话 cookie。`api()` 覆盖不到的请求(自定义请求头)自己拼时用它。 */
  cookie: string;
  gitea: FakeGitea;
  /** 被审的真实仓库。范围审查的两端要从它取真的 commit sha。 */
  repo: RepoFixture;
  /** 内存 Forge 的记录面:建了哪些分支、开了哪些 PR、发了哪些 review。 */
  memory: MemoryForge;
  db: { path: string };
  /** 工作副本缓存根。本地 clone 在它下面的 `<owner>/<repo>`。 */
  cacheDir: string;
  dispatched: PullRequestRef[];
  settled: { event: NormalizedEvent; error?: unknown }[];
  /** 后台准备工作副本(issue #184)的结果,按结束先后。 */
  worktrees: { repoId: number; failure?: string }[];
  /** 后台跑完的基点探索(issue #205),按结束先后。 */
  explorations: { repoId: number; failure?: string }[];
  /** 后台跑完的处置反哺解读(issue #208),按结束先后。 */
  dispositionFeedbacks: { findingId: number; failure?: string }[];
  /** 后台跑完的知识整理(issue #284),按结束先后。 */
  consolidations: { repoId: number; failure?: string }[];
  /** 后台跑完的人工提议(issue #294),按结束先后。 */
  revisionIntents: { intentId: number; failure?: string }[];
  /** 跑完的定时检查(issue #314),按先后。 */
  scheduledChecks: { rangeReviewId: number; result: ScheduledCheckResult }[];
  /** 每次组装 Reviewer 时拿到的完整本轮运行计划。 */
  runtimePlans: (readonly ReviewerRuntimePlan[])[];
  api(method: string, path: string, body?: unknown): Promise<Response>;
  deliverViaHook(
    headSha: string,
    snapshot?: { url: string; secret: string },
  ): Promise<Response>;
  settledAtLeast(count: number): Promise<void>;
  /** 等到至少这么多次工作副本准备已经结束。不猜时序:等的是服务自己发的回调。 */
  worktreesPreparedAtLeast(count: number): Promise<void>;
  /** 等到至少这么多次基点探索已经结束(issue #205)。 */
  explorationsAtLeast(count: number): Promise<void>;
  /** 等到至少这么多次处置反哺解读已经结束(issue #208)。 */
  dispositionFeedbackAtLeast(count: number): Promise<void>;
  /** 等到至少这么多次知识整理已经结束(issue #284)。 */
  consolidationsAtLeast(count: number): Promise<void>;
  /** 等到至少这么多次人工提议已经结束(issue #294)。 */
  revisionIntentsAtLeast(count: number): Promise<void>;
  /** 等到至少这么多次定时检查已经跑完(issue #314)。 */
  scheduledChecksAtLeast(count: number): Promise<void>;
};

/** 凭据测试用的主密钥。缺主密钥那一档传 `credentialMasterKey: undefined` 起 harness。 */
export const PANEL_CREDENTIAL_MASTER_KEY = "panel-harness-master-key";

/** harness 的全局模型组合。模型标识因此是 `test:global-model`。 */
export const HARNESS_SPEC: ReviewerSpec = {
  provider: "test",
  model: "global-model",
};

/**
 * 为组合写入测试建一条真实可用的自定义模型服务；不碰旧目录与旧凭据表。
 *
 * `fields` 整份服务共用,省略即什么都不声明(推理能力因此落到运行基线的 false,
 * 支持的思考档位只有 `off`)。要一个思考得起来的模型就显式给 `reasoning: true`。
 */
export function seedAvailableModelService(
  harness: Pick<PanelHarness, "db">,
  provider: string,
  models: readonly string[],
  fields: DiscoveredModel["fields"] = {},
  /** 调用地址。省略即一个不存在的假地址;跑真实 SDK 链路的用例传本机假模型服务的那一个。 */
  serviceBaseUrl?: string,
): void {
  assert.ok(models.length > 0, "测试模型服务至少要有一个模型");
  const baseUrl = serviceBaseUrl ?? `https://${provider}.models.example.test/v1`;
  const api = "openai-completions";
  const at = "2026-08-20T00:00:00.000Z";
  const store = openStore(harness.db.path);
  try {
    assert.equal(store.commitModelServiceVersion(null, {
      provider,
      type: "custom",
      baseUrl,
      api,
      targetFingerprint: modelServiceTargetFingerprint(baseUrl, api),
      disabledReason: null,
      createdAt: at,
      updatedAt: at,
      credential: {
        state: "verified",
        apiKeyEncrypted: encryptCredential(PANEL_CREDENTIAL_MASTER_KEY, `secret-${provider}`),
        updatedAt: at,
        verifiedAt: at,
        validationModel: `${provider}:${models[0]!}`,
        verificationSource: "inference",
      },
      directory: {
        state: "available",
        lastAttemptAt: at,
        lastSuccessAt: at,
        failure: null,
        ignoredModelCount: 0,
      },
      automaticModels: models.map((model) => ({
        identity: `${provider}:${model}`,
        provider,
        id: model,
        fields,
      })),
      supplements: [],
    }), 1);
  } finally {
    store.close();
  }
}

export type PanelHarnessOptions = {
  /** 模型凭据的主密钥。省略取 `PANEL_CREDENTIAL_MASTER_KEY`,显式给 undefined 即不配。 */
  credentialMasterKey?: string | undefined;
  /** Reviewer 的组装。省略即按 spec 建脚本 Reviewer;真组装那一档传 `buildReviewers`。 */
  buildReviewers?: WebhookServerDeps["buildReviewers"];
  /**
   * 本轮合并 agent 的组装(issue #304)。省略即用真实的 Pi 子进程实现;要断言这一轮的
   * 合并用了哪一处模型的用例注入脚本化实现,收到的那份运行模型就是解析出的辅助模型。
   */
  buildMergeAgent?: WebhookServerDeps["buildMergeAgent"];
  /** 先写进库的全局模型组合。省略取 `[HARNESS_SPEC]`,给空数组即「还没配组合」。 */
  reviewers?: readonly ReviewerSpec[];
  discoverModelServiceModels?: WebhookServerDeps["discoverModelServiceModels"];
  /** 在 harness 的 Forge 外再包一层,用来让某个方法失败。省略即不包。 */
  wrapForge?: (forge: Forge) => Forge;
  /** 审查轨迹 SSE 的心跳间隔,省略取服务默认值。 */
  traceHeartbeatMs?: number;
  /** 定时检查的 tick 间隔(issue #314),省略取服务默认值。用例拨到毫秒级。 */
  scheduledCheckTickMs?: number;
  /** 服务时钟,省略即真实时间。用例拨它驱动定时检查的「今天」。 */
  now?: () => number;
  /** 规则 agent(issue #205)。省略即用真实的 Pi 子进程实现,用例注入脚本化实现。 */
  ruleAgent?: WebhookServerDeps["ruleAgent"];
  /** 排空状态(issue #249)。用例自己 `begin()` 之后再调端点,验排空期间的回绝。 */
  drain?: Drain;
  /**
   * Agent 会话子进程的空闲回收门槛(毫秒,issue #335)。省略取服务默认的十分钟;验「回收后
   * 再发消息从记录重建」的用例拨到毫秒级。
   */
  agentSessionIdleReclaimMs?: number;
  /**
   * Agent 会话子进程执行中的静默判死门槛(毫秒,issue #335)。省略取服务默认的五分钟;验判死
   * 的用例拨到秒级,与 Reviewer 那套子进程注入静默闸同一做法。
   */
  agentSessionSilenceTimeoutMs?: number;
  /**
   * 仅 `startReadyPanelHarness` 认:起完就用 `GITEA_REPO` 的坐标注册这个仓库
   * (`POST /repos`),断言 201。省略即不注册。
   */
  registerRepo?: boolean;
};

/**
 * 「按结束先后记一条 + 等到至少 N 条已结束」这套三件套的工厂。harness 上六路后台
 * 回调(审查轮次、工作副本准备、基点探索、处置反哺、知识整理、人工提议)各建一份。
 */
function counter<T>(): { entries: T[]; push(entry: T): void; atLeast(count: number): Promise<void> } {
  const entries: T[] = [];
  let waiting: { count: number; resolve: () => void }[] = [];
  return {
    entries,
    push(entry: T): void {
      entries.push(entry);
      waiting = waiting.filter((w) => {
        if (entries.length < w.count) return true;
        w.resolve();
        return false;
      });
    },
    atLeast(count: number): Promise<void> {
      if (entries.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiting.push({ count, resolve });
      });
    },
  };
}

export async function startPanelHarness(
  options: PanelHarnessOptions = {},
): Promise<PanelHarness> {
  const cleanups = testCleanups();
  const credentialMasterKey =
    "credentialMasterKey" in options
      ? options.credentialMasterKey
      : PANEL_CREDENTIAL_MASTER_KEY;
  const repo = makeRepo({
    base: {
      "src/answer.ts": "export const answer = 1;\n",
      "src/other.ts": "export const other = 1;\n",
    },
    head: {
      "src/answer.ts": "export const answer = 2;\n",
      "src/other.ts": "export const other = 2;\n",
    },
  });
  const cache = makeCacheDir();
  const db = makeDbPath();
  const gitea = await startFakeGitea(GITEA_REPO);
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup, gitea.close);

  // 全局模型组合在库里(issue #66),服务起来之前先播种。
  const reviewers = options.reviewers ?? [HARNESS_SPEC];
  const seed = openStore(db.path);
  seed.createPanelUser({
    username: PANEL_ADMIN_USERNAME,
    displayName: "Panel Admin",
    passwordHash: PANEL_ADMIN_PASSWORD_HASH,
    mustChangePassword: false,
    createdAt: "2026-08-19T00:00:00.000Z",
    isSystemAdmin: true,
    roleId: null,
  });
  seed.close();
  // Harness 初始组合代表升级前已存在的状态；运行期组合写必须走 Store 的原子可用性门禁。
  if (reviewers.length > 0) {
    const fixtureDb = new DatabaseSync(db.path);
    fixtureDb.prepare("INSERT INTO global_setting (key, value) VALUES (?, ?)").run(
      "reviewers",
      JSON.stringify(reviewers),
    );
    fixtureDb.close();
  }

  const base = memoryForge({
    pullRequest: {
      number: HARNESS_PR.number,
      title: HARNESS_PR_TITLE,
      draft: false,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: [
      { path: "src/answer.ts", status: "modified" },
      { path: "src/other.ts", status: "modified" },
    ],
  });
  const dispatched: PullRequestRef[] = [];
  const recording: Forge = {
    ...base.forge,
    // 建分支与删分支落到夹具仓库自己身上,和真实 Forge 一样:增量评审走的是本地
    // clone 的 `git push`,不经 Forge,只有分支真的在仓库里两条路才看得到同一份事实。
    createBranch: async (ref, branch: string, fromSha: string) => {
      await base.forge.createBranch(ref, branch, fromSha);
      repo.setBranch(branch, fromSha);
    },
    deleteBranch: async (ref, branch: string) => {
      await base.forge.deleteBranch(ref, branch);
      repo.deleteBranch(branch);
    },
    getPullRequest: async (ref: PullRequestRef) => {
      dispatched.push(ref);
      // 容器 PR 是本服务自己开的,读回来的两端就是它那两条分支此刻指向的 commit。
      const container = base.createdPullRequests.find((pr) => pr.number === ref.number);
      if (container !== undefined) {
        const pointsAt = (branch: string): string => {
          const sha = repo.branchSha(branch);
          assert.notEqual(sha, undefined, `夹具仓库里没有分支 ${branch}`);
          return sha!;
        };
        return {
          number: ref.number,
          title: container.title,
          draft: false,
          baseSha: pointsAt(container.base),
          headSha: pointsAt(container.head),
          cloneUrl: repo.dir,
        };
      }
      // 与真实 Forge 同构:不存在的 PR 号抛错,而不是回同一份 PR。
      if (ref.number !== HARNESS_PR.number) {
        throw new Error(`PR #${ref.number} 不存在`);
      }
      return base.forge.getPullRequest(ref);
    },
  };
  const forge = options.wrapForge === undefined ? recording : options.wrapForge(recording);

  const runtimePlans: (readonly ReviewerRuntimePlan[])[] = [];
  const settled = counter<{ event: NormalizedEvent; error?: unknown }>();
  const worktrees = counter<{ repoId: number; failure?: string }>();
  const explorations = counter<{ repoId: number; failure?: string }>();
  const dispositionFeedbacks = counter<{ findingId: number; failure?: string }>();
  const consolidations = counter<{ repoId: number; failure?: string }>();
  const revisionIntents = counter<{ intentId: number; failure?: string }>();
  const scheduledChecks = counter<{ rangeReviewId: number; result: ScheduledCheckResult }>();

  const server = createWebhookServer({
    forges: { gitea: forge },
    ...(options.drain === undefined ? {} : { drain: options.drain }),
    buildReviewers: (plans) => {
      runtimePlans.push(plans);
      if (options.buildReviewers !== undefined) return options.buildReviewers(plans);
      return plans.map((plan) => scriptedReviewer(plan.spec.model, []));
    },
    ...(options.buildMergeAgent === undefined
      ? {}
      : { buildMergeAgent: options.buildMergeAgent }),
    cacheDir: cache.dir,
    dbPath: db.path,
    bootstrapSecret: "panel-harness-bootstrap",
    baseUrl: PANEL_BASE_URL,
    panelDist: `${cache.dir}/no-dist`,
    gitea: { baseUrl: gitea.url, token: "bot-pat" },
    ...(credentialMasterKey === undefined ? {} : { credentialMasterKey }),
    onDelivery: () => {},
    ...(options.traceHeartbeatMs === undefined ? {} : { traceHeartbeatMs: options.traceHeartbeatMs }),
    ...(options.scheduledCheckTickMs === undefined
      ? {}
      : { scheduledCheckTickMs: options.scheduledCheckTickMs }),
    ...(options.agentSessionIdleReclaimMs === undefined
      ? {}
      : { agentSessionIdleReclaimMs: options.agentSessionIdleReclaimMs }),
    ...(options.agentSessionSilenceTimeoutMs === undefined
      ? {}
      : { agentSessionSilenceTimeoutMs: options.agentSessionSilenceTimeoutMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    onScheduledCheck: (rangeReviewId, result) => {
      scheduledChecks.push({ rangeReviewId, result });
    },
    ...(options.discoverModelServiceModels === undefined
      ? {}
      : { discoverModelServiceModels: options.discoverModelServiceModels }),
    // 默认注入一个零产出的规则 agent:不给的话探索与处置反哺会去 fork 真的 Pi 子进程,
    // 而 harness 上的模型服务指向的是一个假地址。要断言产出的用例自己传脚本化实现。
    ruleAgent: options.ruleAgent ?? (async () => ({ items: [] })),
    onRuleExplorationSettled: (repoId, failure) => {
      explorations.push({ repoId, ...(failure === undefined ? {} : { failure }) });
    },
    onRuleConsolidationSettled: (repoId, failure) => {
      consolidations.push({ repoId, ...(failure === undefined ? {} : { failure }) });
    },
    onRevisionIntentSettled: (intentId, failure) => {
      revisionIntents.push({ intentId, ...(failure === undefined ? {} : { failure }) });
    },
    onDispositionFeedbackSettled: (findingId, failure) => {
      dispositionFeedbacks.push({ findingId, ...(failure === undefined ? {} : { failure }) });
    },
    onWorktreePrepared: (repoId, failure) => {
      worktrees.push({ repoId, ...(failure === undefined ? {} : { failure }) });
    },
    onRunSettled: (event, error) => {
      settled.push({ event, ...(error === undefined ? {} : { error }) });
    },
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const serverUrl = `http://127.0.0.1:${port}`;
  cleanups.push(async () => {
    // 常驻的会话子进程不随测试进程退出,它的 IPC 通道还会让事件循环活着(issue #333)。
    // 等它收完:释放工作树与删会话根是异步的(issue #335),不等就会在 `tmpdir` 里留目录。
    // 临时库可能已经被前面的收尾删掉,落「被排空中止」那一条因此可能抛,吞掉它——此刻要的
    // 只是把子进程收干净。
    await disposeAgentSessions().catch(() => {});
    server.closeAllConnections();
    server.close();
  });

  const login = await fetch(`${serverUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: PANEL_ADMIN_USERNAME, password: PANEL_ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;

  function api(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${serverUrl}/api${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /**
   * 用 hook 的 secret 与 ?k= 签一次投递,和真实 Gitea 的行为同构。默认取假 Gitea 上
   * 第一条 hook;传入快照可在 hook 被删之后重放,验证「同一份凭据已失效」。
   */
  function deliverViaHook(
    headSha: string,
    snapshot?: { url: string; secret: string },
  ): Promise<Response> {
    const hook =
      snapshot ??
      (() => {
        const live = gitea.hooks[0];
        assert.notEqual(live, undefined, "假 Gitea 上没有 hook 可用");
        return { url: live!.config.url!, secret: live!.config.secret! };
      })();
    const target = new URL(hook.url);
    const body = JSON.stringify({
      action: "opened",
      number: HARNESS_PR.number,
      pull_request: { draft: false, head: { sha: headSha } },
      repository: {
        id: GITEA_REPO.id,
        name: HARNESS_PR.repo,
        owner: { login: HARNESS_PR.owner },
      },
    });
    return fetch(`${serverUrl}${target.pathname}${target.search}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitea-event": "pull_request",
        "x-hub-signature-256": `sha256=${createHmac("sha256", hook.secret)
          .update(body)
          .digest("hex")}`,
      },
      body,
    });
  }

  return {
    serverUrl,
    cookie,
    gitea,
    repo,
    memory: base,
    db,
    cacheDir: cache.dir,
    dispatched,
    settled: settled.entries,
    worktrees: worktrees.entries,
    explorations: explorations.entries,
    dispositionFeedbacks: dispositionFeedbacks.entries,
    consolidations: consolidations.entries,
    revisionIntents: revisionIntents.entries,
    scheduledChecks: scheduledChecks.entries,
    runtimePlans,
    api,
    deliverViaHook,
    settledAtLeast: settled.atLeast,
    worktreesPreparedAtLeast: worktrees.atLeast,
    explorationsAtLeast: explorations.atLeast,
    dispositionFeedbackAtLeast: dispositionFeedbacks.atLeast,
    consolidationsAtLeast: consolidations.atLeast,
    revisionIntentsAtLeast: revisionIntents.atLeast,
    scheduledChecksAtLeast: scheduledChecks.atLeast,
  };
}

/** 需要走仓库注册 API 的既有测试使用：让默认全局组合先达到审查配置就绪。 */
export async function startReadyPanelHarness(
  options: PanelHarnessOptions = {},
): Promise<PanelHarness> {
  const harness = await startPanelHarness(options);
  seedAvailableModelService(harness, HARNESS_SPEC.provider, [HARNESS_SPEC.model]);
  if (options.registerRepo === true) {
    const registered = await harness.api("POST", "/repos", {
      owner: GITEA_REPO.owner,
      repo: GITEA_REPO.repo,
    });
    assert.equal(registered.status, 201);
  }
  return harness;
}

/** 播种升级前已经存在的仓库，用于验证注册门禁不能改变历史投递。 */
export function seedHistoricalRepo(
  harness: Pick<PanelHarness, "db">,
  key = "historical-repo-key",
): { url: string; secret: string } {
  const store = openStore(harness.db.path);
  try {
    assert.equal(store.registerRepo({
      repoId: GITEA_REPO.id,
      owner: GITEA_REPO.owner,
      repo: GITEA_REPO.repo,
      generation: 1,
      key,
    }), true);
  } finally {
    store.close();
  }
  // 「升级前已经存在」的另一半:存量迁移把这些仓库写成已确认空知识集(issue #206)。
  confirmEmptyRuleSet(harness.db.path, GITEA_REPO.id);
  return { url: `${PANEL_BASE_URL}/webhook?k=1`, secret: key };
}

/**
 * 建一个绑定到指定仓库的普通用户并登录拿 cookie。`permissions` 给了非空数组即建一个
 * 同名角色套上去,省略或空数组即不建角色、留系统默认的无角色态。
 */
export async function scopedUser(
  h: Pick<PanelHarness, "db" | "serverUrl">,
  username: string,
  password: string,
  at: string,
  repoIds: readonly number[],
  permissions: readonly PanelPermission[] = [],
): Promise<string> {
  const store = openStore(h.db.path);
  try {
    store.createPanelUser({
      username,
      displayName: null,
      passwordHash: await hashPassword(password),
      mustChangePassword: false,
      createdAt: at,
      isSystemAdmin: false,
      roleId: null,
    });
    store.setPanelUserAssignment(username, repoIds);
    if (permissions.length > 0) {
      const role = store.createPanelRole({
        name: `role-${username}`,
        permissions: [...permissions],
        createdAt: at,
      });
      assert.equal(
        store.updatePanelUser(username, {
          displayName: null,
          roleId: role.id,
          isSystemAdmin: false,
        }),
        "updated",
      );
    }
  } finally {
    store.close();
  }
  const response = await fetch(`${h.serverUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 204);
  return response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
}

/** 直接落一行注册表,不建 hook。返回 `repoId` 供调用方接着用。 */
export function seedRepo(
  h: Pick<PanelHarness, "db">,
  repoId: number,
  owner: string,
  repo: string,
): number {
  const store = openStore(h.db.path);
  try {
    assert.equal(
      store.registerRepo({ repoId, owner, repo, generation: 1, key: `key-${repoId}` }),
      true,
    );
  } finally {
    store.close();
  }
  return repoId;
}

/** 已经建好账号密码之后登录换 cookie。建账号是调用方自己的事。 */
export async function userCookie(
  serverUrl: string,
  username: string,
  password: string,
): Promise<string> {
  const response = await fetch(`${serverUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 204);
  return response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
}

/**
 * 发起一个范围审查并等第一轮跑完。`body` 省略即用当前仓库的 base..head 建一条最简请求;
 * 要附指令、显式比较项等场景自己拼 body。
 */
export async function startRangeReview<T = unknown>(
  h: PanelHarness,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await h.api(
    "POST",
    "/range-reviews",
    body ?? {
      title: "范围审查标题",
      owner: HARNESS_PR.owner,
      repo: HARNESS_PR.repo,
      base: h.repo.baseSha,
      comparison: h.repo.headSha,
    },
  );
  assert.equal(response.status, 202);
  const { rangeReview } = (await response.json()) as { rangeReview: T };
  await h.settledAtLeast(1);
  return rangeReview;
}
