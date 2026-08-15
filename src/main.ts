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

/**
 * 基地址是明文 http 且非 localhost 时拒绝启动:Secure cookie 在明文 HTTP 下发不出去,
 * 服务起得来、面板打得开、就是登不进——这比起不来更难排查。localhost 放行,浏览器把
 * 它当安全上下文,本机调试不受影响。
 */
function assertUsableBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`MULTIREVIEWER_BASE_URL 不是合法的 URL:${value}`);
  }
  if (url.protocol === "https:") return;
  if (url.protocol !== "http:") {
    throw new Error(`MULTIREVIEWER_BASE_URL 要以 http:// 或 https:// 开头:${value}`);
  }
  // WHATWG URL 的 IPv6 hostname 带方括号:`new URL("http://[::1]").hostname` 是 "[::1]"。
  const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!localhost) {
    throw new Error(
      `MULTIREVIEWER_BASE_URL 是明文 http 且不是 localhost(${value})。` +
        "Secure cookie 发不出去,面板会打得开却登不进。换 https,或本机调试用 localhost。",
    );
  }
}

/** 面板前缀是路径的一段,字符要 URL 安全,且不能撞上路由表里的固定入口。 */
function panelPrefix(): string {
  const value = required("MULTIREVIEWER_PANEL_PREFIX");
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value === "webhook" || value === "assets") {
    throw new Error(
      `MULTIREVIEWER_PANEL_PREFIX 只能由字母、数字、- 与 _ 组成,且不能是 webhook 或 assets:${value}`,
    );
  }
  return value;
}

const config = loadConfig(process.env["MULTIREVIEWER_CONFIG"] ?? DEFAULT_CONFIG_PATH);
const port = Number(process.env["MULTIREVIEWER_PORT"] ?? DEFAULT_PORT);

const adminToken = required("MULTIREVIEWER_ADMIN_TOKEN");
const prefix = panelPrefix();
assertUsableBaseUrl(required("MULTIREVIEWER_BASE_URL"));

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
  adminToken,
  panelPrefix: prefix,
  ...(config.maxChangedLinesPerBatch === undefined
    ? {}
    : { maxChangedLinesPerBatch: config.maxChangedLinesPerBatch }),
});

server.listen(port, () => {
  console.log(`MultiReviewer webhook 监听 ${port}`);
});
