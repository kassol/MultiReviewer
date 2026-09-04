/**
 * 进程入口。读环境变量建出 Forge,起 webhook 服务。模型组合与批次上限在库里,
 * 由面板的设置页管(issue #66)。
 */
import { readFileSync } from "node:fs";
import { buildReviewers } from "./config.ts";
import { createDrain } from "./drain.ts";

import {
  assertSupportedVersion,
  createGiteaForge,
  type GiteaForgeOptions,
} from "./forge/gitea.ts";
import { createGitHubForge, type GitHubAuth } from "./forge/github.ts";
import { CREDENTIAL_MASTER_KEY_ENV } from "./panel/credential-crypto.ts";
import { createWebhookServer } from "./webhook/server.ts";

const DEFAULT_PORT = 3000;

/**
 * 排空上限(issue #249)。与 `docker-compose.yml` 的 `stop_grace_period` 是同一个数:
 * 容器的宽限期短于它的话,等到一半仍会被 SIGKILL,批次白跑。改一处必须改另一处。
 */
const DEFAULT_DRAIN_TIMEOUT_SECONDS = 300;

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

const port = Number(process.env["MULTIREVIEWER_PORT"] ?? DEFAULT_PORT);
const dbPath = process.env["MULTIREVIEWER_DB"] ?? "multireviewer.db";
const cacheDir = process.env["MULTIREVIEWER_CACHE_DIR"] ?? ".cache/worktrees";

const baseUrl = required("MULTIREVIEWER_BASE_URL");
assertUsableBaseUrl(baseUrl);

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

const drain = createDrain();
// 填了个解析不出的值时退回默认:NaN 传给 setTimeout 会立刻超时,那等于每次发版都放弃
// 全部在跑的轮次,而这只会在真正发版时才显形。
const drainTimeoutSeconds = Number(process.env["MULTIREVIEWER_DRAIN_TIMEOUT_SECONDS"]);
const drainTimeoutMs =
  (Number.isFinite(drainTimeoutSeconds) && drainTimeoutSeconds > 0
    ? drainTimeoutSeconds
    : DEFAULT_DRAIN_TIMEOUT_SECONDS) * 1000;

const server = createWebhookServer({
  drain,
  forges: {
    ...(github === undefined ? {} : { github: createGitHubForge({ auth: github }) }),
    ...(gitea === undefined ? {} : { gitea: createGiteaForge(gitea) }),
  },
  cacheDir,
  dbPath,
  baseUrl,
  panelDist: process.env["MULTIREVIEWER_PANEL_DIST"] ?? "web/dist",
  // 模型凭据的主密钥(ADR 0008)。没配不拦启动:凭据页会说明差什么,而服务起不来
  // 的话人连面板都进不去。
  ...(process.env[CREDENTIAL_MASTER_KEY_ENV] === undefined
    ? {}
    : { credentialMasterKey: process.env[CREDENTIAL_MASTER_KEY_ENV] }),
  onBootstrap: (secret) => {
    console.log("库里还没有用户。用这枚一次性口令注册第一个管理员:");
    console.log(`  bootstrap: ${secret}`);
    console.log("(注册成功后它立即失效,重启会换一枚新的)");
  },
  ...(gitea === undefined ? {} : { gitea }),
  // 全局组合与每仓库的模型覆盖走同一套组装逻辑,凭据取 Run 开始时的库内快照。
  buildReviewers,
});

server.listen(port, () => {
  console.log(`MultiReviewer webhook 监听 ${port}`);
});

/**
 * 优雅退出(issue #249)。发版换容器时 Docker 先发 SIGTERM:停止接受新连接与新投递,
 * 已开跑的轮次跑完当前批次并落库后停下,再退出。缺的批次由下一次启动续跑(issue #248)。
 *
 * 超过上限仍没停下的轮次不再等:它们停在哪一批已经落了库,下一次启动照样续得回来。
 * 退出码一律 0——这是一次预期之内的停机,不是失败。
 */
let exiting = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (exiting) return;
  exiting = true;
  console.log(`[drain] 收到 ${signal},停止接受新投递,等在跑的轮次跑完当前批次`);
  drain.begin();
  server.close();
  // 长连接不会自己断开(面板的 SSE 就是),不主动关掉的话 close 永远等不到。
  server.closeIdleConnections();
  const abandoned = await drain.settle(drainTimeoutMs);
  if (abandoned.length > 0) {
    console.warn(
      `[drain] 等了 ${drainTimeoutMs / 1000} 秒仍没停下,放弃这些轮次:${abandoned.join("、")}`,
    );
  }
  console.log("[drain] 排空结束,退出");
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal));
}
