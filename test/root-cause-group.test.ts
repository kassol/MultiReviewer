/**
 * 同根因组(CONTEXT.md,ADR 0030,issue #308)。
 *
 * 打在 `runReview` 的注入边界上(先例 `merge-agent`):脚本化 Reviewer 给 Finding、脚本化
 * 合并 agent 在分组之外多给几组同根因,内存 Forge 跑一到两轮,断言落库的组与成员、Forge
 * 评论末尾那一行,以及坏提议被丢弃时的轨迹。不测 prompt 文本,也不测内部调用序列。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { runReview } from "../src/review/run.ts";
import { openStore } from "../src/review/store.ts";
import { FILES, STUB, query, setup as setupRepo } from "./support/batch-run.ts";
import { testCleanups } from "./support/git-fixture.ts";
import { scriptedMergeAgent, scriptedReviewer } from "./support/memory-forge.ts";

const cleanups = testCleanups();

const EVENT = { owner: "acme", repo: "widgets", number: 7 };
const PANEL = "https://panel.invalid";

function setup() {
  return setupRepo(cleanups);
}

/** 一条 Finding 的模板:落在文件的第一处新增行(第 4 行)或紧随的第 5 行。 */
const AT = (file: string, line: number, title: string) => ({
  file,
  line,
  severity: "P1" as const,
  category: "bug" as const,
  title,
  description: `${file}:${line} ${title}`,
});

/** 落库的同根因组与成员:组、根因说明,成员按组内次序给它所在的文件与轮次。 */
function rootCauseRows(dbPath: string): {
  group: number;
  reason: string;
  members: { file: string; runId: number }[];
}[] {
  const rows = query(
    dbPath,
    `SELECT g.id AS gid, g.reason AS reason, f.file AS file, f.run_id AS run_id
       FROM root_cause_group g
       JOIN root_cause_group_member m ON m.group_id = g.id
       JOIN finding f ON f.id = m.finding_id
      ORDER BY g.id, m.position`,
  );
  const groups: { group: number; reason: string; members: { file: string; runId: number }[] }[] = [];
  for (const row of rows) {
    const gid = Number(row["gid"]);
    let group = groups.find((entry) => entry.group === gid);
    if (group === undefined) {
      group = { group: gid, reason: String(row["reason"]), members: [] };
      groups.push(group);
    }
    group.members.push({ file: String(row["file"]), runId: Number(row["run_id"]) });
  }
  return groups;
}

/** 这一轮落库的全部轨迹事件。 */
function trace(dbPath: string): { kind: string; payload: Record<string, unknown> }[] {
  const store = openStore(dbPath);
  try {
    const runId = store.listRuns({ limit: 1 })[0]!.id;
    return store
      .listTrace(runId)
      .map((event) => ({ kind: event.kind, payload: event.payload as Record<string, unknown> }));
  } finally {
    store.close();
  }
}

test("三处同根因归成一组:组与成员落库,三条评论各带同根因一行,组外那条不带", async () => {
  const { cache, db, forge } = setup();
  // 四条各成一个合并组:前三条是同一个写坏的 helper 在三个文件里的调用,第四条无关。
  const merge = scriptedMergeAgent(
    [
      { members: [0], reason: "a 里调用了写坏的 helper" },
      { members: [1], reason: "b 里调用了写坏的 helper" },
      { members: [2], reason: "c 里调用了写坏的 helper" },
      { members: [3], reason: "这一条与 helper 无关" },
    ],
    { rootCauses: [{ groups: [0, 1, 2], reason: "helper 少判了一次边界,三处调用都受影响" }] },
  );

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [
        AT(FILES[0]!, 4, "helper 用错了"),
        AT(FILES[1]!, 4, "helper 用错了"),
        AT(FILES[2]!, 4, "helper 用错了"),
        AT(FILES[0]!, 5, "另一个无关的问题"),
      ]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    panelBaseUrl: PANEL,
    mergeAgent: merge,
  });

  assert.equal(result.findings.length, 4, "同根因组不改变分组方案");
  assert.deepEqual(rootCauseRows(db.path), [
    {
      group: 1,
      reason: "helper 少判了一次边界,三处调用都受影响",
      members: [
        { file: FILES[0]!, runId: 1 },
        { file: FILES[1]!, runId: 1 },
        { file: FILES[2]!, runId: 1 },
      ],
    },
  ]);

  // 评论按文件首次出现的先后、组内按行号:a:4、a:5、b:4、c:4。
  const bodies = forge.createdReviews[0]!.comments.map((comment) => comment.body);
  const note = `[同根因另见 2 处](${PANEL}/stages/pr%3Aacme%2Fwidgets%2F7?rootCause=1)`;
  for (const index of [0, 2, 3]) {
    assert.ok(bodies[index]!.includes(note), `第 ${index} 条评论要带同根因那一行`);
  }
  assert.ok(!bodies[1]!.includes("同根因"), "未入组的那条评论正文不变");
});

test("坏提议逐组丢弃:轨迹各记一条,分组方案与组外评论照常", async () => {
  const { cache, db, forge } = setup();
  const merge = scriptedMergeAgent(
    [
      { members: [0], reason: "a" },
      { members: [1], reason: "b" },
      { members: [2], reason: "c" },
    ],
    {
      rootCauses: [
        { groups: [0], reason: "只有一个合并组" },
        { groups: [0, 9], reason: "引用了不存在的编号" },
        { groups: [0, 1], reason: "这一组是好的" },
        { groups: [2, 2], reason: "同一份提议里把合并组 2 列了两次" },
        { groups: [1, 2], reason: "合并组 1 已经在上一组里了" },
      ],
    },
  );

  const result = await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [
        AT(FILES[0]!, 4, "第一处"),
        AT(FILES[1]!, 4, "第二处"),
        AT(FILES[2]!, 4, "第三处"),
      ]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    panelBaseUrl: PANEL,
    mergeAgent: merge,
  });

  assert.equal(result.findings.length, 3, "坏提议不作废分组方案");
  assert.equal(trace(db.path).filter((event) => event.kind === "merge_fallback").length, 0);
  assert.deepEqual(
    trace(db.path)
      .filter((event) => event.kind === "root_cause_group_rejected")
      .map((event) => [event.payload["groups"], event.payload["reason"]]),
    [
      [[0], "同根因组的成员不足两个合并组"],
      [[0, 9], "同根因组引用的合并组 9 不在本轮的 0 到 2 之间"],
      // 自己写重了与来晚了是两件事,两句话分开说(评审复核 2026-09-09)。
      [[2, 2], "同根因组把合并组 2 列了两次"],
      [[1, 2], "合并组 1 已经进了前面一个同根因组"],
    ],
  );

  // 过了验收的那一组照常落库,第三条不在任何组里,正文不多那一行。
  assert.deepEqual(rootCauseRows(db.path), [
    {
      group: 1,
      reason: "这一组是好的",
      members: [
        { file: FILES[0]!, runId: 1 },
        { file: FILES[1]!, runId: 1 },
      ],
    },
  ]);
  const bodies = forge.createdReviews[0]!.comments.map((comment) => comment.body);
  assert.ok(!bodies[2]!.includes("同根因"));
});

test("成员一律记本轮那一行:折叠的记本轮落的行,延续的记承接后的新行", async () => {
  const ctx = setup();
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT(FILES[0]!, 4, "a 处的老问题"), AT(FILES[1]!, 4, "b 处的老问题")]),
    ],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    panelBaseUrl: PANEL,
  });
  ctx.forge.existingComments.push(
    ...ctx.forge.publishedComments.map((comment) => ({ ...comment, resolved: false })),
  );

  // b 的那处代码改写掉:旧指纹在新 head 上算不出,那一条只能走延续;a 原样,走折叠。
  ctx.forge.pullRequest.headSha = ctx.repo.commitToBranch("feature", {
    [FILES[1]!]: `${STUB}const rewritten = 42;\nconst other = 7;\n`,
  });

  const merge = scriptedMergeAgent(
    (request) => [
      { members: [0], history: [request.history![0]!.id], reason: "a 处还是同一个问题" },
      { members: [1], history: [request.history![1]!.id], reason: "b 处代码改写了,同一个问题还在" },
    ],
    { rootCauses: [{ groups: [0, 1], reason: "两处都出自那个写坏的 helper" }] },
  );
  await runReview(EVENT, {
    forge: ctx.forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT(FILES[0]!, 4, "a 处的同一个问题"), AT(FILES[1]!, 4, "b 处的同一个问题")]),
    ],
    cacheDir: ctx.cache.dir,
    dbPath: ctx.db.path,
    panelBaseUrl: PANEL,
    mergeAgent: merge,
  });

  // 两条收口各走一档:a 折叠到旧评论(本轮不发新评论),b 承接旧 Identity 并记「延续自」。
  assert.deepEqual(
    query(ctx.db.path, "SELECT file, run_id, continued_from FROM finding ORDER BY id").map(
      (row) => [row["file"], row["run_id"], row["continued_from"] === null ? null : "延续自"],
    ),
    [
      [FILES[0]!, 1, null],
      [FILES[1]!, 1, null],
      [FILES[0]!, 2, null],
      [FILES[1]!, 2, "延续自"],
    ],
  );
  assert.deepEqual(ctx.forge.createdReviews[1]!.comments.map((comment) => comment.path), [
    FILES[1]!,
  ]);

  assert.deepEqual(rootCauseRows(ctx.db.path), [
    {
      group: 1,
      reason: "两处都出自那个写坏的 helper",
      members: [
        // 折叠的那条本轮不发评论,但本轮同样落一行,它与被折叠到的那条历史在 identityKey
        // 下是同一条 Identity,成员记本轮这一行(评审复核 2026-09-09)。
        { file: FILES[0]!, runId: 2 },
        // 延续的那条承接同一条 Identity,成员是本轮承接后的新行。
        { file: FILES[1]!, runId: 2 },
      ],
    },
  ]);
});

test("合并 agent 缺席的那一轮没有组,评论也不多那一行", async () => {
  const { cache, db, forge } = setup();
  await runReview(EVENT, {
    forge: forge.forge,
    reviewers: [
      scriptedReviewer("model-a", [AT(FILES[0]!, 4, "第一处"), AT(FILES[1]!, 4, "第二处")]),
    ],
    cacheDir: cache.dir,
    dbPath: db.path,
    panelBaseUrl: PANEL,
  });

  assert.deepEqual(rootCauseRows(db.path), []);
  for (const comment of forge.createdReviews[0]!.comments) {
    assert.ok(!comment.body.includes("同根因"));
  }
});
