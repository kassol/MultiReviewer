/**
 * Webhook 端点。接收 Gitea 与 GitHub 的 pull request 事件,规范化成同一形状,再异步跑
 * 一次 Review Run。
 *
 * 审查结果只以 review 评论呈现,本工具从不调用 status / check 之类会阻断合并的接口,
 * `Forge` 接口里也没有这类方法:审查是建议,不是门禁,人保留最终判断权。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type { Forge } from "../forge/forge.ts";
import type { Reviewer } from "../review/finding.ts";
import { runReview } from "../review/run.ts";
import { openStore } from "../review/store.ts";

export type Platform = "github" | "gitea";

/**
 * 规范化后的 pull request 事件。两个平台的投递解析到这一个形状,除 `platform` 外逐
 * 字段相同,`runReview` 之下再也分不出投递来自哪个平台。
 */
export type NormalizedEvent = {
  platform: Platform;
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  draft: boolean;
  /** 只有这两个动作触发 Review Run,其余在规范化时就被滤掉。 */
  action: "opened" | "new-commit";
};

export type WebhookServerDeps = {
  /** 校验投递签名的密钥,两个平台共用一个。 */
  secret: string;
  /**
   * 按来源平台索引的 Forge。某个平台没有配凭据时那一格可以缺失,缺失时记录下来
   * 并放行投递——是本服务的配置缺口,不是投递的问题。
   */
  forges: Partial<Record<Platform, Forge>>;
  reviewers: readonly Reviewer[];
  cacheDir: string;
  dbPath: string;
  maxChangedLinesPerBatch?: number;
  /**
   * 后台 Review Run 结束时回调,`error` 有值即这次投递没跑成——平台缺 Forge 而被放掉
   * 时也走这里。不传则把结果写进 stdout、把失败写进 stderr。
   */
  onRunSettled?: (event: NormalizedEvent, error?: unknown) => void;
  /**
   * 通过签名校验的投递记一行,说明这次做了什么。不传则写 stdout。
   *
   * 没有这行记录时,这个服务在正常工作与完全收不到投递之间看起来一模一样:两种情况的
   * 日志都只有启动那一句。测试注入它来消掉噪音。
   *
   * 本服务对 pull request 的判定结果逐条记,与本服务无关的投递只记首次,见 `handle`。
   */
  onDelivery?: (message: string) => void;
};

/** 两个平台标识 pull request 事件的头值相同。 */
const PULL_REQUEST_EVENT = "pull_request";

/** 未认证的投递方能塞任意大的 body,先设上限再读进内存。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * 「PR 新增 commit」两个平台拼写不同:GitHub 是 `synchronize`,Gitea 是 `synchronized`。
 *
 * 依据:go-gitea/gitea `release/v1.26` 的 `modules/structs/hook.go:377`
 * (`HookIssueSynchronized HookIssueAction = "synchronized"`,`opened` 在 :359);
 * GitHub 见 https://docs.github.com/en/webhooks/webhook-events-and-payloads 的
 * pull_request 事件 action 列表。
 */
const ACTIONS: Record<Platform, Record<string, NormalizedEvent["action"]>> = {
  github: { opened: "opened", synchronize: "new-commit" },
  gitea: { opened: "opened", synchronized: "new-commit" },
};

/**
 * 两个平台共用 `X-Hub-Signature-256`:值是 `sha256=` 加原始 body 的 HMAC-SHA256 十六
 * 进制摘要。Gitea 另发一个 `X-Gitea-Signature`(裸十六进制,无前缀),内容相同,不必
 * 再认第二个头。
 *
 * 依据:go-gitea/gitea `release/v1.26` 的 `services/webhook/deliver.go` 中
 * `addDefaultHeaders` 写下 `req.Header.Add("X-Hub-Signature-256", "sha256="+signatureSHA256)`,
 * 其中 `signatureSHA256 = hex.EncodeToString(hmac.New(sha256.New, secret).Sum(nil))`,
 * 输入是投递的原始 body;GitHub 见
 * https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries。
 */
function verifySignature(
  secret: string,
  body: Buffer,
  header: string | string[] | undefined,
): boolean {
  if (typeof header !== "string") return false;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  );
  const provided = Buffer.from(header);
  // timingSafeEqual 在两段长度不等时抛异常,长度先短路。
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * 认出投递来自哪个平台,并要求它是 pull request 事件。
 *
 * Gitea 为兼容 GitHub 的接收端,把 `X-GitHub-Event` 与自己的 `X-Gitea-Event` 一起发
 * (deliver.go 的 `addDefaultHeaders` 同一段代码),因此必须先认 `X-Gitea-Event`,
 * 否则 Gitea 的投递会被当成 GitHub 的解析,action 的拼写差异就会让它全被丢掉。
 */
function pullRequestSource(req: IncomingMessage): Platform | undefined {
  const gitea = req.headers["x-gitea-event"];
  if (gitea !== undefined) return gitea === PULL_REQUEST_EVENT ? "gitea" : undefined;
  const github = req.headers["x-github-event"];
  if (github !== undefined) return github === PULL_REQUEST_EVENT ? "github" : undefined;
  return undefined;
}

type RawPayload = {
  action?: unknown;
  number?: unknown;
  pull_request?: { draft?: unknown; head?: { sha?: unknown } };
  repository?: { name?: unknown; owner?: { login?: unknown } };
};

/**
 * 把一个平台的 pull_request payload 解析成 `NormalizedEvent`。
 *
 * 不触发审查的 action 返回 `"ignored"`;字段对不上返回 `"malformed"`——平台改了字段名
 * 时它会在投递记录里显形,静默回 200 会让服务看起来正常却一次审查都不跑。
 *
 * 字段路径两个平台逐字相同。Gitea 的依据是 `release/v1.26` 的
 * `modules/structs/hook.go:434` `PullRequestPayload`(`Index int64 \`json:"number"\``、
 * `PullRequest *PullRequest \`json:"pull_request"\``、`Repository *Repository \`json:"repository"\``)、
 * `modules/structs/pull.go` 的 `PullRequest`(`Draft bool \`json:"draft"\`` 在 :39,
 * `Head *PRBranchInfo \`json:"head"\`` 在 :78)与 `PRBranchInfo`(`Sha string \`json:"sha"\`` 在 :105)、
 * `modules/structs/repo.go:50` 的 `Repository`(`Owner *User \`json:"owner"\``、
 * `Name string \`json:"name"\``)、`modules/structs/user.go:19` 的 `User`
 * (`UserName string \`json:"login"\``);GitHub 见其 pull_request 事件文档。
 *
 * PR number 取顶层的 `number`,两个平台都在顶层给了它。
 */
export function normalizeEvent(
  platform: Platform,
  payload: unknown,
): NormalizedEvent | "ignored" | "malformed" {
  if (typeof payload !== "object" || payload === null) return "malformed";
  const raw = payload as RawPayload;

  if (typeof raw.action !== "string") return "malformed";
  const action = ACTIONS[platform][raw.action];
  if (action === undefined) return "ignored";

  const owner = raw.repository?.owner?.login;
  const repo = raw.repository?.name;
  const headSha = raw.pull_request?.head?.sha;
  const draft = raw.pull_request?.draft;
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    typeof raw.number !== "number" ||
    typeof headSha !== "string" ||
    typeof draft !== "boolean"
  ) {
    return "malformed";
  }

  return { platform, owner, repo, number: raw.number, headSha, draft, action };
}

/**
 * 投递所属的 `owner/repo`,用来把「只记首次」按仓库分桶。取不到(非 JSON、无 repository
 * 字段,如 ping 事件)返回空串,退回按事件类型全局记一次——认不出仓库时也认不出该分给谁。
 */
function repoTag(payload: unknown): string {
  const raw = payload as RawPayload | null;
  const owner = raw?.repository?.owner?.login;
  const repo = raw?.repository?.name;
  return typeof owner === "string" && typeof repo === "string" ? `${owner}/${repo}` : "";
}

/** body 解析成 JSON,失败返回 null。无关事件的 payload 只为抽出仓库,不值得为它抛。 */
function safeParse(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

function send(res: ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}

async function readBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      send(res, 413);
      req.destroy();
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** 日志里指认一次投递。head commit 取前 7 位,与 git 的短 SHA 一致。 */
function describe(event: NormalizedEvent): string {
  return `${event.platform} ${event.owner}/${event.repo}#${event.number} ${event.action} @${event.headSha.slice(0, 7)}`;
}

function logFailure(event: NormalizedEvent, error?: unknown): void {
  if (error === undefined) {
    console.log(`[webhook] ${describe(event)} — 审查结束`);
    return;
  }
  console.error(
    `[webhook] ${describe(event)} — 审查失败:`,
    error instanceof Error ? error.message : String(error),
  );
}

/** 幂等:同一个「仓库 + head commit」只有第一次领得走。 */
function claim(dbPath: string, event: NormalizedEvent): boolean {
  const store = openStore(dbPath);
  try {
    return store.claimDelivery(event.owner, event.repo, event.headSha);
  } finally {
    store.close();
  }
}

function startRun(deps: WebhookServerDeps, forge: Forge, event: NormalizedEvent): void {
  const settled = deps.onRunSettled ?? logFailure;
  // 这是长跑服务,后台任务的 rejection 不接住就会变成 unhandledRejection 把进程带崩。
  void runReview(
    { owner: event.owner, repo: event.repo, number: event.number },
    {
      forge,
      reviewers: deps.reviewers,
      cacheDir: deps.cacheDir,
      dbPath: deps.dbPath,
      ...(deps.maxChangedLinesPerBatch === undefined
        ? {}
        : { maxChangedLinesPerBatch: deps.maxChangedLinesPerBatch }),
    },
  ).then(
    () => settled(event),
    (error: unknown) => settled(event, error),
  );
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  loggedOnce: Set<string>,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;

  // 签名先于一切:后面每一步都在用 body 里的内容做决定。
  if (!verifySignature(deps.secret, body, req.headers["x-hub-signature-256"])) {
    return send(res, 401);
  }

  // 签名过了才记日志:未认证的请求可以随便发,记它们等于把日志交给外人写。
  const log = deps.onDelivery ?? ((message: string) => console.log(`[webhook] ${message}`));

  /**
   * 与本服务无关的投递按 `key` 只记首次。webhook 订阅通常宽于本服务要的两个 action,
   * PR 下每条评论、每次打标签都投一次,逐条记会把真正要看的判定结果淹掉。
   *
   * 仍记首次而不是完全不记:「投递到底有没有到」只有这行能证明,它同时是测试对
   * 「收到了但不处理」的观测点。状态只在本进程内,重启后每类再记一次——重启值得重新
   * 报一遍这个端点在收什么。键的取值范围是两个平台的事件类型与 action,是闭集。
   */
  const logOnce = (key: string, message: string): void => {
    if (loggedOnce.has(key)) return;
    loggedOnce.add(key);
    log(message);
  };

  // 不关心的事件类型不是错误,投递本身是成功的,只是没有活要干。
  const platform = pullRequestSource(req);
  if (platform === undefined) {
    const name = req.headers["x-gitea-event"] ?? req.headers["x-github-event"] ?? "(无)";
    // 无关事件不解析 payload 去跑审查,但仍抽出它所属的仓库把「只记首次」按仓库分桶:
    // 一份实例服务多个仓库,不分桶时一个仓库的 push 会把其余仓库的同类投递日志全吞掉。
    logOnce(
      `event:${repoTag(safeParse(body))}:${String(name)}`,
      `收到 ${String(name)} 事件,只有 pull request 会触发审查`,
    );
    return send(res, 200);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    log("body 不是合法 JSON,回 400");
    return send(res, 400);
  }

  const event = normalizeEvent(platform, payload);
  if (event === "ignored") {
    const action = String((payload as RawPayload).action);
    logOnce(
      `action:${platform}:${repoTag(payload)}:${action}`,
      `${platform} 的 ${action} 动作不触发审查`,
    );
    return send(res, 200);
  }
  if (event === "malformed") {
    log(`${platform} 的 payload 缺必需字段,回 400`);
    return send(res, 400);
  }

  // 草稿 PR 在触发层就挡掉,不进 runReview:作者还没打算让人看这份代码。
  if (event.draft) {
    log(`${describe(event)} — 草稿,不审`);
    return send(res, 200);
  }

  const forge = deps.forges[platform];
  if (forge === undefined) {
    // 是本服务的配置缺口,不是投递的问题,因此照样回 200 而不是 500。
    (deps.onRunSettled ?? logFailure)(
      event,
      new Error(`${platform} 没有配置 Forge,这次投递没有跑 Review Run`),
    );
    return send(res, 200);
  }

  if (!claim(deps.dbPath, event)) {
    log(`${describe(event)} — 这个 head commit 已经审过,跳过`);
    return send(res, 200);
  }

  log(`${describe(event)} — 开始审查`);
  // 先回 200 再开跑:一次审查可能要跑很久,平台等不到那时候就会判超时。
  send(res, 200);
  startRun(deps, forge, event);
}

export function createWebhookServer(deps: WebhookServerDeps): Server {
  // 已经记过首次的无关事件类型与 action,整个服务共用一份。
  const loggedOnce = new Set<string>();
  return createServer((req, res) => {
    void handle(req, res, deps, loggedOnce).catch((error: unknown) => {
      console.error("webhook 处理失败:", error instanceof Error ? error.message : error);
      if (!res.headersSent) send(res, 500);
    });
  });
}
