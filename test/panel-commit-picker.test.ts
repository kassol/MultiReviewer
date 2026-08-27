/**
 * commit 选择器的两个只读接口(issue #178):列分支与列某分支的提交。
 *
 * 打在面板 API 的真实 HTTP 缝上:数据来自服务端本地 clone,git fixture 就是那个「远端」,
 * 往它上面推一个 commit 即模拟作者推代码。断言只看响应。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  HARNESS_PR,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

type Branch = { name: string; isDefault: boolean };
type Commit = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authoredAt: string;
  /** 带 base 查时才有(issue #179)。 */
  descendsFromBase?: boolean;
  messageMatchExcerpt?: string;
};
type Tag = {
  name: string;
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authoredAt: string;
  tagger?: string;
  taggedAt?: string;
  descendsFromBase?: boolean;
  messageMatchExcerpt?: string;
};

const REPO_QUERY = `owner=${HARNESS_PR.owner}&repo=${HARNESS_PR.repo}`;

async function registeredHarness(): Promise<PanelHarness> {
  const harness = await startReadyPanelHarness(cleanups);
  assert.equal(
    (await harness.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo }))
      .status,
    201,
  );
  return harness;
}

async function branchPage(
  h: PanelHarness,
  query = "",
): Promise<{ branches: Branch[]; truncated: boolean }> {
  const suffix = query === "" ? "" : `&${query}`;
  const response = await h.api("GET", `/repo-branches?${REPO_QUERY}${suffix}`);
  assert.equal(response.status, 200);
  return (await response.json()) as { branches: Branch[]; truncated: boolean };
}

async function branches(h: PanelHarness): Promise<Branch[]> {
  return (await branchPage(h)).branches;
}

async function commits(h: PanelHarness, query: string): Promise<{ commits: Commit[]; nextOffset: number | null }> {
  const response = await h.api("GET", `/repo-commits?${REPO_QUERY}&${query}`);
  assert.equal(response.status, 200);
  return (await response.json()) as { commits: Commit[]; nextOffset: number | null };
}

async function tags(
  h: PanelHarness,
  query = "",
): Promise<{ tags: Tag[]; nextOffset: number | null; hasUsableTags: boolean }> {
  const suffix = query === "" ? "" : `&${query}`;
  const response = await h.api("GET", `/repo-tags?${REPO_QUERY}${suffix}`);
  assert.equal(response.status, 200);
  return (await response.json()) as {
    tags: Tag[];
    nextOffset: number | null;
    hasUsableTags: boolean;
  };
}

test("列分支:标出默认分支,容器 PR 的机器人分支不出现", async () => {
  const h = await registeredHarness();
  // 远端上已经有一个容器 PR 的两条分支(ADR 0012 的固定前缀)。
  h.repo.setBranch("multireviewer/9-base", h.repo.baseSha);
  h.repo.setBranch("multireviewer/9-head", h.repo.headSha);

  const rows = await branches(h);
  assert.deepEqual(
    rows.map((row) => row.name),
    ["main", "feature"],
  );
  assert.deepEqual(
    rows.filter((row) => row.isDefault).map((row) => row.name),
    ["main"],
  );
});

test("列提交:每条带短 sha、完整 sha、信息首行、作者与时间", async () => {
  const h = await registeredHarness();

  const page = await commits(h, "branch=feature");
  assert.equal(page.nextOffset, null);
  const [head] = page.commits;
  assert.notEqual(head, undefined);
  assert.equal(head!.sha, h.repo.headSha);
  assert.equal(head!.shortSha, h.repo.headSha.slice(0, 7));
  assert.equal(head!.subject, "head");
  assert.equal(head!.author, "fixture");
  assert.match(head!.authoredAt, /^\d{4}-\d{2}-\d{2}T/);
  // feature 上是 base 那一个加自己那一个,新的在前。
  assert.deepEqual(
    page.commits.map((commit) => commit.sha),
    [h.repo.headSha, h.repo.mergeBaseSha],
  );
});

test("列提交:offset 与 limit 分页,还有下一页时给 nextOffset", async () => {
  const h = await registeredHarness();

  const first = await commits(h, "branch=feature&limit=1");
  assert.deepEqual(first.commits.map((commit) => commit.sha), [h.repo.headSha]);
  assert.equal(first.nextOffset, 1);

  const second = await commits(h, `branch=feature&limit=1&offset=${first.nextOffset}`);
  assert.deepEqual(second.commits.map((commit) => commit.sha), [h.repo.mergeBaseSha]);

  // 取满一页就还给下一页的入口(与评审记录同一套),翻过头拿到的是空的一页。
  const third = await commits(h, `branch=feature&limit=1&offset=${second.nextOffset}`);
  assert.deepEqual(third.commits, []);
  assert.equal(third.nextOffset, null);
});

test("列分支先 fetch:刚推上远端的 commit 随即选得到", async () => {
  const h = await registeredHarness();
  // 先让本地 clone 建出来,新 commit 才是「已有副本之后推的」。
  await branches(h);

  const pushed = h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  await branches(h);

  const page = await commits(h, "branch=feature");
  assert.equal(page.commits[0]!.sha, pushed);
});

test("分支搜索:默认分支优先、最多 50 条，输入时只查本地 refs", async () => {
  const h = await registeredHarness();
  for (let index = 0; index < 55; index += 1) {
    h.repo.setBranch(`topic-${String(index).padStart(2, "0")}`, h.repo.headSha);
  }

  const initial = await branchPage(h, "refresh=1");
  assert.equal(initial.branches[0]!.name, "main");
  assert.equal(initial.branches.length, 50);
  assert.equal(initial.truncated, true);

  h.repo.setBranch("brand-new", h.repo.headSha);
  const stale = await branchPage(h, "q=brand-new&refresh=0");
  assert.deepEqual(stale.branches, []);
  assert.equal(stale.truncated, false);

  const refreshed = await branchPage(h, "q=brand-new&refresh=1");
  assert.deepEqual(refreshed.branches.map((row) => row.name), ["brand-new"]);
  // 有搜索词时，默认分支不匹配就不额外塞进结果。
  assert.equal(refreshed.branches.some((row) => row.isDefault), false);

  // 选中的分支可能排在模糊搜索前 50 条之外；精确核对仍要找得到它。
  const exact = await branchPage(h, "q=topic-54&exact=1&refresh=0");
  assert.deepEqual(exact.branches.map((row) => row.name), ["topic-54"]);
});

test("列 Tag:同步轻量与附注 Tag，解析成不可变的目标 commit sha", async () => {
  const h = await registeredHarness();
  h.repo.setLightweightTag("v1.0.0", h.repo.mergeBaseSha);
  h.repo.setAnnotatedTag("v2.0.0", h.repo.headSha, "release v2");

  // 打开选择器先同步 refs；Tag 接口只查询这份本地 refs。
  await branches(h);
  const page = await tags(h);

  assert.deepEqual(
    page.tags.map((tag) => [tag.name, tag.sha, tag.shortSha, tag.subject, tag.author]),
    [
      ["v2.0.0", h.repo.headSha, h.repo.headSha.slice(0, 7), "head", "fixture"],
      ["v1.0.0", h.repo.mergeBaseSha, h.repo.mergeBaseSha.slice(0, 7), "base", "fixture"],
    ],
  );
  assert.equal(page.tags[0]!.tagger, "fixture");
  assert.match(page.tags[0]!.taggedAt!, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal("tagger" in page.tags[1]!, false);
  assert.equal(page.nextOffset, null);
  assert.equal(page.hasUsableTags, true);
});

test("列 Tag:递归 peel Tag 链，并排除 tree/blob 目标", async () => {
  const h = await registeredHarness();
  h.repo.setAnnotatedTag("inner", h.repo.headSha);
  h.repo.setAnnotatedTag("outer", "refs/tags/inner");
  h.repo.setLightweightTag("tree-only", `${h.repo.headSha}^{tree}`);

  await branches(h);
  const page = await tags(h);
  assert.equal(page.tags.find((tag) => tag.name === "outer")?.sha, h.repo.headSha);
  assert.equal(page.tags.some((tag) => tag.name === "tree-only"), false);
});

test("列 Tag:只有 tree/blob 目标时明确标成没有可用 Tag", async () => {
  const h = await registeredHarness();
  h.repo.setLightweightTag("tree-only", `${h.repo.headSha}^{tree}`);

  await branches(h);
  const page = await tags(h);
  assert.deepEqual(page.tags, []);
  assert.equal(page.hasUsableTags, false);
});

test("刷新 refs:Tag 移动与删除会同步，但此前选中的 SHA 事实不变", async () => {
  const h = await registeredHarness();
  h.repo.setLightweightTag("moving", h.repo.mergeBaseSha);
  await branches(h);
  const selectedSha = (await tags(h, "q=moving")).tags[0]!.sha;

  h.repo.setLightweightTag("moving", h.repo.headSha);
  await branchPage(h, "refresh=1");
  assert.equal((await tags(h, "q=moving")).tags[0]!.sha, h.repo.headSha);
  assert.equal(selectedSha, h.repo.mergeBaseSha);

  h.repo.deleteTag("moving");
  await branchPage(h, "refresh=1");
  assert.deepEqual((await tags(h, "q=moving")).tags, []);
});

test("Tag 搜索与筛选:名称/目标提交字段逐词 AND，日期、merge、合法后代先筛后分页", async () => {
  const h = await registeredHarness();
  const base = h.repo.headSha;
  const side = h.repo.branchFrom("tag-side", h.repo.mergeBaseSha, {
    "src/tag-side.ts": "export const tagSide = true;\n",
  });
  const january = h.repo.commitToBranch(
    "feature",
    { "src/tag-january.ts": "export const january = true;\n" },
    {
      message: "January release\n\nThe hidden codename is ORCHID.",
      authorName: "Alice Tagger",
      authorEmail: "alice-tags@example.invalid",
      authoredAt: "2024-01-15T12:00:00+08:00",
    },
  );
  const merge = h.repo.mergeInto("feature", "tag-side", "merge tag side");
  const february = h.repo.commitToBranch(
    "feature",
    { "src/tag-february.ts": "export const february = true;\n" },
    { message: "February release", authoredAt: "2024-02-15T12:00:00+08:00" },
  );
  h.repo.setLightweightTag("release-january", january);
  h.repo.setLightweightTag("release-merge", merge);
  h.repo.setLightweightTag("release-february", february);
  h.repo.setLightweightTag("release-invalid-side", side);
  await branches(h);

  const searched = await tags(h, "q=release-january%20orchid%20alice-tags");
  assert.deepEqual(searched.tags.map((tag) => tag.sha), [january]);
  assert.match(searched.tags[0]!.messageMatchExcerpt!, /ORCHID/);

  const januaryOnly = await tags(
    h,
    "q=release-&from=2024-01-01T00%3A00%3A00.000Z&to=2024-01-31T23%3A59%3A59.999Z",
  );
  assert.deepEqual(januaryOnly.tags.map((tag) => tag.sha), [january]);
  assert.deepEqual((await tags(h, "q=release-&merge=only")).tags.map((tag) => tag.sha), [merge]);

  const legalFirst = await tags(h, `q=release-&base=${base}&legal=only&limit=1`);
  const legalSecond = await tags(
    h,
    `q=release-&base=${base}&legal=only&limit=1&offset=1`,
  );
  assert.deepEqual(
    [...legalFirst.tags, ...legalSecond.tags].map((tag) => tag.sha),
    [merge, february],
  );
  assert.equal(
    [...legalFirst.tags, ...legalSecond.tags].every((tag) => tag.descendsFromBase === true),
    true,
  );
});

test("提交与 Tag 元数据允许 unit separator，不会让完整信息解析错位", async () => {
  const h = await registeredHarness();
  const separator = "\x1f";
  const sha = h.repo.commitToBranch(
    "feature",
    { "src/control-character.ts": "export const controlCharacter = true;\n" },
    {
      message: `Release${separator}candidate\n\nBody${separator}marker ORCHID`,
      authorName: `Alice${separator}Unit`,
      authorEmail: "alice-unit@example.invalid",
      authoredAt: "2024-03-15T12:00:00+08:00",
    },
  );
  h.repo.setAnnotatedTag("control-character", sha, `Tag${separator}message`);
  await branches(h);

  const commitPage = await commits(h, "branch=feature&q=orchid%20alice-unit");
  assert.equal(commitPage.commits[0]!.sha, sha);
  assert.equal(commitPage.commits[0]!.subject, `Release${separator}candidate`);
  assert.equal(commitPage.commits[0]!.author, `Alice${separator}Unit`);
  assert.match(commitPage.commits[0]!.messageMatchExcerpt!, /ORCHID/);

  const tagPage = await tags(h, "q=control-character%20orchid%20alice-unit");
  assert.equal(tagPage.tags[0]!.sha, sha);
  assert.equal(tagPage.tags[0]!.subject, `Release${separator}candidate`);
  assert.equal(tagPage.tags[0]!.author, `Alice${separator}Unit`);
  assert.match(tagPage.tags[0]!.taggedAt!, /^\d{4}-\d{2}-\d{2}T/);
});

test("列分支与列提交:仓库要注册,分支要存在", async () => {
  const h = await registeredHarness();

  assert.equal((await h.api("GET", "/repo-branches?owner=nobody&repo=nothing")).status, 409);
  assert.equal((await h.api("GET", `/repo-commits?${REPO_QUERY}`)).status, 400);
  assert.equal(
    (await h.api("GET", `/repo-commits?${REPO_QUERY}&branch=no-such-branch`)).status,
    404,
  );
  assert.equal(
    (await h.api("GET", `/repo-commits?${REPO_QUERY}&branch=feature&offset=-1`)).status,
    400,
  );
});

test("列提交带 base:后代标出来,base 自己与旁支都不算", async () => {
  const h = await registeredHarness();
  // base 取 feature 上的 head,它后面再推一个 commit;另有一条从 base 之前分出去的分支。
  const base = h.repo.headSha;
  const advanced = h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  const side = h.repo.branchFrom("side", h.repo.mergeBaseSha, {
    "src/side.ts": "export const side = 1;\n",
  });
  // 副本在注册时就备好了(issue #184),列提交本身不 fetch;和人在选择器里的顺序一样,
  // 先列一次分支把新推的这两条取回来。
  await branches(h);

  const page = await commits(h, `branch=feature&base=${base}`);
  assert.deepEqual(
    page.commits.map((commit) => [commit.sha, commit.descendsFromBase]),
    [
      [advanced, true],
      // base 自己不是自己的后代:推进接口也拒绝比较项与 base 是同一个 commit。
      [base, false],
      [h.repo.mergeBaseSha, false],
    ],
  );

  // 切到另一条分支,置灰规则照旧:这条从 base 之前分出去,整条都不是后代。
  const other = await commits(h, `branch=side&base=${base}`);
  assert.deepEqual(
    other.commits.map((commit) => [commit.sha, commit.descendsFromBase]),
    [
      [side, false],
      [h.repo.mergeBaseSha, false],
    ],
  );
});

test("列提交带 base:从 base 分出去的旁支算后代", async () => {
  const h = await registeredHarness();
  const base = h.repo.headSha;
  const rebased = h.repo.branchFrom("rebased", base, {
    "src/answer.ts": "export const answer = 4;\n",
  });
  await branches(h);

  const page = await commits(h, `branch=rebased&base=${base}`);
  assert.deepEqual(
    page.commits.map((commit) => [commit.sha, commit.descendsFromBase]),
    [
      [rebased, true],
      [base, false],
      [h.repo.mergeBaseSha, false],
    ],
  );
});

test("提交搜索:空白分词后逐词 AND 匹配 SHA、完整信息和作者，并回显正文命中片段", async () => {
  const h = await registeredHarness();
  const sha = h.repo.commitToBranch(
    "feature",
    { "src/search.ts": "export const searchable = true;\n" },
    {
      message: "Improve picker\n\nThe hidden release needle is explained here.\n\nReviewed-by: Robot",
      authorName: "Alice Example",
      authorEmail: "alice@example.invalid",
    },
  );
  await branches(h);

  const bodyAndAuthor = await commits(h, "branch=feature&q=NEEDLE%20%20alice");
  assert.deepEqual(bodyAndAuthor.commits.map((commit) => commit.sha), [sha]);
  assert.match(bodyAndAuthor.commits[0]!.messageMatchExcerpt!, /hidden release needle/i);

  const shaAndEmail = await commits(
    h,
    `branch=feature&q=${sha.slice(0, 10)}%20EXAMPLE.INVALID`,
  );
  assert.deepEqual(shaAndEmail.commits.map((commit) => commit.sha), [sha]);

  const missingTerm = await commits(h, "branch=feature&q=needle%20nobody");
  assert.deepEqual(missingTerm.commits, []);
});

test("提交筛选:作者日期、merge 形态与合法后代在分页前按 AND 组合", async () => {
  const h = await registeredHarness();
  const base = h.repo.headSha;
  const side = h.repo.branchFrom("old-side", h.repo.mergeBaseSha, {
    "src/old-side.ts": "export const oldSide = true;\n",
  });
  const january = h.repo.commitToBranch(
    "feature",
    { "src/january.ts": "export const january = true;\n" },
    { message: "january change", authoredAt: "2024-01-15T12:00:00+08:00" },
  );
  const merge = h.repo.mergeInto("feature", "old-side", "merge old side");
  const february = h.repo.commitToBranch(
    "feature",
    { "src/february.ts": "export const february = true;\n" },
    { message: "february change", authoredAt: "2024-02-15T12:00:00+08:00" },
  );
  await branches(h);

  const januaryOnly = await commits(
    h,
    "branch=feature&from=2024-01-01T00%3A00%3A00.000Z&to=2024-01-31T23%3A59%3A59.999Z",
  );
  assert.deepEqual(januaryOnly.commits.map((commit) => commit.sha), [january]);

  const merges = await commits(h, "branch=feature&merge=only");
  assert.deepEqual(merges.commits.map((commit) => commit.sha), [merge]);
  const nonMerges = await commits(h, "branch=feature&merge=non");
  assert.equal(nonMerges.commits.some((commit) => commit.sha === merge), false);

  const legal = await commits(h, `branch=feature&base=${base}&legal=only&limit=2`);
  assert.deepEqual(legal.commits.map((commit) => commit.sha), [february, merge]);
  assert.equal(legal.commits.every((commit) => commit.descendsFromBase === true), true);
  assert.equal(legal.commits.some((commit) => commit.sha === side), false);
  // 非法的 side 在 Git 历史顺序里夹在 merge 与 january 之间；先过滤再分页，第二页仍是 january。
  const legalSecond = await commits(
    h,
    `branch=feature&base=${base}&legal=only&limit=1&offset=2`,
  );
  assert.deepEqual(legalSecond.commits.map((commit) => commit.sha), [january]);
});

test("列提交不带 base:响应形状不变,没有后代标记", async () => {
  const h = await registeredHarness();

  const page = await commits(h, "branch=feature");
  for (const commit of page.commits) {
    assert.equal("descendsFromBase" in commit, false);
  }
});

test("列提交:base 不是 sha 或不在这个仓库里都被拒", async () => {
  const h = await registeredHarness();

  assert.equal(
    (await h.api("GET", `/repo-commits?${REPO_QUERY}&branch=feature&base=nope`)).status,
    400,
  );
  const missing = await h.api(
    "GET",
    `/repo-commits?${REPO_QUERY}&branch=feature&base=0123456789abcdef0123456789abcdef01234567`,
  );
  assert.equal(missing.status, 400);
  assert.match(((await missing.json()) as { error: string }).error, /base/);
});
