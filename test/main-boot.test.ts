/**
 * 进程入口的 Forge 组装。
 *
 * 只审 Gitea 的部署不该被逼着配 GitHub 凭据,而一个 Forge 都没配的服务起得来却一次
 * 审查都跑不了——两条都只在真正起进程时才显形,因此这里直接 spawn `main.ts`。
 * 只配 Gitea 的那一档要连真实实例做版本检查,留给 `gitea-live.test.ts`。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import type { ReviewerSpec } from "../src/config.ts";
import { openStore } from "../src/review/store.ts";

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

async function boot(
  overrides: Record<string, string>,
  reviewers: readonly ReviewerSpec[] = [{ provider: "test", model: "stub" }],
): Promise<Boot> {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-boot-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "multireviewer.db");
  // 模型组合在库里(issue #66):启动前先播种,空数组即「还没配组合」的空库。
  const seed = openStore(dbPath);
  seed.putGlobalSettings({
    reviewersJson: reviewers.length === 0 ? null : JSON.stringify(reviewers),
    maxChangedLinesPerBatch: null,
  });
  seed.close();

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !CLEARED.includes(name)) env[name] = value;
  }
  Object.assign(env, {
    MULTIREVIEWER_DB: dbPath,
    MULTIREVIEWER_CACHE_DIR: join(dir, "worktrees"),
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

/**
 * 派生的用户模型配置在启动时被重建(issue #85)。Reviewer 子进程只读这份文件,而它的真相
 * 源是库:只在有人打开面板时才重建的话,谁都没点过面板的实例投递进来会直接报「模型不存在」。
 *
 * 断言打在真实启动上而不是那个写入函数上:函数自己对不对由 `reviewer-model-store` 那条缝
 * 守着,而「启动时到底调没调它」只有起进程才看得出来。
 */
test("启动时重建派生的模型配置,库里没有的行被清掉", async () => {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-boot-config-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const cacheDir = join(dir, "worktrees");
  const configPath = join(cacheDir, "pi-models", "models.json");

  // 上一代留下的一行:重建之后不该还在。
  mkdirSync(join(cacheDir, "pi-models"), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({ providers: { openrouter: { models: [{ id: "stale-row" }] } } }),
  );

  const result = await boot({ GITHUB_TOKEN: "ghp-stub", MULTIREVIEWER_CACHE_DIR: cacheDir });
  assert.equal(result.listening, true, result.output);

  const rebuilt = JSON.parse(readFileSync(configPath, "utf8")) as {
    providers: Record<string, unknown>;
  };
  assert.deepEqual(rebuilt.providers, {}, "启动没有按库里的当前状态重建这份文件");
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

test("admin token 缺失时启动失败", async () => {
  const result = await boot({ GITHUB_TOKEN: "ghp-stub", MULTIREVIEWER_ADMIN_TOKEN: "" });
  assert.equal(result.listening, false);
  assert.match(result.output, /MULTIREVIEWER_ADMIN_TOKEN/);
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
