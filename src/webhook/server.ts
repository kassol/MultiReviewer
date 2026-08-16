/**
 * Webhook 端点。投递凭所属仓库的 key 准入(每仓库一把,没有全局 secret),通过后把
 * Gitea 与 GitHub 的 pull request 事件规范化成同一形状,再异步跑一次 Review Run。
 *
 * 审查结果只以 review 评论呈现,本工具从不调用 status / check 之类会阻断合并的接口,
 * `Forge` 接口里也没有这类方法:审查是建议,不是门禁,人保留最终判断权。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname, join, resolve, sep } from "node:path";

import { assertReviewerSpecs, type ReviewerSpec } from "../config.ts";
import type { Forge } from "../forge/forge.ts";
import {
  createGiteaHookManager,
  hookConverged,
  type GiteaHook,
  type GiteaHookManager,
} from "../forge/gitea-hooks.ts";
import type { GiteaForgeOptions } from "../forge/gitea.ts";
import { createPanelAuth, SESSION_TTL_MS, type PanelAuth } from "../panel/auth.ts";
import { checkCredential } from "../panel/credential-check.ts";
import {
  credentialTail,
  CREDENTIAL_MASTER_KEY_ENV,
  decryptCredential,
  encryptCredential,
} from "../panel/credential-crypto.ts";
import type { Reviewer } from "../review/finding.ts";
import { backfillUpdates, priorDispositions, runReview } from "../review/run.ts";
import { openStore, type RepoKey, type Store } from "../review/store.ts";

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
  /**
   * 前两个动作触发 Review Run;`closed` 触发对该 PR 的 disposition 全量回填
   * (ADR 0006),`reopened` 清掉关闭标记,都不跑审查。其余动作在规范化时就被滤掉。
   * `rerun` 不来自投递,是面板手动重跑的标记——日志里要与真实投递分得开。
   */
  action: "opened" | "new-commit" | "closed" | "reopened" | "rerun";
};

export type WebhookServerDeps = {
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
   * 例外是「未注册仓库」与「代次不对」两类准入拒绝:它们发生在验签之前,是管理员排查
   * 「接入了却没反应」的唯一线索,按仓库只记首次。
   */
  onDelivery?: (message: string) => void;
  /** 「只记首次」集合的上限,默认 `LOGGED_ONCE_MAX`。只该测试注入,用来触达封顶分支。 */
  loggedOnceMax?: number;
  /** 面板登录用的 admin token,登录换 session cookie。 */
  adminToken: string;
  /** 面板路径的随机首段(不含斜杠),API 挂在 `/<前缀>/api` 下。 */
  panelPrefix: string;
  /** 服务对外的基地址(实例根),注册仓库时用它拼 hook 的投递地址 `<基地址>/webhook?k=<代次>`。 */
  baseUrl: string;
  /** 前端构建产物目录(Vite 的 dist)。目录不在时页面路由回 503,与 404 分开。 */
  panelDist: string;
  /** Gitea 实例的地址与 bot 凭据。没配这一格时注册与移除仓库的端点不可用。 */
  gitea?: GiteaForgeOptions;
  /**
   * 按模型覆盖构建 Reviewer。带覆盖的仓库触发 Review Run 时用它替换全局的
   * `reviewers`;注册时也用它试构建一次,让「覆盖引用了不存在的凭据」这类错误在
   * 注册响应里显形,而不是等到投递时。
   */
  buildReviewers: (specs: ReviewerSpec[]) => readonly Reviewer[];
  /**
   * 模型凭据的加密主密钥(ADR 0008),取自环境变量。缺失时凭据端点读写都拒绝并说明
   * 原因,服务其余部分照常——起不来就进不了面板,进不了面板就配不了凭据。
   */
  credentialMasterKey?: string;
  /** 时钟,默认 `Date.now`。只该测试注入,用来驱动登录退避的时间窗。 */
  now?: () => number;
};

/** 两个平台标识 pull request 事件的头值相同。 */
const PULL_REQUEST_EVENT = "pull_request";

/** 未认证的投递方能塞任意大的 body,先设上限再读进内存。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** 「只记首次」集合的上限。准入拒绝的去重键含未认证方可自选的仓库 id,不设限会被写满内存。 */
const LOGGED_ONCE_MAX = 10_000;

/**
 * 「PR 新增 commit」两个平台拼写不同:GitHub 是 `synchronize`,Gitea 是 `synchronized`。
 *
 * 依据:go-gitea/gitea `release/v1.26` 的 `modules/structs/hook.go:377`
 * (`HookIssueSynchronized HookIssueAction = "synchronized"`,`opened` 在 :359);
 * GitHub 见 https://docs.github.com/en/webhooks/webhook-events-and-payloads 的
 * pull_request 事件 action 列表。
 */
const ACTIONS: Record<Platform, Record<string, NormalizedEvent["action"]>> = {
  // `closed` 与 `reopened` 两个平台拼写相同(Gitea 见 `modules/structs/hook.go:361,363`
  // 的 `HookIssueClosed = "closed"` 与 `HookIssueReOpened = "reopened"`),合并同样投
  // `closed`。
  github: {
    opened: "opened",
    synchronize: "new-commit",
    closed: "closed",
    reopened: "reopened",
  },
  gitea: {
    opened: "opened",
    synchronized: "new-commit",
    closed: "closed",
    reopened: "reopened",
  },
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
  repository?: { id?: unknown; name?: unknown; owner?: { login?: unknown } };
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
  const what = event.action === "closed" ? "回填" : "审查";
  if (error === undefined) {
    console.log(`[webhook] ${describe(event)} — ${what}结束`);
    return;
  }
  console.error(
    `[webhook] ${describe(event)} — ${what}失败:`,
    error instanceof Error ? error.message : String(error),
  );
}

/** 幂等:同一个「仓库 + head commit」只有第一次领得走。 */
function claim(dbPath: string, event: NormalizedEvent): boolean {
  return withStore(dbPath, (store) =>
    store.claimDelivery(event.owner, event.repo, event.headSha),
  );
}

/** payload 里的数值 repo id,准入查 key 的键。取不到即无从验签。 */
function repoIdOf(payload: unknown): number | undefined {
  const id = (payload as RawPayload | null)?.repository?.id;
  return typeof id === "number" ? id : undefined;
}

/**
 * 把一段文本解析成代次。只认十进制数字(`Number()` 会把 "0x10"、"1e2" 也解析成整数,
 * 宽于代次的语义),超出安全整数的也拒绝——那样的值转回字符串会变成指数记法,写进
 * hook URL 就再也验不过了。
 */
function parseGeneration(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * hook URL `?k=` 上的代次(ADR 0007)。代次是索引不是凭证:它只决定拿哪把 key 验签,
 * 解析不出就当没有,让选 key 落空成 401。
 */
function generationOf(req: IncomingMessage): number | undefined {
  const query = (req.url ?? "").split("?")[1];
  if (query === undefined) return undefined;
  return parseGeneration(new URLSearchParams(query).get("k"));
}

/**
 * 准入拒绝的日志里指认仓库。名字来自未认证的 payload,只作提示,id 才是判据;
 * 控制字符滤掉、长度设限——这行在验签前输出,不滤等于让外人往日志里塞伪造行。
 */
function describeRepo(payload: unknown, repoId: number): string {
  const tag = repoTag(payload).replace(/\p{Cc}/gu, "").slice(0, 200);
  return tag === "" ? `id=${repoId}` : `${tag}(id=${repoId})`;
}

/** 开库执行一段读写,用完即关——webhook 层用库的既有约定,短开短关。 */
function withStore<T>(dbPath: string, fn: (store: Store) => T): T {
  const store = openStore(dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/**
 * 按仓库的模型覆盖构建 Reviewer:null 即跟随全局。坏覆盖(解析不了、缺凭据引用)
 * 抛出,投递链与手动重跑各自决定错误出口(静默记录 / 409 显形)。
 */
function overrideReviewers(
  deps: WebhookServerDeps,
  reviewersJson: string | null,
  repoId: number,
): readonly Reviewer[] {
  if (reviewersJson === null) return deps.reviewers;
  return deps.buildReviewers(
    assertReviewerSpecs(JSON.parse(reviewersJson), `仓库 ${repoId} 的模型覆盖`),
  );
}

type Admission = {
  keys: RepoKey[];
  /** 该仓库的模型覆盖(JSON),null 即跟随全局。与 key 同一次开库读出。 */
  reviewersJson: string | null;
};

function lookupAdmission(dbPath: string, repoId: number): Admission {
  return withStore(dbPath, (store) => ({
    keys: store.listRepoKeys(repoId),
    reviewersJson: store.getRepo(repoId)?.reviewersJson ?? null,
  }));
}

function startRun(
  deps: WebhookServerDeps,
  forge: Forge,
  event: NormalizedEvent,
  reviewers: readonly Reviewer[],
): void {
  const settled = deps.onRunSettled ?? logFailure;
  // 这是长跑服务,后台任务的 rejection 不接住就会变成 unhandledRejection 把进程带崩。
  void runReview(
    { owner: event.owner, repo: event.repo, number: event.number },
    {
      forge,
      reviewers,
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

/**
 * PR 关闭时的全量回填(ADR 0006):读回全部历史评论与 review 正文,把 resolve 状态
 * 覆盖到该 PR 名下的 finding 上,并给它的 Review Run 记下 pr_state——已关闭 PR 上仍然
 * unknown 的 finding 从此进统计分母。零新增 API 调用:两个读取端点与审查链路同款。
 */
async function runClosedBackfill(
  deps: WebhookServerDeps,
  forge: Forge,
  event: NormalizedEvent,
): Promise<void> {
  const [comments, bodies] = await Promise.all([
    forge.listReviewComments(event),
    forge.listReviewBodies(event),
  ]);
  const updates = backfillUpdates(priorDispositions(comments, bodies));
  withStore(deps.dbPath, (store) => {
    store.backfillDispositions(event.owner, event.repo, event.number, updates);
    store.markPullRequestState(event.owner, event.repo, event.number, "closed");
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  loggedOnce: Set<string>,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;

  const log = deps.onDelivery ?? ((message: string) => console.log(`[webhook] ${message}`));

  /**
   * 按 `key` 只记首次的行。两处在用:与本服务无关的投递(webhook 订阅通常宽于本服务
   * 要的两个 action,PR 下每条评论都投一次,逐条记会把判定结果淹掉),以及验签之前的
   * 两类准入拒绝(未注册 / 代次不对)。
   *
   * 仍记首次而不是完全不记:「投递到底有没有到」只有这行能证明,它同时是测试对
   * 「收到了但不处理」的观测点。状态只在本进程内,重启后每类再记一次——重启值得重新
   * 报一遍这个端点在收什么。准入拒绝的键含未认证方可自选的仓库 id,集合设上限,
   * 否则伪造不重复的 id 能把内存写满;满了以后新类别不再记,已记过的仍去重。
   */
  const logOnce = (key: string, message: string): void => {
    if (loggedOnce.has(key)) return;
    if (loggedOnce.size >= (deps.loggedOnceMax ?? LOGGED_ONCE_MAX)) return;
    loggedOnce.add(key);
    log(message);
  };

  // 准入先于验签(每仓库一把 key,没有全局 secret):从 payload 取仓库 id 查 key,
  // 按 `?k=` 代次选 key,再验签。此时 body 未经认证,id 只当查询索引用,验签仍决定
  // 一切。解析不出 id(含非法 JSON)就无从选 key,同样 401,且不记日志——这类请求
  // 谁都能发,归不进任何仓库的记录里。
  const payload = safeParse(body);
  const repoId = repoIdOf(payload);
  if (repoId === undefined) return send(res, 401);

  const admission = lookupAdmission(deps.dbPath, repoId);
  const keys = admission.keys;
  if (keys.length === 0) {
    logOnce(`unregistered:${repoId}`, `仓库 ${describeRepo(payload, repoId)} 未注册,回 401`);
    return send(res, 401);
  }

  const generation = generationOf(req);
  const key = keys.find((candidate) => candidate.generation === generation);
  if (key === undefined) {
    logOnce(
      `generation:${repoId}`,
      `仓库 ${describeRepo(payload, repoId)} 的投递代次不对(已废弃或缺失),回 401`,
    );
    return send(res, 401);
  }

  if (!verifySignature(key.key, body, req.headers["x-hub-signature-256"])) {
    return send(res, 401);
  }

  // 不关心的事件类型不是错误,投递本身是成功的,只是没有活要干。
  const platform = pullRequestSource(req);
  if (platform === undefined) {
    const name = req.headers["x-gitea-event"] ?? req.headers["x-github-event"] ?? "(无)";
    // 「只记首次」按仓库分桶:一份实例服务多个仓库,不分桶时一个仓库的 push 会把
    // 其余仓库的同类投递日志全吞掉。
    logOnce(
      `event:${repoTag(payload)}:${String(name)}`,
      `收到 ${String(name)} 事件,只有 pull request 会触发审查`,
    );
    return send(res, 200);
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

  // PR 重开:关闭标记清掉,unknown 的 finding 回到「还在流程中」的档(ADR 0006 的
  // 「unknown 按 PR 状态区分」隐含状态要跟随 PR)。
  if (event.action === "reopened") {
    log(`${describe(event)} — PR 重新打开,清掉关闭标记`);
    withStore(deps.dbPath, (store) =>
      store.markPullRequestState(event.owner, event.repo, event.number, null),
    );
    return send(res, 200);
  }

  // PR 关闭:不跑审查,对它做一次 disposition 全量回填并落 PR 状态(ADR 0006)。
  // 放在草稿拦截之前——评审记录可能来自 PR 转草稿之前。也不走幂等 claim:closed 与
  // 最后一次 push 的 head commit 相同,那个键早被审查占走,走 claim 会把回填整个跳掉。
  if (event.action === "closed") {
    const forge = deps.forges[platform];
    if (forge === undefined) {
      (deps.onRunSettled ?? logFailure)(
        event,
        new Error(`${platform} 没有配置 Forge,这次投递没有跑回填`),
      );
      return send(res, 200);
    }
    log(`${describe(event)} — PR 已关闭,回填处置状态`);
    send(res, 200);
    const settled = deps.onRunSettled ?? logFailure;
    void runClosedBackfill(deps, forge, event).then(
      () => settled(event),
      (error: unknown) => settled(event, error),
    );
    return;
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

  // 每仓库的模型覆盖:语义是全量替换 reviewers 列表,没有覆盖就用全局。覆盖坏了
  // (解析不了、缺 buildReviewers)按配置错误记录并回 200,与缺 Forge 同一档;放在
  // claim 之前——坏配置不该吃掉幂等键,修好后同一 head commit 要能重新触发。
  let reviewers = deps.reviewers;
  try {
    reviewers = overrideReviewers(deps, admission.reviewersJson, repoId);
  } catch (error) {
    (deps.onRunSettled ?? logFailure)(event, error);
    return send(res, 200);
  }

  if (!claim(deps.dbPath, event)) {
    log(`${describe(event)} — 这个 head commit 已经审过,跳过`);
    return send(res, 200);
  }

  log(`${describe(event)} — 开始审查`);
  // 先回 200 再开跑:一次审查可能要跑很久,平台等不到那时候就会判超时。
  send(res, 200);
  startRun(deps, forge, event, reviewers);
}

/** 请求路径,不含查询串。hook URL 会带 `?k=<代次>`(ADR 0007),匹配只看路径。 */
function pathname(req: IncomingMessage): string {
  return (req.url ?? "").split("?", 1)[0]!;
}

const SESSION_COOKIE = "multireviewer_session";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Cookie 头里 `name` 的值。只认第一个匹配,面板只发这一个 cookie。 */
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/**
 * 面板 API。登录是唯一免认证的端点,其余一律先验 session——端点存在与否都回 401,
 * 枚举 API 面也要先过认证。API 下的未知路径回 JSON 404,与页面的裸 404 分开:调用方
 * 是程序,它要能把「端点不存在」从「前缀不对」里区分出来。
 */
async function handlePanelApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  auth: PanelAuth,
  hookManager: GiteaHookManager | undefined,
): Promise<void> {
  const sub = pathname(req).slice(`/${deps.panelPrefix}/api`.length) || "/";

  if (sub === "/session" && req.method === "POST") {
    const body = await readBody(req, res);
    if (body === undefined) return;
    const payload = safeParse(body) as { token?: unknown } | null;
    // 形状不对不算猜 token,不计入退避——退避只该罚「猜」,不该罚「坏客户端」。
    if (payload === null || typeof payload.token !== "string") {
      return sendJson(res, 400, { error: 'body 要是 {"token": "..."} 形状的 JSON' });
    }
    // 锁定按直连地址分桶,不认 X-Forwarded-For:未认证方伪造它就能绕过锁定。代价是
    // 反代之后所有客户端同桶,攻击者能把管理员一起锁住——对单管理员面板,锁过头
    // 好过锁不住。
    const outcome = auth.login(payload.token, req.socket.remoteAddress ?? "");
    if (!outcome.ok) {
      return sendJson(res, outcome.status, {
        error: outcome.status === 429 ? "失败次数过多,稍后再试" : "token 不对",
      });
    }
    res.writeHead(204, {
      "set-cookie":
        `${SESSION_COOKIE}=${outcome.sessionId}; HttpOnly; Secure; SameSite=Strict; ` +
        `Path=/${deps.panelPrefix}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    });
    res.end();
    return;
  }

  if (!auth.authenticate(cookieValue(req.headers.cookie, SESSION_COOKIE))) {
    return sendJson(res, 401, { error: "未登录" });
  }

  // 登录状态探测,SPA 启动时靠它决定进登录页还是进面板。
  if (sub === "/session" && req.method === "GET") {
    return send(res, 204);
  }

  // 全局默认的模型组合,仓库详情用来展示「跟随全局」跟的是什么。只给模型标识,
  // provider 与凭据环境变量不属于面板要关心的事。
  if (sub === "/reviewers" && req.method === "GET") {
    return sendJson(res, 200, {
      models: deps.reviewers.map((reviewer) => reviewer.model),
    });
  }

  if (sub === "/stats" && req.method === "GET") {
    return handleStats(req, res, deps);
  }

  if (sub === "/runs" && req.method === "GET") {
    return handleRuns(req, res, deps);
  }
  if (sub === "/rerun" && req.method === "POST") {
    return handleRerun(req, res, deps);
  }

  if (sub === "/repos" && req.method === "GET") {
    const rows = withStore(deps.dbPath, (store) => store.listRepos());
    return sendJson(
      res,
      200,
      rows.map(({ reviewersJson, ...row }) => ({
        ...row,
        // 覆盖以解析后的形状交给前端,编辑时原样回传 PUT。坏 JSON(直接写库的遗留)
        // 按 null 透出——一行坏数据不该把整个列表拖成 500,投递链对同一列也是这个态度。
        reviewers: reviewersJson === null ? null : safeParseJson(reviewersJson),
      })),
    );
  }
  if (sub === "/repos" && req.method === "POST") {
    return handleRegister(req, res, deps, hookManager);
  }
  const repoRoute = /^\/repos\/(\d+)$/.exec(sub);
  if (repoRoute !== null && req.method === "DELETE") {
    return handleRemove(res, deps, hookManager, Number(repoRoute[1]));
  }
  const reviewersRoute = /^\/repos\/(\d+)\/reviewers$/.exec(sub);
  if (reviewersRoute !== null && req.method === "PUT") {
    return handleSetReviewers(req, res, deps, Number(reviewersRoute[1]));
  }
  const rotateRoute = /^\/repos\/(\d+)\/rotate$/.exec(sub);
  if (rotateRoute !== null && req.method === "POST") {
    return handleRotate(res, deps, hookManager, Number(rotateRoute[1]));
  }
  const hooksRoute = /^\/repos\/(\d+)\/hooks$/.exec(sub);
  if (hooksRoute !== null && req.method === "GET") {
    return handleHookCheck(res, deps, hookManager, Number(hooksRoute[1]));
  }

  if (sub === "/credentials" && req.method === "GET") {
    return handleListCredentials(res, deps);
  }
  const credentialRoute = /^\/credentials\/([A-Za-z0-9_-]+)$/.exec(sub);
  if (credentialRoute !== null && req.method === "PUT") {
    return handlePutCredential(req, res, deps, credentialRoute[1]!);
  }
  if (credentialRoute !== null && req.method === "DELETE") {
    return handleRemoveCredential(res, deps, credentialRoute[1]!);
  }

  return sendJson(res, 404, { error: "没有这个端点" });
}

/**
 * 缺主密钥时凭据端点整体不可用:读写都 503 并说明差什么(ADR 0008)。服务本身照常
 * 启动——起不来就进不了面板,进不了面板就配不了凭据。
 */
const MASTER_KEY_MISSING =
  `没有设置环境变量 ${CREDENTIAL_MASTER_KEY_ENV},凭据加密不了也解不开。` +
  "在 .env 里补上它并重启服务。";

/**
 * 凭据列表。只写不回显(ADR 0008):给 provider、是否已配、更新时间、尾 4 位。
 * 解不开的密文按未配置透出,不抛也不做重加密迁移。
 */
function handleListCredentials(res: ServerResponse, deps: WebhookServerDeps): void {
  const masterKey = deps.credentialMasterKey;
  if (masterKey === undefined || masterKey === "") {
    return sendJson(res, 503, { error: MASTER_KEY_MISSING });
  }
  const rows = withStore(deps.dbPath, (store) => store.listModelCredentials());
  return sendJson(res, 200, {
    credentials: rows.map((row) => {
      const apiKey = decryptCredential(masterKey, row.apiKeyEncrypted);
      return {
        provider: row.provider,
        configured: apiKey !== undefined,
        updatedAt: row.updatedAt,
        last4: apiKey === undefined ? null : credentialTail(apiKey),
      };
    }),
  });
}

/**
 * 写一家厂商的凭据。先真发一次最小请求验证,失败不落库并回报原因——key 打错要在粘贴
 * 的那一刻显形,不能等下一个 PR 进来。同 provider 二次写入是覆盖。
 */
async function handlePutCredential(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  provider: string,
): Promise<void> {
  const masterKey = deps.credentialMasterKey;
  if (masterKey === undefined || masterKey === "") {
    return sendJson(res, 503, { error: MASTER_KEY_MISSING });
  }
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = safeParse(body) as { apiKey?: unknown } | null;
  if (payload === null || typeof payload.apiKey !== "string" || payload.apiKey === "") {
    return sendJson(res, 400, { error: 'body 要是 {"apiKey": "..."} 形状的 JSON' });
  }
  const apiKey = payload.apiKey;

  const check = await checkCredential(provider, apiKey);
  if (!check.ok) {
    return sendJson(res, 400, { error: `凭据没通过验证,没有保存:${check.reason}` });
  }

  const updatedAt = new Date((deps.now ?? Date.now)()).toISOString();
  withStore(deps.dbPath, (store) =>
    store.putModelCredential(provider, encryptCredential(masterKey, apiKey), updatedAt),
  );
  return sendJson(res, 200, {
    provider,
    configured: true,
    updatedAt,
    last4: credentialTail(apiKey),
  });
}

/** 摘掉一家厂商的凭据。不存在也回 204——目标状态已达成。 */
function handleRemoveCredential(
  res: ServerResponse,
  deps: WebhookServerDeps,
  provider: string,
): void {
  if (deps.credentialMasterKey === undefined || deps.credentialMasterKey === "") {
    return sendJson(res, 503, { error: MASTER_KEY_MISSING });
  }
  withStore(deps.dbPath, (store) => store.removeModelCredential(provider));
  return send(res, 204);
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * 解析并校验一段模型覆盖入参:形状校验加试构建(坏凭据引用要在响应里显形,不能等
 * 投递),注册与 PUT 共用同一判据。返回序列化好的 JSON,校验不过返回错误信息。
 */
function parseReviewersOverride(
  deps: WebhookServerDeps,
  value: unknown,
  context: string,
): { ok: true; reviewersJson: string } | { ok: false; error: string } {
  try {
    const specs = assertReviewerSpecs(value, context);
    deps.buildReviewers(specs);
    return { ok: true, reviewersJson: JSON.stringify(specs) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 时间流一页的条数。翻页用 id 游标,不用 offset——历史只增不删,游标不会漂。 */
const RUNS_PAGE = 30;

/** 跨仓库 Review Run 时间流的一页。覆盖已移除仓库的历史——评审记录只写不清。 */
function handleRuns(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
): void {
  const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const beforeRaw = query.get("before");
  const beforeId = beforeRaw === null ? undefined : Number(beforeRaw);
  if (beforeId !== undefined && !Number.isSafeInteger(beforeId)) {
    return sendJson(res, 400, { error: "before 要是整数游标" });
  }
  const owner = query.get("owner");
  const repo = query.get("repo");
  if ((owner === null) !== (repo === null)) {
    return sendJson(res, 400, { error: "owner 与 repo 要成对给,过滤不接受半个键" });
  }
  const runs = withStore(deps.dbPath, (store) =>
    store.listRuns({
      limit: RUNS_PAGE,
      ...(beforeId === undefined ? {} : { beforeId }),
      ...(owner !== null && repo !== null ? { owner, repo } : {}),
    }),
  );
  const nextBefore = runs.length === RUNS_PAGE ? runs[runs.length - 1]!.id : null;
  return sendJson(res, 200, { runs, nextBefore });
}

/**
 * 手动重跑:对一个 PR 开新一轮 Review Run,走既有的跨轮次折叠。不走幂等 claim——
 * 同一 head commit 重复审在这里是合法诉求(spec 原话),claim 只属于 webhook 投递。
 * 入参用 owner/repo 字符串而非数值 id:时间流里的历史行(含已移除仓库)只有名字。
 */
async function handleRerun(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = safeParse(body) as {
    owner?: unknown;
    repo?: unknown;
    pullNumber?: unknown;
  } | null;
  if (
    payload === null ||
    typeof payload.owner !== "string" ||
    typeof payload.repo !== "string" ||
    typeof payload.pullNumber !== "number" ||
    !Number.isSafeInteger(payload.pullNumber)
  ) {
    return sendJson(res, 400, {
      error: 'body 要是 {"owner", "repo", "pullNumber"} 形状,pullNumber 是整数',
    });
  }
  const { owner, repo, pullNumber } = payload;

  const registered = withStore(deps.dbPath, (store) => store.listRepos()).find(
    (row) => row.owner === owner && row.repo === repo,
  );
  if (registered === undefined) {
    return sendJson(res, 409, { error: "仓库不在注册表里,先注册再重跑" });
  }
  const forge = deps.forges.gitea;
  if (forge === undefined) {
    return sendJson(res, 503, { error: "gitea 没有配置 Forge,重跑不了" });
  }

  // 坏覆盖在这里显形(409),不像投递那样静默记日志——重跑是人在等结果的动作。
  let reviewers = deps.reviewers;
  try {
    reviewers = overrideReviewers(deps, registered.reviewersJson, registered.repoId);
  } catch (error) {
    return sendJson(res, 409, {
      error: `模型覆盖坏了,先改组合再重跑:${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const ref = { owner, repo, number: pullNumber };
  let headSha: string;
  try {
    headSha = (await forge.getPullRequest(ref)).headSha;
  } catch {
    return sendJson(res, 404, { error: "PR 读不到:号不对,或 bot 无权限" });
  }
  sendJson(res, 202, { pullNumber, headSha });
  startRun(
    deps,
    forge,
    { platform: "gitea", owner, repo, number: pullNumber, headSha, draft: false, action: "rerun" },
    reviewers,
  );
}

/** 一天的毫秒数,处置率页的默认时间窗取最近 30 天。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 处置率统计与库体量。时间窗缺省取最近 30 天;口径全在 `store.dispositionStats`
 * (ADR 0006),这里只做参数与打包——页面矩阵与 API 的数字必须同源。
 */
function handleStats(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
): void {
  const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const nowMs = (deps.now ?? Date.now)();
  const fromMs = Date.parse(query.get("from") ?? new Date(nowMs - 30 * DAY_MS).toISOString());
  const toMs = Date.parse(query.get("to") ?? new Date(nowMs).toISOString());
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    return sendJson(res, 400, { error: "from 与 to 要是可解析的 ISO 时间" });
  }
  // 归一成 ISO 再进 SQL:库里比的是字典序,非 ISO 但可解析的写法会静默算错窗口。
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();

  const { cells, tables } = withStore(deps.dbPath, (store) => ({
    cells: store.dispositionStats(from, to),
    tables: store.tableCounts(),
  }));
  let fileBytes = 0;
  try {
    fileBytes = statSync(deps.dbPath).size;
  } catch {
    // 库文件还没建出来:没有一次投递的全新部署,体量就是 0。
  }
  return sendJson(res, 200, { from, to, cells, database: { fileBytes, tables } });
}

/** hook 投递地址里代次之前的部分:`<基地址>/webhook?k=`。 */
function webhookUrlBase(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/webhook?k=`;
}

/** hook 的投递地址:`<基地址>/webhook?k=<代次>`。代次是 URL 里唯一双向可见的字段(ADR 0007)。 */
function hookUrl(baseUrl: string, generation: number): string {
  return `${webhookUrlBase(baseUrl)}${generation}`;
}

/** 从 hook URL 读回代次。不是指向本服务的 hook 返回 undefined。 */
function generationFromHookUrl(url: string, baseUrl: string): number | undefined {
  const prefix = webhookUrlBase(baseUrl);
  if (!url.startsWith(prefix)) return undefined;
  return parseGeneration(url.slice(prefix.length));
}

async function handleRegister(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  hookManager: GiteaHookManager | undefined,
): Promise<void> {
  if (hookManager === undefined) {
    return sendJson(res, 500, { error: "没有配置 Gitea,无法注册仓库" });
  }
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = safeParse(body) as {
    owner?: unknown;
    repo?: unknown;
    reviewers?: unknown;
  } | null;
  if (
    payload === null ||
    typeof payload.owner !== "string" ||
    payload.owner === "" ||
    typeof payload.repo !== "string" ||
    payload.repo === ""
  ) {
    return sendJson(res, 400, {
      error: 'body 要是 {"owner": "...", "repo": "..."} 形状的 JSON',
    });
  }
  const ref = { owner: payload.owner, repo: payload.repo };

  // 模型覆盖跟随注册一起写入,语义是全量替换 reviewers 列表,省略即跟随全局。
  let reviewersJson: string | undefined;
  if (payload.reviewers !== undefined) {
    const parsed = parseReviewersOverride(
      deps,
      payload.reviewers,
      `${ref.owner}/${ref.repo} 的模型覆盖`,
    );
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
    reviewersJson = parsed.reviewersJson;
  }

  // 权限不足要明确拒绝并说明缺什么:不产生「注册成功却永远收不到投递」的哑仓库。
  const check = await hookManager.checkAdmin(ref);
  if (!check.admin) {
    return sendJson(res, 403, { error: check.reason });
  }
  const repoId = check.repoId;

  if (withStore(deps.dbPath, (store) => store.getRepo(repoId)) !== undefined) {
    return sendJson(res, 409, { error: `${ref.owner}/${ref.repo} 已注册(repo id ${repoId})` });
  }

  // 新代次取 Gitea 上可见的最大代次 +1(ADR 0007):上一次安装残留的本服务 hook 不与
  // 它撞 URL,残留 hook 的投递按已废弃代次 401 显形,不会静默吞掉新 hook 的创建。
  // 库那一侧此刻必为空——上面刚确认过未注册,而注册表行与 Key 在同一个事务里生灭。
  const hooks = await hookManager.listHooks(ref);
  const seenGenerations = hooks
    .map((hook) => generationFromHookUrl(hook.url, deps.baseUrl))
    .filter((generation): generation is number => generation !== undefined);
  const generation = Math.max(0, ...seenGenerations) + 1;
  const key = randomBytes(32).toString("hex");

  // 先落库再建 hook:hook 一旦在,投递就会来,库里必须已经有 Key 能验它。建 hook
  // 失败时回滚刚落的注册,不留「已注册却无 hook」的哑仓库。
  withStore(deps.dbPath, (store) =>
    store.registerRepo({
      repoId,
      owner: ref.owner,
      repo: ref.repo,
      generation,
      key,
      ...(reviewersJson === undefined ? {} : { reviewersJson }),
    }),
  );
  try {
    await hookManager.ensureHook(ref, { url: hookUrl(deps.baseUrl, generation), key });
  } catch (error) {
    withStore(deps.dbPath, (store) => store.removeRepo(repoId));
    return sendJson(res, 502, {
      error: `Gitea 建 hook 失败:${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return sendJson(res, 201, { repoId, owner: ref.owner, repo: ref.repo, generation });
}

async function handleRemove(
  res: ServerResponse,
  deps: WebhookServerDeps,
  hookManager: GiteaHookManager | undefined,
  repoId: number,
): Promise<void> {
  if (hookManager === undefined) {
    return sendJson(res, 500, { error: "没有配置 Gitea,无法移除仓库" });
  }
  const record = withStore(deps.dbPath, (store) => store.getRepo(repoId));
  if (record === undefined) {
    return sendJson(res, 404, { error: `没有 repo id 为 ${repoId} 的注册仓库` });
  }

  // hook 操作按仓库的「现名」寻址:注册表里的名字是注册时的,仓库改名或转移后按旧名
  // 找会把「改名」误判成「已删」,移除放行后真 hook 留在新名字下永远投 401——恰是
  // 设计要消除的「有 hook 无记录」。id 在 Gitea 上已不存在才说明仓库真没了,hook
  // 随仓库一起没了,直接摘表。
  const ref = (await hookManager.resolveRepo(repoId)) ?? {
    owner: record.owner,
    repo: record.repo,
  };

  // 先删 hook,删不掉(404 除外)不放行移除:放行会留下一条永远拿 401 又不在任何
  // 视图里的孤儿 hook。「Gitea 上有 hook 而库里无记录」这个中间态被设计消除。
  const ours = (await hookManager.listHooks(ref)).filter(
    (hook) => generationFromHookUrl(hook.url, deps.baseUrl) !== undefined,
  );
  try {
    for (const hook of ours) {
      await hookManager.deleteHook(ref, hook.id);
    }
  } catch (error) {
    return sendJson(res, 502, {
      error: `Gitea 删 hook 失败,移除不放行:${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // 评审记录一行不动:模型选型的历史不因仓库下线而断(移除后的投递按未注册 401)。
  withStore(deps.dbPath, (store) => store.removeRepo(repoId));
  return send(res, 204);
}

/**
 * 改写模型覆盖(语义与注册一致:全量替换 reviewers 列表,null 即清除、跟随全局)。
 * 非空时校验并试构建一次——坏凭据引用要在响应里显形,不能等投递。
 */
async function handleSetReviewers(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  repoId: number,
): Promise<void> {
  const record = withStore(deps.dbPath, (store) => store.getRepo(repoId));
  if (record === undefined) {
    return sendJson(res, 404, { error: `没有 repo id 为 ${repoId} 的注册仓库` });
  }
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = safeParse(body) as { reviewers?: unknown } | null;
  if (payload === null || !("reviewers" in payload)) {
    return sendJson(res, 400, {
      error: 'body 要是 {"reviewers": [...]} 或 {"reviewers": null} 形状的 JSON',
    });
  }

  let reviewersJson: string | null = null;
  if (payload.reviewers !== null) {
    const parsed = parseReviewersOverride(
      deps,
      payload.reviewers,
      `${record.owner}/${record.repo} 的模型覆盖`,
    );
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
    reviewersJson = parsed.reviewersJson;
  }
  withStore(deps.dbPath, (store) => store.setRepoReviewers(repoId, reviewersJson));
  return send(res, 204);
}

/**
 * 把仓库收敛到「只有目标代次」:先确保目标 hook 在,再删其余全部本服务 hook(含库
 * 回滚场景残留的更高代次),最后摘掉其他代次的 Key。顺序即 ADR 0007 的先建后删,
 * 收敛途中新旧两把 Key 并存,重复投递被幂等键吃掉,投递不中断。
 */
async function convergeToGeneration(
  deps: WebhookServerDeps,
  hookManager: GiteaHookManager,
  ref: { owner: string; repo: string },
  repoId: number,
  target: RepoKey,
): Promise<void> {
  await hookManager.ensureHook(ref, {
    url: hookUrl(deps.baseUrl, target.generation),
    key: target.key,
  });
  // 只清「低于目标代次」的,不动更高的:单线程下不存在更高代次(target 就是两侧
  // 最大 +1),更高代次只可能来自并发的另一次轮转——动它会把并发交错推向「库里
  // 零 key、投递全 401、再点轮转在空列表上炸掉」的死局;留它则至多多一条 hook,
  // 核对能报出,下一次轮转清掉。
  for (const hook of await hookManager.listHooks(ref)) {
    const generation = generationFromHookUrl(hook.url, deps.baseUrl);
    if (generation !== undefined && generation < target.generation) {
      await hookManager.deleteHook(ref, hook.id);
    }
  }
  withStore(deps.dbPath, (store) => {
    for (const key of store.listRepoKeys(repoId)) {
      if (key.generation < target.generation) {
        store.removeRepoKey(repoId, key.generation);
      }
    }
  });
}

/**
 * 轮转(ADR 0007):可重入的单调推进,不落轮转状态。每一步之后中断,再点一次都从
 * 「库里的 key 列表 + Gitea 上的代次」推断断点继续。
 */
async function handleRotate(
  res: ServerResponse,
  deps: WebhookServerDeps,
  hookManager: GiteaHookManager | undefined,
  repoId: number,
): Promise<void> {
  if (hookManager === undefined) {
    return sendJson(res, 500, { error: "没有配置 Gitea,无法轮转" });
  }
  const record = withStore(deps.dbPath, (store) => store.getRepo(repoId));
  if (record === undefined) {
    return sendJson(res, 404, { error: `没有 repo id 为 ${repoId} 的注册仓库` });
  }

  try {
    // 仓库在 Gitea 上已不存在时轮转永远续不完(建 hook 必 404),直接指向出路,
    // 不让「再点一次」变成原地循环。
    const resolved = await hookManager.resolveRepo(repoId);
    if (resolved === undefined) {
      return sendJson(res, 409, {
        error: "仓库在 Gitea 上已不存在,轮转无从进行。移除仓库即可,评审记录会保留。",
      });
    }
    const ref = resolved;

    // 上一轮未收尾先推到底:两把 Key 时收敛到较新的那把,代次不堆积。
    let keys = withStore(deps.dbPath, (store) => store.listRepoKeys(repoId));
    if (keys.length > 1) {
      await convergeToGeneration(deps, hookManager, ref, repoId, keys[keys.length - 1]!);
      keys = withStore(deps.dbPath, (store) => store.listRepoKeys(repoId));
    }
    // 注册表行与第一把 Key 同事务生灭,注册过的仓库至少有一把。
    const current = keys[keys.length - 1]!;

    // 新代次取库与 Gitea 两侧最大代次 +1:库回滚到旧备份时 Gitea 侧更高,取上界让
    // 一次轮转自愈,不必人工介入。
    const giteaGenerations = (await hookManager.listHooks(ref))
      .map((hook) => generationFromHookUrl(hook.url, deps.baseUrl))
      .filter((generation): generation is number => generation !== undefined);
    const next = Math.max(current.generation, ...giteaGenerations) + 1;
    const key = randomBytes(32).toString("hex");
    withStore(deps.dbPath, (store) => store.addRepoKey(repoId, next, key));
    await convergeToGeneration(deps, hookManager, ref, repoId, { generation: next, key });
    return sendJson(res, 200, { repoId, generation: next });
  } catch (error) {
    return sendJson(res, 502, {
      error: `轮转没有完成,再点一次会从断点继续:${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

/**
 * 核对(ADR 0007):拉一次 Gitea 的 hook 列表与库比对,只展示差异与下一步动作,
 * 不自动修——读页面这个动作本身不产生副作用。
 */
async function handleHookCheck(
  res: ServerResponse,
  deps: WebhookServerDeps,
  hookManager: GiteaHookManager | undefined,
  repoId: number,
): Promise<void> {
  if (hookManager === undefined) {
    return sendJson(res, 500, { error: "没有配置 Gitea,无法核对" });
  }
  const record = withStore(deps.dbPath, (store) => store.getRepo(repoId));
  if (record === undefined) {
    return sendJson(res, 404, { error: `没有 repo id 为 ${repoId} 的注册仓库` });
  }
  const keys = withStore(deps.dbPath, (store) => store.listRepoKeys(repoId));
  const expectedGenerations = keys.map((key) => key.generation);
  const issues: { message: string; action: string }[] = [];

  const resolved = await hookManager.resolveRepo(repoId);
  if (resolved === undefined) {
    issues.push({
      message: "仓库在 Gitea 上已不存在(按 id 查不到)",
      action: "移除仓库,评审记录会保留",
    });
    return sendJson(res, 200, { expectedGenerations, hooks: [], issues });
  }
  if (resolved.owner !== record.owner || resolved.repo !== record.repo) {
    issues.push({
      message: `仓库已改名或转移:注册时是 ${record.owner}/${record.repo},现在是 ${resolved.owner}/${resolved.repo}`,
      action: "无需操作,准入按数值 id 不受影响",
    });
  }

  const hooks: { hook: GiteaHook; generation: number }[] = [];
  for (const hook of await hookManager.listHooks(resolved)) {
    const generation = generationFromHookUrl(hook.url, deps.baseUrl);
    if (generation !== undefined) hooks.push({ hook, generation });
  }

  if (keys.length > 1) {
    issues.push({ message: "上一轮轮转未收尾", action: "点一次轮转收尾" });
  }
  for (const key of keys) {
    const match = hooks.find((entry) => entry.generation === key.generation);
    if (match === undefined) {
      issues.push({
        message: `代次 ${key.generation} 的 hook 不在 Gitea 上`,
        action: "点一次轮转重建",
      });
    } else if (!hookConverged(match.hook)) {
      issues.push({
        message: `代次 ${key.generation} 的 hook 订阅、激活或 content type 被改过`,
        action: "点一次轮转恢复",
      });
    }
  }
  for (const entry of hooks) {
    if (!keys.some((key) => key.generation === entry.generation)) {
      issues.push({
        message: `Gitea 上有已废弃代次 ${entry.generation} 的 hook`,
        action: "点一次轮转清理",
      });
    }
  }

  return sendJson(res, 200, {
    expectedGenerations,
    hooks: hooks.map((entry) => ({
      id: entry.hook.id,
      generation: entry.generation,
      active: entry.hook.active,
      contentType: entry.hook.contentType,
      events: entry.hook.events,
    })),
    issues,
  });
}

/** `/assets` 下会出现的几种产物。列表外的一律按二进制流给,浏览器自己认。 */
const ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

/** 静态产物。`/assets` 不带认证直接对外,路径解码后必须钉死在 dist 之内。 */
async function serveAsset(
  res: ServerResponse,
  panelDist: string,
  path: string,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return send(res, 404);
  }
  // 包含检查钉在 assets 子目录上,不是 dist 根:钉根的话 `..` 还能爬回 dist 里
  // 不该经 /assets 暴露的文件(index.html 之外的任何东西)。
  const assetsRoot = resolve(panelDist, "assets");
  const file = resolve(resolve(panelDist), `.${decoded}`);
  if (!file.startsWith(`${assetsRoot}${sep}`)) return send(res, 404);
  try {
    const content = await readFile(file);
    res.writeHead(200, {
      "content-type": ASSET_TYPES[extname(file)] ?? "application/octet-stream",
    });
    res.end(content);
  } catch {
    send(res, 404);
  }
}

/**
 * 前缀下的页面:注入过前缀全局变量的 index.html。前缀是运行时随机值,构建产物与它
 * 无关——Router basepath 与前端 API 基址都从这个注入的变量读。深层路由刷新也走这里,
 * 客户端路由自己接管路径。
 */
async function servePage(res: ServerResponse, deps: WebhookServerDeps): Promise<void> {
  let html: string;
  try {
    html = await readFile(join(deps.panelDist, "index.html"), "utf8");
  } catch {
    // 与 404 分开:404 是「前缀记错了」,这里是「前端没构建 / 路径配错」的部署问题。
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("面板前端产物缺失:镜像构建要包含 web/dist,或检查 MULTIREVIEWER_PANEL_DIST。");
    return;
  }
  // 前缀经启动校验只含 URL 安全字符,JSON.stringify 后不可能拼出闭合脚本的序列。
  const injected = html.replace(
    "</head>",
    `<script>window.__MULTIREVIEWER__ = ${JSON.stringify({ prefix: deps.panelPrefix })};</script></head>`,
  );
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(injected);
}

export function createWebhookServer(deps: WebhookServerDeps): Server {
  // 已经记过首次的无关事件类型与 action,整个服务共用一份。
  const loggedOnce = new Set<string>();
  const auth = createPanelAuth(deps.adminToken, deps.now);
  const hookManager =
    deps.gitea === undefined ? undefined : createGiteaHookManager(deps.gitea);
  const apiPrefix = `/${deps.panelPrefix}/api`;
  return createServer((req, res) => {
    // 路由表(issue #26):`POST /webhook` → 投递;`<前缀>/api/*` → 面板 API;
    // `<前缀>` 与 `<前缀>/*` → 注入过的 index.html;`/assets/*` → 构建产物;其余一律
    // 404,不重定向——`GET /webhook` 与 `/` 也是,重定向会把扫描器引向真实入口。
    const path = pathname(req);
    if (req.method === "POST" && path === "/webhook") {
      void handle(req, res, deps, loggedOnce).catch((error: unknown) => {
        console.error("webhook 处理失败:", error instanceof Error ? error.message : error);
        if (!res.headersSent) send(res, 500);
      });
      return;
    }
    if (path === apiPrefix || path.startsWith(`${apiPrefix}/`)) {
      void handlePanelApi(req, res, deps, auth, hookManager).catch((error: unknown) => {
        console.error("面板 API 处理失败:", error instanceof Error ? error.message : error);
        if (!res.headersSent) sendJson(res, 500, { error: "内部错误" });
      });
      return;
    }
    if (req.method === "GET" && path.startsWith("/assets/")) {
      void serveAsset(res, deps.panelDist, path).catch(() => {
        if (!res.headersSent) send(res, 500);
      });
      return;
    }
    const pagePrefix = `/${deps.panelPrefix}`;
    if (req.method === "GET" && (path === pagePrefix || path.startsWith(`${pagePrefix}/`))) {
      void servePage(res, deps).catch(() => {
        if (!res.headersSent) send(res, 500);
      });
      return;
    }
    return send(res, 404);
  });
}
