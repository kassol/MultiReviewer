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

/**
 * 重启之后手填的模型行仍在(issue #87)。库是真相源,派生的用户模型配置在启动时按库重建:
 * 这一步漏了的话,清过缓存目录或换过卷的实例起来就是一份空的配置,面板上还列着那些行,
 * Reviewer 子进程一个都取不到。
 *
 * 库先自己建好再交给 `boot`:`overrides` 最后覆盖环境,`MULTIREVIEWER_DB` 因此指向这里
 * 播种好的那一个,而 `boot` 自己那份播种落在它自己的库上,与本条无关。
 */
test("启动时按库里的模型行重建派生的模型配置", async () => {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-boot-rows-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "seeded.db");
  const cacheDir = join(dir, "worktrees");

  const seed = openStore(dbPath);
  seed.putModelRow({
    provider: "openrouter",
    model: "multireviewer/boot-hand-filled",
    costInput: 1.5,
    costOutput: null,
    contextWindow: 65_536,
    createdAt: "2026-08-18T00:00:00.000Z",
  });
  seed.close();

  const result = await boot({
    GITHUB_TOKEN: "ghp-stub",
    MULTIREVIEWER_DB: dbPath,
    MULTIREVIEWER_CACHE_DIR: cacheDir,
  });
  assert.equal(result.listening, true, result.output);

  const rebuilt = JSON.parse(
    readFileSync(join(cacheDir, "pi-models", "models.json"), "utf8"),
  ) as { providers: Record<string, unknown> };
  assert.deepEqual(rebuilt.providers, {
    openrouter: {
      models: [
        {
          id: "multireviewer/boot-hand-filled",
          // 单价一旦要写就得写满四个费率,没填的那一半按 0 补齐。
          cost: { input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 65_536,
        },
      ],
    },
  });
});

/**
 * 重启之后自定义 provider 仍在(issue #88)。库是真相源,派生的用户模型配置在启动时按库
 * 重建:这一步漏了自定义 provider 那一半的话,起来之后这一家整个不在目录里(全新 provider
 * 缺 `api` 与 `baseUrl` 就是消失,不是报错),面板上还列着它,已经选进模型组合的模型标识
 * 一个都取不到。
 *
 * provider 一级的 `api` 与 `baseUrl` 因此必须落进文件:它们继承不到任何东西。
 */
test("启动时按库里的自定义 provider 重建派生的模型配置", async () => {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-boot-custom-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "seeded.db");
  const cacheDir = join(dir, "worktrees");

  const seed = openStore(dbPath);
  seed.putCustomProvider({
    name: "corp-gateway",
    baseUrl: "https://ai.corp.example/v1",
    api: "openai-completions",
    createdAt: "2026-08-18T00:00:00.000Z",
  });
  seed.putModelRow({
    provider: "corp-gateway",
    model: "corp-qwen3-max",
    costInput: null,
    costOutput: null,
    contextWindow: null,
    createdAt: "2026-08-18T00:00:00.000Z",
  });
  seed.close();

  const result = await boot({
    GITHUB_TOKEN: "ghp-stub",
    MULTIREVIEWER_DB: dbPath,
    MULTIREVIEWER_CACHE_DIR: cacheDir,
  });
  assert.equal(result.listening, true, result.output);

  const rebuilt = JSON.parse(
    readFileSync(join(cacheDir, "pi-models", "models.json"), "utf8"),
  ) as { providers: Record<string, unknown> };
  assert.deepEqual(rebuilt.providers, {
    "corp-gateway": {
      // 全新 provider 没有继承来源,这两项缺任一者这一家整个从目录消失。
      api: "openai-completions",
      baseUrl: "https://ai.corp.example/v1",
      models: [{ id: "corp-qwen3-max" }],
    },
  });
});

/**
 * 重启之后撞名那一家仍然不写进派生文件(issue #94)。这是撞名最可能真实发生的那条路:升级
 * 一次 Pi 之后重启,启动时那一次重建要是不认撞名,内置那一家的每个模型都改指自定义那个端点,
 * 而且这一档一直持续到有人碰一次面板。
 *
 * 名字取一个 Pi 内置就有的(`openrouter`),另一家用自己起的名字当对照:重建的结果里必须只有
 * 后者。`openrouter` 哪天真从 Pi 内置目录里消失,这一条会当场红。
 */
test("启动时撞名的自定义 provider 不写进派生的模型配置", async () => {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-boot-conflict-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "seeded.db");
  const cacheDir = join(dir, "worktrees");

  const seed = openStore(dbPath);
  for (const name of ["openrouter", "corp-gateway"]) {
    seed.putCustomProvider({
      name,
      baseUrl: "https://ai.corp.example/v1",
      api: "openai-completions",
      createdAt: "2026-08-18T00:00:00.000Z",
    });
    seed.putModelRow({
      provider: name,
      model: "corp-qwen3-max",
      costInput: null,
      costOutput: null,
      contextWindow: null,
      createdAt: "2026-08-18T00:00:00.000Z",
    });
  }
  seed.close();

  const result = await boot({
    GITHUB_TOKEN: "ghp-stub",
    MULTIREVIEWER_DB: dbPath,
    MULTIREVIEWER_CACHE_DIR: cacheDir,
  });
  assert.equal(result.listening, true, result.output);

  const rebuilt = JSON.parse(
    readFileSync(join(cacheDir, "pi-models", "models.json"), "utf8"),
  ) as { providers: Record<string, unknown> };
  // 撞名那一家连它的模型行一起不写:模型行留着的话 Pi 会把它当成给内置这一家手填的行追加进来。
  assert.deepEqual(Object.keys(rebuilt.providers), ["corp-gateway"]);
});
