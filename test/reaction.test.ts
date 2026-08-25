/**
 * 审查进度在 PR 上的呈现:开跑挂 👀,跑完无问题换 👍。
 *
 * 这是 PR 上唯一能区分「审查通过」与「审查根本没跑」的信号——零 Finding 时本工具
 * 不发任何 review,没有它 PR 上一点痕迹都没有。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import type { Forge } from "../src/forge/forge.ts";
import { runReview } from "../src/review/run.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./support/git-fixture.ts";
import { memoryForge, scriptedReviewer } from "./support/memory-forge.ts";

const EVENT = { owner: "acme", repo: "widgets", number: 7 };
const BASE = "export const answer = 1;\n";
const HEAD = "export const answer = 2;\n";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

function harness() {
  const repo = makeRepo({ base: { "src/a.ts": BASE }, head: { "src/a.ts": HEAD } });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);

  const forge = memoryForge({
    pullRequest: {
      number: EVENT.number,
      title: "示例 PR",
      draft: false,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: [{ path: "src/a.ts", status: "modified" }],
  });

  return { repo, forge, deps: { cacheDir: cache.dir, dbPath: db.path } };
}

const FINDING = {
  file: "src/a.ts",
  line: 1,
  severity: "P0" as const,
  category: "bug" as const,
  description: "答案变了",
};

test("发现问题时:开跑挂眼睛,收尾撤掉,不留赞", async () => {
  const h = harness();

  await runReview(EVENT, {
    forge: h.forge.forge,
    reviewers: [scriptedReviewer("model-a", [FINDING])],
    ...h.deps,
  });

  // 上一轮的结论先作废,再挂「正在审查」。
  assert.deepEqual(h.forge.reactionLog, ["remove:+1", "add:eyes", "remove:eyes"]);
  assert.deepEqual([...h.forge.reactions], []);
  assert.equal(h.forge.createdReviews.length, 1);
});

test("零 Finding 时:眼睛换成赞,这是 PR 上唯一的痕迹", async () => {
  const h = harness();

  await runReview(EVENT, {
    forge: h.forge.forge,
    reviewers: [scriptedReviewer("model-a", [])],
    ...h.deps,
  });

  assert.deepEqual(h.forge.reactionLog, [
    "remove:+1",
    "add:eyes",
    "add:+1",
    "remove:eyes",
  ]);
  assert.deepEqual([...h.forge.reactions], ["+1"]);
  // 零 Finding 不发 review,赞因此是这次审查在 PR 上留下的全部。
  assert.equal(h.forge.createdReviews.length, 0);
});

test("审查中途抛异常时眼睛照样撤掉,不会永远挂着", async () => {
  const h = harness();
  const failing: Forge = {
    ...h.forge.forge,
    createReview: async () => {
      throw new Error("发布失败");
    },
  };

  await assert.rejects(
    runReview(EVENT, {
      forge: failing,
      reviewers: [scriptedReviewer("model-a", [FINDING])],
      ...h.deps,
    }),
    /发布失败/,
  );

  assert.ok(h.forge.reactionLog.includes("remove:eyes"), "眼睛没被撤掉");
  assert.deepEqual([...h.forge.reactions], []);
});

test("reaction 发不出去时审查照常跑完", async () => {
  const h = harness();
  // 令牌缺 write:issue 时就是这个样子。
  const noReactions: Forge = {
    ...h.forge.forge,
    addReaction: async () => {
      throw new Error("token does not have at least one of required scope(s)");
    },
    removeReaction: async () => {
      throw new Error("token does not have at least one of required scope(s)");
    },
  };

  const result = await runReview(EVENT, {
    forge: noReactions,
    reviewers: [scriptedReviewer("model-a", [FINDING])],
    ...h.deps,
  });

  assert.equal(result.failed, false);
  assert.equal(result.inlineCount, 1);
  assert.equal(h.forge.createdReviews.length, 1);
});
