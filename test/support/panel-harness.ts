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

import type { ReviewerSpec } from "../../src/config.ts";
import type { Forge, PullRequestRef } from "../../src/forge/forge.ts";
import {
  createWebhookServer,
  type NormalizedEvent,
} from "../../src/webhook/server.ts";
import { startFakeGitea, type FakeGitea } from "./fake-gitea.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./git-fixture.ts";
import { memoryForge, scriptedReviewer } from "./memory-forge.ts";

export const PANEL_ADMIN_TOKEN = "panel-harness-admin-token";
export const PANEL_PREFIX = "panel-harness-prefix";
export const PANEL_BASE_URL = "https://reviewer.example.test";

export const GITEA_REPO = { id: 4242, owner: "acme", repo: "widgets" };
export const HARNESS_PR: PullRequestRef = {
  owner: GITEA_REPO.owner,
  repo: GITEA_REPO.repo,
  number: 7,
};

export type PanelHarness = {
  gitea: FakeGitea;
  db: { path: string };
  dispatched: PullRequestRef[];
  settled: { event: NormalizedEvent; error?: unknown }[];
  factoryCalls: ReviewerSpec[][];
  api(method: string, path: string, body?: unknown): Promise<Response>;
  deliverViaHook(
    headSha: string,
    snapshot?: { url: string; secret: string },
  ): Promise<Response>;
  settledAtLeast(count: number): Promise<void>;
};

export async function startPanelHarness(
  cleanups: (() => void)[],
): Promise<PanelHarness> {
  const repo = makeRepo({
    base: { "src/answer.ts": "export const answer = 1;\n" },
    head: { "src/answer.ts": "export const answer = 2;\n" },
  });
  const cache = makeCacheDir();
  const db = makeDbPath();
  const gitea = await startFakeGitea(GITEA_REPO);
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup, gitea.close);

  const base = memoryForge({
    pullRequest: {
      number: HARNESS_PR.number,
      draft: false,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: [{ path: "src/answer.ts", status: "modified" }],
  });
  const dispatched: PullRequestRef[] = [];
  const forge: Forge = {
    ...base.forge,
    getPullRequest: async (ref: PullRequestRef) => {
      dispatched.push(ref);
      return base.forge.getPullRequest(ref);
    },
  };

  const factoryCalls: ReviewerSpec[][] = [];
  const settled: { event: NormalizedEvent; error?: unknown }[] = [];
  let waiting: { count: number; resolve: () => void }[] = [];

  const server = createWebhookServer({
    forges: { gitea: forge },
    reviewers: [scriptedReviewer("global-model", [])],
    buildReviewers: (specs) => {
      factoryCalls.push(specs);
      return specs.map((spec) => scriptedReviewer(spec.model, []));
    },
    cacheDir: cache.dir,
    dbPath: db.path,
    adminToken: PANEL_ADMIN_TOKEN,
    panelPrefix: PANEL_PREFIX,
    baseUrl: PANEL_BASE_URL,
    panelDist: `${cache.dir}/no-dist`,
    gitea: { baseUrl: gitea.url, token: "bot-pat" },
    onDelivery: () => {},
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
    body: JSON.stringify({ token: PANEL_ADMIN_TOKEN }),
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
    gitea,
    db,
    dispatched,
    settled,
    factoryCalls,
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
