/**
 * 进程入口的 Forge 组装。
 *
 * 只审 Gitea 的部署不该被逼着配 GitHub 凭据,而一个 Forge 都没配的服务起得来却一次
 * 审查都跑不了——两条都只在真正起进程时才显形,因此这里直接 spawn `main.ts`。
 * 只配 Gitea 的那一档要连真实实例做版本检查,留给 `gitea-live.test.ts`。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

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
];

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

type Boot = { listening: boolean; output: string };

async function boot(overrides: Record<string, string>): Promise<Boot> {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-boot-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      reviewers: [{ provider: "test", model: "stub", apiKeyEnv: "STUB_KEY" }],
    }),
  );

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !CLEARED.includes(name)) env[name] = value;
  }
  Object.assign(env, {
    MULTIREVIEWER_CONFIG: configPath,
    MULTIREVIEWER_DB: join(dir, "multireviewer.db"),
    MULTIREVIEWER_CACHE_DIR: join(dir, "worktrees"),
    // 0 让内核挑一个空闲端口,并发跑测试时不会撞上。
    MULTIREVIEWER_PORT: "0",
    STUB_KEY: "stub-credential",
    ...overrides,
  });

  const child = spawn(process.execPath, [MAIN], { cwd: dir, env });
  return await new Promise<Boot>((resolve) => {
    let output = "";
    const settle = (listening: boolean): void => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve({ listening, output });
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

test("一个 Forge 都没配时启动失败并说明要配什么", async () => {
  const result = await boot({});
  assert.equal(result.listening, false);
  assert.match(result.output, /至少要配置一个 Forge/);
  assert.match(result.output, /MULTIREVIEWER_GITEA_URL/);
});
