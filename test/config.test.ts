import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertReviewerSpecs,
  buildReviewers,
  parseGlobalReviewers,
  type ReviewerSpec,
} from "../src/config.ts";

const VALID: ReviewerSpec[] = [
  { provider: "anthropic", model: "claude-haiku-4-5" },
  { provider: "deepseek", model: "deepseek-v4-flash" },
];

/** 撞名的自定义 provider 一家都没有,组装的常态(issue #94)。 */
const NO_CONFLICT: ReadonlySet<string> = new Set();

test("组合里的每个条目建成一个 Reviewer,各自绑定自己的模型与凭据", () => {
  const reviewers = buildReviewers(
    VALID,
    new Map([
      ["anthropic", "a-secret"],
      ["deepseek", "d-secret"],
    ]),
    NO_CONFLICT,
  );

  assert.deepEqual(
    reviewers.map((r) => r.model),
    ["anthropic:claude-haiku-4-5", "deepseek:deepseek-v4-flash"],
  );
});

test("缺凭据的 provider 不抛,建出的 Reviewer 一跑就报失败并写明缺哪一家", async () => {
  const reviewers = buildReviewers(VALID, new Map([["anthropic", "a-secret"]]), NO_CONFLICT);

  const outcome = await reviewers[1]!.review(
    { baseSha: "base", headSha: "head", files: [] },
    "/nonexistent-worktree",
  );
  assert.match(outcome.failure ?? "", /deepseek/);
  assert.deepEqual(outcome.findings, []);
});

test("一个模型都没配时建出的 Reviewer 一跑就报失败,而不是零 Reviewer", async () => {
  const reviewers = buildReviewers([], new Map(), NO_CONFLICT);
  assert.equal(reviewers.length, 1);

  const outcome = await reviewers[0]!.review(
    { baseSha: "base", headSha: "head", files: [] },
    "/nonexistent-worktree",
  );
  assert.match(outcome.failure ?? "", /还没有配置模型组合/);
});

test("组合为空、条目缺字段时报错,报错指认来源层级", () => {
  assert.throws(() => assertReviewerSpecs([], "全局模型组合"), /全局模型组合至少要选一个模型/);
  assert.throws(
    () => assertReviewerSpecs([{ provider: "x" }], "仓库 7 的模型覆盖"),
    /仓库 7 的模型覆盖.*model/,
  );
  assert.throws(() => assertReviewerSpecs([{ model: "y" }], "全局模型组合"), /provider/);
});

test("同一个模型标识被配置两次时报错,否则 Finding 的模型标识无法区分来源", () => {
  assert.throws(
    () =>
      assertReviewerSpecs(
        [
          { provider: "a", model: "same" },
          { provider: "a", model: "same" },
        ],
        "全局模型组合",
      ),
    /a:same 选了两次/,
  );
});

test("同一个 model id 在两家 provider 下是两个 Reviewer,可共存", () => {
  const specs = assertReviewerSpecs(
    [
      { provider: "a", model: "same" },
      { provider: "b", model: "same" },
    ],
    "全局模型组合",
  );
  const reviewers = buildReviewers(
    specs,
    new Map([
      ["a", "k1"],
      ["b", "k2"],
    ]),
    NO_CONFLICT,
  );
  assert.deepEqual(
    reviewers.map((r) => r.model),
    ["a:same", "b:same"],
  );
});

test("带斜杠的 model id 拆包无歧义:首个冒号即边界", () => {
  const [reviewer] = buildReviewers(
    [{ provider: "openrouter", model: "z-ai/glm-5.2:free" }],
    new Map([["openrouter", "k1"]]),
    NO_CONFLICT,
  );
  assert.equal(reviewer!.model, "openrouter:z-ai/glm-5.2:free");
  const [provider, ...rest] = reviewer!.model.split(":");
  assert.equal(provider, "openrouter");
  assert.equal(rest.join(":"), "z-ai/glm-5.2:free");
});

test("库里没写过全局组合时是空数组,写过的按同一套判据校验", () => {
  assert.deepEqual(parseGlobalReviewers(null), []);
  assert.deepEqual(parseGlobalReviewers(JSON.stringify(VALID)), VALID);
  // 全局这一层允许空组合:空库刚部署时它本来就是空的(issue #66)。
  assert.deepEqual(parseGlobalReviewers("[]"), []);
});

/**
 * 撞名那一家(issue #94)。名字在库里有一条自定义 provider 登记,而 Pi 的内置目录里也有
 * 同名的一家——登记当时不撞,升级一次 Pi 之后才撞。这一档必须与「缺凭据」、「模型不存在」
 * 两种措辞分得开:三者的下一步动作完全不同(改名重建 / 去凭据页粘 key / 改模型标识),
 * 合成一句话人就不知道该去哪。
 *
 * 凭据故意给足:撞名那一家登记时 key 是必填的,所以现实里它必然有凭据在。判据因此不能
 * 靠「顺带落进缺凭据那一档」。
 */
const COLLIDED: ReviewerSpec = { provider: "corp-gateway", model: "corp-qwen3-max" };
const KEYED = new Map([
  ["corp-gateway", "k-corp"],
  ["anthropic", "a-secret"],
]);

test("撞名的 provider 建出的 Reviewer 一跑就报名字冲突,与缺凭据分得开", async () => {
  const conflict = await buildReviewers(
    [COLLIDED],
    KEYED,
    new Set([COLLIDED.provider]),
  )[0]!.review({ baseSha: "base", headSha: "head", files: [] }, "/nonexistent-worktree");

  assert.match(conflict.failure ?? "", /corp-gateway/);
  assert.match(conflict.failure ?? "", /名字/);
  assert.deepEqual(conflict.findings, []);

  // 同一个 spec 不撞名、只是没配凭据时给的是另一句话。两句话必须互不匹配,否则面板上
  // 「去凭据页配 key」会被贴到一个配了 key 也跑不起来的 provider 上。
  const missing = await buildReviewers([COLLIDED], new Map(), NO_CONFLICT)[0]!.review(
    { baseSha: "base", headSha: "head", files: [] },
    "/nonexistent-worktree",
  );
  assert.match(missing.failure ?? "", /模型凭据/);
  assert.doesNotMatch(conflict.failure ?? "", /模型凭据/);
  assert.doesNotMatch(missing.failure ?? "", /名字/);
  // 「模型不存在」是子进程那一档的措辞,这两句都不该占用它。
  assert.doesNotMatch(conflict.failure ?? "", /模型不存在/);

  // 撞名那一家的凭据被摘掉之后仍然报撞名:冲突是根因,补一把 key 也跑不起来,把人送去凭据页
  // 是白跑一趟。这一档决定了撞名要排在凭据之前判。
  const both = await buildReviewers([COLLIDED], new Map(), new Set([COLLIDED.provider]))[0]!.review(
    { baseSha: "base", headSha: "head", files: [] },
    "/nonexistent-worktree",
  );
  assert.match(both.failure ?? "", /名字/);
  assert.doesNotMatch(both.failure ?? "", /模型凭据/);
});

test("只有撞名那一家被停用,同一个组合里其余模型照常组装", () => {
  const reviewers = buildReviewers(
    [COLLIDED, VALID[0]!],
    KEYED,
    new Set([COLLIDED.provider]),
  );
  assert.deepEqual(
    reviewers.map((r) => r.model),
    ["corp-gateway:corp-qwen3-max", "anthropic:claude-haiku-4-5"],
  );
});
