/**
 * 进程入口。读配置文件与环境变量,建出 Forge 与 Reviewer,起 webhook 服务。
 */
import { readFileSync } from "node:fs";

import { buildReviewers, DEFAULT_CONFIG_PATH, loadConfig } from "./config.ts";
import { createGitHubForge, type GitHubAuth } from "./forge/github.ts";
import { createWebhookServer } from "./webhook/server.ts";

const DEFAULT_PORT = 3000;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`环境变量 ${name} 未设置`);
  return value;
}

/** 生产用 GitHub App(ADR 0005),开发阶段可退回个人令牌。 */
function githubAuth(): GitHubAuth {
  const appId = process.env["MULTIREVIEWER_GITHUB_APP_ID"];
  if (appId === undefined || appId === "") {
    return { kind: "token", token: required("GITHUB_TOKEN") };
  }
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

const config = loadConfig(process.env["MULTIREVIEWER_CONFIG"] ?? DEFAULT_CONFIG_PATH);
const port = Number(process.env["MULTIREVIEWER_PORT"] ?? DEFAULT_PORT);

const server = createWebhookServer({
  secret: required("MULTIREVIEWER_WEBHOOK_SECRET"),
  // Gitea 的实现还没有(issue #3),落地后填上这一格即可。
  forges: { github: createGitHubForge({ auth: githubAuth() }) },
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
