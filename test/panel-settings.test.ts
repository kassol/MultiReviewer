/**
 * 全局设置端点(issue #66)。模型组合与批次上限都在库里,面板是唯一的配置面,
 * 没有配置文件与之竞争。走 panel harness 的真实 HTTP 缝。
 *
 * 「空库没配组合」那一条测在既有的 runReview 集成缝上:harness 注入的
 * `buildReviewers` 就是服务真用的那一个入口,这里传真实实现。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { buildReviewers } from "../src/config.ts";
import { DEFAULT_MAX_CHANGED_LINES_PER_BATCH } from "../src/review/batch.ts";
import { openStore } from "../src/review/store.ts";
import { HARNESS_PR, startPanelHarness } from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

test("PUT 后 GET 拿回同一形状", async () => {
  const h = await startPanelHarness(cleanups);
  const body = {
    reviewers: [
      { provider: "deepseek", model: "deepseek-v4-flash" },
      { provider: "openrouter", model: "z-ai/glm-4.6" },
    ],
    maxChangedLinesPerBatch: 800,
  };

  const put = await h.api("PUT", "/settings", body);
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), body);
  assert.deepEqual(await (await h.api("GET", "/settings")).json(), body);
});

test("批次上限缺省时回默认值,显式清空回到默认值", async () => {
  const h = await startPanelHarness(cleanups, { reviewers: [] });
  assert.deepEqual(await (await h.api("GET", "/settings")).json(), {
    reviewers: [],
    maxChangedLinesPerBatch: DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
  });

  const reviewers = [{ provider: "test", model: "global-model" }];
  await h.api("PUT", "/settings", { reviewers, maxChangedLinesPerBatch: 800 });
  const cleared = await h.api("PUT", "/settings", { reviewers });
  assert.deepEqual(await cleared.json(), {
    reviewers,
    maxChangedLinesPerBatch: DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
  });
});

test("非法的 reviewers 被既有校验拒绝,报错标注来源是全局这一层", async () => {
  const h = await startPanelHarness(cleanups);

  const missingField = await h.api("PUT", "/settings", {
    reviewers: [{ provider: "deepseek" }],
  });
  assert.equal(missingField.status, 400);
  assert.match(((await missingField.json()) as { error: string }).error, /全局模型组合.*model/);

  const duplicate = await h.api("PUT", "/settings", {
    reviewers: [
      { provider: "a", model: "same" },
      { provider: "a", model: "same" },
    ],
  });
  assert.equal(duplicate.status, 400);
  assert.match(((await duplicate.json()) as { error: string }).error, /a:same 选了两次/);

  // 坏入参一条都不落库:组合还是 harness 播种的那一份。
  assert.deepEqual(await (await h.api("GET", "/settings")).json(), {
    reviewers: [{ provider: "test", model: "global-model" }],
    maxChangedLinesPerBatch: DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
  });
});

test("批次上限不是正整数时拒绝", async () => {
  const h = await startPanelHarness(cleanups);
  const reviewers = [{ provider: "test", model: "global-model" }];
  for (const limit of [0, -1, 1.5, "800"]) {
    const response = await h.api("PUT", "/settings", {
      reviewers,
      maxChangedLinesPerBatch: limit,
    });
    assert.equal(response.status, 400, `${String(limit)} 应被拒绝`);
    assert.match(
      ((await response.json()) as { error: string }).error,
      /maxChangedLinesPerBatch/,
    );
  }
});

test("全局组合允许清空,每仓库覆盖仍必须至少一个", async () => {
  // 空的全局组合是受支持的状态(issue #66):投递照常受理,留下一条写明「还没配模型
  // 组合」的失败 Run。拒收它会把「只想先调批次上限」也一起连坐掉——这个端点整表写入。
  const h = await startPanelHarness(cleanups);
  const empty = await h.api("PUT", "/settings", {
    reviewers: [],
    maxChangedLinesPerBatch: 900,
  });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { reviewers: [], maxChangedLinesPerBatch: 900 });
  assert.deepEqual(await (await h.api("GET", "/settings")).json(), {
    reviewers: [],
    maxChangedLinesPerBatch: 900,
  });

  // 每仓库覆盖是另一层判据(issue #69):空覆盖表达不了意图,要停掉就清成 null。
  const register = await h.api("POST", "/repos", {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
  });
  assert.equal(register.status, 201);
  const { repoId } = (await register.json()) as { repoId: number };
  const override = await h.api("PUT", `/repos/${repoId}/reviewers`, { reviewers: [] });
  assert.equal(override.status, 400);
  assert.match(((await override.json()) as { error: string }).error, /至少要选一个模型/);
});

test("改过的全局组合下一次投递就生效", async () => {
  const h = await startPanelHarness(cleanups);
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );
  assert.equal(
    (
      await h.api("PUT", "/settings", {
        reviewers: [{ provider: "test", model: "swapped-model" }],
      })
    ).status,
    200,
  );

  assert.equal((await h.deliverViaHook("sha-1")).status, 200);
  await h.settledAtLeast(1);
  assert.deepEqual(h.factoryCalls.at(-1), [{ provider: "test", model: "swapped-model" }]);
});

test("空库、没配模型组合时投递留下一条失败的 Review Run,原因可读", async () => {
  // 真组装:组合为空,零 Reviewer 的 Run 既不失败也不报错,人看到的会是「投了没反应」。
  const h = await startPanelHarness(cleanups, { reviewers: [], buildReviewers });
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );

  assert.equal((await h.deliverViaHook("sha-1")).status, 200);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);

  const store = openStore(h.db.path);
  const runs = store.listRuns({ limit: 30 });
  store.close();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.failed, true);

  const sqlite = new DatabaseSync(h.db.path);
  try {
    const rows = sqlite.prepare("SELECT failure FROM reviewer_outcome").all() as {
      failure: string | null;
    }[];
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.failure ?? "", /还没有配置模型组合/);
  } finally {
    sqlite.close();
  }
});

/**
 * 撞名的自定义 provider 接进 Review Run(issue #94)。测在同一条组装缝上:harness 注入的
 * `buildReviewers` 就是服务真用的那一个入口,而撞名的判据是服务在开跑前自己算出来喂给它的。
 * 少了这一条,服务端不算撞名、一律传空集合也照样全绿——组装那一档的用例是直接调
 * `buildReviewers` 的,碰不到这段接线。
 *
 * 同一个组合里放两家自定义 provider:一家的名字是 Pi 内置就有的(`openrouter`,撞名),另一家
 * 是自己起的名字(不撞)。两句失败措辞必须不同——这既守住接线,也顺带证实判据不是「凡是自定义
 * provider 都算撞名」。`openrouter` 哪天真从 Pi 内置目录里消失,这一条会当场红。
 */
test("组合里有撞名的自定义 provider 时,那一个模型的失败原因写明是名字冲突", async () => {
  const collided = { provider: "openrouter", model: "corp-qwen3-max" };
  const fine = { provider: "corp-gateway", model: "corp-glm-5" };
  const h = await startPanelHarness(cleanups, {
    reviewers: [collided, fine],
    buildReviewers,
  });
  // 两家都登记在库里,只有名字撞上内置那一家的才该被停用。凭据一把都不配:撞名那一档必须
  // 压过缺凭据那一档。
  const seed = openStore(h.db.path);
  for (const name of [collided.provider, fine.provider]) {
    seed.putCustomProvider({
      name,
      baseUrl: "https://ai.corp.example/v1",
      api: "openai-completions",
      createdAt: new Date(0).toISOString(),
    });
  }
  seed.close();
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );

  assert.equal((await h.deliverViaHook("sha-1")).status, 200);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);

  const store = openStore(h.db.path);
  const models = store.listRuns({ limit: 1 })[0]!.models;
  store.close();
  const failure = (model: string): string =>
    models.find((row) => row.model === model)?.failure ?? "";
  assert.match(failure("openrouter:corp-qwen3-max"), /名字/, "撞名那一个没写明是名字冲突");
  assert.match(failure("corp-gateway:corp-glm-5"), /模型凭据/, "不撞名的那一个被误判成撞名");
});
