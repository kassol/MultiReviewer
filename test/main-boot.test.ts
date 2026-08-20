/**
 * 进程入口的 Forge 组装。
 *
 * 只审 Gitea 的部署不该被逼着配 GitHub 凭据,而一个 Forge 都没配的服务起得来却一次
 * 审查都跑不了——两条都只在真正起进程时才显形,因此这里直接 spawn `main.ts`。
 * 只配 Gitea 的那一档要连真实实例做版本检查,留给 `gitea-live.test.ts`。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import type { ReviewerSpec } from "../src/config.ts";
import { openStore, STORE_SCHEMA } from "../src/review/store.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const LISTENING = "MultiReviewer webhook 监听";
const BOOT_TIMEOUT_MS = 30_000;

/** 宿主机上导出过的凭据会让「没配」这一档根本测不出来,逐个剥掉。 */
const CLEARED = [
  "MULTIREVIEWER_GITEA_URL",
  "MULTIREVIEWER_GITEA_TOKEN",
  "MULTIREVIEWER_GITHUB_APP_ID",
  "MULTIREVIEWER_GITHUB_PRIVATE_KEY_PATH",
  "GITHUB_TOKEN",
  "MULTIREVIEWER_CREDENTIAL_MASTER_KEY",
];

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

type Boot = { listening: boolean; output: string; dir: string };
type BootPaths = { dbPath: string; cacheDir: string };

async function boot(
  overrides: Record<string, string>,
  reviewers: readonly ReviewerSpec[] = [{ provider: "test", model: "stub" }],
  prepare?: (paths: BootPaths) => void,
): Promise<Boot> {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-boot-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "multireviewer.db");
  const cacheDir = join(dir, "worktrees");
  if (prepare === undefined) {
    const seed = openStore(dbPath);
    seed.putGlobalSettings({
      reviewersJson: reviewers.length === 0 ? null : JSON.stringify(reviewers),
      maxChangedLinesPerBatch: null,
    });
    seed.close();
  } else {
    prepare({ dbPath, cacheDir });
  }

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !CLEARED.includes(name)) env[name] = value;
  }
  Object.assign(env, {
    MULTIREVIEWER_DB: dbPath,
    MULTIREVIEWER_CACHE_DIR: cacheDir,
    MULTIREVIEWER_ADMIN_TOKEN: "boot-test-admin-token",
    MULTIREVIEWER_PANEL_PREFIX: "boot-test-prefix",
    // 明文 http 但 localhost:基地址校验要放行本机调试。
    MULTIREVIEWER_BASE_URL: "http://localhost:3000",
    // 0 让内核挑一个空闲端口,并发跑测试时不会撞上。
    MULTIREVIEWER_PORT: "0",
    ...overrides,
  });

  const child = spawn(process.execPath, [MAIN], { cwd: dir, env });
  return await new Promise<Boot>((resolve) => {
    let output = "";
    const settle = (listening: boolean): void => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve({ listening, output, dir });
    };
    const timer = setTimeout(() => settle(false), BOOT_TIMEOUT_MS);

    const collect = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.includes(LISTENING)) settle(true);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("exit", () => settle(output.includes(LISTENING)));
  });
}

function seedLegacyDatabase({ dbPath, cacheDir }: BootPaths): void {
  const db = new DatabaseSync(dbPath);
  db.exec(STORE_SCHEMA);
  db.exec(`
    CREATE TABLE model_credential (
      provider TEXT PRIMARY KEY,
      api_key_encrypted TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE model_row (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      cost_input REAL,
      cost_output REAL,
      context_window INTEGER,
      max_output_tokens INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider, model)
    );
    CREATE TABLE custom_provider (
      name TEXT PRIMARY KEY,
      base_url TEXT NOT NULL,
      api TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const at = "2026-08-19T00:00:00.000Z";
  db.prepare("INSERT INTO custom_provider (name, base_url, api, created_at) VALUES (?, ?, ?, ?)")
    .run("corp-gateway", "https://ai.example.test/v1", "openai-completions", at);
  db.prepare(
    `INSERT INTO model_row
       (provider, model, cost_input, cost_output, context_window, max_output_tokens, created_at)
     VALUES (?, ?, null, null, null, null, ?)`,
  ).run("corp-gateway", "legacy-model", at);
  db.prepare("INSERT INTO global_setting (key, value) VALUES ('reviewers', ?)")
    .run(JSON.stringify([{ provider: "corp-gateway", model: "legacy-model" }]));
  db.prepare(
    `INSERT INTO review_run
       (id, owner, repo, pull_number, head_sha, started_at, finished_at,
        changed_files, changed_lines, batch_count, failed)
     VALUES (1, 'acme', 'history', 7, 'legacy-head', ?, ?, 1, 2, 1, 0)`,
  ).run(at, at);
  db.close();

  const projectionDir = join(cacheDir, "pi-models");
  mkdirSync(projectionDir, { recursive: true });
  writeFileSync(join(projectionDir, "models.json"), "legacy-current-config");
  writeFileSync(join(projectionDir, "models-store.json"), "legacy-catalog-cache");
}

test("启动先迁移 schema-v0、删除旧投影并只输出一次摘要，历史仍可读", async () => {
  const first = await boot({ GITHUB_TOKEN: "ghp-stub" }, [], seedLegacyDatabase);
  assert.equal(first.listening, true, first.output);
  assert.match(first.output, /"event":"model-service-migration"/);

  const dbPath = join(first.dir, "multireviewer.db");
  const cacheDir = join(first.dir, "worktrees");
  const sqlite = new DatabaseSync(dbPath);
  assert.equal(Number(sqlite.prepare("PRAGMA user_version").get()?.["user_version"]), 1);
  const tables = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all().map((row) => String(row["name"]));
  sqlite.close();
  for (const removed of ["model_credential", "model_row", "custom_provider"]) {
    assert.equal(tables.includes(removed), false, `${removed} 被重新建回来了`);
  }
  assert.equal(existsSync(join(cacheDir, "pi-models", "models.json")), false);
  assert.equal(existsSync(join(cacheDir, "pi-models", "models-store.json")), false);
  assert.equal(
    readdirSync(first.dir).filter((name) => name.includes(".pre-model-service-v1.sqlite")).length,
    1,
  );

  const store = openStore(dbPath);
  assert.equal(store.listRuns({ limit: 1 })[0]?.headSha, "legacy-head");
  assert.equal(store.getGlobalSettings().reviewersJson, JSON.stringify([
    { provider: "corp-gateway", model: "legacy-model" },
  ]));
  store.close();

  const second = await boot({
    GITHUB_TOKEN: "ghp-stub",
    MULTIREVIEWER_DB: dbPath,
    MULTIREVIEWER_CACHE_DIR: cacheDir,
  }, []);
  assert.equal(second.listening, true, second.output);
  assert.equal(second.output.includes('"event":"model-service-migration"'), false);
  assert.equal(
    readdirSync(first.dir).filter((name) => name.includes(".pre-model-service-v1.sqlite")).length,
    1,
    "正常重启覆盖或追加了迁移备份",
  );
  const reopened = new DatabaseSync(dbPath, { readOnly: true });
  const reopenedTables = reopened.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all().map((row) => String(row["name"]));
  reopened.close();
  for (const removed of ["model_credential", "model_row", "custom_provider"]) {
    assert.equal(reopenedTables.includes(removed), false, `${removed} 在迁移库重启时被重新建回来了`);
  }
});

test("监听失败不确认迁移摘要，下一次成功启动仍输出并确认", async () => {
  const blocker = createServer();
  blocker.listen(0);
  await once(blocker, "listening");
  const address = blocker.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    const failed = await boot(
      { GITHUB_TOKEN: "ghp-stub", MULTIREVIEWER_PORT: String(address.port) },
      [],
      seedLegacyDatabase,
    );
    assert.equal(failed.listening, false);
    assert.equal(failed.output.includes('"event":"model-service-migration"'), false);

    const retried = await boot({
      GITHUB_TOKEN: "ghp-stub",
      MULTIREVIEWER_DB: join(failed.dir, "multireviewer.db"),
      MULTIREVIEWER_CACHE_DIR: join(failed.dir, "worktrees"),
    }, []);
    assert.equal(retried.listening, true, retried.output);
    assert.match(retried.output, /"event":"model-service-migration"/);
  } finally {
    blocker.close();
    await once(blocker, "close");
  }
});

test("只配 GitHub 令牌时服务起得来", async () => {
  const result = await boot({ GITHUB_TOKEN: "ghp-stub" });
  assert.equal(result.listening, true, result.output);
});

/**
 * 空库、多家 provider 一把凭据都没有、连主密钥都没设的新部署:启动不校验凭据
 * (issue #65),否则起不来就进不了面板,进不了面板就配不了凭据。
 */
test("空库、没有任何模型凭据时服务照常起", async () => {
  const result = await boot({ GITHUB_TOKEN: "ghp-stub" }, [
    { provider: "anthropic", model: "claude-haiku-4-5" },
    { provider: "deepseek", model: "deepseek-v4-flash" },
  ]);
  assert.equal(result.listening, true, result.output);
});


test("一个 Forge 都没配时启动失败并说明要配什么", async () => {
  const result = await boot({});
  assert.equal(result.listening, false);
  assert.match(result.output, /至少要配置一个 Forge/);
  assert.match(result.output, /MULTIREVIEWER_GITEA_URL/);
});

test("基地址是明文 http 且非 localhost 时拒绝启动并说明后果", async () => {
  const result = await boot({
    GITHUB_TOKEN: "ghp-stub",
    MULTIREVIEWER_BASE_URL: "http://reviewer.example.com",
  });
  assert.equal(result.listening, false);
  // 说清「起得来却登不进」的因果,不是干巴巴的「不合法」。
  assert.match(result.output, /Secure cookie/);
});

test("admin token 缺失不拦启动,零用户时打印 bootstrap 口令", async () => {
  const result = await boot({ GITHUB_TOKEN: "ghp-stub", MULTIREVIEWER_ADMIN_TOKEN: "" });
  assert.equal(result.listening, true);
  assert.match(result.output, /bootstrap:/);
});

test("面板前缀撞上固定入口或带非法字符时启动失败", async () => {
  const result = await boot({ GITHUB_TOKEN: "ghp-stub", MULTIREVIEWER_PANEL_PREFIX: "webhook" });
  assert.equal(result.listening, false);
  assert.match(result.output, /MULTIREVIEWER_PANEL_PREFIX/);
});

test("基地址不是 http(s) 时启动失败", async () => {
  const result = await boot({
    GITHUB_TOKEN: "ghp-stub",
    MULTIREVIEWER_BASE_URL: "ftp://reviewer.example.com",
  });
  assert.equal(result.listening, false);
  assert.match(result.output, /http/);
});
