import assert from "node:assert/strict";
import { after, test } from "node:test";

import { openStore } from "../src/review/store.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  seedAvailableModelService,
  startPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

type SetupStatus = {
  hasRunnableModelService: boolean;
  reviewConfigurationReady: boolean;
  hasRepository: boolean;
  instanceEnabled: boolean;
};

async function setupStatus(h: PanelHarness): Promise<SetupStatus> {
  const response = await h.api("GET", "/setup-status");
  assert.equal(response.status, 200);
  return (await response.json()) as SetupStatus;
}

test("首次配置状态从空实例推进到可运行服务、审查配置就绪和实例启用", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  assert.deepEqual(await setupStatus(h), {
    hasRunnableModelService: false,
    reviewConfigurationReady: false,
    hasRepository: false,
    instanceEnabled: false,
  });

  seedAvailableModelService(h, "setup-provider", ["review-model"]);
  assert.deepEqual(await setupStatus(h), {
    hasRunnableModelService: true,
    reviewConfigurationReady: false,
    hasRepository: false,
    instanceEnabled: false,
  });

  const settings = (await (await h.api("GET", "/settings")).json()) as {
    reviewersVersion: number;
  };
  assert.equal(
    (
      await h.api("PUT", "/settings", {
        reviewers: [{ provider: "setup-provider", model: "review-model" }],
        expectedVersion: settings.reviewersVersion,
      })
    ).status,
    200,
  );
  assert.deepEqual(await setupStatus(h), {
    hasRunnableModelService: true,
    reviewConfigurationReady: true,
    hasRepository: false,
    instanceEnabled: false,
  });

  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );
  assert.deepEqual(await setupStatus(h), {
    hasRunnableModelService: true,
    reviewConfigurationReady: true,
    hasRepository: true,
    instanceEnabled: true,
  });
});

test("审查配置未就绪时注册在任何 Gitea 调用、Key 生成和落库前拒绝", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  h.gitea.requests.length = 0;

  const response = await h.api("POST", "/repos", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "审查配置尚未就绪，请先到审查策略保存至少一个当前可用模型",
    action: "/settings",
  });
  assert.deepEqual(h.gitea.requests, []);
  assert.deepEqual(await (await h.api("GET", "/repos")).json(), []);
  const store = openStore(h.db.path);
  assert.deepEqual(store.listRepoKeys(GITEA_REPO.id), []);
  store.close();
});
