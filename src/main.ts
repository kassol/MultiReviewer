/**
 * 进程入口。读配置文件与环境变量,建出 Forge 与 Reviewer,起 webhook 服务。
 */
import { readFileSync } from "node:fs";

import { buildReviewers, DEFAULT_CONFIG_PATH, loadConfig } from "./config.ts";
import {
  assertSupportedVersion,
  createGiteaForge,
  type GiteaForgeOptions,
} from "./forge/gitea.ts";
import { createGitHubForge, type GitHubAuth } from "./forge/github.ts";
import { createWebhookServer } from "./webhook/server.ts";

const DEFAULT_PORT = 3000;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`环境变量 ${name} 未设置`);
  return value;
}

/**
 * 生产用 GitHub App(ADR 0005),开发阶段可退回个人令牌。没配就不建这一格——目标平台
 * 是自托管 Gitea,只审 Gitea 的部署不该被逼着在服务器上放一枚用不到的 GitHub 令牌。
 */
function githubAuth(): GitHubAuth | undefined {
  const appId = process.env["MULTIREVIEWER_GITHUB_APP_ID"];
  if (appId !== undefined && appId !== "") {
    return {
      kind: "app",
      appId,
      // 私钥是多行 PEM,塞进环境变量会被换行折腾,改成给路径。
      privateKey: readFileSync(
        required("MULTIREVIEWER_GITHUB_PRIVATE_KEY_PATH"),
        "utf8",
      ),
    };
  }
  const token = process.env["GITHUB_TOKEN"];
  if (token === undefined || token === "") return undefined;
  return { kind: "token", token };
}

/** Gitea 用 bot 账号加 scoped PAT(ADR 0005)。没配就不建这一格。 */
function giteaOptions(): GiteaForgeOptions | undefined {
  const baseUrl = process.env["MULTIREVIEWER_GITEA_URL"];
  if (baseUrl === undefined || baseUrl === "") return undefined;
  return { baseUrl, token: required("MULTIREVIEWER_GITEA_TOKEN") };
}

const config = loadConfig(process.env["MULTIREVIEWER_CONFIG"] ?? DEFAULT_CONFIG_PATH);
const port = Number(process.env["MULTIREVIEWER_PORT"] ?? DEFAULT_PORT);

const gitea = giteaOptions();
const github = githubAuth();
// 一个 Forge 都没有时服务照样能起、照样收投递,却一次审查都跑不了,只在日志里留下
// 「没有配置 Forge」。这种起得来的哑服务比起不来更难发现,当场拦掉。
if (gitea === undefined && github === undefined) {
  throw new Error(
    "至少要配置一个 Forge:Gitea 设 MULTIREVIEWER_GITEA_URL 与 MULTIREVIEWER_GITEA_TOKEN," +
      "GitHub 设 MULTIREVIEWER_GITHUB_APP_ID 或 GITHUB_TOKEN。",
  );
}

// 版本检查在启动时做一次。实例版本不够时 resolve / unresolve 会 404,Disposition 整
// 条链路都是哑的,而这要等到第一次有人处置 Finding 才会显形——宁可起不来。
if (gitea !== undefined) await assertSupportedVersion(gitea);

const server = createWebhookServer({
  forges: {
    ...(github === undefined ? {} : { github: createGitHubForge({ auth: github }) }),
    ...(gitea === undefined ? {} : { gitea: createGiteaForge(gitea) }),
  },
  reviewers: buildReviewers(config),
  cacheDir: process.env["MULTIREVIEWER_CACHE_DIR"] ?? ".cache/worktrees",
  dbPath: process.env["MULTIREVIEWER_DB"] ?? "multireviewer.db",
  ...(config.maxChangedLinesPerBatch === undefined
    ? {}
    : { maxChangedLinesPerBatch: config.maxChangedLinesPerBatch }),
});

server.listen(port, () => {
  console.log(`MultiReviewer webhook 监听 ${port}`);
});
