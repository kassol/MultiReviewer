/**
 * 存量搬迁脚本(issue #457)。夹具 `test/fixtures/legacy-sqlite.db` 是按 main 5e13e7e 那一版
 * 的 SQLite schema 造的一份小库,各域各几行,专挑要转型的列与它们可空的那一档。
 *
 * 断的是搬完之后目标库里的样子:逐表行数相等、三类列各自转对了、identity 序列推过了最大 id;
 * 另外两条是拒绝与回滚——目标库非空时不动手,中途失败整笔回滚。
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { migrateLegacyDatabase } from "../scripts/migrate-sqlite-to-pg.ts";
import { makeTestDatabase, testCleanups, withTestDb } from "./support/git-fixture.ts";

const cleanups = testCleanups();

const FIXTURE = join(import.meta.dirname, "fixtures", "legacy-sqlite.db");

async function emptyTarget(): Promise<string> {
  const db = await makeTestDatabase();
  cleanups.push(db.cleanup);
  return db.url;
}

/** 夹具的副本,给要改坏它的那两条用例用。 */
function legacyCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-legacy-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "legacy.db");
  copyFileSync(FIXTURE, path);
  return path;
}

test("夹具库整份搬进 PostgreSQL,49 张表逐表行数相等", async () => {
  const url = await emptyTarget();

  const report = await migrateLegacyDatabase(FIXTURE, url);

  assert.equal(report.ok, true);
  assert.equal(report.counts.length, 49);
  const mismatched = report.counts.filter((row) => row.source !== row.target);
  assert.deepEqual(mismatched, []);
  // 夹具本身不是空的:每张表都至少一行,不然「行数相等」在零行上也成立。
  assert.deepEqual(
    report.counts.filter((row) => row.source === 0),
    [],
  );
});

test("时刻、布尔与 JSON 三类列按目标类型落库", async () => {
  const url = await emptyTarget();
  await migrateLegacyDatabase(FIXTURE, url);

  await withTestDb(url, async (sql) => {
    // 时刻:SQLite 里是 ISO 文本,PostgreSQL 里是 timestamptz(读回经全局解析器仍是 ISO)。
    const [run] = await sql(`SELECT started_at, finished_at FROM review_run WHERE id = $1`, 1);
    assert.equal(run?.["started_at"], "2026-09-01T10:00:00.000Z");
    assert.equal(run?.["finished_at"], "2026-09-01T11:30:45.123Z");
    const [pending] = await sql(`SELECT finished_at FROM review_run WHERE id = $1`, 2);
    assert.equal(pending?.["finished_at"], null);
    const [kind] = await sql(
      `SELECT pg_typeof(started_at)::text AS t FROM review_run WHERE id = $1`,
      1,
    );
    assert.equal(kind?.["t"], "timestamp with time zone");

    // 布尔:0/1 变成 false/true,NULL 仍是 NULL。
    const [alice] = await sql(
      `SELECT is_system_admin, must_change_password FROM panel_user WHERE username = $1`,
      "alice",
    );
    assert.equal(alice?.["is_system_admin"], true);
    assert.equal(alice?.["must_change_password"], false);
    const [findings] = await sql(
      `SELECT
         (SELECT handoff_pending FROM finding WHERE id = 1) AS one,
         (SELECT line_author_adjacent FROM finding WHERE id = 1) AS adjacent,
         (SELECT handoff_pending FROM finding WHERE id = 2) AS two`,
    );
    assert.equal(findings?.["one"], true);
    assert.equal(findings?.["adjacent"], false);
    assert.equal(findings?.["two"], null);

    // JSON 文本变成 jsonb,而且查得动内容——这正是换列类型的由来。(`repo.reviewers` 按文本比
    // 「换没换组合」,留 text,issue #451;这里取的是轮次上冻结的辅助模型与批次计划。)
    const [frozen] = await sql(
      `SELECT auxiliary_model->>'model' AS model, jsonb_typeof(batch_plan_json) AS shape
         FROM review_run WHERE id = $1`,
      1,
    );
    assert.equal(frozen?.["model"], "deepseek-flash");
    assert.equal(frozen?.["shape"], "array");
    const [empty] = await sql(`SELECT auxiliary_model FROM review_run WHERE id = $1`, 2);
    assert.equal(empty?.["auxiliary_model"], null);

    // 自引用往后指的那一行(条目 1 被条目 2 顶掉):插入顺序排不出来,得补回去。
    const [entry] = await sql(
      `SELECT superseded_by FROM product_knowledge_entry WHERE id = $1`,
      1,
    );
    assert.equal(entry?.["superseded_by"], 2);
  });
});

test("原 id 保留,identity 序列推到最大 id 之后", async () => {
  const url = await emptyTarget();
  await migrateLegacyDatabase(FIXTURE, url);

  await withTestDb(url, async (sql) => {
    const roles = await sql(`SELECT id FROM panel_role ORDER BY id`);
    assert.deepEqual(roles.map((row) => row["id"]), [1]);

    const [role] = await sql(
      `INSERT INTO panel_role (name, created_at) VALUES ($1, $2) RETURNING id`,
      "另一个角色",
      "2026-09-03T00:00:00.000Z",
    );
    assert.equal(role?.["id"], 2);

    const [entry] = await sql(
      `INSERT INTO product_knowledge_entry
         (product_id, kind, name, body, avoided, annotations, written_at)
       VALUES (1, 'term', '新词', '正文', '[]', '[]', '2026-09-03T00:00:00.000Z')
       RETURNING id`,
    );
    assert.equal(entry?.["id"], 3);
  });
});

test("目标库不是空的就拒绝执行,已有的行一条不动", async () => {
  const url = await emptyTarget();
  await withTestDb(url, async (sql) => {
    await sql(
      `INSERT INTO panel_role (id, name, created_at) VALUES (9, $1, $2)`,
      "先来的",
      "2026-08-01T00:00:00.000Z",
    );
  });

  await assert.rejects(migrateLegacyDatabase(FIXTURE, url), /目标库不是空的/);

  await withTestDb(url, async (sql) => {
    const roles = await sql(`SELECT id, name FROM panel_role ORDER BY id`);
    assert.deepEqual(roles, [{ id: 9, name: "先来的" }]);
    const [users] = await sql(`SELECT COUNT(*)::int AS n FROM panel_user`);
    assert.equal(users?.["n"], 0);
  });
});

test("中途失败整笔回滚,目标库保持空", async () => {
  const url = await emptyTarget();
  const broken = legacyCopy();
  // Finding 指向一个不存在的轮次:仓库、轮次那几张表已经插进去了,到 finding 这一张才炸。
  const db = new DatabaseSync(broken);
  db.exec(`PRAGMA foreign_keys = OFF`);
  db.prepare(`UPDATE finding SET run_id = 999 WHERE id = 1`).run();
  db.close();

  // 倒在 finding 这一张上,而不是更早——不然「目标库是空的」这条断言在零行上也成立。
  // Drizzle 把驱动的报错包一层,真正那句在 cause 上。
  await assert.rejects(migrateLegacyDatabase(broken, url), (error: unknown) =>
    /violates foreign key constraint "finding_run_id/.test(
      String((error as { cause?: unknown }).cause),
    ),
  );

  await withTestDb(url, async (sql) => {
    const [counts] = await sql(
      `SELECT
         (SELECT COUNT(*) FROM repo)::int AS repos,
         (SELECT COUNT(*) FROM review_run)::int AS runs,
         (SELECT COUNT(*) FROM finding)::int AS findings`,
    );
    assert.deepEqual(counts, { repos: 0, runs: 0, findings: 0 });
  });
});
