/**
 * Webhook 端点。投递凭所属仓库的 key 准入(每仓库一把,没有全局 secret),通过后把
 * Gitea 与 GitHub 的 pull request 事件规范化成同一形状,再异步跑一次 Review Run。
 *
 * 审查结果只以 review 评论呈现,本工具从不调用 status / check 之类会阻断合并的接口,
 * `Forge` 接口里也没有这类方法:审查是建议,不是门禁,人保留最终判断权。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { extname, join, resolve, sep } from "node:path";

import {
  assertReviewerSpecs,
  GLOBAL_REVIEWERS_CONTEXT,
  parseGlobalReviewers,
  type CredentialSnapshot,
  type ReviewerSpec,
} from "../config.ts";
import type { Forge } from "../forge/forge.ts";
import {
  createGiteaHookManager,
  hookConverged,
  missingAdminReason,
  type GiteaHook,
  type GiteaHookManager,
} from "../forge/gitea-hooks.ts";
import type { GiteaForgeOptions } from "../forge/gitea.ts";
import { createPanelAuth, sessionHash, SESSION_TTL_MS, type PanelAuth } from "../panel/auth.ts";
import { hashPassword } from "../panel/password.ts";
import { isPanelPermission, type PanelPermission } from "../panel/permissions.ts";
import { checkCredential, CHECKED_PROVIDERS } from "../panel/credential-check.ts";
import {
  credentialTail,
  CREDENTIAL_MASTER_KEY_ENV,
  decryptCredential,
  encryptCredential,
} from "../panel/credential-crypto.ts";
import { DEFAULT_MAX_CHANGED_LINES_PER_BATCH } from "../review/batch.ts";
import type { Reviewer } from "../review/finding.ts";
import { backfillUpdates, priorDispositions, runReview } from "../review/run.ts";
import {
  openStore,
  type RepoKey,
  type Store,
} from "../review/store.ts";
import {
  conflictingProviderNames,
  invalidateModelCatalog,
  modelCatalog,
} from "../reviewer/catalog.ts";
import {
  CUSTOM_PROVIDER_APIS,
  sharedModelPaths,
  writeSharedModelsConfig,
} from "../reviewer/model-runtime.ts";

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
  cacheDir: string;
  dbPath: string;
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
  /** 测试注入 bootstrap 口令;生产省略即在零用户时随机生成。 */
  bootstrapSecret?: string;
  /** 零用户启动时拿到 bootstrap 口令;生产打印,测试可观察或忽略。 */
  onBootstrap?: (secret: string) => void;
  /** 面板路径的随机首段(不含斜杠),API 挂在 `/<前缀>/api` 下。 */
  panelPrefix: string;
  /** 服务对外的基地址(实例根),注册仓库时用它拼 hook 的投递地址 `<基地址>/webhook?k=<代次>`。 */
  baseUrl: string;
  /** 前端构建产物目录(Vite 的 dist)。目录不在时页面路由回 503,与 404 分开。 */
  panelDist: string;
  /** Gitea 实例的地址与 bot 凭据。没配这一格时注册与移除仓库的端点不可用。 */
  gitea?: GiteaForgeOptions;
  /**
   * 按模型组合与凭据快照组装 Reviewer,每次 Review Run 开始时调一次。缺凭据的
   * provider 由它建出一个报失败的 Reviewer,不抛(issue #65);名字撞上内置那一家的自定义
   * provider 同理(第三个入参,issue #94)。
   */
  buildReviewers: (
    specs: readonly ReviewerSpec[],
    credentials: CredentialSnapshot,
    conflictingProviders: ReadonlySet<string>,
  ) => readonly Reviewer[];
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

/** 全局设置。模型组合与批次上限都在库里(issue #66),用时读一次。 */
function globalSettings(deps: WebhookServerDeps): {
  reviewers: ReviewerSpec[];
  maxChangedLinesPerBatch: number | null;
} {
  const row = withStore(deps.dbPath, (store) => store.getGlobalSettings());
  return {
    reviewers: parseGlobalReviewers(row.reviewersJson),
    maxChangedLinesPerBatch: row.maxChangedLinesPerBatch,
  };
}

/**
 * 这次 Review Run 用的模型组合:仓库有覆盖就用覆盖,null 即跟随全局。坏覆盖
 * (解析不了)抛出,投递链与手动重跑各自决定错误出口(静默记录 / 409 显形)。
 */
function resolveSpecs(
  deps: WebhookServerDeps,
  reviewersJson: string | null,
  repoId: number,
): readonly ReviewerSpec[] {
  if (reviewersJson === null) return globalSettings(deps).reviewers;
  return assertReviewerSpecs(JSON.parse(reviewersJson), `仓库 ${repoId} 的模型覆盖`);
}

/**
 * Review Run 开始时的模型凭据快照:一次开库读全部密文,在编排进程里解密成明文
 * (ADR 0004、0008)。解不开的按未配置处理,那一家的 Reviewer 会报失败。
 *
 * 快照只在这里取一次,整轮不重读——轮转不影响进行中的 Run。
 */
function credentialSnapshot(deps: WebhookServerDeps): CredentialSnapshot {
  const masterKey = deps.credentialMasterKey;
  if (masterKey === undefined || masterKey === "") return new Map();
  const snapshot = new Map<string, string>();
  for (const row of withStore(deps.dbPath, (store) => store.listModelCredentials())) {
    const apiKey = decryptCredential(masterKey, row.apiKeyEncrypted);
    if (apiKey !== undefined && apiKey !== "") snapshot.set(row.provider, apiKey);
  }
  return snapshot;
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

/**
 * 开一轮 Review Run。调用方一律 `void` 它:这是长跑服务,后台任务的 rejection 不接住就会
 * 变成 unhandledRejection 把进程带崩,所以整段包在 try 里,失败一律经 `settled` 出去。
 */
async function startRun(
  deps: WebhookServerDeps,
  forge: Forge,
  event: NormalizedEvent,
  specs: readonly ReviewerSpec[],
  triggeredBy?: string,
): Promise<void> {
  const settled = deps.onRunSettled ?? logFailure;
  try {
    // 撞名的自定义 provider 现算(issue #94):判据是「库里的登记 ∩ Pi 内置目录」这个交集,
    // 不落库,所以操作员改完名字下一次投递就自己恢复了。一家自定义 provider 都没登记时它连
    // 运行时都不建。
    const conflicting = await conflictingProviderNames(
      withStore(deps.dbPath, (store) => store.listCustomProviders()),
    );
    // 组装就在这里:凭据在 Run 开始时快照一次,缺哪一家由那一家的 Reviewer 报失败。
    const reviewers = deps.buildReviewers(specs, credentialSnapshot(deps), conflicting);
    const maxChangedLinesPerBatch = globalSettings(deps).maxChangedLinesPerBatch;
    await runReview(
      { owner: event.owner, repo: event.repo, number: event.number },
      {
        forge,
        reviewers,
        cacheDir: deps.cacheDir,
        dbPath: deps.dbPath,
        ...(triggeredBy === undefined ? {} : { triggeredBy }),
        ...(maxChangedLinesPerBatch === null ? {} : { maxChangedLinesPerBatch }),
      },
    );
  } catch (error) {
    settled(event, error);
    return;
  }
  settled(event);
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
  // (解析不了)按配置错误记录并回 200,与缺 Forge 同一档;放在 claim 之前——坏配置
  // 不该吃掉幂等键,修好后同一 head commit 要能重新触发。
  let specs: readonly ReviewerSpec[];
  try {
    specs = resolveSpecs(deps, admission.reviewersJson, repoId);
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
  void startRun(deps, forge, event, specs);
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
 * 会话 cookie 的 Set-Cookie 头。登录与登出共用一个拼装点:清除用的属性必须与写入时
 * 逐字一致,Path 差一个字浏览器就不删,旧 cookie 会留在浏览器里。
 */
function sessionCookieHeader(prefix: string, value: string, maxAgeSeconds: number): string {
  return (
    `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; ` +
    `Path=/${prefix}; Max-Age=${maxAgeSeconds}`
  );
}

// `access` 在 `PanelRoute` 上必填:新增端点时必须同时声明门禁。
type PanelAccess = PanelPermission | "public" | "authenticated-only" | "system-admin-only";
type PanelRouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  deps: WebhookServerDeps;
  auth: PanelAuth;
  hookManager: GiteaHookManager | undefined;
  bootstrapSecret: () => string | undefined;
  clearBootstrap: () => void;
  caller?: { username: string; isSystemAdmin: boolean; permissions: readonly PanelPermission[] };
};
type PanelRouteHandler = (
  context: PanelRouteContext,
  match: RegExpMatchArray | undefined,
) => void | Promise<void>;
type PanelRoute = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  pattern: string | RegExp;
  access: PanelAccess;
  allowedWhilePasswordExpired?: true;
  handler: PanelRouteHandler;
};
/**
 * 自定义 provider 的名字与删除路径共用一个判据:名字要整个放进 URL,所以既限制为
 * 内置 provider id 同形的字符集,也限制在 64 字符内;登记得进就必须删得掉。
 */
const CUSTOM_PROVIDER_NAME_MAX = 64;
const CUSTOM_PROVIDER_NAME_PATTERN = `[a-z0-9-]{1,${CUSTOM_PROVIDER_NAME_MAX}}`;
const CUSTOM_PROVIDER_NAME = new RegExp(`^${CUSTOM_PROVIDER_NAME_PATTERN}$`);
const CUSTOM_PROVIDER_ROUTE = new RegExp(`^/custom-providers/(${CUSTOM_PROVIDER_NAME_PATTERN})$`);

function listRepos(res: ServerResponse, deps: WebhookServerDeps): void {
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
const PANEL_USERNAME = /^[a-z0-9._-]{1,32}$/;
const bootstrapFailures = new Map<string, { count: number; nextAttemptAt: number }>();

function secretMatches(expected: string, provided: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  auth: PanelAuth,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = safeParse(body) as { username?: unknown; password?: unknown } | null;
  if (
    payload === null ||
    typeof payload.username !== "string" ||
    typeof payload.password !== "string"
  ) {
    return sendJson(res, 400, { error: 'body 要是 {"username":"...","password":"..."} 形状的 JSON' });
  }
  const username = payload.username;
  const password = payload.password;
  const user = withStore(deps.dbPath, (store) => store.getPanelUser(username));
  const outcome = await auth.login(
    user === undefined ? { username } : { username: user.username, passwordHash: user.passwordHash },
    password,
    req.socket.remoteAddress ?? "",
  );
  if (!outcome.ok) {
    if (outcome.status === 429) res.setHeader("retry-after", String(outcome.retryAfter));
    return sendJson(res, outcome.status, {
      error: outcome.status === 429 ? `太快了,${outcome.retryAfter} 秒后再试` : "用户名或密码不对",
    });
  }
  const raw = randomBytes(32).toString("hex");
  const now = deps.now ?? Date.now;
  const createdAt = new Date(now()).toISOString();
  withStore(deps.dbPath, (store) =>
    store.createPanelSession({
      sessionHash: sessionHash(raw),
      username,
      createdAt,
      expiresAt: new Date(now() + SESSION_TTL_MS).toISOString(),
    }),
  );
  res.writeHead(204, {
    "set-cookie": sessionCookieHeader(deps.panelPrefix, raw, Math.floor(SESSION_TTL_MS / 1000)),
  });
  res.end();
}

async function handleBootstrapRegister(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  bootstrapSecret: () => string | undefined,
  clearBootstrap: () => void,
): Promise<void> {
  if (withStore(deps.dbPath, (store) => store.countPanelUsers()) !== 0) {
    return sendJson(res, 409, { error: "实例已初始化,找管理员建号" });
  }
  const ip = req.socket.remoteAddress ?? "";
  const nowMs = (deps.now ?? Date.now)();
  const failure = bootstrapFailures.get(ip);
  if (failure !== undefined && failure.nextAttemptAt > nowMs) {
    const retryAfter = Math.max(1, Math.ceil((failure.nextAttemptAt - nowMs) / 1_000));
    res.setHeader("retry-after", String(retryAfter));
    return sendJson(res, 429, { error: `太快了,${retryAfter} 秒后再试` });
  }
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = safeParse(body) as {
    bootstrap?: unknown;
    username?: unknown;
    password?: unknown;
  } | null;
  if (
    payload === null ||
    typeof payload.bootstrap !== "string" ||
    typeof payload.username !== "string" ||
    typeof payload.password !== "string" ||
    !PANEL_USERNAME.test(payload.username)
  ) {
    return sendJson(res, 400, { error: "body 要带 bootstrap、合法 username 与 password" });
  }
  const username = payload.username;
  const password = payload.password;
  const expected = bootstrapSecret();
  if (expected === undefined || !secretMatches(expected, payload.bootstrap)) {
    const count = (failure?.count ?? 0) + 1;
    const nextAttemptAt =
      count <= 3 ? 0 : nowMs + Math.min(1_000 * 2 ** (count - 4), 30_000);
    bootstrapFailures.set(ip, { count, nextAttemptAt });
    if (nextAttemptAt > 0) console.warn(`登录节流:账号 bootstrap,来源 ${ip},已失败 ${count} 次`);
    return sendJson(res, 401, { error: "bootstrap 口令不对" });
  }
  bootstrapFailures.delete(ip);
  const now = new Date((deps.now ?? Date.now)()).toISOString();
  const passwordHash = await hashPassword(password);
  const created = withStore(deps.dbPath, (store) =>
    store.registerFirstPanelUser({
      username,
      displayName: null,
      passwordHash,
      mustChangePassword: false,
      createdAt: now,
      isSystemAdmin: true,
      roleId: null,
    }),
  );
  if (!created) return sendJson(res, 409, { error: "实例已初始化,找管理员建号" });
  clearBootstrap();
  return sendJson(res, 201, { username, isSystemAdmin: true });
}

function panelSession(req: IncomingMessage, deps: WebhookServerDeps) {
  const raw = cookieValue(req.headers.cookie, SESSION_COOKIE);
  if (raw === undefined) return undefined;
  const hash = sessionHash(raw);
  return withStore(deps.dbPath, (store) => {
    const session = store.getPanelSession(hash);
    if (session === undefined) return undefined;
    const now = (deps.now ?? Date.now)();
    const expiry = Date.parse(session.expiresAt);
    if (expiry <= now) {
      store.removePanelSession(hash);
      return undefined;
    }
    let renewed = false;
    if (expiry - now < SESSION_TTL_MS / 2) {
      store.renewPanelSession(hash, new Date(now + SESSION_TTL_MS).toISOString());
      renewed = true;
    }
    const permissions =
      session.roleId === null
        ? []
        : (store.listPanelRoles().find((role) => role.id === session.roleId)?.permissions ?? []);
    const systemAdmins = store
      .listPanelUsers()
      .filter((user) => user.isSystemAdmin)
      .map((user) => user.displayName ?? user.username);
    return { ...session, permissions, systemAdmins, hash, raw, renewed };
  });
}
async function handlePanelUsers(req: IncomingMessage, res: ServerResponse, deps: WebhookServerDeps) {
  if (req.method === "GET") {
    return sendJson(res, 200, {
      users: withStore(deps.dbPath, (store) =>
        store.listPanelUsers().map(({ passwordHash: _passwordHash, ...user }) => user),
      ),
    });
  }
  const body = await readBody(req, res);
  if (body === undefined) return;
  const value = safeParse(body) as { username?: unknown; password?: unknown; displayName?: unknown } | null;
  if (
    value === null ||
    typeof value.username !== "string" ||
    typeof value.password !== "string" ||
    !PANEL_USERNAME.test(value.username) ||
    (value.displayName !== undefined && typeof value.displayName !== "string")
  ) return sendJson(res, 400, { error: "用户名或密码形状不对" });
  const displayName = value.displayName === undefined ? null : value.displayName;
  const password = value.password;
  const username = value.username;
  const existsInHistory = withStore(deps.dbPath, (store) => store.hasHistoricalRunTrigger(username));
  if (existsInHistory) return sendJson(res, 409, { error: "这个用户名在评审记录里出现过,换一个" });
  const passwordHash = await hashPassword(password);
  try {
    withStore(deps.dbPath, (store) =>
      store.createPanelUser({
        username,
        displayName,
        passwordHash,
        mustChangePassword: true,
        createdAt: new Date((deps.now ?? Date.now)()).toISOString(),
        isSystemAdmin: false,
        roleId: null,
      }),
    );
  } catch {
    return sendJson(res, 409, { error: "用户名已存在" });
  }
  return sendJson(res, 201, { username });
}
async function handlePanelUser(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  username: string,
) {
  if (req.method === "DELETE") {
    const store = openStore(deps.dbPath);
    try {
      const prior = store.getPanelUser(username);
      if (prior === undefined) return sendJson(res, 404, { error: "用户不存在" });
      if (prior.isSystemAdmin && store.listPanelUsers().filter((user) => user.isSystemAdmin).length === 1) {
        return sendJson(res, 409, { error: "不能删除最后一个系统管理员" });
      }
      store.removePanelUser(username);
      return send(res, 204);
    } finally {
      store.close();
    }
  }
  const body = await readBody(req, res);
  if (body === undefined) return;
  const value = safeParse(body) as {
    displayName?: unknown;
    roleId?: unknown;
    isSystemAdmin?: unknown;
  } | null;
  if (
    value === null ||
    (value.displayName !== null && typeof value.displayName !== "string") ||
    (value.roleId !== null && typeof value.roleId !== "number") ||
    typeof value.isSystemAdmin !== "boolean"
  ) return sendJson(res, 400, { error: "用户更新形状不对" });
  const displayName = value.displayName;
  const roleId = value.roleId;
  const isSystemAdmin = value.isSystemAdmin;
  const result = withStore(deps.dbPath, (store) =>
    store.updatePanelUser(username, { displayName, roleId, isSystemAdmin }),
  );
  if (result === "missing") return sendJson(res, 404, { error: "用户不存在" });
  if (result === "last-system-admin") return sendJson(res, 409, { error: "不能降级最后一个系统管理员" });
  return send(res, 204);
}

async function handleResetPanelPassword(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  username: string,
) {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const value = safeParse(body) as { password?: unknown } | null;
  if (value === null || typeof value.password !== "string") return sendJson(res, 400, { error: "密码形状不对" });
  const passwordHash = await hashPassword(value.password);
  const updated = withStore(deps.dbPath, (store) => store.resetPanelPassword(username, passwordHash));
  return updated ? send(res, 204) : sendJson(res, 404, { error: "用户不存在" });
}

async function handleSelfPassword(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  caller: { username: string },
) {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const value = safeParse(body) as { password?: unknown } | null;
  if (value === null || typeof value.password !== "string") return sendJson(res, 400, { error: "密码形状不对" });
  const passwordHash = await hashPassword(value.password);
  const raw = cookieValue(req.headers.cookie, SESSION_COOKIE)!;
  const current = sessionHash(raw);
  withStore(deps.dbPath, (store) => {
    store.updatePanelPassword(caller.username, passwordHash, false);
    store.removePanelSessions(caller.username, current);
  });
  return send(res, 204);
}
async function handlePanelRoles(req: IncomingMessage, res: ServerResponse, deps: WebhookServerDeps) {
  if (req.method === "GET") {
    return sendJson(res, 200, { roles: withStore(deps.dbPath, (store) => store.listPanelRoles()) });
  }
  const body = await readBody(req, res);
  if (body === undefined) return;
  const value = safeParse(body) as { name?: unknown; permissions?: unknown } | null;
  if (value === null || typeof value.name !== "string" || !Array.isArray(value.permissions)) {
    return sendJson(res, 400, { error: "角色形状不对" });
  }
  const permissions = value.permissions.filter(
    (permission): permission is string => typeof permission === "string",
  );
  if (permissions.length !== value.permissions.length || !permissions.every(isPanelPermission)) {
    return sendJson(res, 400, { error: "有认不出的权限格" });
  }
  const name = value.name;
  try {
    const role = withStore(deps.dbPath, (store) =>
      store.createPanelRole({ name, permissions, createdAt: new Date((deps.now ?? Date.now)()).toISOString() }),
    );
    return sendJson(res, 201, role);
  } catch {
    return sendJson(res, 409, { error: "角色名已存在" });
  }
}

async function handlePanelRole(req: IncomingMessage, res: ServerResponse, deps: WebhookServerDeps, id: number) {
  if (req.method === "DELETE") {
    const result = withStore(deps.dbPath, (store) => store.removePanelRole(id));
    if (result.usernames.length > 0) return sendJson(res, 409, { error: "角色仍在使用", usernames: result.usernames });
    return result.removed ? send(res, 204) : sendJson(res, 404, { error: "角色不存在" });
  }
  const body = await readBody(req, res);
  if (body === undefined) return;
  const value = safeParse(body) as { name?: unknown; permissions?: unknown } | null;
  if (value === null || typeof value.name !== "string" || !Array.isArray(value.permissions)) return sendJson(res, 400, { error: "角色形状不对" });
  const permissions = value.permissions.filter((permission): permission is string => typeof permission === "string");
  if (permissions.length !== value.permissions.length || !permissions.every(isPanelPermission)) return sendJson(res, 400, { error: "有认不出的权限格" });
  const name = value.name;
  const role = withStore(deps.dbPath, (store) => store.updatePanelRole(id, { name, permissions }));
  return role === undefined ? sendJson(res, 404, { error: "角色不存在" }) : sendJson(res, 200, role);
}

function handleLogout(req: IncomingMessage, res: ServerResponse, deps: WebhookServerDeps): void {
  const raw = cookieValue(req.headers.cookie, SESSION_COOKIE);
  if (raw !== undefined) {
    withStore(deps.dbPath, (store) => store.removePanelSession(sessionHash(raw)));
  }
  res.writeHead(204, { "set-cookie": sessionCookieHeader(deps.panelPrefix, "", 0) });
  res.end();
}

const PANEL_ROUTES: readonly PanelRoute[] = [
  {
    method: "POST",
    pattern: "/session",
    access: "public",
    handler: ({ req, res, deps, auth }) => handleLogin(req, res, deps, auth),
  },
  {
    method: "POST",
    pattern: "/users/bootstrap",
    access: "public",
    handler: ({ req, res, deps, bootstrapSecret, clearBootstrap }) =>
      handleBootstrapRegister(req, res, deps, bootstrapSecret, clearBootstrap),
  },
  {
    method: "GET",
    pattern: "/session",
    access: "authenticated-only",
    allowedWhilePasswordExpired: true,
    handler: ({ req, res, deps }) => {
      const session = panelSession(req, deps)!;
      return sendJson(res, 200, {
        username: session.username,
        displayName: session.displayName,
        permissions: session.permissions,
        isSystemAdmin: session.isSystemAdmin,
        systemAdmins: session.systemAdmins,
        mustChangePassword: session.mustChangePassword,
      });
    },
  },
  {
    method: "GET",
    pattern: "/users",
    access: "system-admin-only",
    handler: ({ req, res, deps }) => handlePanelUsers(req, res, deps),
  },
  {
    method: "POST",
    pattern: "/users",
    access: "system-admin-only",
    handler: ({ req, res, deps }) => handlePanelUsers(req, res, deps),
  },
  {
    method: "PUT",
    pattern: /^\/users\/([a-z0-9._-]{1,32})$/,
    access: "system-admin-only",
    handler: ({ req, res, deps }, match) => handlePanelUser(req, res, deps, match![1]!),
  },
  {
    method: "DELETE",
    pattern: /^\/users\/([a-z0-9._-]{1,32})$/,
    access: "system-admin-only",
    handler: ({ req, res, deps }, match) => handlePanelUser(req, res, deps, match![1]!),
  },
  {
    method: "POST",
    pattern: /^\/users\/([a-z0-9._-]{1,32})\/reset-password$/,
    access: "system-admin-only",
    handler: ({ req, res, deps }, match) =>
      handleResetPanelPassword(req, res, deps, match![1]!),
  },
  {
    method: "PUT",
    pattern: "/session/password",
    access: "authenticated-only",
    allowedWhilePasswordExpired: true,
    handler: ({ req, res, deps, caller }) => handleSelfPassword(req, res, deps, caller!),
  },
  {
    method: "GET",
    pattern: "/roles",
    access: "system-admin-only",
    handler: ({ req, res, deps }) => handlePanelRoles(req, res, deps),
  },
  {
    method: "POST",
    pattern: "/roles",
    access: "system-admin-only",
    handler: ({ req, res, deps }) => handlePanelRoles(req, res, deps),
  },
  {
    method: "PUT",
    pattern: /^\/roles\/(\d+)$/,
    access: "system-admin-only",
    handler: ({ req, res, deps }, match) => handlePanelRole(req, res, deps, Number(match![1])),
  },
  {
    method: "DELETE",
    pattern: /^\/roles\/(\d+)$/,
    access: "system-admin-only",
    handler: ({ req, res, deps }, match) => handlePanelRole(req, res, deps, Number(match![1])),
  },
  {
    method: "DELETE",
    pattern: "/session",
    allowedWhilePasswordExpired: true,
    access: "authenticated-only",
    handler: ({ req, res, deps }) => handleLogout(req, res, deps),
  },
  { method: "GET", pattern: "/settings", access: "model:read", handler: ({ res, deps }) => handleGetSettings(res, deps) },
  { method: "PUT", pattern: "/settings", access: "model:write", handler: ({ req, res, deps }) => handlePutSettings(req, res, deps) },
  { method: "GET", pattern: "/stats", access: "review:read", handler: ({ req, res, deps }) => handleStats(req, res, deps) },
  { method: "GET", pattern: "/runs", access: "review:read", handler: ({ req, res, deps }) => handleRuns(req, res, deps) },
  { method: "POST", pattern: "/rerun", access: "review:rerun", handler: ({ req, res, deps, caller }) => handleRerun(req, res, deps, caller!.username) },
  {
    method: "GET",
    pattern: "/repos/search",
    access: "repo:write",
    handler: ({ req, res, deps, hookManager }) =>
      handleRepoSearch(req, res, deps, hookManager),
  },
  { method: "GET", pattern: "/repos", access: "repo:read", handler: ({ res, deps }) => listRepos(res, deps) },
  {
    method: "POST",
    pattern: "/repos",
    access: "repo:write",
    handler: ({ req, res, deps, hookManager }) =>
      handleRegister(req, res, deps, hookManager),
  },
  {
    method: "DELETE",
    pattern: /^\/repos\/(\d+)$/,
    access: "repo:write",
    handler: ({ res, deps, hookManager }, match) =>
      handleRemove(res, deps, hookManager, Number(match![1])),
  },
  {
    method: "PUT",
    pattern: /^\/repos\/(\d+)\/reviewers$/,
    access: "repo:write",
    handler: ({ req, res, deps }, match) =>
      handleSetReviewers(req, res, deps, Number(match![1])),
  },
  {
    method: "POST",
    pattern: /^\/repos\/(\d+)\/rotate$/,
    access: "repo:write",
    handler: ({ res, deps, hookManager }, match) =>
      handleRotate(res, deps, hookManager, Number(match![1])),
  },
  {
    method: "GET",
    pattern: /^\/repos\/(\d+)\/hooks$/,
    access: "repo:read",
    handler: ({ res, deps, hookManager }, match) =>
      handleHookCheck(res, deps, hookManager, Number(match![1])),
  },
  { method: "GET", pattern: "/catalog", access: "model:read", handler: ({ res, deps }) => handleCatalog(res, deps) },
  { method: "GET", pattern: "/credentials", access: "credential:read", handler: ({ res, deps }) => handleListCredentials(res, deps) },
  {
    method: "PUT",
    pattern: /^\/credentials\/([A-Za-z0-9_-]+)$/,
    access: "credential:write",
    handler: ({ req, res, deps }, match) =>
      handlePutCredential(req, res, deps, match![1]!),
  },
  {
    method: "DELETE",
    pattern: /^\/credentials\/([A-Za-z0-9_-]+)$/,
    access: "credential:write",
    handler: ({ res, deps }, match) => handleRemoveCredential(res, deps, match![1]!),
  },
  { method: "GET", pattern: "/model-rows", access: "model:read", handler: ({ res, deps }) => handleListModelRows(res, deps) },
  {
    method: "POST",
    pattern: "/model-rows",
    access: "model:write",
    handler: ({ req, res, deps }) => handleAddModelRow(req, res, deps),
  },
  {
    method: "DELETE",
    pattern: "/model-rows",
    access: "model:write",
    handler: ({ req, res, deps }) => handleRemoveModelRow(req, res, deps),
  },
  { method: "GET", pattern: "/custom-providers", access: "model:read", handler: ({ res, deps }) => handleListCustomProviders(res, deps) },
  {
    method: "POST",
    pattern: "/custom-providers",
    access: "model:write",
    handler: ({ req, res, deps }) => handleAddCustomProvider(req, res, deps),
  },
  {
    method: "DELETE",
    pattern: CUSTOM_PROVIDER_ROUTE,
    access: "model:write",
    handler: ({ res, deps }, match) => handleRemoveCustomProvider(res, deps, match![1]!),
  },
];

function matchPanelRoute(
  route: PanelRoute,
  method: string | undefined,
  sub: string,
): { route: PanelRoute; match: RegExpMatchArray | undefined } | undefined {
  if (route.method !== method) return undefined;
  if (typeof route.pattern === "string") {
    return route.pattern === sub ? { route, match: undefined } : undefined;
  }
  const match = route.pattern.exec(sub);
  return match === null ? undefined : { route, match };
}

function findPanelRoute(
  method: string | undefined,
  sub: string,
): { route: PanelRoute; match: RegExpMatchArray | undefined } | undefined {
  for (const route of PANEL_ROUTES) {
    const matched = matchPanelRoute(route, method, sub);
    if (matched !== undefined) return matched;
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
  bootstrapSecret: () => string | undefined,
  clearBootstrap: () => void,
): Promise<void> {
  const sub = pathname(req).slice(`/${deps.panelPrefix}/api`.length) || "/";
  const matched = findPanelRoute(req.method, sub);
  const context: PanelRouteContext = {
    req,
    res,
    deps,
    auth,
    hookManager,
    bootstrapSecret,
    clearBootstrap,
  };
  if (matched?.route.access === "public") {
    return matched.route.handler(context, matched.match);
  }
  const session = panelSession(req, deps);
  // 未匹配也先过门禁:不登录不能借 404 枚举 API 面。
  if (session === undefined) {
    const bootstrap = withStore(deps.dbPath, (store) => store.countPanelUsers()) === 0;
    return sendJson(res, 401, { error: "未登录", ...(bootstrap ? { bootstrap: true } : {}) });
  }
  if (session.renewed) {
    res.setHeader(
      "set-cookie",
      sessionCookieHeader(deps.panelPrefix, session.raw, Math.floor(SESSION_TTL_MS / 1000)),
    );
  }
  if (matched === undefined) return sendJson(res, 404, { error: "没有这个端点" });
  if (session.mustChangePassword && matched.route.allowedWhilePasswordExpired !== true) {
    return sendJson(res, 403, { error: "先改密码" });
  }
  if (
    matched.route.access === "system-admin-only" &&
    !session.isSystemAdmin
  ) {
    return sendJson(res, 403, { error: "只有系统管理员能做" });
  }
  if (
    matched.route.access !== "authenticated-only" &&
    matched.route.access !== "system-admin-only" &&
    !session.isSystemAdmin &&
    !session.permissions.includes(matched.route.access)
  ) {
    return sendJson(res, 403, { error: "没有这一格权限" });
  }
  return matched.route.handler(
    {
      ...context,
      caller: {
        username: session.username,
        isSystemAdmin: session.isSystemAdmin,
        permissions: session.permissions,
      },
    },
    matched.match,
  );
}

/**
 * 全局设置:模型组合与批次上限。仓库详情用它展示「跟随全局」跟的是什么。
 * 批次上限没配时回默认值,读回来的就是这次审查真会用的那个数。
 */
function handleGetSettings(res: ServerResponse, deps: WebhookServerDeps): void {
  const settings = globalSettings(deps);
  return sendJson(res, 200, {
    reviewers: settings.reviewers,
    maxChangedLinesPerBatch:
      settings.maxChangedLinesPerBatch ?? DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
  });
}

/**
 * 改写全局设置,回 GET 的同一形状。模型组合的校验判据与每仓库覆盖同一套,报错里的
 * 来源标注写「全局模型组合」,只有「空不空」这一条两层不同:
 *
 * 全局组合允许为空——空库刚部署时它本来就是空的,而这个状态有确定行为(投递照常受理,
 * 留下一条写明「还没配模型组合」的失败 Run,issue #66)。拒收空组合会把「只想先调批次
 * 上限」也一起连坐掉:这个端点是整表写入,两项在一次请求里。
 * 每仓库覆盖仍必须至少一个(issue #69),判据见 `assertReviewerSpecs`。
 */
async function handlePutSettings(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = safeParse(body) as {
    reviewers?: unknown;
    maxChangedLinesPerBatch?: unknown;
  } | null;
  if (payload === null) {
    return sendJson(res, 400, { error: "body 要是 JSON" });
  }
  const parsed = parseReviewerSpecs(payload.reviewers, GLOBAL_REVIEWERS_CONTEXT, {
    allowEmpty: true,
  });
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });

  // 缺省与显式清空都写成 null,读回来取默认值。
  const limit = payload.maxChangedLinesPerBatch ?? null;
  if (limit !== null && (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0)) {
    return sendJson(res, 400, {
      error: "maxChangedLinesPerBatch 要是正整数,留空即取默认值",
    });
  }

  withStore(deps.dbPath, (store) =>
    store.putGlobalSettings({
      reviewersJson: parsed.reviewersJson,
      maxChangedLinesPerBatch: limit,
    }),
  );
  return handleGetSettings(res, deps);
}

/**
 * 缺主密钥时凭据端点整体不可用:读写都 503 并说明差什么(ADR 0008)。服务本身照常
 * 启动——起不来就进不了面板,进不了面板就配不了凭据。
 */
const MASTER_KEY_MISSING =
  `没有设置环境变量 ${CREDENTIAL_MASTER_KEY_ENV},凭据加密不了也解不开。` +
  "在 .env 里补上它并重启服务。";

/**
 * 模型目录:服务进程里那份 Pi 的全部 provider 与它们的模型,每家带上凭据是否已配、
 * 保存凭据时会不会真发验证请求。目录与凭据状态一次拿齐——分成两个端点要在前端合并两份
 * 数据,还多一次往返。`verifiable` 由服务端给,前端硬编码那四家会与这里漂移。
 *
 * 没配凭据的 provider 照常在结果里:面板要先能看见一家,才知道该去配它的凭据。
 */
async function handleCatalog(res: ServerResponse, deps: WebhookServerDeps): Promise<void> {
  const masterKey = deps.credentialMasterKey;
  const { credentials, modelRows, customProviders } = withStore(deps.dbPath, (store) => ({
    credentials: store.listModelCredentials(),
    modelRows: store.listModelRows(),
    customProviders: store.listCustomProviders(),
  }));
  // 目录是 Pi 的内置事实,与凭据无关,缺主密钥照样给——选模型这件事本身不需要凭据,
  // 而看不见目录的人也就无从知道该去配哪一家。缺主密钥时全部按未配置算。
  const configured = new Set(
    masterKey === undefined || masterKey === ""
      ? []
      : credentials
          // 判据与凭据列表同一套:解不开的密文按未配置算。
          .filter((row) => decryptCredential(masterKey, row.apiKeyEncrypted) !== undefined)
          .map((row) => row.provider),
  );
  // 单价留空的模型行,按 provider 归拢(issue #89)。判据只在库里:目录里的 `cost` 是 Pi
  // 给的结果,而手填一行留空时 Pi 填的默认值恰好也是 0,内置表里本来就有一百多个模型的
  // 单价是真的 0——拿 `cost` 判会把「免费」诬告成「没记账」。留空的判据与落盘那一处同一条
  // (`writeSharedModelsConfig`):两项都是 null 才算留空,只填一头时另一头按 0 落进单价表,
  // 那是操作员写下的 0。库里没有行的模型(内置、远程目录、厂商目录)一律不标。
  const costUnset = new Map<string, Set<string>>();
  for (const row of modelRows) {
    if (row.costInput !== null || row.costOutput !== null) continue;
    let models = costUnset.get(row.provider);
    if (models === undefined) costUnset.set(row.provider, (models = new Set()));
    models.add(row.model);
  }
  // 操作员自己加的那几家(issue #88)。判据在库里而不在目录里:目录里的一家看不出自己是
  // 内置的还是登记进来的,而面板要把两者分开呈现(删得掉哪一家、改得动哪一家的端点)。
  const customNames = new Set(customProviders.map((entry) => entry.name));
  // 撞名的那几家(issue #94)。名字被 Pi 内置的同名 provider 占用时目录里那一条是内置那一家
  // (撞名的不落进派生文件),`custom` 与它同时为真即这一档:登记还在库里、面板删得掉,可是
  // 这一家已经停用。判据现算不落库,冲突消失后下一次读目录就恢复。
  const conflicting = await conflictingProviderNames(customProviders);
  const verifiable = new Set(CHECKED_PROVIDERS);
  const catalog = await modelCatalog();
  return sendJson(res, 200, {
    // 远程那一层的状态照原样透出:`unavailable` 时给出的只有内置目录,选择器里会少
    // 掉 pi.dev 上的那部分模型,不透出去就查不出少在哪。
    remote: catalog.remote,
    // 厂商目录那一层按 provider 分开报,与远程那一层不合并:两层都可能少掉一批模型,
    // 合成一个字段就分不清是哪一层没生效。前端这轮不读它,运维读 API 或日志。
    vendors: catalog.vendors,
    providers: catalog.providers.map((provider) => {
      const unset = costUnset.get(provider.id);
      return {
        id: provider.id,
        name: provider.name,
        configured: configured.has(provider.id),
        // 真发验证请求的那几家,判据就是 `credential-check.ts` 认得的那张表。
        verifiable: verifiable.has(provider.id),
        // 真即这一家是操作员自己加的自定义 provider,不是 Pi 内置的那些家。
        custom: customNames.has(provider.id),
        // 真即这个名字与 Pi 内置的同名 provider 撞上了,这一家已停用(issue #94)。
        conflict: conflicting.has(provider.id),
        models: provider.models.map((model) => ({
          ...model,
          // 真即这个模型的 Review Run 成本会记成零:成本取自这张单价表,而留空的行走的是
          // Pi 的默认值 0。面板据此在模型行与已选列表上标出来。
          costUnset: unset !== undefined && unset.has(model.id),
        })),
      };
    }),
  });
}

/**
 * 凭据列表。只写不回显(ADR 0008):给 provider、是否已配、是否验证过、更新时间、
 * 尾 4 位。解不开的密文按未配置透出,不抛也不做重加密迁移。
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
        // 假即保存时跳过了厂商验证:这一家没有验证端点,key 对不对要等 Review Run 才知道。
        verified: row.verified,
        updatedAt: row.updatedAt,
        last4: apiKey === undefined ? null : credentialTail(apiKey),
      };
    }),
  });
}

/**
 * 写一家厂商的凭据。认得的那几家先真发一次最小请求验证,失败不落库并回报原因——key
 * 打错要在粘贴的那一刻显形,不能等下一个 PR 进来。
 *
 * 认不出的 provider 照样保存,只是跳过验证并标 `verified: false`:模型目录列出 Pi
 * 全部 39 家,拒收会让其余那些家的模型选得出、凭据配不上。同 provider 二次写入是覆盖。
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
    store.putModelCredential(
      provider,
      encryptCredential(masterKey, apiKey),
      updatedAt,
      check.verified,
    ),
  );
  return sendJson(res, 200, {
    provider,
    configured: true,
    verified: check.verified,
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

/**
 * 手填的模型行(issue #87)。回的是库里的原样:派生的用户模型配置与目录端点里那一份都
 * 从这些行重建,面板要能看见自己填过什么、删掉哪一条。
 */
function handleListModelRows(res: ServerResponse, deps: WebhookServerDeps): void {
  return sendJson(res, 200, { rows: withStore(deps.dbPath, (store) => store.listModelRows()) });
}

/**
 * 选填的一个数。缺省与 null 都按「没填」处理(落盘时整项不写,由 Pi 取默认值);填了就
 * 必须能落盘——Pi 对 contextWindow ≤ 0 直接抛,而它把这类错误吞进 provider 的合成里,
 * 那一行会连提示都没有地凭空消失,人只看到「保存成功却选不到」。
 */
function optionalNumber(
  value: unknown,
  options: { min: number; integer?: boolean },
): { ok: true; value: number | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isFinite(value) || value < options.min) {
    return { ok: false };
  }
  if (options.integer === true && !Number.isInteger(value)) return { ok: false };
  return { ok: true, value };
}

/**
 * 加一条手填的模型行。三道拒收:provider 要在模型目录里、要已配模型凭据、model id 非空。
 *
 * 凭据是硬门禁(issue #80):选择器今天就以凭据为准(未配凭据的那一家整组 disabled),
 * 放开到全部 39 家会让同一个 provider 点不动却填得进,两套规则并存。填一个目录里没有的
 * provider 落到的是自定义 provider 那条入口,不是这一条。
 *
 * model id 本身不校验:填错了由子进程报「模型不存在」,单个 Reviewer 失败不拦整轮,失败
 * 原因落库并显示在评审记录上(issue #65 的既有链路)。
 *
 * 回的形状与 GET 相同——加完立刻要显示完整的一览,让前端再打一次列表是白付一次往返。
 */
async function handleAddModelRow(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = safeParse(body) as {
    provider?: unknown;
    model?: unknown;
    costInput?: unknown;
    costOutput?: unknown;
    contextWindow?: unknown;
  } | null;
  if (payload === null) {
    return sendJson(res, 400, { error: "body 要是 JSON" });
  }
  if (typeof payload.provider !== "string" || payload.provider === "") {
    return sendJson(res, 400, { error: "provider 要从模型目录里选一家。" });
  }
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  if (model === "") {
    return sendJson(res, 400, { error: "model id 不能是空的,填厂商文档里那个模型标识。" });
  }
  const costInput = optionalNumber(payload.costInput, { min: 0 });
  const costOutput = optionalNumber(payload.costOutput, { min: 0 });
  const contextWindow = optionalNumber(payload.contextWindow, { min: 1, integer: true });
  if (!costInput.ok || !costOutput.ok || !contextWindow.ok) {
    return sendJson(res, 400, {
      error: "单价要是不小于 0 的数,上下文窗口要是正整数;两项都能留空,留空即取 Pi 的默认值。",
    });
  }

  const masterKey = deps.credentialMasterKey;
  // 没有主密钥就判不出哪一家配过凭据,而凭据是这个端点的门禁:与凭据页同一档回 503。
  if (masterKey === undefined || masterKey === "") {
    return sendJson(res, 503, { error: MASTER_KEY_MISSING });
  }

  const wanted = payload.provider;
  const provider = (await modelCatalog()).providers.find((entry) => entry.id === wanted);
  if (provider === undefined) {
    return sendJson(res, 400, {
      error: `模型目录里没有 ${wanted} 这一家,手填的模型行只能加在目录里已有的厂商下。`,
    });
  }
  // 接口协议与 base URL 是从该家的第一个模型继承来的,一个模型都没有就继承不到:Pi 会把
  // 这一行整个丢掉(内置目录里 radius 就是这一档)。
  if (provider.models.length === 0) {
    return sendJson(res, 400, {
      error: `${provider.id} 在模型目录里一个模型都没有,手填的行继承不到接口协议与 base URL,填了也取不到。`,
    });
  }
  const { credentials, customProviders } = withStore(deps.dbPath, (store) => ({
    credentials: store.listModelCredentials(),
    customProviders: store.listCustomProviders(),
  }));
  // 撞名的那一家整个停用了(issue #94):派生文件里没有它,往它下面填的行会落库却永远进不了
  // 模型目录,那就是「保存成功却选不到」。这一道必须自己判——上面两道都过得去:撞上的内置
  // 那一家在目录里、也有模型,而凭据就是登记撞名那一家时落下的那一把。
  if ((await conflictingProviderNames(customProviders)).has(provider.id)) {
    return sendJson(res, 400, {
      error:
        `${provider.id} 这个名字与 Pi 内置的同名 provider 撞上了,你登记的那一家已停用,` +
        "填在它下面的模型行进不了模型目录。先给那一家改个名字重建、或者把它删掉,再回来填。",
    });
  }
  const configured = credentials.some(
    (row) =>
      row.provider === provider.id &&
      // 判据与目录端点同一套:解不开的密文按未配置算。
      decryptCredential(masterKey, row.apiKeyEncrypted) !== undefined,
  );
  if (!configured) {
    return sendJson(res, 400, {
      error: `${provider.id} 还没配模型凭据,先去凭据页粘一把 key,再在这一家下面填模型标识。`,
    });
  }

  // 回响应体的那一份快照各读各的:它只是给面板显示用,派生文件那一份由重建自己现读。
  const rows = withStore(deps.dbPath, (store) => {
    store.putModelRow({
      provider: provider.id,
      model,
      costInput: costInput.value,
      costOutput: costOutput.value,
      contextWindow: contextWindow.value,
      createdAt: new Date((deps.now ?? Date.now)()).toISOString(),
    });
    return store.listModelRows();
  });
  const failure = await rebuildModelsConfig(deps.dbPath);
  if (failure !== undefined) return sendJson(res, 500, { error: rebuildFailureMessage(failure) });
  return sendJson(res, 200, { rows });
}

/**
 * 摘掉一条手填的模型行。目标走 body 而不是路径:model id 里既有斜杠
 * (`z-ai/glm-4.5-air`)又有冒号(`…:free`),塞进路径要靠 `%2F`,而外部反代常把它解回
 * 真正的斜杠,路由当场对不上。不存在的行也照样重建派生文件并回 204——目标状态已达成。
 */
async function handleRemoveModelRow(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = safeParse(body) as { provider?: unknown; model?: unknown } | null;
  const provider = payload === null ? undefined : payload.provider;
  const model = payload === null ? undefined : payload.model;
  if (typeof provider !== "string" || typeof model !== "string") {
    return sendJson(res, 400, {
      error: 'body 要是 {"provider": "...", "model": "..."} 形状的 JSON',
    });
  }
  withStore(deps.dbPath, (store) => store.removeModelRow(provider, model));
  const failure = await rebuildModelsConfig(deps.dbPath);
  if (failure !== undefined) return sendJson(res, 500, { error: rebuildFailureMessage(failure) });
  return send(res, 204);
}


/**
 * 已登记的自定义 provider(issue #88)。回的是库里的原样:面板要能看见自己加过哪几家、
 * 各自指向哪个端点。那把 key 不在这里,凭据列表按 provider 给出它的状态。
 */
function handleListCustomProviders(res: ServerResponse, deps: WebhookServerDeps): void {
  return sendJson(res, 200, {
    providers: withStore(deps.dbPath, (store) => store.listCustomProviders()),
  });
}

/**
 * 加一家自定义 provider:一个 OpenAI 兼容的端点,和内置那些家并列进模型目录。
 *
 * 五道拒收,每一道都对着一个查证过的 Pi 行为:
 *
 * 一、**名字撞上目录里已有的 id 或已登记的自定义 provider 时拒收。**Pi 对同名 provider
 *     不报错而是做覆盖:只给 base URL 不给模型列表时,内置那份模型列表原样保留、每一个都
 *     改指新端点(`applyModelsJson` 的第一步就是这个映射)。叫 `openai` 会让已有的模型组合
 *     悄声换掉接口地址,而面板上零痕迹——模型标识一个字都没变。判据取目录与库两处的并集:
 *     目录是权威的那一份,而派生文件一时写不出来时目录里看不到已登记的那几家,只查目录会
 *     让同一个名字被登记第二次(主键冲突直抛 500)。
 * 二、**名字含非法字符或者超过长度上限时拒收。**只小写字母、数字与连字符:与内置 id 同形,
 *     且顺带排除冒号——模型标识 `provider:model` 按第一个冒号切分,名字里带冒号会把标识切错
 *     位置。长度上限见 `CUSTOM_PROVIDER_NAME_MAX`:超长的名字删除时进不了路由,登得进去删不
 *     出来。
 * 三、**base URL 缺失时拒收。**四、**接口协议缺失或不在取值集里时拒收。**全新 provider
 *     没有继承来源(内置那些家的模型行从 `models[0]` 继承这两项),缺任一者 Pi 把这一家
 *     整个从目录里丢掉——不是报错,是消失,人只看到「保存成功却选不到」。
 * 五、**第一个 model id 缺失时拒收。**新加的一家要立刻有东西可选;那一行进 `model_row` 表,
 *     与手填那条入口复用同一张表与同一条派生链路。
 *
 * key 走既有的模型凭据加密路径(ADR 0008),只写不回显。自定义端点必然落在厂商验证认不出的
 * 那一类(认得的四家都是内置 id,而内置名字在第一道就被拒了),因此跳过验证并标成未验证:
 * key 对不对要等 Review Run 才知道。
 *
 * base URL 填错不在拒收之列:只要 `api` 与 `baseUrl` 两项都在,这一家就在目录里,地址对不
 * 对要到真请求那一刻才知道,那时留下的是一条带原因的 Reviewer 失败记录(issue #65)。
 *
 * 三张表(定义、第一个模型行、那把凭据)在一个事务里写齐(`registerCustomProvider`):分三句
 * 自动提交时中途报错会留下一份补不齐的半成品——重试撞上「名字已被占用」。
 */
async function handleAddCustomProvider(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
): Promise<void> {
  const masterKey = deps.credentialMasterKey;
  // 这一家的 key 与它一起落库,没有主密钥就加密不了:与凭据页同一档回 503。
  if (masterKey === undefined || masterKey === "") {
    return sendJson(res, 503, { error: MASTER_KEY_MISSING });
  }
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = safeParse(body) as {
    name?: unknown;
    baseUrl?: unknown;
    api?: unknown;
    model?: unknown;
    apiKey?: unknown;
  } | null;
  if (payload === null) {
    return sendJson(res, 400, { error: "body 要是 JSON" });
  }

  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!CUSTOM_PROVIDER_NAME.test(name)) {
    return sendJson(res, 400, {
      error:
        `provider 的名字只能用小写字母、数字与连字符,1 到 ${CUSTOM_PROVIDER_NAME_MAX} 个字符。` +
        "与 Pi 内置那些家的 id 同形,而且不能带冒号——模型标识 provider:model 按第一个冒号切分;" +
        "长度上限是因为删除时名字要整个放进 URL 路径,过长的请求行在路由之前就被拒了。",
    });
  }
  const baseUrl = typeof payload.baseUrl === "string" ? payload.baseUrl.trim() : "";
  if (baseUrl === "") {
    return sendJson(res, 400, {
      error:
        "base URL 不能留空:全新的一家 provider 没有可继承的来源,缺了它 Pi 会把这一家整个" +
        "从模型目录里丢掉,而不是报错。填厂商或网关文档里那个 OpenAI 兼容的基地址。",
    });
  }
  const api = typeof payload.api === "string" ? payload.api.trim() : "";
  if (!(CUSTOM_PROVIDER_APIS as readonly string[]).includes(api)) {
    return sendJson(res, 400, {
      error:
        `接口协议要从 ${CUSTOM_PROVIDER_APIS.join(" / ")} 里选一个,留空或填别的值时 Pi 会把` +
        "这一家整个从模型目录里丢掉。走 /chat/completions 的选 openai-completions,走 /responses 的选 openai-responses。",
    });
  }
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  if (model === "") {
    return sendJson(res, 400, {
      error: "第一个 model id 不能是空的:新加的一家要立刻有东西可选。填这个端点上那个模型标识。",
    });
  }
  const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
  if (apiKey === "") {
    return sendJson(res, 400, {
      error: "key 不能留空:一个名字对应一把模型凭据,没有它这一家的 Review Run 一开跑就失败。",
    });
  }

  const existing = withStore(deps.dbPath, (store) => store.listCustomProviders());
  const catalog = await modelCatalog();
  if (
    catalog.providers.some((provider) => provider.id === name) ||
    existing.some((provider) => provider.name === name)
  ) {
    return sendJson(res, 409, {
      error:
        `${name} 这个名字已被占用,换一个。Pi 对同名 provider 不报错而是做覆盖:` +
        "这一家已有的模型会原样留着、却全部改指你填的这个端点,已经选进模型组合的模型标识" +
        "一个字都不变,面板上看不出任何痕迹。",
    });
  }

  // 认不出的 provider 一个请求都不发,直接放行并标未验证。自定义端点必然走这一档,复用同
  // 一条路径是为了让两个写入口的判据只有一处。
  const check = await checkCredential(name, apiKey);
  if (!check.ok) {
    return sendJson(res, 400, { error: `凭据没通过验证,没有保存:${check.reason}` });
  }

  const createdAt = new Date((deps.now ?? Date.now)()).toISOString();
  const providers = withStore(deps.dbPath, (store) => {
    store.registerCustomProvider({
      name,
      baseUrl,
      api,
      model,
      apiKeyEncrypted: encryptCredential(masterKey, apiKey),
      verified: check.verified,
      createdAt,
    });
    return store.listCustomProviders();
  });
  const failure = await rebuildModelsConfig(deps.dbPath);
  if (failure !== undefined) return sendJson(res, 500, { error: rebuildFailureMessage(failure) });
  return sendJson(res, 200, { providers });
}

/**
 * 摘掉一家自定义 provider,连它的模型行与它那把凭据一起。
 *
 * 还被模型组合引用着就拒收并指名道姓说清是哪几处(全局组合与每仓库覆盖都查):删掉不问的话
 * 那些组合留着一个取不到的模型标识,下一次审查里那个模型报「模型不存在」,而人根本不会把它
 * 联想到这次删除。修法是先去那几处把它换掉,再回来删。
 *
 * 坏掉的覆盖 JSON(直接写库的遗留)按「引用不到」跳过,不让一行坏数据把删除卡死——它本来
 * 就已经在投递链上按配置错误处理了。
 */
async function handleRemoveCustomProvider(
  res: ServerResponse,
  deps: WebhookServerDeps,
  name: string,
): Promise<void> {
  const referenced = withStore(deps.dbPath, (store) => {
    const uses = (reviewersJson: string | null): boolean => {
      if (reviewersJson === null) return false;
      const specs = safeParseJson(reviewersJson);
      return (
        Array.isArray(specs) &&
        specs.some(
          (spec) =>
            typeof spec === "object" && spec !== null && "provider" in spec && spec.provider === name,
        )
      );
    };
    const where: string[] = [];
    if (uses(store.getGlobalSettings().reviewersJson)) where.push("全局组合");
    for (const repo of store.listRepos()) {
      if (uses(repo.reviewersJson)) where.push(`${repo.owner}/${repo.repo} 的覆盖`);
    }
    return where;
  });
  if (referenced.length > 0) {
    return sendJson(res, 409, {
      error:
        `${name} 还在模型组合里被引用着(${referenced.join("、")}),没有删。` +
        "先在那几处把它的模型换掉,再回来删这一家——留着引用的话下一次审查那个模型会报「模型不存在」。",
    });
  }

  withStore(deps.dbPath, (store) => store.removeCustomProvider(name));
  const failure = await rebuildModelsConfig(deps.dbPath);
  if (failure !== undefined) return sendJson(res, 500, { error: rebuildFailureMessage(failure) });
  return send(res, 204);
}

/**
 * 三个写端点共用的 500 措辞。写不出来是「已入库、派生物没跟上」这一档:此刻子进程取不到它,
 * 而启动时会按库重建(`main.ts`),措辞因此指向那条出路,不让人重填一遍。
 */
function rebuildFailureMessage(reason: string): string {
  return (
    `改动已入库,但派生的模型配置写不出来,现在还取不到(${reason})。` +
    "修好共用模型目录的写权限之后重启服务,启动时会按库里的内容重建它。"
  );
}

/** 派生文件重建的串行链,见 `rebuildModelsConfig`。 */
let modelsConfigWrites: Promise<void> = Promise.resolve();

/**
 * 把库里的模型行与自定义 provider 重新落成派生的用户模型配置,并让模型目录的缓存失效。
 * 写不出来时返回一句给人看的原因,不抛(措辞由调用方给:端点回 500,启动那一次只告警)。
 *
 * **重建串行,而且在轮到自己写的时候才读库。**入参只有库的位置:调用方提前截取的那一份集合
 * 会过期——它与写文件之间隔着一次撞名探测(建一份运行时,毫秒级),两个写请求于是可以按 A、B
 * 落库却按 B、A 写文件,A 手上那份旧快照把 B 的结果整份盖掉。两个请求都回了 2xx,而 B 那一行
 * 在库里存着、子进程却取不到,直到下一次重建或者重启——这恰好打破整份 spec 最要紧的那条不变量
 * (面板选得出的子进程必须取得到)。落盘的 `.pending` 中间名也是固定的,同时写还会互相覆盖。
 * 串起来两件事一起消失,而库是真相源,轮到自己时现读一次就一定是最新的全量。
 *
 * 手法与模型目录的加载一致(`catalog.ts` 的 `loadFromPi`),前提也一样:**这两份派生文件只有
 * 服务进程写**,Reviewer 子进程只读(`worker.ts`)。多进程部署不在这个前提里——那时进程内的
 * 队列不够用,得换成跨进程的锁或者原子方案。
 *
 * 落盘是整份重写,两样一起读:少给一样等于把那一样从模型目录里抹掉——自定义 provider 那一样
 * 漏了的话,那几家连带它们的模型全部消失(全新 provider 缺 `api` 与 `baseUrl` 就是消失,不是
 * 报错)。
 *
 * 缓存必须跟着失效:这些行落在 `catalog.ts` 缓存住的那张模型表上(一个进程只读一次),
 * 不失效的话操作员填完回到选择器里看不见自己刚填的那一行,只能重启容器。
 */
export function rebuildModelsConfig(dbPath: string): Promise<string | undefined> {
  const queued = modelsConfigWrites.then(() => writeModelsConfig(dbPath));
  // 链上留的那一份不带失败:一次写不出来不该把排在它后面的一起拖红。
  modelsConfigWrites = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

async function writeModelsConfig(dbPath: string): Promise<string | undefined> {
  const paths = sharedModelPaths();
  if (paths === undefined) return "共用模型目录建不出来";
  // 两样一次开库读齐:两次开库读同一个文件是白付的 I/O。
  const { rows, customProviders } = withStore(dbPath, (store) => ({
    rows: store.listModelRows(),
    customProviders: store.listCustomProviders(),
  }));
  // 撞名的那几家不写进去(issue #94):写了就等于拿自定义那个端点覆盖内置的同名那一家。判据
  // 每次重建现算,所以冲突消失之后下一次写入就把这一家写回去了,不需要别的操作。
  const conflicting = await conflictingProviderNames(customProviders);
  try {
    writeSharedModelsConfig(paths.config, rows, customProviders, conflicting);
  } catch (error) {
    return String(error);
  }
  invalidateModelCatalog();
  return undefined;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * 解析并校验一段模型组合入参。全局设置、仓库注册与每仓库覆盖共用同一判据,`context`
 * 指认是哪一层。返回序列化好的 JSON,校验不过返回错误信息。
 *
 * 只校验形状:凭据缺不缺是 Review Run 开始时的事(issue #65),这里试构建也拦不住,
 * 反而会把「这一家还没配」误报成「覆盖写错了」。
 *
 * `allowEmpty` 只有全局设置那一处给,理由见 `handlePutSettings`。
 */
function parseReviewerSpecs(
  value: unknown,
  context: string,
  options: { allowEmpty?: boolean } = {},
): { ok: true; reviewersJson: string } | { ok: false; error: string } {
  try {
    const specs = assertReviewerSpecs(value, context, options);
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
  triggeredBy: string,
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
  let specs: readonly ReviewerSpec[];
  try {
    specs = resolveSpecs(deps, registered.reviewersJson, registered.repoId);
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
  void startRun(
    deps,
    forge,
    { platform: "gitea", owner, repo, number: pullNumber, headSha, draft: false, action: "rerun" },
    specs,
    triggeredBy,
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

/**
 * 注册用的仓库搜索:服务端拿 bot PAT 去问 Gitea,浏览器不直连——直连等于把 Gitea 的
 * 仓库可见范围挂在一个前端能拿到的 token 上,还要再造一条凭据轮换路径。
 *
 * 不可选的两类(已注册、bot 不是 admin)照样返回,由前端置灰。过滤掉会让人明知仓库
 * 存在却搜不到,第一反应是搜索坏了。
 *
 * `state` 把「还没输关键字」与「输了但没搜到」分开:两者都是空列表,而人下一步该做的
 * 事不同。`truncated` 为真时只是这一页装不下,继续输入以缩小范围。
 */
async function handleRepoSearch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  hookManager: GiteaHookManager | undefined,
): Promise<void> {
  if (hookManager === undefined) {
    return sendJson(res, 500, { error: "没有配置 Gitea,无法搜索仓库" });
  }
  const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("q") ?? "";
  if (query.trim() === "") {
    return sendJson(res, 200, {
      state: "empty-query",
      total: 0,
      truncated: false,
      results: [],
    });
  }

  const page = await hookManager.searchRepos(query.trim());
  const registered = new Set(
    withStore(deps.dbPath, (store) => store.listRepos()).map((row) => row.repoId),
  );
  const results = page.hits.map((hit) => {
    const isRegistered = registered.has(hit.repoId);
    return {
      repoId: hit.repoId,
      owner: hit.owner,
      repo: hit.repo,
      registered: isRegistered,
      admin: hit.admin,
      // 不可选时说明缺什么。文案与注册流程的两条拒绝一字不差:同一件事只有一种说法。
      ...(isRegistered
        ? { reason: `${hit.owner}/${hit.repo} 已注册(repo id ${hit.repoId})` }
        : hit.admin
          ? {}
          : { reason: missingAdminReason(hit) }),
    };
  });
  return sendJson(res, 200, {
    state: results.length === 0 ? "no-match" : "ok",
    total: page.total,
    truncated: page.total > page.hits.length,
    results,
  });
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
    const parsed = parseReviewerSpecs(
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
    const parsed = parseReviewerSpecs(
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
  const hooks = (await hookManager.listHooks(resolved))
    .map((hook) => {
      const generation = generationFromHookUrl(hook.url, deps.baseUrl);
      return generation === undefined ? undefined : { hook, generation };
    })
    .filter((entry): entry is { hook: GiteaHook; generation: number } => entry !== undefined);

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
  const auth = createPanelAuth({
    ...(deps.now === undefined ? {} : { now: deps.now }),
    onGate: ({ account, ip, count }) =>
      console.warn(`登录节流:账号 ${account},来源 ${ip},已失败 ${count} 次`),
  });
  let bootstrap =
    withStore(deps.dbPath, (store) => store.countPanelUsers()) === 0
      ? (deps.bootstrapSecret ?? randomBytes(16).toString("hex"))
      : undefined;
  if (bootstrap !== undefined) deps.onBootstrap?.(bootstrap);
  const bootstrapSecret = (): string | undefined => bootstrap;
  const clearBootstrap = (): void => {
    bootstrap = undefined;
  };
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
      void handlePanelApi(
        req,
        res,
        deps,
        auth,
        hookManager,
        bootstrapSecret,
        clearBootstrap,
      ).catch((error: unknown) => {
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
