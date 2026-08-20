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
import { makeCacheDir, makeDbPath, makeRepo } from "./git-fixture.ts";
import { memoryForge, scriptedReviewer } from "./memory-forge.ts";

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

export type PanelHarness = {
  /** 服务的根地址。未登录调用要自己发请求,不能走带 cookie 的 `api()`。 */
  serverUrl: string;
  gitea: FakeGitea;
  db: { path: string };
  dispatched: PullRequestRef[];
  settled: { event: NormalizedEvent; error?: unknown }[];
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
  const forge: Forge = {
    ...base.forge,
    getPullRequest: async (ref: PullRequestRef) => {
      dispatched.push(ref);
      // 与真实 Forge 同构:不存在的 PR 号抛错,而不是回同一份 PR。
      if (ref.number !== HARNESS_PR.number) {
        throw new Error(`PR #${ref.number} 不存在`);
      }
      return base.forge.getPullRequest(ref);
    },
  };

  const factoryCalls: (readonly ReviewerSpec[])[] = [];
  const runtimePlans: (readonly ReviewerRuntimePlan[])[] = [];
  const snapshots: ReadonlyMap<string, string>[] = [];
  const settled: { event: NormalizedEvent; error?: unknown }[] = [];
  let waiting: { count: number; resolve: () => void }[] = [];

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
    ...(options.discoverModelServiceModels === undefined
      ? {}
      : { discoverModelServiceModels: options.discoverModelServiceModels }),
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
    gitea,
    db,
    dispatched,
    settled,
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
  };
}
