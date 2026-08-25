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
import type { Forge, PullRequestRef } from "../../src/forge/forge.ts";
import {
  createWebhookServer,
  type NormalizedEvent,
  type WebhookServerDeps,
} from "../../src/webhook/server.ts";
import { hashPassword } from "../../src/panel/password.ts";
import { encryptCredential } from "../../src/panel/credential-crypto.ts";
import { modelServiceTargetFingerprint } from "../../src/review/model-service-migration.ts";
import { openStore } from "../../src/review/store.ts";
import { startFakeGitea, type FakeGitea } from "./fake-gitea.ts";
import { makeCacheDir, makeDbPath, makeRepo, type RepoFixture } from "./git-fixture.ts";
import { memoryForge, scriptedReviewer, type MemoryForge } from "./memory-forge.ts";

export const PANEL_ADMIN_USERNAME = "panel-admin";
export const PANEL_ADMIN_PASSWORD = "panel-harness-password";
const PANEL_ADMIN_PASSWORD_HASH = await hashPassword(PANEL_ADMIN_PASSWORD);
export const PANEL_PREFIX = "panel-harness-prefix";
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
  factoryCalls: (readonly ReviewerSpec[])[];
  /** 每次组装 Reviewer 时拿到的完整本轮运行计划。 */
  runtimePlans: (readonly ReviewerRuntimePlan[])[];
  /** 兼容既有凭据边界断言的明文快照，仅由本轮计划投影。 */
  snapshots: ReadonlyMap<string, string>[];
  api(method: string, path: string, body?: unknown): Promise<Response>;
  deliverViaHook(
    headSha: string,
    snapshot?: { url: string; secret: string },
  ): Promise<Response>;
  settledAtLeast(count: number): Promise<void>;
  /** 等到至少这么多次工作副本准备已经结束。不猜时序:等的是服务自己发的回调。 */
  worktreesPreparedAtLeast(count: number): Promise<void>;
};

/** 凭据测试用的主密钥。缺主密钥那一档传 `credentialMasterKey: undefined` 起 harness。 */
export const PANEL_CREDENTIAL_MASTER_KEY = "panel-harness-master-key";

/** harness 的全局模型组合。模型标识因此是 `test:global-model`。 */
export const HARNESS_SPEC: ReviewerSpec = {
  provider: "test",
  model: "global-model",
};

/** 为组合写入测试建一条真实可用的自定义模型服务；不碰旧目录与旧凭据表。 */
export function seedAvailableModelService(
  harness: Pick<PanelHarness, "db">,
  provider: string,
  models: readonly string[],
): void {
  assert.ok(models.length > 0, "测试模型服务至少要有一个模型");
  const baseUrl = `https://${provider}.models.example.test/v1`;
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
        fields: {},
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
  /** 先写进库的全局模型组合。省略取 `[HARNESS_SPEC]`,给空数组即「还没配组合」。 */
  reviewers?: readonly ReviewerSpec[];
  discoverModelServiceModels?: WebhookServerDeps["discoverModelServiceModels"];
  /** 在 harness 的 Forge 外再包一层,用来让某个方法失败。省略即不包。 */
  wrapForge?: (forge: Forge) => Forge;
  /** 审查轨迹 SSE 的心跳间隔,省略取服务默认值。 */
  traceHeartbeatMs?: number;
};

export async function startPanelHarness(
  cleanups: (() => void)[],
  options: PanelHarnessOptions = {},
): Promise<PanelHarness> {
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
    // 建分支与删分支落到夹具仓库自己身上,和真实 Forge 一样:推进比较项走的是本地
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

  const factoryCalls: (readonly ReviewerSpec[])[] = [];
  const runtimePlans: (readonly ReviewerRuntimePlan[])[] = [];
  const snapshots: ReadonlyMap<string, string>[] = [];
  const settled: { event: NormalizedEvent; error?: unknown }[] = [];
  let waiting: { count: number; resolve: () => void }[] = [];
  const worktrees: { repoId: number; failure?: string }[] = [];
  let worktreeWaiting: { count: number; resolve: () => void }[] = [];

  const server = createWebhookServer({
    forges: { gitea: forge },
    buildReviewers: (plans) => {
      runtimePlans.push(plans);
      factoryCalls.push(plans.map((plan) => plan.spec));
      snapshots.push(
        new Map(
          plans.flatMap((plan) =>
            plan.credential === null ? [] : [[plan.spec.provider, plan.credential] as const],
          ),
        ),
      );
      if (options.buildReviewers !== undefined) return options.buildReviewers(plans);
      return plans.map((plan) => scriptedReviewer(plan.spec.model, []));
    },
    cacheDir: cache.dir,
    dbPath: db.path,
    bootstrapSecret: "panel-harness-bootstrap",
    panelPrefix: PANEL_PREFIX,
    baseUrl: PANEL_BASE_URL,
    panelDist: `${cache.dir}/no-dist`,
    gitea: { baseUrl: gitea.url, token: "bot-pat" },
    ...(credentialMasterKey === undefined ? {} : { credentialMasterKey }),
    onDelivery: () => {},
    ...(options.traceHeartbeatMs === undefined ? {} : { traceHeartbeatMs: options.traceHeartbeatMs }),
    ...(options.discoverModelServiceModels === undefined
      ? {}
      : { discoverModelServiceModels: options.discoverModelServiceModels }),
    onWorktreePrepared: (repoId, failure) => {
      worktrees.push({ repoId, ...(failure === undefined ? {} : { failure }) });
      worktreeWaiting = worktreeWaiting.filter((w) => {
        if (worktrees.length < w.count) return true;
        w.resolve();
        return false;
      });
    },
    onRunSettled: (event, error) => {
      settled.push({ event, ...(error === undefined ? {} : { error }) });
      waiting = waiting.filter((w) => {
        if (settled.length < w.count) return true;
        w.resolve();
        return false;
      });
    },
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const serverUrl = `http://127.0.0.1:${port}`;
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });

  const login = await fetch(`${serverUrl}/${PANEL_PREFIX}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: PANEL_ADMIN_USERNAME, password: PANEL_ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;

  function api(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${serverUrl}/${PANEL_PREFIX}/api${path}`, {
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
    settled,
    worktrees,
    factoryCalls,
    snapshots,
    runtimePlans,
    api,
    deliverViaHook,
    settledAtLeast(count: number): Promise<void> {
      if (settled.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiting.push({ count, resolve });
      });
    },
    worktreesPreparedAtLeast(count: number): Promise<void> {
      if (worktrees.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        worktreeWaiting.push({ count, resolve });
      });
    },
  };
}

/** 需要走仓库注册 API 的既有测试使用：让默认全局组合先达到审查配置就绪。 */
export async function startReadyPanelHarness(
  cleanups: (() => void)[],
  options: PanelHarnessOptions = {},
): Promise<PanelHarness> {
  const harness = await startPanelHarness(cleanups, options);
  seedAvailableModelService(harness, HARNESS_SPEC.provider, [HARNESS_SPEC.model]);
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
  return { url: `${PANEL_BASE_URL}/webhook?k=1`, secret: key };
}
