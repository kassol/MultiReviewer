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
  modelIdentity,
  parseGlobalReviewers,
  reviewerPin,
  type ModelServiceTarget,
  type ReviewerRuntimePlan,
  type ReviewerSpec,
} from "../config.ts";
import type { CloneCredentials, Forge, PullRequestRef, RepoRef } from "../forge/forge.ts";
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
import {
  effectivePanelPermissions,
  isPanelPermission,
  type PanelPermission,
} from "../panel/permissions.ts";
import {
  credentialTail,
  CREDENTIAL_MASTER_KEY_ENV,
  decryptCredential,
  encryptCredential,
} from "../panel/credential-crypto.ts";
import {
  ensureWorktree,
  listBranchCommits,
  listBranches,
  prepareRangeDiff,
  pushBranch,
  readRangeDiffFiles,
  readRangeFileDiff,
  removeWorktree,
  resolveRange,
  type BranchCommits,
  type PreparedRange,
  type RangeDiffOptions,
  type RangeDiffRejection,
  type ResolvedRange,
} from "../git/worktree.ts";
import { DEFAULT_MAX_CHANGED_LINES_PER_BATCH } from "../review/batch.ts";
import type { Reviewer } from "../review/finding.ts";
import {
  containerBranches,
  containerPullRequestBody,
  containerPullRequestTitle,
  isContainerBranch,
} from "../review/range-review.ts";
import {
  backfillUpdates,
  createReviewRunPlan,
  priorDispositions,
  runReview,
  type ReviewRunPlan,
} from "../review/run.ts";
import {
  CUSTOM_PROVIDER_NAME_PATTERN,
  openStore,
  type ModelReference,
  type ModelServiceRecord,
  type ModelServiceVersionCommit,
  type ModelSupplementSource,
  type RangeReviewRecord,
  type RepoKey,
  type Store,
} from "../review/store.ts";
import { modelServiceTargetFingerprint } from "../review/model-service-migration.ts";
import { subscribeTrace, type TraceEvent } from "../review/trace.ts";
import {
  conflictingBuiltinProviderNames,
  listPiBuiltinProviders,
  resolvePiBuiltinProviderTarget,
  type PiBuiltinProviderTarget,
} from "../reviewer/catalog.ts";
import {
  discoverModels,
  validateMinimalInference,
  MODEL_RUNTIME_BASELINE,
  normalizeModelServiceBaseUrl,
  synthesizeRuntimeModel,
  type DiscoveredModel,
  type ModelOperationFailure,
  type RuntimeModel,
  type RuntimeSynthesisResult,
  type ModelServiceCandidate,
  type TrustedModelFieldSource,
} from "../reviewer/model-service-runtime.ts";
import {
  CUSTOM_PROVIDER_APIS,
  modelCatalogStorePath,
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
   * `rerun` 与 `range-review` 不来自投递,是面板发起的标记——日志里要与真实投递分得开。
   */
  action: "opened" | "new-commit" | "closed" | "reopened" | "rerun" | "range-review";
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
  /** 审查轨迹 SSE 的心跳间隔(毫秒),默认 `TRACE_HEARTBEAT_MS`。只该测试注入。 */
  traceHeartbeatMs?: number;
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
   * 从已完整物化的不可变 Reviewer 计划组装执行体。每项只含自己的凭据；失败项也建出
   * Reviewer 留痕，不从组合里过滤。
   */
  buildReviewers: (plans: readonly ReviewerRuntimePlan[]) => readonly Reviewer[];
  /**
   * 模型凭据的加密主密钥(ADR 0008),取自环境变量。缺失时凭据端点读写都拒绝并说明
   * 原因,服务其余部分照常——起不来就进不了面板,进不了面板就配不了凭据。
   */
  credentialMasterKey?: string;
  /** 时钟,默认 `Date.now`。只该测试注入,用来驱动登录退避的时间窗。 */
  now?: () => number;
  /** 目录失败的真 HTTP 测试缝；生产默认走真实 Pi 目录加载。 */
  discoverModelServiceModels?: typeof discoverModels;
  /**
   * 后台准备工作副本(issue #184)结束时回调,`failure` 有值即这一次没备成。不传则把
   * 失败写进 stderr,成功不出声。
   */
  onWorktreePrepared?: (repoId: number, failure?: string) => void;
};

/** 两个平台标识 pull request 事件的头值相同。 */
const PULL_REQUEST_EVENT = "pull_request";

/** 未认证的投递方能塞任意大的 body,先设上限再读进内存。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** 「只记首次」集合的上限。准入拒绝的去重键含未认证方可自选的仓库 id,不设限会被写满内存。 */
const LOGGED_ONCE_MAX = 10_000;

/** 审查轨迹 SSE 的心跳间隔。要短过反代常见的 60 秒读超时,并留出余量。 */
const TRACE_HEARTBEAT_MS = 15_000;

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
  pull_request?: {
    draft?: unknown;
    head?: { sha?: unknown; ref?: unknown };
    base?: { ref?: unknown };
  };
  repository?: { id?: unknown; name?: unknown; owner?: { login?: unknown } };
};

/**
 * 投递里的容器 PR 分支名,不是容器 PR 时返回 undefined。
 *
 * 两个平台的 `pull_request.head.ref` / `base.ref` 都是分支名(Gitea 见
 * `modules/structs/pull.go` 的 `PRBranchInfo.Ref json:"ref"`)。两侧都看:容器 PR
 * 的两条分支都带前缀,只认一侧会在字段缺失时漏掉。
 */
function containerBranchOf(payload: unknown): string | undefined {
  const raw = payload as RawPayload | null;
  const head = raw?.pull_request?.head?.ref;
  if (isContainerBranch(head)) return head;
  const base = raw?.pull_request?.base?.ref;
  return isContainerBranch(base) ? base : undefined;
}

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

/** 审查策略。模型组合与批次上限都在库里,用时读一次。 */
function globalSettings(deps: WebhookServerDeps): {
  reviewers: ReviewerSpec[];
  reviewersVersion: number;
  maxChangedLinesPerBatch: number | null;
  maxChangedLinesPerBatchVersion: number;
} {
  const row = withStore(deps.dbPath, (store) => store.getGlobalSettings());
  return {
    reviewers: parseGlobalReviewers(row.reviewersJson),
    reviewersVersion: row.reviewersVersion,
    maxChangedLinesPerBatch: row.maxChangedLinesPerBatch,
    maxChangedLinesPerBatchVersion: row.maxChangedLinesPerBatchVersion,
  };
}

function frozenRuntimeModel(runtime: RuntimeModel): RuntimeModel {
  return Object.freeze({
    ...runtime,
    input: Object.freeze([...runtime.input]),
    sources: Object.freeze({ ...runtime.sources }),
  });
}

function synthesisForRun(
  service: ModelServiceRecord,
  discovery: DiscoveredModel,
  target: ModelServiceTarget | undefined,
): RuntimeSynthesisResult {
  if (target === undefined) {
    return {
      ok: false,
      failure: {
        code: "model-unconstructable",
        message: `模型服务 ${service.provider} 缺少可用的地址或接口协议`,
      },
    };
  }
  if (service.type === "builtin") {
    return synthesizeRuntimeModel(
      { kind: "builtin", provider: service.provider, credential: "" },
      discovery,
      target as PiBuiltinProviderTarget,
    );
  }
  if (!CUSTOM_PROVIDER_APIS.includes(target.api as (typeof CUSTOM_PROVIDER_APIS)[number])) {
    return {
      ok: false,
      failure: {
        code: "model-unconstructable",
        message: `模型服务 ${service.provider} 缺少可用的地址或接口协议`,
      },
    };
  }
  return synthesizeRuntimeModel(
    {
      kind: "openai-compatible",
      provider: service.provider,
      baseUrl: target.baseUrl,
      api: target.api as (typeof CUSTOM_PROVIDER_APIS)[number],
      credential: "",
    },
    discovery,
  );
}

function materializedReviewerPlan(
  spec: ReviewerSpec,
  service: ModelServiceRecord | undefined,
  target: ModelServiceTarget | undefined,
  conflictingProviders: ReadonlySet<string>,
  credential: string | undefined,
): ReviewerRuntimePlan {
  const identity = modelIdentity(spec);
  if (service === undefined) {
    return Object.freeze({
      spec: Object.freeze({ ...spec }),
      modelServiceVersion: null,
      target: null,
      runtimeModel: null,
      credential: null,
      failure: `模型服务 ${spec.provider} 不存在,${identity} 这次没跑。去模型服务页配置后重跑。`,
    });
  }

  const automatic = service.automaticModels.find((model) => model.id === spec.model);
  const supplement = service.supplements.find((entry) => entry.model === spec.model);
  const targetFingerprint =
    target === undefined ? undefined : modelServiceTargetFingerprint(target.baseUrl, target.api);
  const targetMatchesCommittedVersion =
    targetFingerprint !== undefined && service.targetFingerprint === targetFingerprint;
  const hasCurrentSource =
    targetMatchesCommittedVersion &&
    (automatic !== undefined ||
      supplement?.source === "migration-retention" ||
      (supplement?.source === "manual" && supplement.targetFingerprint === targetFingerprint));
  const discovery: DiscoveredModel = automatic ?? {
    identity,
    provider: spec.provider,
    id: spec.model,
    fields: {},
  };
  const synthesis = synthesisForRun(service, discovery, target);
  const runtimeModel = synthesis.ok ? frozenRuntimeModel(synthesis.value.runtime) : null;

  let failure: string | null = null;
  if (conflictingProviders.has(spec.provider)) {
    failure =
      `自定义 provider ${spec.provider} 的名字与 Pi 内置的同名 provider 撞上了,` +
      `${identity} 这次没跑。去模型服务页原子改名或删除它。`;
  } else if (!targetMatchesCommittedVersion) {
    failure = service.type === "builtin"
      ? `Pi 内置目标已经变化，${identity} 这次没跑。请粘贴凭据重新配置模型服务。`
      : `${service.provider} 的目标绑定不一致，${identity} 这次没跑。请重新配置模型服务。`;
  } else if (service.credential.state === "unconfigured") {
    failure =
      `没有配置 ${spec.provider} 的模型凭据,${identity} 这次没跑。` +
      "去模型服务页配好再重跑。";
  } else if (service.credential.state === "pending-reverification") {
    failure = `${spec.provider} 的模型凭据待重新验证,${identity} 这次没跑。`;
  } else if (credential === undefined || credential === "") {
    failure = `${spec.provider} 的模型凭据不可用,${identity} 这次没跑。`;
  } else if (!hasCurrentSource) {
    failure = `模型来源不存在: ${identity},这次没跑。去模型服务页恢复来源后重跑。`;
  } else if (!synthesis.ok) {
    failure = `${synthesis.failure.message},${identity} 这次没跑。`;
  }

  return Object.freeze({
    spec: Object.freeze({ ...spec }),
    modelServiceVersion: service.version,
    target: target === undefined ? null : Object.freeze({ ...target }),
    runtimeModel,
    credential: failure === null ? credential ?? null : null,
    failure,
  });
}

/**
 * 自动投递与手动重跑共用的唯一启动入口。一次 SQLite 读事务固定生效组合、批次上限、引用
 * 服务版本及其密文；事务外只解析这份快照并各解密一次，第一批开始后不再读当前配置。
 */
async function buildRunPlan(deps: WebhookServerDeps, repoId: number): Promise<ReviewRunPlan> {
  const snapshot = withStore(deps.dbPath, (store) => store.getReviewRunSnapshot(repoId));
  const customProviders = snapshot.modelServices
    .filter((service) => service.type === "custom")
    .map((service) => service.provider);
  const [conflictingProviders, builtinTargets] = await Promise.all([
    conflictingBuiltinProviderNames(customProviders),
    Promise.all(
      snapshot.modelServices
        .filter((service) => service.type === "builtin")
        .map(async (service) =>
          [service.provider, await resolvePiBuiltinProviderTarget(service.provider)] as const,
        ),
    ),
  ]);

  const services = new Map(snapshot.modelServices.map((service) => [service.provider, service]));
  const targets = new Map<string, ModelServiceTarget>();
  for (const service of snapshot.modelServices) {
    if (service.type === "custom" && service.baseUrl !== null && service.api !== null) {
      targets.set(service.provider, { baseUrl: service.baseUrl, api: service.api });
    }
  }
  for (const [provider, target] of builtinTargets) {
    if (target !== undefined) targets.set(provider, target);
  }

  const credentials = new Map<string, string>();
  const masterKey = deps.credentialMasterKey;
  if (masterKey !== undefined && masterKey !== "") {
    for (const service of snapshot.modelServices) {
      const target = targets.get(service.provider);
      const targetFingerprint =
        target === undefined ? undefined : modelServiceTargetFingerprint(target.baseUrl, target.api);
      if (
        targetFingerprint === undefined ||
        service.targetFingerprint !== targetFingerprint ||
        conflictingProviders.has(service.provider)
      ) continue;
      const ciphertext = service.credential.apiKeyEncrypted;
      if (service.credential.state !== "verified" || ciphertext === null) continue;
      const credential = decryptCredential(masterKey, ciphertext);
      if (credential !== undefined && credential !== "") {
        credentials.set(service.provider, credential);
      }
    }
  }

  const plans = Object.freeze(
    snapshot.reviewers.map((spec) =>
      materializedReviewerPlan(
        spec,
        services.get(spec.provider),
        targets.get(spec.provider),
        conflictingProviders,
        credentials.get(spec.provider),
      ),
    ),
  );
  return createReviewRunPlan(
    deps.buildReviewers(plans),
    snapshot.maxChangedLinesPerBatch ?? DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
    plans.map(reviewerPin),
  );
}

type Admission = { keys: RepoKey[] };

function lookupAdmission(dbPath: string, repoId: number): Admission {
  return withStore(dbPath, (store) => ({ keys: store.listRepoKeys(repoId) }));
}

/**
 * 开一轮 Review Run。调用方一律 `void` 它:这是长跑服务,后台任务的 rejection 不接住就会
 * 变成 unhandledRejection 把进程带崩,所以整段包在 try 里,失败一律经 `settled` 出去。
 */
async function startRun(
  deps: WebhookServerDeps,
  forge: Forge,
  event: NormalizedEvent,
  plan: ReviewRunPlan,
  triggeredBy?: string,
  rangeReviewId?: number,
): Promise<void> {
  const settled = deps.onRunSettled ?? logFailure;
  try {
    await runReview(
      { owner: event.owner, repo: event.repo, number: event.number },
      {
        forge,
        ...plan,
        cacheDir: deps.cacheDir,
        dbPath: deps.dbPath,
        ...(triggeredBy === undefined ? {} : { triggeredBy }),
        ...(rangeReviewId === undefined ? {} : { rangeReviewId }),
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
 *
 * 范围审查标记审查完成时走的也是这里:容器 PR 关闭就是那条链路的终态(ADR 0012)。
 */
async function runClosedBackfill(
  deps: WebhookServerDeps,
  forge: Forge,
  event: PullRequestRef,
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

  // 容器 PR 是本服务自己开的,它的事件一律丢弃(ADR 0012):推进比较项要推 head 分支,
  // 那一推会投一次 synchronized,受理它就是同一次推进跑两轮。也不走幂等 claim——
  // 幂等键留给真正由人发起的那一轮,让它仍然能重试。
  const containerBranch = containerBranchOf(payload);
  if (containerBranch !== undefined) {
    log(`${describeRepo(payload, repoId)} 的容器 PR 分支 ${containerBranch} — 不触发审查`);
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

  // 在 claim 之前完成唯一一次启动快照：坏覆盖或无法组装计划不该吃掉幂等键，修好后同一
  // head commit 仍能重试。返回后当前设置、服务与凭据切版只影响下一轮。
  let plan: ReviewRunPlan;
  try {
    plan = await buildRunPlan(deps, repoId);
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
  void startRun(deps, forge, event, plan);
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

// `access` 在 `PanelRoute` 上必填:新增端点时必须同时声明门禁。复合要求写明 anyOf/allOf。
// 角色存储的权限先统一展开为有效权限，路由声明只表达端点自身要求。
export type PanelAccess =
  | PanelPermission
  | "public"
  | "authenticated-only"
  | "system-admin-only"
  | { anyOf: readonly PanelPermission[] }
  | { allOf: readonly PanelPermission[] };
type PanelRouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  deps: WebhookServerDeps;
  auth: PanelAuth;
  hookManager: GiteaHookManager | undefined;
  bootstrapSecret: () => string | undefined;
  clearBootstrap: () => void;
  caller?: { username: string; isSystemAdmin: boolean; permissions: readonly PanelPermission[] };
  /** 账号可见的仓库。鉴权之后解析一次,读写接口共用,见 `repoScope`。 */
  scope?: RepoScope;
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
  /**
   * 这个端点的目标仓库从哪里认。声明了就在鉴权之后统一判仓库分配,分配外一律 404。
   * 目标从请求体里来的端点(重跑、发起范围审查)在 handler 里自己判:过滤层读不了
   * 请求体,读了 handler 就没得读。列表类端点也不声明,它们按分配收窄而不是拒绝。
   */
  scope?: PanelScopeTarget;
  handler: PanelRouteHandler;
};

/**
 * 账号可见的仓库(CONTEXT.md 仓库分配)。系统管理员不受限:`refs` 是 undefined,
 * 两个判定一律放行。
 */
type RepoScope = {
  /** 分配内的 owner/repo 对,列表接口据此收窄;不受限时 undefined。 */
  refs: readonly RepoRef[] | undefined;
  allowsId(repoId: number): boolean;
  allows(owner: string, repo: string): boolean;
};

/** 端点的目标仓库怎么认:路径里第 `group` 个捕获组是哪种标识,或者从查询串上认。 */
type PanelScopeTarget =
  | { by: "repo" | "run" | "range-review" | "finding"; group: number }
  | { by: "query" };

const UNRESTRICTED_SCOPE: RepoScope = {
  refs: undefined,
  allowsId: () => true,
  allows: () => true,
};

/**
 * 这个账号可见的仓库。`repoIds` 为 null 即系统管理员,不受限。
 *
 * 分配挂在 repo id 上,而评审记录只记 owner/repo:注册表是两者之间唯一的对照表,
 * 因此这里一次把两种形式都取好。仓库移除后它的历史评审记录不再可见——注册表里
 * 没有行,分配也随之级联删掉了。
 */
function repoScope(deps: WebhookServerDeps, repoIds: readonly number[] | null): RepoScope {
  if (repoIds === null) return UNRESTRICTED_SCOPE;
  const ids = new Set(repoIds);
  // 按 id 逐行取,不走 `listRepos`:那一份带着每个仓库的累计量,而这里只要名字。
  const refs = withStore(deps.dbPath, (store) =>
    repoIds.flatMap((repoId) => {
      const row = store.getRepo(repoId);
      return row === undefined ? [] : [{ owner: row.owner, repo: row.repo }];
    }),
  );
  return {
    refs,
    allowsId: (repoId) => ids.has(repoId),
    allows: (owner, repo) => refs.some((ref) => ref.owner === owner && ref.repo === repo),
  };
}

/**
 * 这个请求的目标是不是在分配内。目标本身不存在时放行:那一档由 handler 回它自己的
 * 404,过滤层不替它判「不存在」。
 */
function scopeAllowsTarget(
  deps: WebhookServerDeps,
  scope: RepoScope,
  target: PanelScopeTarget,
  req: IncomingMessage,
  match: RegExpMatchArray | undefined,
): boolean {
  if (scope.refs === undefined) return true;
  if (target.by === "query") {
    // 查询串上的两种目标形式:成对的 owner + repo,或者一个范围审查标识。
    const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
    const owner = query.get("owner");
    const repo = query.get("repo");
    if (owner !== null && repo !== null && !scope.allows(owner, repo)) return false;
    const rangeReviewRaw = query.get("rangeReviewId");
    if (rangeReviewRaw === null) return true;
    return rangeReviewAllowed(deps, scope, Number(rangeReviewRaw));
  }
  const id = Number(match![target.group]);
  if (target.by === "repo") return scope.allowsId(id);
  if (target.by === "range-review") return rangeReviewAllowed(deps, scope, id);
  return withStore(deps.dbPath, (store) => {
    const row = target.by === "run" ? store.getRunRange(id) : store.getFinding(id);
    return row === undefined || scope.allows(row.owner, row.repo);
  });
}

function rangeReviewAllowed(deps: WebhookServerDeps, scope: RepoScope, id: number): boolean {
  const record = withStore(deps.dbPath, (store) => store.getRangeReview(id));
  return record === undefined || scope.allows(record.owner, record.repo);
}

/** 分配外的目标与不存在同形:404 的措辞跟着 handler 自己那一句。 */
function scopeMissText(target: PanelScopeTarget, match: RegExpMatchArray | undefined): string {
  switch (target.by) {
    case "repo":
      return `没有 repo id 为 ${Number(match![target.group])} 的注册仓库`;
    case "run":
      return "没有这一轮 Review Run";
    case "range-review":
      return "没有这个范围审查";
    case "finding":
      return "没有这条 Finding";
    case "query":
      return "没有这个仓库";
  }
}

function panelPermissionGranted(
  access: PanelAccess,
  permissions: readonly PanelPermission[],
): boolean {
  if (typeof access === "string") {
    return isPanelPermission(access) && permissions.includes(access);
  }
  if ("anyOf" in access) {
    return access.anyOf.some((permission) => permissions.includes(permission));
  }
  return access.allOf.every((permission) => permissions.includes(permission));
}
/** 自定义模型服务名与删除路由共用的字符和长度边界。 */
const CUSTOM_PROVIDER_NAME = CUSTOM_PROVIDER_NAME_PATTERN;

function listRepos(res: ServerResponse, deps: WebhookServerDeps, scope: RepoScope): void {
  const rows = withStore(deps.dbPath, (store) => store.listRepos()).filter((row) =>
    scope.allowsId(row.repoId),
  );
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
    const storedPermissions =
      session.roleId === null
        ? []
        : (store.listPanelRoles().find((role) => role.id === session.roleId)?.permissions ?? []);
    const permissions = effectivePanelPermissions(storedPermissions);
    const users = store.listPanelUsers();
    const systemAdmins = users
      .filter((user) => user.isSystemAdmin)
      .map((user) => user.displayName ?? user.username);
    // 仓库分配挂在用户上;系统管理员不受限,对外就是 null。
    const repoIds = session.isSystemAdmin
      ? null
      : (users.find((user) => user.username === session.username)?.repoIds ?? []);
    return { ...session, permissions, systemAdmins, repoIds, hash, raw, renewed };
  });
}
/**
 * 请求体里的仓库分配。缺省与 null 都表示这次不改,数组是整组覆盖(空数组即清空);
 * 形状不对回 `"invalid"`,由调用方翻成 400。
 */
function parseRepoIds(value: unknown): number[] | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((repoId) => !Number.isSafeInteger(repoId))) {
    return "invalid";
  }
  return value as number[];
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
  const value = safeParse(body) as {
    username?: unknown;
    password?: unknown;
    displayName?: unknown;
    repoIds?: unknown;
  } | null;
  if (
    value === null ||
    typeof value.username !== "string" ||
    typeof value.password !== "string" ||
    !PANEL_USERNAME.test(value.username) ||
    (value.displayName !== undefined && typeof value.displayName !== "string")
  ) return sendJson(res, 400, { error: "用户名或密码形状不对" });
  const repoIds = parseRepoIds(value.repoIds);
  if (repoIds === "invalid") return sendJson(res, 400, { error: "repoIds 要是整型数组" });
  const displayName = value.displayName === undefined ? null : value.displayName;
  const password = value.password;
  const username = value.username;
  const existsInHistory = withStore(deps.dbPath, (store) => store.hasHistoricalRunTrigger(username));
  if (existsInHistory) return sendJson(res, 409, { error: "这个用户名在评审记录里出现过,换一个" });
  const passwordHash = await hashPassword(password);
  try {
    withStore(deps.dbPath, (store) => {
      store.createPanelUser({
        username,
        displayName,
        passwordHash,
        mustChangePassword: true,
        createdAt: new Date((deps.now ?? Date.now)()).toISOString(),
        isSystemAdmin: false,
        roleId: null,
      });
      if (repoIds !== null) store.setPanelUserRepos(username, repoIds);
    });
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
    repoIds?: unknown;
  } | null;
  if (
    value === null ||
    (value.displayName !== null && typeof value.displayName !== "string") ||
    (value.roleId !== null && typeof value.roleId !== "number") ||
    typeof value.isSystemAdmin !== "boolean"
  ) return sendJson(res, 400, { error: "用户更新形状不对" });
  const repoIds = parseRepoIds(value.repoIds);
  if (repoIds === "invalid") return sendJson(res, 400, { error: "repoIds 要是整型数组" });
  const displayName = value.displayName;
  const roleId = value.roleId;
  const isSystemAdmin = value.isSystemAdmin;
  const result = withStore(deps.dbPath, (store) => {
    const outcome = store.updatePanelUser(username, { displayName, roleId, isSystemAdmin });
    if (outcome === "updated" && repoIds !== null) store.setPanelUserRepos(username, repoIds);
    return outcome;
  });
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

export const PANEL_ROUTES: readonly PanelRoute[] = [
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
        repoIds: session.repoIds,
        mustChangePassword: session.mustChangePassword,
        // Forge 的 web 基址。处置只发生在 Forge 的 pull request 上,面板自己做不了;
        // 不给出这个值,面板就只能报出「还有多少条没处置」,而人点不过去。
        giteaUrl: deps.gitea === undefined ? null : deps.gitea.baseUrl.replace(/\/+$/, ""),
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
  {
    method: "GET",
    pattern: "/setup-status",
    access: "authenticated-only",
    handler: async ({ res, deps }) => sendJson(res, 200, await setupStatus(deps)),
  },
  { method: "GET", pattern: "/settings", access: "model:read", handler: ({ res, deps }) => handleGetSettings(res, deps) },
  { method: "PUT", pattern: "/settings", access: "model:write", handler: ({ req, res, deps }) => handlePutSettings(req, res, deps) },
  {
    method: "GET",
    pattern: "/stats",
    access: "authenticated-only",
    handler: ({ req, res, deps, scope }) => handleStats(req, res, deps, scope!),
  },
  {
    method: "GET",
    pattern: "/runs",
    access: "authenticated-only",
    handler: ({ req, res, deps, scope }) => handleRuns(req, res, deps, scope!),
  },
  {
    method: "GET",
    pattern: "/stages",
    access: "authenticated-only",
    handler: ({ req, res, deps, scope }) => handleStages(req, res, deps, scope!),
  },
  {
    // 阶段标识里有斜杠(`pr:<owner>/<repo>/<number>`),在地址里编码成一段,这里整段收。
    method: "GET",
    pattern: /^\/stages\/(.+)$/,
    access: "authenticated-only",
    handler: ({ res, deps, scope }, match) => handleStageDetail(res, deps, match![1]!, scope!),
  },
  {
    method: "GET",
    pattern: /^\/runs\/(\d+)$/,
    access: "authenticated-only",
    scope: { by: "run", group: 1 },
    handler: ({ res, deps }, match) => handleRun(res, deps, Number(match![1])),
  },
  {
    method: "GET",
    pattern: /^\/runs\/(\d+)\/diff$/,
    access: "authenticated-only",
    scope: { by: "run", group: 1 },
    handler: ({ req, res, deps }, match) => handleRunDiff(req, res, deps, Number(match![1])),
  },
  {
    method: "GET",
    pattern: /^\/runs\/(\d+)\/trace$/,
    access: "authenticated-only",
    scope: { by: "run", group: 1 },
    handler: ({ res, deps }, match) => handleRunTrace(res, deps, Number(match![1])),
  },
  {
    method: "GET",
    pattern: /^\/runs\/(\d+)\/trace\/stream$/,
    access: "authenticated-only",
    scope: { by: "run", group: 1 },
    handler: ({ req, res, deps }, match) => handleRunTraceStream(req, res, deps, Number(match![1])),
  },
  {
    method: "GET",
    pattern: "/stage-summary",
    access: "authenticated-only",
    scope: { by: "query" },
    handler: ({ req, res, deps }) => handleStageSummary(req, res, deps),
  },
  {
    method: "POST",
    pattern: "/rerun",
    access: "review:rerun",
    handler: ({ req, res, deps, caller, scope }) =>
      handleRerun(req, res, deps, caller!.username, scope!),
  },
  {
    method: "POST",
    pattern: /^\/findings\/(\d+)\/resolve$/,
    access: "finding:dispose",
    scope: { by: "finding", group: 1 },
    handler: ({ req, res, deps, caller }, match) =>
      handleDispose(req, res, deps, Number(match![1]), "resolved", caller!.username),
  },
  {
    method: "POST",
    pattern: /^\/findings\/(\d+)\/unresolve$/,
    access: "finding:dispose",
    scope: { by: "finding", group: 1 },
    handler: ({ req, res, deps, caller }, match) =>
      handleDispose(req, res, deps, Number(match![1]), "unresolved", caller!.username),
  },
  {
    method: "POST",
    pattern: "/range-reviews",
    access: "review:create",
    handler: ({ req, res, deps, caller, scope }) =>
      handleCreateRangeReview(req, res, deps, caller!.username, scope!),
  },
  {
    method: "GET",
    pattern: "/range-reviews/prefill",
    access: "review:create",
    scope: { by: "query" },
    handler: ({ req, res, deps }) => handleRangeReviewPrefill(req, res, deps),
  },
  {
    method: "POST",
    pattern: /^\/range-reviews\/(\d+)\/advance$/,
    access: "review:create",
    scope: { by: "range-review", group: 1 },
    handler: ({ req, res, deps, caller }, match) =>
      handleAdvanceRangeReview(req, res, deps, Number(match![1]), caller!.username),
  },
  {
    method: "POST",
    pattern: /^\/range-reviews\/(\d+)\/complete$/,
    access: "finding:dispose",
    scope: { by: "range-review", group: 1 },
    handler: ({ res, deps, caller }, match) =>
      handleCompleteRangeReview(res, deps, Number(match![1]), caller!.username),
  },
  {
    method: "GET",
    pattern: "/repo-branches",
    access: "review:create",
    scope: { by: "query" },
    handler: ({ req, res, deps }) => handleRepoBranches(req, res, deps),
  },
  {
    method: "GET",
    pattern: "/repo-commits",
    access: "review:create",
    scope: { by: "query" },
    handler: ({ req, res, deps }) => handleRepoCommits(req, res, deps),
  },
  {
    method: "GET",
    pattern: "/repos/search",
    access: "repo:write",
    handler: ({ req, res, deps, hookManager }) =>
      handleRepoSearch(req, res, deps, hookManager),
  },
  {
    method: "GET",
    pattern: "/repos",
    access: "authenticated-only",
    handler: ({ res, deps, scope }) => listRepos(res, deps, scope!),
  },
  {
    method: "POST",
    pattern: "/repos",
    access: "repo:write",
    handler: ({ req, res, deps, hookManager, caller }) =>
      handleRegister(req, res, deps, hookManager, caller!),
  },
  {
    method: "DELETE",
    pattern: /^\/repos\/(\d+)$/,
    access: "repo:write",
    scope: { by: "repo", group: 1 },
    handler: ({ res, deps, hookManager }, match) =>
      handleRemove(res, deps, hookManager, Number(match![1])),
  },
  {
    method: "POST",
    pattern: /^\/repos\/(\d+)\/worktree$/,
    access: "repo:write",
    scope: { by: "repo", group: 1 },
    handler: ({ res, deps }, match) => handlePrepareWorktree(res, deps, Number(match![1])),
  },
  {
    method: "PUT",
    pattern: /^\/repos\/(\d+)\/reviewers$/,
    access: "repo:write",
    scope: { by: "repo", group: 1 },
    handler: ({ req, res, deps }, match) =>
      handleSetReviewers(req, res, deps, Number(match![1])),
  },
  {
    method: "POST",
    pattern: /^\/repos\/(\d+)\/rotate$/,
    access: "repo:write",
    scope: { by: "repo", group: 1 },
    handler: ({ res, deps, hookManager }, match) =>
      handleRotate(res, deps, hookManager, Number(match![1])),
  },
  {
    method: "GET",
    pattern: /^\/repos\/(\d+)\/hooks$/,
    access: "authenticated-only",
    scope: { by: "repo", group: 1 },
    handler: ({ res, deps, hookManager }, match) =>
      handleHookCheck(res, deps, hookManager, Number(match![1])),
  },
  {
    method: "GET",
    pattern: "/model-services",
    access: { anyOf: ["model:read", "credential:read"] },
    handler: ({ res, deps, caller }) => handleListModelServices(res, deps, caller!),
  },
  {
    method: "GET",
    pattern: "/model-services/providers",
    access: {
      anyOf: ["model:read", "model:write", "credential:read", "credential:write"],
    },
    handler: ({ req, res, deps }) => handleBuiltinProviderSearch(req, res, deps),
  },
  {
    method: "POST",
    pattern: /^\/model-services\/builtin\/preview$/,
    access: "credential:write",
    handler: ({ req, res, deps }) => handlePreviewBuiltinModelService(req, res, deps),
  },
  {
    method: "POST",
    pattern: /^\/model-services\/builtin\/commit$/,
    access: "credential:write",
    handler: ({ req, res, deps }) => handleCommitBuiltinModelService(req, res, deps),
  },
  {
    method: "POST",
    pattern: /^\/model-services\/custom\/preview$/,
    access: { allOf: ["model:write", "credential:write"] },
    handler: ({ req, res, deps }) => handlePreviewCustomModelService(req, res, deps),
  },
  {
    method: "POST",
    pattern: /^\/model-services\/custom\/commit$/,
    access: { allOf: ["model:write", "credential:write"] },
    handler: ({ req, res, deps }) => handleCommitCustomModelService(req, res, deps),
  },
  {
    method: "DELETE",
    pattern: /^\/model-services\/custom\/([a-z0-9-]{1,64})$/,
    access: { allOf: ["model:write", "credential:write"] },
    handler: ({ req, res, deps }, match) =>
      handleDeleteCustomModelService(req, res, deps, match![1]!),
  },
  {
    method: "POST",
    pattern: /^\/model-services\/custom\/([a-z0-9-]{1,64})\/rename$/,
    access: { allOf: ["model:write", "credential:write"] },
    handler: ({ req, res, deps }, match) =>
      handleRenameConflictingCustomModelService(req, res, deps, match![1]!),
  },
  {
    method: "POST",
    pattern: /^\/model-services\/([A-Za-z0-9_-]+)\/reverify$/,
    access: "credential:write",
    handler: ({ req, res, deps }, match) =>
      handleReverifyModelService(req, res, deps, match![1]!),
  },
  {
    method: "DELETE",
    pattern: /^\/model-services\/([A-Za-z0-9_-]+)\/credential$/,
    access: "credential:write",
    handler: ({ req, res, deps }, match) =>
      handleDeleteModelServiceCredential(req, res, deps, match![1]!),
  },
  {
    method: "POST",
    pattern: /^\/model-services\/([A-Za-z0-9_-]+)\/refresh$/,
    access: "model:write",
    handler: ({ req, res, deps }, match) =>
      handleRefreshModelService(req, res, deps, match![1]!),
  },
  {
    method: "PUT",
    pattern: /^\/model-services\/([A-Za-z0-9_-]+)\/model-states$/,
    access: "model:write",
    handler: ({ req, res, deps }, match) =>
      handleUpdateModelServiceModelStates(req, res, deps, match![1]!),
  },
  {
    method: "POST",
    pattern: /^\/model-services\/([A-Za-z0-9_-]+)\/supplements$/,
    access: "model:write",
    handler: ({ req, res, deps }, match) =>
      handleAddModelSupplement(req, res, deps, match![1]!),
  },
  {
    method: "DELETE",
    pattern: /^\/model-services\/([A-Za-z0-9_-]+)\/supplements$/,
    access: "model:write",
    handler: ({ req, res, deps }, match) =>
      handleDeleteModelSupplement(req, res, deps, match![1]!),
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
    !panelPermissionGranted(matched.route.access, session.permissions)
  ) {
    return sendJson(res, 403, { error: "没有这一格权限" });
  }
  // 权限格在前、仓库分配在后:没有这一格的人对每个仓库都是 403,先判它不泄露任何
  // 「这个仓库存在」的信息;有这一格的人才会看到分配决定的 404。
  const scope = repoScope(deps, session.repoIds);
  const target = matched.route.scope;
  if (target !== undefined && !scopeAllowsTarget(deps, scope, target, req, matched.match)) {
    return sendJson(res, 404, { error: scopeMissText(target, matched.match) });
  }
  return matched.route.handler(
    {
      ...context,
      scope,
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
 * 审查策略:模型组合与批次上限。仓库详情用它展示「跟随全局」跟的是什么。
 * 批次上限没配时回默认值,读回来的就是这次审查真会用的那个数。
 */
function handleGetSettings(res: ServerResponse, deps: WebhookServerDeps): void {
  const settings = globalSettings(deps);
  return sendJson(res, 200, {
    reviewers: settings.reviewers,
    reviewersVersion: settings.reviewersVersion,
    maxChangedLinesPerBatch:
      settings.maxChangedLinesPerBatch ?? DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
    maxChangedLinesPerBatchSource:
      settings.maxChangedLinesPerBatch === null ? "default" : "custom",
    maxChangedLinesPerBatchVersion: settings.maxChangedLinesPerBatchVersion,
  });
}

/**
 * 全局模型组合与批次上限各自独立写入并带自己的 expected version。
 */
async function handlePutSettings(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const decoded = safeParse(body);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    return sendJson(res, 400, { error: "body 要是 JSON 对象" });
  }
  const payload = decoded as {
    reviewers?: unknown;
    maxChangedLinesPerBatch?: unknown;
    expectedVersion?: unknown;
  };
  const hasReviewers = Object.hasOwn(payload, "reviewers");
  const hasLimit = Object.hasOwn(payload, "maxChangedLinesPerBatch");
  if (hasReviewers === hasLimit) {
    return sendJson(res, 400, {
      error: "body 必须且只能修改 reviewers 或 maxChangedLinesPerBatch 一项",
    });
  }
  if (
    typeof payload.expectedVersion !== "number" ||
    !Number.isInteger(payload.expectedVersion) ||
    payload.expectedVersion < 1
  ) {
    return sendJson(res, 400, { error: "expectedVersion 要是正整数" });
  }

  let reviewersJson: string | undefined;
  let reviewers: ReviewerSpec[] | undefined;
  if (hasReviewers) {
    const parsed = parseReviewerSpecs(payload.reviewers, GLOBAL_REVIEWERS_CONTEXT);
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
    reviewersJson = parsed.reviewersJson;
    reviewers = parsed.reviewers;
    if (!await ensureModelCombinationAvailable(res, deps, reviewers, GLOBAL_REVIEWERS_CONTEXT)) {
      return;
    }
  }

  let limit: number | null | undefined;
  if (hasLimit) {
    const candidate = payload.maxChangedLinesPerBatch;
    if (
      candidate !== null &&
      (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate <= 0)
    ) {
      return sendJson(res, 400, {
        error: "maxChangedLinesPerBatch 要是正整数，null 即取默认值",
      });
    }
    limit = candidate;
  }

  const saved = withStore(deps.dbPath, (store) =>
    reviewersJson !== undefined
      ? store.putGlobalReviewers(payload.expectedVersion as number, reviewersJson)
      : store.putGlobalBatchLimit(payload.expectedVersion as number, limit ?? null)
  );
  if (!saved) {
    return sendJson(res, 409, { error: "这项审查策略已经被其他人修改，请重新加载后再保存" });
  }
  return handleGetSettings(res, deps);
}

/**
 * 缺主密钥时凭据端点整体不可用:读写都 503 并说明差什么(ADR 0008)。服务本身照常
 * 启动——起不来就进不了面板,进不了面板就配不了凭据。
 */
const MASTER_KEY_MISSING =
  `没有设置环境变量 ${CREDENTIAL_MASTER_KEY_ENV},凭据加密不了也解不开。` +
  "在 .env 里补上它并重启服务。";

type PanelCaller = NonNullable<PanelRouteContext["caller"]>;
type ModelReadSource = "automatic" | ModelSupplementSource;

type ModelUnavailableReason =
  | "provider-name-conflict"
  | "credential-unavailable"
  | "model-source-missing"
  | "model-disabled";

const MODEL_UNAVAILABLE_REASON_TEXT: Record<ModelUnavailableReason, string> = {
  "provider-name-conflict": "provider 名字冲突，已停用",
  "credential-unavailable": "模型凭据不可用",
  "model-source-missing": "模型来源消失",
  "model-disabled": "模型已停用",
};

const BASELINE_RUNTIME_PROJECTION = {
  input: MODEL_RUNTIME_BASELINE.input,
  reasoning: MODEL_RUNTIME_BASELINE.reasoning,
  contextWindow: MODEL_RUNTIME_BASELINE.contextWindow,
  maxOutput: MODEL_RUNTIME_BASELINE.maxTokens,
  sources: {
    input: "runtime-baseline",
    reasoning: "runtime-baseline",
    contextWindow: "runtime-baseline",
    maxOutput: "runtime-baseline",
  },
} as const;

type ProjectedServiceModel = {
  provider: string;
  id: string;
  identity: string;
  enabled: boolean;
  sources: readonly ModelReadSource[];
  available: boolean;
  unavailableReason: ModelUnavailableReason | null;
  unavailableReasonText: string | null;
  unavailableAction: "/credentials" | null;
  discovery: {
    name: string | null;
    api: string | null;
    baseUrl: string | null;
    input: readonly ("text" | "image")[] | null;
    reasoning: boolean | null;
    contextWindow: number | null;
    maxOutput: number | null;
    sources: {
      name: TrustedModelFieldSource | null;
      api: TrustedModelFieldSource | null;
      baseUrl: TrustedModelFieldSource | null;
      input: TrustedModelFieldSource | null;
      reasoning: TrustedModelFieldSource | null;
      contextWindow: TrustedModelFieldSource | null;
      maxOutput: TrustedModelFieldSource | null;
    };
  };
  runtime: {
    input: readonly ("text" | "image")[];
    reasoning: boolean;
    contextWindow: number;
    maxOutput: number;
    sources: {
      input: TrustedModelFieldSource | "runtime-baseline";
      reasoning: TrustedModelFieldSource | "runtime-baseline";
      contextWindow: TrustedModelFieldSource | "runtime-baseline";
      maxOutput: TrustedModelFieldSource | "runtime-baseline";
    };
  };
};

type ModelServiceNextAction =
  | "recover-service"
  | "configure-credential"
  | "add-model-source"
  | "enable-model";

function isHiddenEmptyBuiltinService(
  service: ModelServiceRecord,
  references: readonly ModelReference[],
): boolean {
  return service.type === "builtin" &&
    service.credential.state === "unconfigured" &&
    service.automaticModels.length === 0 &&
    service.supplements.length === 0 &&
    !references.some((reference) => reference.provider === service.provider);
}

function modelRuntimeProjection(
  result: RuntimeSynthesisResult | undefined,
  sources?: ProjectedServiceModel["discovery"]["sources"],
) {
  if (result === undefined || !result.ok) return BASELINE_RUNTIME_PROJECTION;
  const runtime = result.value.runtime;
  return {
    input: runtime.input,
    reasoning: runtime.reasoning,
    contextWindow: runtime.contextWindow,
    maxOutput: runtime.maxTokens,
    sources: {
      input: runtime.sources.input === "trusted" ? sources?.input ?? "service-interface" : runtime.sources.input,
      reasoning: runtime.sources.reasoning === "trusted"
        ? sources?.reasoning ?? "service-interface"
        : runtime.sources.reasoning,
      contextWindow: runtime.sources.contextWindow === "trusted"
        ? sources?.contextWindow ?? "service-interface"
        : runtime.sources.contextWindow,
      maxOutput: runtime.sources.maxTokens === "trusted"
        ? sources?.maxOutput ?? "service-interface"
        : runtime.sources.maxTokens,
    },
  };
}

function modelDiscoverySources(
  service: ModelServiceRecord,
  automatic: ModelServiceRecord["automaticModels"][number] | undefined,
  serviceTarget: PiBuiltinProviderTarget | undefined,
): ProjectedServiceModel["discovery"]["sources"] {
  const inferred = (field: keyof DiscoveredModel["fields"]): TrustedModelFieldSource | null => {
    if (automatic?.fields[field] === undefined) return null;
    return automatic.fieldSources?.[field] ??
      (service.type === "builtin" ? "pi-catalog" : "service-interface");
  };
  return {
    name: inferred("name"),
    api: serviceTarget === undefined ? null : "service-target",
    baseUrl: serviceTarget === undefined ? null : "service-target",
    input: inferred("input"),
    reasoning: inferred("reasoning"),
    contextWindow: inferred("contextWindow"),
    maxOutput: inferred("maxTokens"),
  };
}

function modelAvailabilityProjection(
  unavailableReason: ModelUnavailableReason | null,
): Pick<
  ProjectedServiceModel,
  "available" | "unavailableReason" | "unavailableReasonText" | "unavailableAction"
> {
  return {
    available: unavailableReason === null,
    unavailableReason,
    unavailableReasonText:
      unavailableReason === null ? null : MODEL_UNAVAILABLE_REASON_TEXT[unavailableReason],
    unavailableAction: unavailableReason === null ? null : "/credentials" as const,
  };
}

function projectServiceModel(
  service: ModelServiceRecord,
  id: string,
  sources: readonly ModelReadSource[],
  automatic: ModelServiceRecord["automaticModels"][number] | undefined,
  supplement: ModelServiceRecord["supplements"][number] | undefined,
  serviceTarget: PiBuiltinProviderTarget | undefined,
  credentialState: ModelServiceRecord["credential"]["state"],
  enabled: boolean,
): ProjectedServiceModel {
  const discovery = automatic?.fields ?? {};
  const discoverySources = modelDiscoverySources(service, automatic, serviceTarget);
  let synthesis: RuntimeSynthesisResult | undefined;
  if (service.type === "builtin" && serviceTarget !== undefined) {
    synthesis = synthesizeRuntimeModel(
      { kind: "builtin", provider: service.provider, credential: "" },
      {
        identity: modelIdentity({ provider: service.provider, model: id }),
        provider: service.provider,
        id,
        fields: discovery,
      },
      serviceTarget,
    );
  } else if (
    service.type === "custom" &&
    serviceTarget !== undefined &&
    CUSTOM_PROVIDER_APIS.includes(serviceTarget.api as (typeof CUSTOM_PROVIDER_APIS)[number])
  ) {
    synthesis = synthesizeRuntimeModel(
      {
        kind: "openai-compatible",
        provider: service.provider,
        baseUrl: serviceTarget.baseUrl,
        api: serviceTarget.api as (typeof CUSTOM_PROVIDER_APIS)[number],
        credential: "",
      },
      {
        identity: modelIdentity({ provider: service.provider, model: id }),
        provider: service.provider,
        id,
        fields: discovery,
      },
    );
  }

  const currentTargetFingerprint =
    serviceTarget === undefined
      ? undefined
      : modelServiceTargetFingerprint(serviceTarget.baseUrl, serviceTarget.api);
  const targetMatchesCommittedVersion =
    currentTargetFingerprint !== undefined &&
    service.targetFingerprint === currentTargetFingerprint;
  const hasCurrentSource =
    targetMatchesCommittedVersion &&
    (automatic !== undefined ||
      supplement?.source === "migration-retention" ||
      (supplement?.source === "manual" &&
        supplement.targetFingerprint === currentTargetFingerprint));
  const unavailableReason: ModelUnavailableReason | null =
    service.disabledReason === "name-conflict"
      ? "provider-name-conflict"
      : credentialState !== "verified"
        ? "credential-unavailable"
        : !hasCurrentSource || synthesis?.ok !== true
          ? "model-source-missing"
          : enabled ? null : "model-disabled";
  return {
    provider: service.provider,
    id,
    identity: modelIdentity({ provider: service.provider, model: id }),
    enabled,
    sources,
    ...modelAvailabilityProjection(unavailableReason),
    discovery: {
      name: discovery.name ?? null,
      api: serviceTarget?.api ?? null,
      baseUrl: serviceTarget?.baseUrl ?? null,
      input: discovery.input ?? null,
      reasoning: discovery.reasoning ?? null,
      contextWindow: discovery.contextWindow ?? null,
      maxOutput: discovery.maxTokens ?? null,
      sources: discoverySources,
    },
    runtime: modelRuntimeProjection(synthesis, discoverySources),
  };
}


function projectMissingServiceModel(spec: ReviewerSpec): ProjectedServiceModel {
  return {
    provider: spec.provider,
    id: spec.model,
    identity: modelIdentity(spec),
    enabled: false,
    sources: [],
    ...modelAvailabilityProjection("model-source-missing"),
    discovery: {
      name: null,
      api: null,
      baseUrl: null,
      input: null,
      reasoning: null,
      contextWindow: null,
      maxOutput: null,
      sources: {
        name: null,
        api: null,
        baseUrl: null,
        input: null,
        reasoning: null,
        contextWindow: null,
        maxOutput: null,
      },
    },
    runtime: BASELINE_RUNTIME_PROJECTION,
  };
}

async function projectCurrentModelServices(
  deps: WebhookServerDeps,
  retainedSpecs: readonly ReviewerSpec[] = [],
  includeModels = true,
) {
  const { services, supplements, references, states } = withStore(deps.dbPath, (store) => ({
    services: store.listModelServices(),
    supplements: store.listModelSupplements(),
    references: store.listModelReferences(),
    states: store.listModelServiceModelStates(),
  }));
  const retainedByIdentity = new Map<string, ReviewerSpec>();
  const retainedByProvider = new Map<string, ReviewerSpec[]>();
  const retain = (spec: ReviewerSpec): void => {
    const identity = modelIdentity(spec);
    if (retainedByIdentity.has(identity)) return;
    retainedByIdentity.set(identity, spec);
    const providerSpecs = retainedByProvider.get(spec.provider) ?? [];
    providerSpecs.push(spec);
    retainedByProvider.set(spec.provider, providerSpecs);
  };
  for (const reference of references) retain(reference);
  for (const spec of retainedSpecs) retain(spec);

  const conflicting = await conflictingBuiltinProviderNames(
    services.filter((service) => service.type === "custom").map((service) => service.provider),
  );
  const supplementByProvider = new Map<string, ModelServiceRecord["supplements"]>();
  for (const supplement of supplements) {
    const current = supplementByProvider.get(supplement.provider) ?? [];
    current.push(supplement);
    supplementByProvider.set(supplement.provider, current);
  }
  const stateByIdentity = new Map(
    states.map((state) => [modelIdentity({ provider: state.provider, model: state.model }), state.enabled]),
  );

  const projected = await Promise.all(services.map(async (stored) => {
    const service = {
      ...stored,
      disabledReason:
        stored.type === "custom"
          ? conflicting.has(stored.provider) ? "name-conflict" as const : null
          : stored.disabledReason,
      supplements: supplementByProvider.get(stored.provider) ?? [],
    };
    const serviceTarget: PiBuiltinProviderTarget | undefined =
      service.type === "builtin"
        ? await resolvePiBuiltinProviderTarget(service.provider)
        : service.baseUrl !== null &&
            service.api !== null &&
            CUSTOM_PROVIDER_APIS.includes(service.api as (typeof CUSTOM_PROVIDER_APIS)[number])
          ? { baseUrl: service.baseUrl, api: service.api }
          : undefined;
    const currentTargetFingerprint = serviceTarget === undefined
      ? undefined
      : modelServiceTargetFingerprint(serviceTarget.baseUrl, serviceTarget.api);
    const targetMatchesCommittedVersion =
      currentTargetFingerprint !== undefined &&
      service.targetFingerprint === currentTargetFingerprint;
    const masterKey = deps.credentialMasterKey;
    const plaintext =
      !targetMatchesCommittedVersion ||
      masterKey === undefined ||
      masterKey === "" ||
      service.credential.apiKeyEncrypted === null
        ? undefined
        : decryptCredential(masterKey, service.credential.apiKeyEncrypted);
    const credentialState = service.credential.state === "unconfigured"
      ? "unconfigured" as const
      : !targetMatchesCommittedVersion
        ? "pending-reverification" as const
        : service.credential.state === "verified" && plaintext === undefined
          ? "unconfigured" as const
          : service.credential.state;
    const health =
      service.disabledReason === "name-conflict"
        ? "disabled" as const
        : credentialState !== "verified" || service.directory.state !== "available"
          ? "attention" as const
          : "healthy" as const;

    const automaticById = new Map(service.automaticModels.map((model) => [model.id, model]));
    const supplementById = new Map(service.supplements.map((entry) => [entry.model, entry]));
    const sourceById = new Map<string, ModelReadSource[]>();
    for (const model of service.automaticModels) sourceById.set(model.id, ["automatic"]);
    for (const supplement of service.supplements) {
      const sources = sourceById.get(supplement.model) ?? [];
      if (!sources.includes(supplement.source)) sources.push(supplement.source);
      sourceById.set(supplement.model, sources);
    }
    for (const retained of retainedByProvider.get(service.provider) ?? []) {
      if (!sourceById.has(retained.model)) sourceById.set(retained.model, []);
    }
    const models = [...sourceById.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, sources]) =>
        projectServiceModel(
          service,
          id,
          sources,
          automaticById.get(id),
          supplementById.get(id),
          serviceTarget,
          credentialState,
          stateByIdentity.get(modelIdentity({ provider: service.provider, model: id })) ?? true,
        ),
      );
    const target = service.type === "custom"
      ? { baseUrl: service.baseUrl, api: service.api }
      : { baseUrl: serviceTarget?.baseUrl ?? null, api: serviceTarget?.api ?? null };
    const runnable = models.some((model) => model.available);
    const reason: ModelUnavailableReason | null = runnable
      ? null
      : service.disabledReason === "name-conflict"
        ? "provider-name-conflict"
        : credentialState !== "verified"
          ? "credential-unavailable"
          : models.some((model) => model.unavailableReason === "model-disabled")
            ? "model-disabled"
            : "model-source-missing";
    const nextAction: ModelServiceNextAction | null =
      reason === "provider-name-conflict"
        ? "recover-service"
        : reason === "credential-unavailable"
          ? "configure-credential"
          : reason === "model-source-missing"
          ? "add-model-source"
          : reason === "model-disabled"
            ? "enable-model"
          : null;
    return {
      provider: service.provider,
      name: service.provider,
      type: service.type,
      version: service.version,
      health,
      hidden: isHiddenEmptyBuiltinService(service, references),
      providerState: service.disabledReason === "name-conflict" ? "name-conflict" as const : "normal" as const,
      runCapability: {
        runnable,
        reason,
        reasonText: reason === null ? null : MODEL_UNAVAILABLE_REASON_TEXT[reason],
        nextAction,
      },
      references: references.filter((reference) => reference.provider === service.provider),
      target,
      credential: {
        state: credentialState,
        last4: plaintext === undefined ? null : credentialTail(plaintext),
        updatedAt: service.credential.updatedAt,
        verifiedAt: service.credential.verifiedAt,
        validationModel: service.credential.validationModel,
        verificationSource: service.credential.verificationSource,
      },
      directory: service.directory,
      models,
    };
  })).then((entries) => entries.filter((service) => !service.hidden));

  const candidateByIdentity = new Map<string, ProjectedServiceModel>();
  if (includeModels) {
    for (const service of projected) {
      for (const model of service.models ?? []) {
        if (model.available || retainedByIdentity.has(model.identity)) {
          candidateByIdentity.set(model.identity, model);
        }
      }
    }
    for (const spec of retainedByIdentity.values()) {
      const identity = modelIdentity(spec);
      if (!candidateByIdentity.has(identity)) {
        candidateByIdentity.set(identity, projectMissingServiceModel(spec));
      }
    }
  }
  return {
    services: projected,
    candidates: [...candidateByIdentity.values()].sort((left, right) =>
      left.identity.localeCompare(right.identity),
    ),
  };
}

async function ensureModelCombinationAvailable(
  res: ServerResponse,
  deps: WebhookServerDeps,
  specs: readonly ReviewerSpec[],
  context: string,
): Promise<boolean> {
  const projection = await projectCurrentModelServices(deps, specs);
  const candidateByIdentity = new Map(
    projection.candidates.map((candidate) => [candidate.identity, candidate]),
  );
  const unavailable: {
    identity: string;
    reason: ModelUnavailableReason;
    reasonText: string;
    action: "/credentials";
  }[] = [];
  for (const spec of specs) {
    const identity = modelIdentity(spec);
    const candidate = candidateByIdentity.get(identity);
    if (candidate?.available === true) continue;
    const reason = candidate?.unavailableReason ?? "model-source-missing";
    unavailable.push({
      identity,
      reason,
      reasonText: candidate?.unavailableReasonText ?? MODEL_UNAVAILABLE_REASON_TEXT[reason],
      action: candidate?.unavailableAction ?? "/credentials",
    });
  }
  if (unavailable.length === 0) return true;
  sendJson(res, 400, {
    error: `${context}包含不可用模型：${unavailable
      .map((entry) => `${entry.identity}（${entry.reasonText}）`)
      .join("；")}。请先到模型服务恢复，或从组合中移除。`,
    unavailable,
  });
  return false;
}

async function setupStatus(deps: WebhookServerDeps): Promise<{
  hasRunnableModelService: boolean;
  reviewConfigurationReady: boolean;
  hasRepository: boolean;
  instanceEnabled: boolean;
}> {
  const settings = globalSettings(deps);
  const projection = await projectCurrentModelServices(deps, settings.reviewers);
  const availableByIdentity = new Map(
    projection.candidates.map((candidate) => [candidate.identity, candidate.available]),
  );
  const hasRunnableModelService = projection.services.some(
    (service) => service.runCapability.runnable,
  );
  const reviewConfigurationReady =
    settings.reviewers.length > 0 &&
    settings.reviewers.every(
      (reviewer) => availableByIdentity.get(modelIdentity(reviewer)) === true,
    );
  const hasRepository = withStore(deps.dbPath, (store) => store.listRepos().length > 0);
  return {
    hasRunnableModelService,
    reviewConfigurationReady,
    hasRepository,
    instanceEnabled: reviewConfigurationReady && hasRepository,
  };
}

async function handleListModelServices(
  res: ServerResponse,
  deps: WebhookServerDeps,
  caller: PanelCaller,
): Promise<void> {
  const canReadModels =
    caller.isSystemAdmin || caller.permissions.includes("model:read");
  const canReadCredential =
    caller.isSystemAdmin || caller.permissions.includes("credential:read");
  const projection = await projectCurrentModelServices(deps, [], canReadModels);
  const services = projection.services.map((service) => {
    const common = {
      provider: service.provider,
      name: service.name,
      type: service.type,
      version: service.version,
      health: service.health,
      runCapability: service.runCapability,
    };
    const credential = canReadCredential
      ? service.credential
      : { state: service.credential.state };
    if (!canReadModels) return { ...common, credential };
    return {
      ...common,
      providerState: service.providerState,
      target: service.target ?? { baseUrl: null, api: null },
      credential,
      directory: service.directory,
      references: service.references,
      models: service.models ?? [],
    };
  });
  return sendJson(
    res,
    200,
    canReadModels ? { services, candidates: projection.candidates } : { services },
  );
}

async function handleBuiltinProviderSearch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
): Promise<void> {
  const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "")
    .get("query")
    ?.trim()
    .toLowerCase() ?? "";
  const configured = new Map(
    withStore(deps.dbPath, (store) => {
      const references = store.listModelReferences();
      return store.listModelServices().map((service) => [
        service.provider,
        {
          service,
          visible: !isHiddenEmptyBuiltinService(service, references),
        },
      ] as const);
    }),
  );
  const providers = (await listPiBuiltinProviders())
    .filter(
      (provider) =>
        query === "" ||
        provider.id.toLowerCase().includes(query) ||
        provider.name.toLowerCase().includes(query),
    )
    .map((provider) => {
      const entry = configured.get(provider.id);
      const service = entry?.service;
      return {
        id: provider.id,
        name: provider.name,
        configured: entry?.visible === true,
        version: service?.version ?? null,
        conflict:
          service?.type === "custom" || service?.disabledReason === "name-conflict",
      };
    });
  return sendJson(res, 200, { providers });
}

async function handlePreviewBuiltinModelService(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = safeParse(body) as {
    provider?: unknown;
    credential?: unknown;
    expectedVersion?: unknown;
  } | null;
  if (
    payload === null ||
    typeof payload.provider !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(payload.provider) ||
    typeof payload.credential !== "string" ||
    payload.credential.length === 0 ||
    !(payload.expectedVersion === null ||
      (Number.isInteger(payload.expectedVersion) && Number(payload.expectedVersion) > 0))
  ) {
    return sendJson(res, 400, { error: "内置模型服务候选形状不对" });
  }
  const provider = payload.provider;
  const expectedVersion = payload.expectedVersion as number | null;
  const current = withStore(deps.dbPath, (store) => store.getModelService(provider));
  if (current !== undefined && current.type !== "builtin") {
    return sendJson(res, 409, { error: `${provider} 已被同名自定义模型服务占用` });
  }
  const actualVersion = current?.version ?? null;
  if (actualVersion !== expectedVersion) {
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新打开配置",
      expectedVersion,
      actualVersion,
    });
  }
  const target = await resolvePiBuiltinProviderTarget(provider);
  if (target === undefined) {
    return sendJson(res, 400, { error: `Pi 没有内置 provider ${provider}` });
  }
  const catalogStorePath = modelCatalogStorePath(deps.cacheDir);
  const discovered = await (deps.discoverModelServiceModels ?? discoverModels)(
    { kind: "builtin", provider, credential: payload.credential },
    { allowNetwork: true, ...(catalogStorePath === undefined ? {} : { catalogStorePath }) },
  );
  if (!discovered.ok) {
    return sendCandidateFailure(res, discovered.failure, [payload.credential], "discovery");
  }
  return sendJson(res, 200, {
    provider,
    expectedVersion,
    target,
    models: discovered.models,
    ignoredModelCount: discovered.ignoredCount,
  });
}

async function commitVerifiedBuiltinModelService(
  res: ServerResponse,
  deps: WebhookServerDeps,
  input: {
    provider: string;
    credential: string;
    credentialUpdatedAt?: string;
    validationModel: string;
    expectedVersion: number | null;
  },
): Promise<void> {
  const masterKey = deps.credentialMasterKey;
  if (masterKey === undefined || masterKey === "") {
    return sendJson(res, 503, { error: MASTER_KEY_MISSING });
  }
  const current = withStore(deps.dbPath, (store) => store.getModelService(input.provider));
  if (current !== undefined && current.type !== "builtin") {
    return sendJson(res, 409, { error: `${input.provider} 已被同名自定义模型服务占用` });
  }
  const actualVersion = current?.version ?? null;
  if (actualVersion !== input.expectedVersion) {
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新打开配置",
      expectedVersion: input.expectedVersion,
      actualVersion,
    });
  }
  const target = await resolvePiBuiltinProviderTarget(input.provider);
  if (target === undefined) {
    return sendJson(res, 400, { error: `Pi 没有内置 provider ${input.provider}` });
  }
  const candidate = {
    kind: "builtin" as const,
    provider: input.provider,
    credential: input.credential,
  };
  const catalogStorePath = modelCatalogStorePath(deps.cacheDir);
  const discovered = await (deps.discoverModelServiceModels ?? discoverModels)(candidate, {
    allowNetwork: true,
    ...(catalogStorePath === undefined ? {} : { catalogStorePath }),
  });
  const validationDiscovery = discovered.ok
    ? discovered.models.find((model) => model.id === input.validationModel)
    : undefined;
  const validation = await validateMinimalInference(
    candidate,
    validationDiscovery ?? input.validationModel,
  );
  if (!validation.ok) {
    return sendCandidateFailure(res, validation.failure, [input.credential, masterKey], "validation");
  }

  const committedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const targetFingerprint = modelServiceTargetFingerprint(target.baseUrl, target.api);
  const needsValidationSupplement = !discovered.ok || validationDiscovery === undefined;
  const supplements = (current?.supplements ?? []).map((entry) => ({
    model: entry.model,
    source: entry.source,
    targetFingerprint: entry.targetFingerprint,
    createdAt: entry.createdAt,
  }));
  if (needsValidationSupplement) {
    const supplement = {
      model: input.validationModel,
      source: "manual" as const,
      targetFingerprint,
      createdAt:
        supplements.find((entry) => entry.model === input.validationModel)?.createdAt ?? committedAt,
    };
    const index = supplements.findIndex((entry) => entry.model === input.validationModel);
    if (index === -1) supplements.push(supplement);
    else supplements[index] = supplement;
  }

  let directory: ModelServiceVersionCommit["directory"];
  if (!discovered.ok) {
    const lastSuccessAt = current?.directory.lastSuccessAt ?? null;
    directory = {
      state: lastSuccessAt === null ? "discovery-failed" : "refresh-failed",
      lastAttemptAt: committedAt,
      lastSuccessAt,
      failure: discovered.failure.message,
      ignoredModelCount: 0,
    };
  } else if (validationDiscovery === undefined) {
    directory = {
      state: "discovery-failed",
      lastAttemptAt: committedAt,
      lastSuccessAt: null,
      failure: `最终目录里已没有验证模型 ${input.validationModel}；真实推理成功后已补录该模型`,
      ignoredModelCount: discovered.ignoredCount,
    };
  } else {
    directory = {
      state: "available",
      lastAttemptAt: committedAt,
      lastSuccessAt: committedAt,
      failure: null,
      ignoredModelCount: discovered.ignoredCount,
    };
  }
  const record: ModelServiceVersionCommit = {
    provider: input.provider,
    type: "builtin",
    baseUrl: null,
    api: null,
    targetFingerprint,
    disabledReason: null,
    createdAt: current?.createdAt ?? committedAt,
    updatedAt: committedAt,
    credential: {
      state: "verified",
      apiKeyEncrypted: encryptCredential(masterKey, input.credential),
      updatedAt: input.credentialUpdatedAt ?? committedAt,
      verifiedAt: committedAt,
      validationModel: modelIdentity({ provider: input.provider, model: input.validationModel }),
      verificationSource: "inference",
    },
    directory,
    automaticModels: discovered.ok ? discovered.models : (current?.automaticModels ?? []),
    supplements,
  };
  const version = withStore(deps.dbPath, (store) =>
    store.commitModelServiceVersion(input.expectedVersion, record),
  );
  if (version === undefined) {
    const latestVersion = withStore(deps.dbPath, (store) =>
      store.getModelService(input.provider)?.version ?? null,
    );
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新打开配置",
      expectedVersion: input.expectedVersion,
      actualVersion: latestVersion,
    });
  }
  return sendJson(res, 200, {
    provider: input.provider,
    version,
    credential: { state: "verified" },
    directory: { state: directory.state },
  });
}

async function handleCommitBuiltinModelService(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = safeParse(body) as {
    provider?: unknown;
    credential?: unknown;
    validationModel?: unknown;
    expectedVersion?: unknown;
  } | null;
  if (
    payload === null ||
    typeof payload.provider !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(payload.provider) ||
    typeof payload.credential !== "string" ||
    payload.credential.length === 0 ||
    typeof payload.validationModel !== "string" ||
    payload.validationModel.length === 0 ||
    payload.validationModel !== payload.validationModel.trim() ||
    !(payload.expectedVersion === null ||
      (Number.isInteger(payload.expectedVersion) && Number(payload.expectedVersion) > 0))
  ) {
    return sendJson(res, 400, { error: "内置模型服务最终候选形状不对" });
  }
  return commitVerifiedBuiltinModelService(res, deps, {
    provider: payload.provider,
    credential: payload.credential,
    validationModel: payload.validationModel,
    expectedVersion: payload.expectedVersion as number | null,
  });
}

async function handleReverifyModelService(
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
  const payload = safeParse(body) as {
    validationModel?: unknown;
    expectedVersion?: unknown;
  } | null;
  if (
    payload === null ||
    typeof payload.validationModel !== "string" ||
    payload.validationModel.length === 0 ||
    payload.validationModel !== payload.validationModel.trim() ||
    !Number.isInteger(payload.expectedVersion) ||
    Number(payload.expectedVersion) <= 0
  ) {
    return sendJson(res, 400, { error: "模型服务重验参数形状不对" });
  }
  const validationModel = payload.validationModel;
  const expectedVersion = Number(payload.expectedVersion);
  const current = withStore(deps.dbPath, (store) => store.getModelService(provider));
  if (current === undefined) {
    return sendJson(res, 404, { error: `没有模型服务 ${provider}` });
  }
  if (current.version !== expectedVersion) {
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新打开配置",
      expectedVersion,
      actualVersion: current.version,
    });
  }

  let candidate: ModelServiceCandidate;
  let targetFingerprint: string;
  if (current.type === "builtin") {
    const target = await resolvePiBuiltinProviderTarget(provider);
    if (target === undefined) {
      return sendJson(res, 409, { error: `Pi 已没有内置 provider ${provider}` });
    }
    targetFingerprint = modelServiceTargetFingerprint(target.baseUrl, target.api);
    if (current.targetFingerprint !== targetFingerprint) {
      return sendJson(res, 409, { error: "Pi 内置目标已经变化，请粘贴凭据重新配置" });
    }
  } else {
    if ((await conflictingBuiltinProviderNames([provider])).has(provider)) {
      return sendJson(res, 409, { error: `${provider} 与当前 Pi 内置 provider 名字冲突，不能重新验证` });
    }
    if (
      current.baseUrl === null ||
      current.api === null ||
      !CUSTOM_PROVIDER_APIS.includes(current.api as (typeof CUSTOM_PROVIDER_APIS)[number])
    ) {
      return sendJson(res, 409, { error: `${provider} 缺少可用的地址或接口协议` });
    }
    targetFingerprint = modelServiceTargetFingerprint(current.baseUrl, current.api);
    if (current.targetFingerprint !== targetFingerprint) {
      return sendJson(res, 409, { error: `${provider} 的目标绑定不一致，请重新配置` });
    }
  }
  if (
    current.credential.state === "unconfigured" ||
    current.credential.apiKeyEncrypted === null ||
    current.credential.updatedAt === null
  ) {
    return sendJson(res, 409, { error: `${provider} 没有可重验的已存模型凭据` });
  }
  const credential = decryptCredential(masterKey, current.credential.apiKeyEncrypted);
  if (credential === undefined) {
    return sendJson(res, 409, { error: `${provider} 的已存模型凭据无法解密，请重新粘贴` });
  }
  if (current.type === "builtin") {
    return commitVerifiedBuiltinModelService(res, deps, {
      provider,
      credential,
      credentialUpdatedAt: current.credential.updatedAt,
      validationModel,
      expectedVersion,
    });
  }

  candidate = {
    kind: "openai-compatible",
    provider,
    baseUrl: current.baseUrl!,
    api: current.api as (typeof CUSTOM_PROVIDER_APIS)[number],
    credential,
  };
  const catalogStorePath = modelCatalogStorePath(deps.cacheDir);
  const discovered = await (deps.discoverModelServiceModels ?? discoverModels)(candidate, {
    allowNetwork: true,
    ...(catalogStorePath === undefined ? {} : { catalogStorePath }),
  });
  const validationDiscovery = discovered.ok
    ? discovered.models.find((model) => model.id === validationModel)
    : undefined;
  const validation = await validateMinimalInference(
    candidate,
    validationDiscovery ?? validationModel,
  );
  const secrets = [credential, current.credential.apiKeyEncrypted, masterKey];
  if (!validation.ok) return sendCandidateFailure(res, validation.failure, secrets);

  const committedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const supplements = current.supplements.map((entry) => ({
    model: entry.model,
    source: entry.source,
    targetFingerprint: entry.targetFingerprint,
    createdAt: entry.createdAt,
  }));
  if (!discovered.ok || validationDiscovery === undefined) {
    const supplement = {
      model: validationModel,
      source: "manual" as const,
      targetFingerprint,
      createdAt:
        current.supplements.find((entry) => entry.model === validationModel)?.createdAt ??
        committedAt,
    };
    const existing = supplements.findIndex((entry) => entry.model === validationModel);
    if (existing === -1) supplements.push(supplement);
    else supplements[existing] = supplement;
  }
  const directory: ModelServiceVersionCommit["directory"] = !discovered.ok
    ? {
        state: current.directory.lastSuccessAt === null ? "discovery-failed" : "refresh-failed",
        lastAttemptAt: committedAt,
        lastSuccessAt: current.directory.lastSuccessAt,
        failure: redactCandidateFailure(discovered.failure, secrets).message,
        ignoredModelCount: 0,
      }
    : validationDiscovery === undefined
      ? {
          state: "discovery-failed",
          lastAttemptAt: committedAt,
          lastSuccessAt: null,
          failure: `最终目录里已没有验证模型 ${validationModel}；真实推理成功后已补录该模型`,
          ignoredModelCount: discovered.ignoredCount,
        }
      : {
          state: "available",
          lastAttemptAt: committedAt,
          lastSuccessAt: committedAt,
          failure: null,
          ignoredModelCount: discovered.ignoredCount,
        };
  const record: ModelServiceVersionCommit = {
    provider,
    type: "custom",
    baseUrl: current.baseUrl,
    api: current.api,
    targetFingerprint,
    disabledReason: null,
    createdAt: current.createdAt,
    updatedAt: committedAt,
    credential: {
      state: "verified",
      apiKeyEncrypted: current.credential.apiKeyEncrypted,
      updatedAt: current.credential.updatedAt,
      verifiedAt: committedAt,
      validationModel: modelIdentity({ provider, model: validationModel }),
      verificationSource: "inference",
    },
    directory,
    automaticModels: discovered.ok ? discovered.models : current.automaticModels,
    supplements,
  };
  const version = withStore(deps.dbPath, (store) =>
    store.commitModelServiceVersion(expectedVersion, record),
  );
  if (version === undefined) {
    const actualVersion = withStore(deps.dbPath, (store) =>
      store.getModelService(provider)?.version ?? null,
    );
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新打开配置",
      expectedVersion,
      actualVersion,
    });
  }
  return sendJson(res, 200, {
    provider,
    version,
    credential: { state: "verified" },
    directory: { state: directory.state },
  });
}

async function handleDeleteModelServiceCredential(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  provider: string,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = safeParse(body) as { expectedVersion?: unknown } | null;
  if (
    payload === null ||
    !Number.isInteger(payload.expectedVersion) ||
    Number(payload.expectedVersion) <= 0
  ) {
    return sendJson(res, 400, { error: "删除模型凭据参数形状不对" });
  }
  const expectedVersion = Number(payload.expectedVersion);
  const current = withStore(deps.dbPath, (store) => store.getModelService(provider));
  if (current === undefined) {
    return sendJson(res, 404, { error: `没有模型服务 ${provider}` });
  }
  if (current.version !== expectedVersion) {
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新打开配置",
      expectedVersion,
      actualVersion: current.version,
    });
  }
  const references = withStore(deps.dbPath, (store) =>
    store.listModelReferences().filter((reference) => reference.provider === provider),
  );
  if (references.length > 0) {
    return sendJson(res, 409, {
      error: `${provider} 仍被模型组合引用，不能删除模型凭据`,
      references,
    });
  }
  const record: ModelServiceVersionCommit = {
    provider,
    type: current.type,
    baseUrl: current.baseUrl,
    api: current.api,
    targetFingerprint: current.targetFingerprint,
    disabledReason: current.disabledReason,
    createdAt: current.createdAt,
    updatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    credential: {
      state: "unconfigured",
      apiKeyEncrypted: null,
      updatedAt: null,
      verifiedAt: null,
      validationModel: null,
      verificationSource: null,
    },
    directory: current.directory,
    automaticModels: current.automaticModels,
    supplements: current.supplements.map((entry) => ({
      model: entry.model,
      source: entry.source,
      targetFingerprint: entry.targetFingerprint,
      createdAt: entry.createdAt,
    })),
  };
  const version = withStore(deps.dbPath, (store) =>
    store.commitModelServiceVersion(expectedVersion, record),
  );
  if (version === undefined) {
    const actualVersion = withStore(deps.dbPath, (store) =>
      store.getModelService(provider)?.version ?? null,
    );
    return sendJson(res, 409, {
      error: "模型服务版本已变化或仍被模型组合引用，请重新打开配置",
      expectedVersion,
      actualVersion,
    });
  }
  return sendJson(res, 200, {
    provider,
    version,
    credential: { state: "unconfigured" },
  });
}

type StoredModelServiceRuntime =
  | {
      ok: true;
      candidate: ModelServiceCandidate;
      targetFingerprint: string;
      secrets: readonly string[];
    }
  | { ok: false; error: string };

async function hasCurrentCustomProviderNameConflict(
  service: ModelServiceRecord,
): Promise<boolean> {
  return service.type === "custom" &&
    (await conflictingBuiltinProviderNames([service.provider])).has(service.provider);
}

async function storedModelServiceRuntime(
  current: ModelServiceRecord,
  masterKey: string,
): Promise<StoredModelServiceRuntime> {
  const provider = current.provider;
  if (
    current.credential.state !== "verified" ||
    current.credential.apiKeyEncrypted === null
  ) {
    return { ok: false, error: `${provider} 没有已验证的模型凭据` };
  }

  let targetFingerprint: string;
  let target:
    | { kind: "builtin" }
    | {
        kind: "openai-compatible";
        baseUrl: string;
        api: (typeof CUSTOM_PROVIDER_APIS)[number];
      };
  if (current.type === "builtin") {
    const builtinTarget = await resolvePiBuiltinProviderTarget(provider);
    if (builtinTarget === undefined) {
      return { ok: false, error: `Pi 已没有内置 provider ${provider}` };
    }
    targetFingerprint = modelServiceTargetFingerprint(builtinTarget.baseUrl, builtinTarget.api);
    if (current.targetFingerprint !== targetFingerprint) {
      return { ok: false, error: "Pi 内置目标已经变化，请粘贴凭据重新配置" };
    }
    target = { kind: "builtin" };
  } else {
    if (
      current.baseUrl === null ||
      current.api === null ||
      !CUSTOM_PROVIDER_APIS.includes(current.api as (typeof CUSTOM_PROVIDER_APIS)[number])
    ) {
      return { ok: false, error: `${provider} 缺少可用的地址或接口协议` };
    }
    targetFingerprint = modelServiceTargetFingerprint(current.baseUrl, current.api);
    if (current.targetFingerprint !== targetFingerprint) {
      return { ok: false, error: `${provider} 的目标绑定不一致，请重新配置` };
    }
    target = {
      kind: "openai-compatible",
      baseUrl: current.baseUrl,
      api: current.api as (typeof CUSTOM_PROVIDER_APIS)[number],
    };
  }
  const credential = decryptCredential(masterKey, current.credential.apiKeyEncrypted);
  if (credential === undefined) {
    return { ok: false, error: `${provider} 的已存模型凭据无法解密，请重新粘贴` };
  }
  return {
    ok: true,
    candidate: target.kind === "builtin"
      ? { kind: "builtin", provider, credential }
      : {
          kind: "openai-compatible",
          provider,
          baseUrl: target.baseUrl,
          api: target.api,
          credential,
        },
    targetFingerprint,
    secrets: [credential, current.credential.apiKeyEncrypted, masterKey],
  };
}

function parseModelSupplementMutation(
  value: unknown,
): { model: string; expectedVersion: number } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const payload = value as Record<string, unknown>;
  if (
    Object.keys(payload).some((key) => key !== "model" && key !== "expectedVersion") ||
    typeof payload["model"] !== "string" ||
    payload["model"].trim() === "" ||
    payload["model"] !== payload["model"].trim() ||
    !Number.isInteger(payload["expectedVersion"]) ||
    Number(payload["expectedVersion"]) <= 0
  ) {
    return undefined;
  }
  return {
    model: payload["model"],
    expectedVersion: Number(payload["expectedVersion"]),
  };
}

function parseModelStateMutation(
  value: unknown,
): { models: string[]; expectedVersion: number; enabled: boolean } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const payload = value as Record<string, unknown>;
  if (
    Object.keys(payload).some((key) => !["models", "expectedVersion", "enabled"].includes(key)) ||
    !Array.isArray(payload["models"]) ||
    payload["models"].length === 0 ||
    payload["models"].some((model) => typeof model !== "string" || model.trim() !== model || model === "") ||
    !Number.isInteger(payload["expectedVersion"]) ||
    Number(payload["expectedVersion"]) <= 0 ||
    typeof payload["enabled"] !== "boolean"
  ) return undefined;
  return {
    models: [...new Set(payload["models"] as string[])],
    expectedVersion: Number(payload["expectedVersion"]),
    enabled: payload["enabled"] as boolean,
  };
}

async function handleUpdateModelServiceModelStates(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  provider: string,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const input = parseModelStateMutation(safeParse(body));
  if (input === undefined) {
    return sendJson(res, 400, {
      error: "模型状态更新需要 models、enabled 与正整数 expectedVersion",
    });
  }
  const result = withStore(deps.dbPath, (store) => {
    return store.updateModelServiceModelStates(
      provider,
      input.expectedVersion,
      input.models,
      input.enabled,
      new Date((deps.now ?? Date.now)()).toISOString(),
    );
  });
  if (result.status === "version-conflict") {
    const actualVersion = withStore(deps.dbPath, (store) =>
      store.getModelService(provider)?.version ?? null,
    );
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新载入后再更新模型状态",
      expectedVersion: input.expectedVersion,
      actualVersion,
    });
  }
  if (result.status === "unknown-models") {
    return sendJson(res, 400, {
      error: "模型不属于当前目录",
      models: result.models,
    });
  }
  if (result.status === "referenced") {
    return sendJson(res, 409, {
      error: "已被审查策略引用的模型不能停用，请先调整策略",
      references: result.references,
    });
  }
  return sendJson(res, 200, {
    provider,
    enabled: input.enabled,
    updated: result.updated,
  });
}

async function handleRefreshModelService(
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
  const payload = safeParse(body) as { expectedVersion?: unknown } | null;
  if (
    payload === null ||
    !Number.isInteger(payload.expectedVersion) ||
    Number(payload.expectedVersion) <= 0
  ) {
    return sendJson(res, 400, { error: "刷新模型目录必须带正整数 expectedVersion" });
  }
  const expectedVersion = Number(payload.expectedVersion);
  const current = withStore(deps.dbPath, (store) => store.getModelService(provider));
  if (current === undefined) {
    return sendJson(res, 404, { error: `没有模型服务 ${provider}` });
  }
  if (current.version !== expectedVersion) {
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新载入后再刷新",
      expectedVersion,
      actualVersion: current.version,
    });
  }
  if (await hasCurrentCustomProviderNameConflict(current)) {
    return sendJson(res, 409, {
      error: `${provider} 与当前 Pi 内置 provider 名字冲突，不能刷新目录`,
    });
  }
  const runtime = await storedModelServiceRuntime(current, masterKey);
  if (!runtime.ok) return sendJson(res, 409, { error: `${runtime.error}，不能刷新目录` });
  const { candidate, targetFingerprint } = runtime;

  const catalogStorePath = modelCatalogStorePath(deps.cacheDir);
  const discovered = await (deps.discoverModelServiceModels ?? discoverModels)(candidate, {
    allowNetwork: true,
    ...(catalogStorePath === undefined ? {} : { catalogStorePath }),
  });
  const attemptedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const failure = discovered.ok
    ? null
    : redactCandidateFailure(discovered.failure, runtime.secrets).message;
  const directory: ModelServiceVersionCommit["directory"] = discovered.ok
    ? {
        state: "available",
        lastAttemptAt: attemptedAt,
        lastSuccessAt: attemptedAt,
        failure: null,
        ignoredModelCount: discovered.ignoredCount,
      }
    : {
        state: current.directory.lastSuccessAt === null ? "discovery-failed" : "refresh-failed",
        lastAttemptAt: attemptedAt,
        lastSuccessAt: current.directory.lastSuccessAt,
        failure,
        ignoredModelCount: 0,
      };
  const record: ModelServiceVersionCommit = {
    provider,
    type: current.type,
    baseUrl: current.baseUrl,
    api: current.api,
    targetFingerprint,
    disabledReason: current.type === "custom" ? null : current.disabledReason,
    createdAt: current.createdAt,
    updatedAt: attemptedAt,
    credential: current.credential,
    directory,
    automaticModels: discovered.ok ? discovered.models : current.automaticModels,
    supplements: current.supplements.map((entry) => ({
      model: entry.model,
      source: entry.source,
      targetFingerprint: entry.targetFingerprint,
      createdAt: entry.createdAt,
    })),
  };
  const version = withStore(deps.dbPath, (store) =>
    store.commitModelServiceVersion(expectedVersion, record),
  );
  if (version === undefined) {
    const actualVersion = withStore(deps.dbPath, (store) =>
      store.getModelService(provider)?.version ?? null,
    );
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新载入后再刷新",
      expectedVersion,
      actualVersion,
    });
  }
  return sendJson(res, 200, {
    provider,
    version,
    directory: {
      state: directory.state,
      ignoredModelCount: directory.ignoredModelCount,
      failure: directory.failure,
    },
  });
}

async function handleAddModelSupplement(
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
  const input = parseModelSupplementMutation(safeParse(body));
  if (input === undefined) {
    return sendJson(res, 400, {
      error: "模型补录只接受 model 与正整数 expectedVersion",
    });
  }
  const current = withStore(deps.dbPath, (store) => store.getModelService(provider));
  if (current === undefined) {
    return sendJson(res, 404, { error: `没有模型服务 ${provider}` });
  }
  if (current.version !== input.expectedVersion) {
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新载入后再补录",
      expectedVersion: input.expectedVersion,
      actualVersion: current.version,
    });
  }
  if (await hasCurrentCustomProviderNameConflict(current)) {
    return sendJson(res, 409, {
      error: `${provider} 与当前 Pi 内置 provider 名字冲突，不能补录模型`,
    });
  }
  const runtime = await storedModelServiceRuntime(current, masterKey);
  if (!runtime.ok) return sendJson(res, 409, { error: `${runtime.error}，不能补录模型` });

  const validation = await validateMinimalInference(runtime.candidate, input.model);
  if (!validation.ok) {
    return sendCandidateFailure(res, validation.failure, runtime.secrets);
  }
  const committedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const supplements = current.supplements.map((entry) => ({
    model: entry.model,
    source: entry.source,
    targetFingerprint: entry.targetFingerprint,
    createdAt: entry.createdAt,
  }));
  const supplement = {
    model: input.model,
    source: "manual" as const,
    targetFingerprint: runtime.targetFingerprint,
    createdAt:
      current.supplements.find((entry) => entry.model === input.model)?.createdAt ?? committedAt,
  };
  const existing = supplements.findIndex((entry) => entry.model === input.model);
  if (existing === -1) supplements.push(supplement);
  else supplements[existing] = supplement;
  const record: ModelServiceVersionCommit = {
    provider,
    type: current.type,
    baseUrl: current.baseUrl,
    api: current.api,
    targetFingerprint: runtime.targetFingerprint,
    disabledReason: current.type === "custom" ? null : current.disabledReason,
    createdAt: current.createdAt,
    updatedAt: committedAt,
    credential: current.credential,
    directory: current.directory,
    automaticModels: current.automaticModels,
    supplements,
  };
  const version = withStore(deps.dbPath, (store) =>
    store.commitModelServiceVersion(input.expectedVersion, record),
  );
  if (version === undefined) {
    const actualVersion = withStore(deps.dbPath, (store) =>
      store.getModelService(provider)?.version ?? null,
    );
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新载入后再补录",
      expectedVersion: input.expectedVersion,
      actualVersion,
    });
  }
  return sendJson(res, 200, {
    provider,
    model: input.model,
    identity: modelIdentity({ provider, model: input.model }),
    source: "manual",
    version,
  });
}

async function handleDeleteModelSupplement(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  provider: string,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const input = parseModelSupplementMutation(safeParse(body));
  if (input === undefined) {
    return sendJson(res, 400, {
      error: "删除模型补录只接受 model 与正整数 expectedVersion",
    });
  }
  const current = withStore(deps.dbPath, (store) => store.getModelService(provider));
  if (current === undefined) {
    return sendJson(res, 404, { error: `没有模型服务 ${provider}` });
  }
  if (current.version !== input.expectedVersion) {
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新载入后再删除补录",
      expectedVersion: input.expectedVersion,
      actualVersion: current.version,
    });
  }
  const supplement = current.supplements.find((entry) => entry.model === input.model);
  if (supplement === undefined) {
    return sendJson(res, 404, {
      error: `${modelIdentity({ provider, model: input.model })} 没有补录来源`,
    });
  }
  const hasAutomaticSource = current.automaticModels.some((entry) => entry.id === input.model);
  const identity = modelIdentity({ provider, model: input.model });
  if (!hasAutomaticSource) {
    const reference = withStore(deps.dbPath, (store) =>
      store.listModelReferences().find((entry) => entry.identity === identity),
    );
    if (reference !== undefined) {
      return sendJson(res, 409, {
        error: `${identity} 的补录是当前唯一来源，仍被模型组合引用`,
        references: [reference],
      });
    }
  }

  const committedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const record: ModelServiceVersionCommit = {
    provider,
    type: current.type,
    baseUrl: current.baseUrl,
    api: current.api,
    targetFingerprint: current.targetFingerprint,
    disabledReason: current.disabledReason,
    createdAt: current.createdAt,
    updatedAt: committedAt,
    credential: current.credential,
    directory: current.directory,
    automaticModels: current.automaticModels,
    supplements: current.supplements
      .filter((entry) => entry.model !== input.model)
      .map((entry) => ({
        model: entry.model,
        source: entry.source,
        targetFingerprint: entry.targetFingerprint,
        createdAt: entry.createdAt,
      })),
  };
  const version = withStore(deps.dbPath, (store) =>
    store.commitModelServiceVersion(input.expectedVersion, record),
  );
  if (version === undefined) {
    const actualVersion = withStore(deps.dbPath, (store) =>
      store.getModelService(provider)?.version ?? null,
    );
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新载入后再删除补录",
      expectedVersion: input.expectedVersion,
      actualVersion,
    });
  }
  return sendJson(res, 200, {
    provider,
    model: input.model,
    identity,
    removedSource: supplement.source,
    remainingSources: hasAutomaticSource ? ["automatic"] : [],
    version,
  });
}

type CustomModelServiceCandidateInput = {
  provider: string;
  baseUrl: string;
  api: (typeof CUSTOM_PROVIDER_APIS)[number];
  credential: string;
  validationModel: string;
  expectedVersion: number | null;
  reconfirmedSupplements: string[];
};

function parseCustomModelServiceCandidate(
  value: unknown,
  validationRequired = true,
): CustomModelServiceCandidateInput | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const payload = value as Record<string, unknown>;
  const provider = payload["provider"];
  const api = payload["api"];
  const credential = payload["credential"];
  const validationModel = payload["validationModel"];
  const baseUrl =
    typeof payload["baseUrl"] === "string"
      ? normalizeModelServiceBaseUrl(payload["baseUrl"])
      : undefined;
  const expectedVersion = payload["expectedVersion"];
  const reconfirmed = payload["reconfirmedSupplements"];
  if (
    typeof provider !== "string" ||
    !CUSTOM_PROVIDER_NAME.test(provider) ||
    baseUrl === undefined ||
    typeof api !== "string" ||
    !CUSTOM_PROVIDER_APIS.includes(api as (typeof CUSTOM_PROVIDER_APIS)[number]) ||
    typeof credential !== "string" ||
    credential.length === 0 ||
    (validationRequired && (
      typeof validationModel !== "string" ||
      validationModel.trim() === "" ||
      validationModel !== validationModel.trim()
    )) ||
    (!validationRequired && validationModel !== undefined && (
      typeof validationModel !== "string" || validationModel !== validationModel.trim()
    )) ||
    !(expectedVersion === null || (Number.isInteger(expectedVersion) && Number(expectedVersion) > 0)) ||
    !Array.isArray(reconfirmed) ||
    reconfirmed.some(
      (identity) =>
        typeof identity !== "string" ||
        !identity.startsWith(`${provider}:`) ||
        identity.slice(provider.length + 1).trim() === "" ||
        identity !== identity.trim(),
    ) ||
    new Set(reconfirmed).size !== reconfirmed.length
  ) {
    return undefined;
  }
  return {
    provider,
    baseUrl,
    api: api as (typeof CUSTOM_PROVIDER_APIS)[number],
    credential,
    validationModel: typeof validationModel === "string" ? validationModel : "",
    expectedVersion: expectedVersion as number | null,
    reconfirmedSupplements: reconfirmed as string[],
  };
}

function redactCandidateFailure(
  failure: ModelOperationFailure,
  secrets: readonly string[],
): ModelOperationFailure {
  let message = failure.message;
  for (const secret of secrets) {
    if (secret !== "") message = message.replaceAll(secret, "[REDACTED]");
  }
  message = message
    .replace(/\bBearer\s+[^\s"',;}]+/giu, "Bearer [REDACTED]")
    .replace(
      /\b(authorization|api[-_ ]?key|credential|ciphertext|master[-_ ]?key)\b\s*[:=]\s*[^,;}\n]+/giu,
      "$1: [REDACTED]",
    );
  return { ...failure, message };
}

function sendCandidateFailure(
  res: ServerResponse,
  failure: ModelOperationFailure,
  secrets: readonly string[],
  stage: "discovery" | "validation" = "validation",
): void {
  const redacted = redactCandidateFailure(failure, secrets);
  const requestId = randomBytes(8).toString("hex");
  console.error(
    `[model-service] request ${requestId} ${stage} failed (${redacted.code}): ${redacted.message}`,
  );
  const operation = stage === "discovery" ? "模型发现" : "模型验证";
  sendJson(res, 422, { error: `${operation}失败，请按 request id 查看服务日志`, requestId });
}

async function handlePreviewCustomModelService(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const input = parseCustomModelServiceCandidate(safeParse(body), false);
  if (input === undefined) {
    return sendJson(res, 400, { error: "自定义模型服务候选形状不对" });
  }
  const current = withStore(deps.dbPath, (store) => store.getModelService(input.provider));
  if (current !== undefined && current.type !== "custom") {
    return sendJson(res, 409, { error: `${input.provider} 已被同名内置模型服务占用` });
  }
  const actualVersion = current?.version ?? null;
  if (actualVersion !== input.expectedVersion) {
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新打开配置",
      expectedVersion: input.expectedVersion,
      actualVersion,
    });
  }
  if ((await listPiBuiltinProviders()).some(({ id }) => id === input.provider)) {
    return sendJson(res, 409, { error: `${input.provider} 与当前 Pi 内置 provider 名字冲突` });
  }
  const candidate = {
    kind: "openai-compatible" as const,
    provider: input.provider,
    baseUrl: input.baseUrl,
    api: input.api,
    credential: input.credential,
  };
  const catalogStorePath = modelCatalogStorePath(deps.cacheDir);
  const discovered = await (deps.discoverModelServiceModels ?? discoverModels)(candidate, {
    allowNetwork: true,
    ...(catalogStorePath === undefined ? {} : { catalogStorePath }),
  });
  if (!discovered.ok) {
    return sendCandidateFailure(res, discovered.failure, [input.credential], "discovery");
  }
  return sendJson(res, 200, {
    provider: input.provider,
    expectedVersion: input.expectedVersion,
    target: { baseUrl: input.baseUrl, api: input.api },
    models: discovered.models,
    ignoredModelCount: discovered.ignoredCount,
  });
}

async function handleCommitCustomModelService(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
): Promise<void> {
  const masterKey = deps.credentialMasterKey;
  if (masterKey === undefined || masterKey === "") {
    return sendJson(res, 503, { error: MASTER_KEY_MISSING });
  }
  const body = await readBody(req, res);
  if (body === undefined) return;
  const input = parseCustomModelServiceCandidate(safeParse(body));
  if (input === undefined) {
    return sendJson(res, 400, { error: "自定义模型服务最终候选形状不对" });
  }
  const { current, knownSupplements } = withStore(deps.dbPath, (store) => ({
    current: store.getModelService(input.provider),
    knownSupplements: store.listModelSupplements(input.provider),
  }));
  if (current !== undefined && current.type !== "custom") {
    return sendJson(res, 409, { error: `${input.provider} 已被同名内置模型服务占用` });
  }
  const actualVersion = current?.version ?? null;
  if (actualVersion !== input.expectedVersion) {
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新打开配置",
      expectedVersion: input.expectedVersion,
      actualVersion,
    });
  }
  if ((await listPiBuiltinProviders()).some(({ id }) => id === input.provider)) {
    return sendJson(res, 409, { error: `${input.provider} 与当前 Pi 内置 provider 名字冲突` });
  }
  const supplementByIdentity = new Map(
    knownSupplements.map((entry) => [modelIdentity(entry), entry]),
  );
  const unknownReconfirmed = input.reconfirmedSupplements.filter(
    (identity) => !supplementByIdentity.has(identity),
  );
  if (unknownReconfirmed.length > 0) {
    return sendJson(res, 400, {
      error: "只能重新确认当前模型服务已有的模型补录",
      identities: unknownReconfirmed,
    });
  }


  const candidate = {
    kind: "openai-compatible" as const,
    provider: input.provider,
    baseUrl: input.baseUrl,
    api: input.api,
    credential: input.credential,
  };
  const catalogStorePath = modelCatalogStorePath(deps.cacheDir);
  const discovered = await (deps.discoverModelServiceModels ?? discoverModels)(candidate, {
    allowNetwork: true,
    ...(catalogStorePath === undefined ? {} : { catalogStorePath }),
  });
  const validationDiscovery = discovered.ok
    ? discovered.models.find((model) => model.id === input.validationModel)
    : undefined;
  const validation = await validateMinimalInference(
    candidate,
    validationDiscovery ?? input.validationModel,
  );
  if (!validation.ok) {
    return sendCandidateFailure(res, validation.failure, [input.credential]);
  }

  const committedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const targetFingerprint = modelServiceTargetFingerprint(input.baseUrl, input.api);
  const sameTarget = current?.targetFingerprint === targetFingerprint;
  const supplements = sameTarget
    ? knownSupplements.map((entry) => ({
        model: entry.model,
        source: entry.source,
        targetFingerprint: entry.targetFingerprint,
        createdAt: entry.createdAt,
      }))
    : input.reconfirmedSupplements.map((identity) => {
        const entry = supplementByIdentity.get(identity)!;
        return {
          model: entry.model,
          source: "manual" as const,
          targetFingerprint,
          createdAt: entry.createdAt,
        };
      });
  if (!discovered.ok || validationDiscovery === undefined) {
    const supplement = {
      model: input.validationModel,
      source: "manual" as const,
      targetFingerprint,
      createdAt:
        current?.supplements.find((entry) => entry.model === input.validationModel)?.createdAt ??
        committedAt,
    };
    const index = supplements.findIndex((entry) => entry.model === input.validationModel);
    if (index === -1) supplements.push(supplement);
    else supplements[index] = supplement;
  }
  if (!sameTarget) {
    const nextModels = new Set(discovered.ok ? discovered.models.map(({ id }) => id) : []);
    for (const supplement of supplements) nextModels.add(supplement.model);
    const unresolved = withStore(deps.dbPath, (store) =>
      store
        .listModelReferences()
        .filter(
          (reference) =>
            reference.provider === input.provider && !nextModels.has(reference.model),
        ),
    );
    if (unresolved.length > 0) {
      return sendJson(res, 409, {
        error: "目标切换会移除仍被模型组合引用的模型来源",
        references: unresolved,
      });
    }
  }
  let directory: ModelServiceVersionCommit["directory"];
  if (!discovered.ok) {
    const lastSuccessAt = sameTarget ? current?.directory.lastSuccessAt ?? null : null;
    directory = {
      state: lastSuccessAt === null ? "discovery-failed" : "refresh-failed",
      lastAttemptAt: committedAt,
      lastSuccessAt,
      failure: redactCandidateFailure(discovered.failure, [input.credential]).message,
      ignoredModelCount: 0,
    };
  } else if (validationDiscovery === undefined) {
    directory = {
      state: "discovery-failed",
      lastAttemptAt: committedAt,
      lastSuccessAt: null,
      failure: `最终目录里已没有验证模型 ${input.validationModel}；真实推理成功后已补录该模型`,
      ignoredModelCount: discovered.ignoredCount,
    };
  } else {
    directory = {
      state: "available",
      lastAttemptAt: committedAt,
      lastSuccessAt: committedAt,
      failure: null,
      ignoredModelCount: discovered.ignoredCount,
    };
  }
  const record: ModelServiceVersionCommit = {
    provider: input.provider,
    type: "custom",
    baseUrl: input.baseUrl,
    api: input.api,
    targetFingerprint,
    disabledReason: null,
    createdAt: current?.createdAt ?? committedAt,
    updatedAt: committedAt,
    credential: {
      state: "verified",
      apiKeyEncrypted: encryptCredential(masterKey, input.credential),
      updatedAt: committedAt,
      verifiedAt: committedAt,
      validationModel: modelIdentity({ provider: input.provider, model: input.validationModel }),
      verificationSource: "inference",
    },
    directory,
    automaticModels: discovered.ok
      ? discovered.models
      : sameTarget
        ? current?.automaticModels ?? []
        : [],
    supplements,
  };
  const version = withStore(deps.dbPath, (store) =>
    store.commitModelServiceVersion(input.expectedVersion, record),
  );
  if (version === undefined) {
    const latestVersion = withStore(deps.dbPath, (store) =>
      store.getModelService(input.provider)?.version ?? null,
    );
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新打开配置",
      expectedVersion: input.expectedVersion,
      actualVersion: latestVersion,
    });
  }
  return sendJson(res, 200, {
    provider: input.provider,
    version,
    credential: { state: "verified" },
    directory: { state: directory.state },
  });
}

async function handleDeleteCustomModelService(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  provider: string,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = safeParse(body);
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("expectedVersion" in payload) ||
    typeof payload.expectedVersion !== "number" ||
    !Number.isInteger(payload.expectedVersion) ||
    payload.expectedVersion <= 0
  ) {
    return sendJson(res, 400, { error: "删除模型服务必须带正整数 expectedVersion" });
  }
  const expectedVersion = Number(payload.expectedVersion);
  const { current, references } = withStore(deps.dbPath, (store) => ({
    current: store.getModelService(provider),
    references: store.listModelReferences().filter((reference) => reference.provider === provider),
  }));
  if (current === undefined) {
    return sendJson(res, 404, { error: `没有自定义模型服务 ${provider}` });
  }
  if (current.type !== "custom") {
    return sendJson(res, 400, { error: `${provider} 不是自定义模型服务` });
  }
  if (current.version !== expectedVersion) {
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新打开配置",
      expectedVersion,
      actualVersion: current.version,
    });
  }
  if (references.length > 0) {
    return sendJson(res, 409, {
      error: "模型服务仍被模型组合引用，不能删除",
      references,
    });
  }
  const removed = withStore(deps.dbPath, (store) =>
    store.removeCustomModelService(provider, expectedVersion),
  );
  if (!removed) {
    const actualVersion = withStore(deps.dbPath, (store) =>
      store.getModelService(provider)?.version ?? null,
    );
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新打开配置",
      expectedVersion,
      actualVersion,
    });
  }
  return sendJson(res, 200, { provider, deleted: true });
}

async function handleRenameConflictingCustomModelService(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  currentProvider: string,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = safeParse(body);
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("provider" in payload) ||
    typeof payload.provider !== "string" ||
    !CUSTOM_PROVIDER_NAME.test(payload.provider) ||
    !("expectedVersion" in payload) ||
    typeof payload.expectedVersion !== "number" ||
    !Number.isInteger(payload.expectedVersion) ||
    payload.expectedVersion <= 0
  ) {
    return sendJson(res, 400, {
      error: "冲突服务改名必须带合法 provider 与正整数 expectedVersion",
    });
  }
  const provider = payload.provider;
  const expectedVersion = payload.expectedVersion;
  const current = withStore(deps.dbPath, (store) => store.getModelService(currentProvider));
  if (current === undefined) {
    return sendJson(res, 404, { error: `没有自定义模型服务 ${currentProvider}` });
  }
  if (current.version !== expectedVersion) {
    return sendJson(res, 409, {
      error: "模型服务版本已变化，请重新打开配置",
      expectedVersion,
      actualVersion: current.version,
    });
  }
  if (current.type !== "custom" || current.disabledReason !== "name-conflict") {
    return sendJson(res, 409, { error: "只有因 provider 名称冲突而停用的自定义服务可以改名" });
  }
  if ((await listPiBuiltinProviders()).some(({ id }) => id === provider)) {
    return sendJson(res, 409, { error: `${provider} 与当前 Pi 内置 provider 名字冲突` });
  }
  const result = withStore(deps.dbPath, (store) =>
    store.renameConflictingCustomModelService(
      currentProvider,
      provider,
      expectedVersion,
      new Date((deps.now ?? Date.now)()).toISOString(),
    ),
  );
  if (result.status === "renamed") {
    return sendJson(res, 200, { provider, version: result.version });
  }
  if (result.status === "missing-models") {
    return sendJson(res, 409, {
      error: "当前模型服务缺少仍被模型组合引用的模型，改名未执行",
      references: result.references,
    });
  }
  if (result.status === "provider-conflict") {
    return sendJson(res, 409, { error: `${provider} 已被现有模型服务占用` });
  }
  if (result.status === "invalid-provider") {
    return sendJson(res, 400, { error: "新 provider 名称不符合规则" });
  }
  if (result.status === "not-conflicting") {
    return sendJson(res, 409, { error: "只有因 provider 名称冲突而停用的自定义服务可以改名" });
  }
  const actualVersion = withStore(deps.dbPath, (store) =>
    store.getModelService(currentProvider)?.version ?? null,
  );
  return sendJson(res, 409, {
    error: "模型服务版本已变化，请重新打开配置",
    expectedVersion,
    actualVersion,
  });
}


function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * 解析并校验一段模型组合入参。审查策略、仓库注册与每仓库覆盖共用同一形状判据；
 * 当前模型服务可用性随后由 `ensureModelCombinationAvailable` 在落库前重新投影。
 */
function parseReviewerSpecs(
  value: unknown,
  context: string,
  options: { allowEmpty?: boolean } = {},
):
  | { ok: true; reviewers: ReviewerSpec[]; reviewersJson: string }
  | { ok: false; error: string } {
  try {
    const specs = assertReviewerSpecs(value, context, options);
    return { ok: true, reviewers: specs, reviewersJson: JSON.stringify(specs) };
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
  scope: RepoScope,
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
  // 游标取的是这一页最后一行的 id,分配外的行滤掉之后它也不变:翻页照常走完整段
  // 时间流,人看到的只是其中属于自己的那些。
  const nextBefore = runs.length === RUNS_PAGE ? runs[runs.length - 1]!.id : null;
  return sendJson(res, 200, {
    runs: runs.filter((run) => scope.allows(run.owner, run.repo)),
    nextBefore,
  });
}

/** 评审记录一页的行数。行是审查阶段,不是轮次(issue #174)。 */
const STAGES_PAGE = 30;

/**
 * 评审记录的一页(issue #174):每行一个审查阶段。全局列表与仓库页读的是同一个端点,
 * 仓库页多给 `owner` + `repo` 一对过滤。
 *
 * 筛选维度是状态与来源,两项都省即全部;认不出来的值一律 400——悄悄按「全部」处理,
 * 人看到的就是一份与自己所选无关的列表。翻页用 `offset`:排序键是最新一轮的时间,
 * 新一轮随时会把某一行顶上来,id 游标在这里不成立。
 */
function handleStages(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  scope: RepoScope,
): void {
  const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const offsetRaw = query.get("offset");
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return sendJson(res, 400, { error: "offset 要是非负整数" });
  }
  const owner = query.get("owner");
  const repo = query.get("repo");
  if ((owner === null) !== (repo === null)) {
    return sendJson(res, 400, { error: "owner 与 repo 要成对给,过滤不接受半个键" });
  }
  const statusRaw = query.get("status");
  if (statusRaw !== null && statusRaw !== "active" && statusRaw !== "closed") {
    return sendJson(res, 400, { error: "status 只能是 active 或 closed" });
  }
  const sourceRaw = query.get("source");
  if (sourceRaw !== null && sourceRaw !== "pull-request" && sourceRaw !== "range-review") {
    return sendJson(res, 400, { error: "source 只能是 pull-request 或 range-review" });
  }
  const stages = withStore(deps.dbPath, (store) =>
    store.listStages({
      offset,
      limit: STAGES_PAGE,
      // 收窄在 SQL 里做:回到 JS 再滤会让「这一页有几行」与翻页游标对不上。
      ...(scope.refs === undefined ? {} : { repos: scope.refs }),
      ...(owner !== null && repo !== null ? { owner, repo } : {}),
      ...(statusRaw === null ? {} : { status: statusRaw }),
      ...(sourceRaw === null ? {} : { source: sourceRaw }),
    }),
  );
  const nextOffset = stages.length === STAGES_PAGE ? offset + STAGES_PAGE : null;
  return sendJson(res, 200, { stages, nextOffset });
}

/**
 * 一个审查阶段的详情(issue #175):评审记录里的那一行,加它按代码推进分组的时间线。
 * 两种来源的阶段用同一份形状,详情页因此只有一个。
 *
 * 范围审查阶段另带它自己那条记录(issue #176):详情页的推进比较项要 base 与当前比较
 * 项,审查完成与重跑要它此刻还是不是进行中。pull request 阶段没有这一格。
 *
 * 阶段标识是路径参数,里面的斜杠在地址里编码过,这里先解回来。解不开的与查不到的都是
 * 404:调用方要知道的都是「没有这个阶段」,而不是「这个标识长得不对」。
 */
function handleStageDetail(
  res: ServerResponse,
  deps: WebhookServerDeps,
  rawStageId: string,
  scope: RepoScope,
): void {
  let stageId: string;
  try {
    stageId = decodeURIComponent(rawStageId);
  } catch {
    return sendJson(res, 404, { error: "没有这个审查阶段" });
  }
  const detail = withStore(deps.dbPath, (store) => {
    const found = store.stageDetail(stageId);
    if (found === undefined) return undefined;
    const rangeReviewId = found.stage.rangeReviewId;
    return rangeReviewId === null
      ? found
      : { ...found, rangeReview: store.getRangeReview(rangeReviewId) };
  });
  if (detail === undefined || !scope.allows(detail.stage.owner, detail.stage.repo)) {
    return sendJson(res, 404, { error: "没有这个审查阶段" });
  }
  return sendJson(res, 200, detail);
}

/**
 * 一轮 Review Run(issue #174)。评审记录的一行点开的是该阶段最新一轮,行上只带它的
 * id,轮次本身按 id 在这里取,与时间流读的是同一份投影。
 */
function handleRun(res: ServerResponse, deps: WebhookServerDeps, runId: number): void {
  const run = withStore(deps.dbPath, (store) => store.listRuns({ limit: 1, id: runId })[0]);
  if (run === undefined) return sendJson(res, 404, { error: "没有这一轮 Review Run" });
  return sendJson(res, 200, { run });
}

/**
 * 一个审查阶段的当前状态(issue #168):按 Finding Identity 汇总的 Finding 列表、三个
 * 计数与逐轮的时间线。
 *
 * 阶段有两条链路,入参因此二选一:`rangeReviewId` 取那个范围审查名下的全部轮次,
 * `owner` + `repo` + `pullNumber` 取那个 pull request 名下、不属于任何范围审查的那些。
 * 两条都给或都不给都是 400——「这是哪个阶段」不能由服务端替调用方猜。
 */
function handleStageSummary(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
): void {
  const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const rangeReviewRaw = query.get("rangeReviewId");
  const owner = query.get("owner");
  const repo = query.get("repo");
  const pullRaw = query.get("pullNumber");
  const byPullRequest = owner !== null || repo !== null || pullRaw !== null;
  if ((rangeReviewRaw !== null) === byPullRequest) {
    return sendJson(res, 400, {
      error: "要按 rangeReviewId 或 owner + repo + pullNumber 取一个阶段,两条只能给一条",
    });
  }
  if (rangeReviewRaw !== null) {
    const rangeReviewId = Number(rangeReviewRaw);
    if (!Number.isSafeInteger(rangeReviewId) || rangeReviewId <= 0) {
      return sendJson(res, 400, { error: "rangeReviewId 要是正整数" });
    }
    const summary = withStore(deps.dbPath, (store) => {
      const rangeReview = store.getRangeReview(rangeReviewId);
      if (rangeReview === undefined) return undefined;
      // 这一档只按 rangeReviewId 取轮次;容器 PR 还没建出来时它名下本来就一轮都没有。
      return store.stageSummary({ rangeReviewId });
    });
    if (summary === undefined) return sendJson(res, 404, { error: "没有这个范围审查" });
    return sendJson(res, 200, summary);
  }
  if (owner === null || repo === null || pullRaw === null) {
    return sendJson(res, 400, { error: "owner、repo 与 pullNumber 要一起给" });
  }
  const pullNumber = Number(pullRaw);
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
    return sendJson(res, 400, { error: "pullNumber 要是正整数" });
  }
  const summary = withStore(deps.dbPath, (store) =>
    store.stageSummary({ owner, repo, pullNumber }),
  );
  return sendJson(res, 200, summary);
}

/**
 * 一轮 Review Run 的审查轨迹(CONTEXT.md,issue #171),按 `seq` 升序。
 *
 * 可见范围与轮次详情一致(登录即可读,仓库分配决定读得到哪些):能看轮次就能看它的
 * 轨迹,不另配一格。升级前跑过的轮次一条事件都没有,回空列表——那不是错误,是
 * 那时候还不记过程。
 */
function handleRunTrace(res: ServerResponse, deps: WebhookServerDeps, runId: number): void {
  const events = withStore(deps.dbPath, (store) =>
    store.getRunRange(runId) === undefined ? undefined : store.listTrace(runId),
  );
  if (events === undefined) return sendJson(res, 404, { error: "没有这一轮 Review Run" });
  return sendJson(res, 200, { events });
}

/** 续传起点的一个来源。认不出来的按 0 算,即「从头给」。 */
function positiveSeq(raw: string | undefined | null): number {
  const seq = Number(raw);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
}

/** 一条 SSE 帧:`id` 取 `seq`,断线之后浏览器用它作 `Last-Event-ID` 续传。 */
function traceFrame(event: TraceEvent): string {
  return `id: ${event.seq}\nevent: trace\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * 审查轨迹的实时推送(issue #171)。
 *
 * 先订阅再回放,两步之间没有 await:事件由同一个进程同步广播,中间插不进第三方,
 * 因此既不会漏也不会重。这一轮已经结束时不订阅,回放完直接发 `end` 并关闭——没有后续
 * 事件可等,让页面挂着等于让它永远转圈。
 */
function handleRunTraceStream(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  runId: number,
): void {
  const exists = withStore(deps.dbPath, (store) => store.getRunRange(runId) !== undefined);
  if (!exists) return sendJson(res, 404, { error: "没有这一轮 Review Run" });

  // 只补这个序号之后的那些。两条来源:浏览器重连时自动带的 `Last-Event-ID`,以及
  // 查询串上的 `?after=`——原生 `EventSource` 设不了首个请求的请求头,面板打开时先取
  // `/trace` 补历史、再拿最后那个 seq 接流,只能走查询串。两个都在时取大的:它们说的
  // 是同一件事,取小的会把已经收到的事件再发一遍。认不出来的值按「从头给」处理。
  const header = req.headers["last-event-id"];
  const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const afterSeq = Math.max(
    positiveSeq(Array.isArray(header) ? header[0] : header),
    positiveSeq(query.get("after")),
  );

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    // 反代默认缓冲响应体,缓冲下来「实时」就变成了跑完一次性出现。
    "x-accel-buffering": "no",
  });
  // 头要立刻发出去。`?after=` 给的是最后一条时没有可回放的帧,不 flush 的话 node 会把头
  // 攒到第一次 write,页面这边就是「连了但没 open」,反代等满读超时再按失败断掉——
  // 浏览器把没握手成功的 EventSource 当永久失败,不再重连。
  res.flushHeaders();

  // 模型一次调用可以静默一两分钟,长过反代的读超时。定时写一条 SSE 注释帧(以冒号开头,
  // 浏览器不当事件),让反代看到上游还活着。
  const heartbeat = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, deps.traceHeartbeatMs ?? TRACE_HEARTBEAT_MS);

  const finish = (): void => {
    clearInterval(heartbeat);
    res.write("event: end\ndata: {}\n\n");
    res.end();
  };

  const unsubscribe = subscribeTrace(runId, {
    onEvent: (event) => res.write(traceFrame(event)),
    onEnd: finish,
  });

  for (const event of withStore(deps.dbPath, (store) => store.listTrace(runId, afterSeq))) {
    res.write(traceFrame(event));
  }

  if (unsubscribe === undefined) {
    finish();
    return;
  }
  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

/** 本地副本里取不到 Review Range 的三档各自对应一句话。这不是服务出错,是代码不在了。 */
const RANGE_DIFF_REJECTION: Record<RangeDiffRejection["reason"], string> = {
  "base-missing": "这一轮的 base commit 已经不在本地副本里,看不了 diff",
  "head-missing": "这一轮的 head commit 已经不在本地副本里(分支删了或者被强推过),看不了 diff",
  "no-merge-base": "base 与 head 没有共同祖先,算不出 Review Range",
};

/** 准备一轮 diff 的结果:解析好的 Review Range,或者一条给人看的拒绝。 */
type RunDiffPreparation = PreparedRange | { ok: false; status: number; error: string };

/**
 * 取一轮 diff 之前要做的全部准备:库里的两端、Forge 上的仓库与 pull request、本地副本
 * 上的两端解析与 merge-base。
 *
 * base 的出处两条链路不同——范围审查记着阶段基准,PR 触发的那一档库里只有 head,base
 * 要去 Forge 上读那个 pull request。取到之后一律按 merge-base 算,与 Reviewer 读的那份
 * 以及 Forge 的 PR 页面是同一个范围。
 */
async function prepareRunDiff(
  deps: WebhookServerDeps,
  runId: number,
): Promise<RunDiffPreparation> {
  const run = withStore(deps.dbPath, (store) => store.getRunRange(runId));
  if (run === undefined) return { ok: false, status: 404, error: "没有这一轮 Review Run" };
  const forge = deps.forges.gitea;
  if (forge === undefined) {
    return { ok: false, status: 503, error: "gitea 没有配置 Forge,取不了 diff" };
  }

  const ref: RepoRef = { owner: run.owner, repo: run.repo };
  let options: RangeDiffOptions;
  try {
    const [repository, credentials, pullRequest] = await Promise.all([
      forge.getRepository(ref),
      forge.cloneCredentials(ref),
      run.baseSha === null
        ? forge.getPullRequest({ ...ref, number: run.pullNumber })
        : null,
    ]);
    options = {
      cacheDir: deps.cacheDir,
      ref,
      cloneUrl: repository.cloneUrl,
      credentials,
      baseSha: run.baseSha ?? pullRequest!.baseSha,
      headSha: run.headSha,
    };
  } catch (error) {
    return { ok: false, status: 502, error: `读不到仓库或取不回代码:${failureText(error)}` };
  }

  try {
    const prepared = await prepareRangeDiff(options);
    if (!prepared.ok) {
      return { ok: false, status: 409, error: RANGE_DIFF_REJECTION[prepared.reason] };
    }
    return prepared;
  } catch (error) {
    return { ok: false, status: 502, error: `取 diff 失败:${failureText(error)}` };
  }
}

/**
 * 一次准备管多久。够一次详情页打开:浏览器对同一站点只开六条连接,几十个文件请求是分
 * 几拨到的,只合并「同时在飞」的那些会让每一拨各做一遍准备。
 *
 * 代价是 PR 触发那一档的 base 跟着 pull request 的 base 分支走,这段时间里 base 分支
 * 前进了的话,范围晚这么久才跟上。用真实时钟:这里量的是过了多久,不是领域时间。
 */
const RUN_DIFF_RANGE_TTL_MS = 10_000;

/** 每一轮最近一次准备。键带上库文件:同一进程里跑多个服务时互不串。 */
const runDiffPreparations = new Map<string, { at: number; pending: Promise<RunDiffPreparation> }>();

/**
 * 一轮的准备工作在这段时间里只做一次(issue #181)。
 *
 * 面板打开一轮详情会按文件发几十个 `?file=` 请求,而这几十个要的准备是同一份:各做一遍
 * 等于同一时刻多出几十次 Gitea 往返与上百个 git 子进程,机器被这批活占满,同一进程里排
 * 在后面的请求(含审查轨迹的 SSE 握手)只能等它干完。
 *
 * 只有成功的那次留下来。失败当场丢掉:并发的那一拨仍旧共用一次,而人重试时重新去取,
 * 不会被一次 Forge 抖动黏住十秒。
 */
function runDiffRange(deps: WebhookServerDeps, runId: number): Promise<RunDiffPreparation> {
  const now = Date.now();
  for (const [stale, entry] of runDiffPreparations) {
    if (now - entry.at >= RUN_DIFF_RANGE_TTL_MS) runDiffPreparations.delete(stale);
  }
  const key = `${deps.dbPath} ${runId}`;
  const cached = runDiffPreparations.get(key);
  if (cached !== undefined) return cached.pending;

  const pending = prepareRunDiff(deps, runId);
  runDiffPreparations.set(key, { at: now, pending });
  void pending.then(
    (prepared) => {
      if (!prepared.ok) runDiffPreparations.delete(key);
    },
    () => runDiffPreparations.delete(key),
  );
  return pending;
}

/**
 * 一轮 Review Run 的完整 diff。不带 `file` 时回文件列表(每个文件带增删行数),带 `file`
 * 时只回那一个文件的 unified diff:面板按文件懒加载,大 diff 因此不必一次全取。
 */
async function handleRunDiff(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  runId: number,
): Promise<void> {
  const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const file = query.get("file");
  const prepared = await runDiffRange(deps, runId);
  if (!prepared.ok) return sendJson(res, prepared.status, { error: prepared.error });

  try {
    if (file === null || file === "") {
      return sendJson(res, 200, {
        baseSha: prepared.mergeBaseSha,
        headSha: prepared.headSha,
        files: await readRangeDiffFiles(prepared),
      });
    }
    return sendJson(res, 200, { path: file, patch: await readRangeFileDiff(prepared, file) });
  } catch (error) {
    return sendJson(res, 502, { error: `取 diff 失败:${failureText(error)}` });
  }
}

/**
 * 手动重跑:对一个阶段开新一轮 Review Run,走既有的跨轮次折叠。不走幂等 claim——
 * 同一 head commit 重复审在这里是合法诉求(spec 原话),claim 只属于 webhook 投递。
 *
 * 两种来源共用这一个端点(issue #176),入参二选一:pull request 阶段给 owner/repo/
 * pullNumber——用名字而非数值 id,时间流里的历史行(含已移除仓库)只有名字;范围审查
 * 阶段给 `rangeReviewId`,在它当前的比较项上再跑一轮。
 */
async function handleRerun(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  triggeredBy: string,
  scope: RepoScope,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = safeParse(body) as {
    owner?: unknown;
    repo?: unknown;
    pullNumber?: unknown;
    rangeReviewId?: unknown;
  } | null;
  if (payload !== null && payload.rangeReviewId !== undefined) {
    const rangeReviewId = payload.rangeReviewId;
    if (typeof rangeReviewId !== "number" || !Number.isSafeInteger(rangeReviewId) || rangeReviewId <= 0) {
      return sendJson(res, 400, { error: "rangeReviewId 要是正整数" });
    }
    return rerunRangeReview(res, deps, rangeReviewId, triggeredBy, scope);
  }
  if (
    payload === null ||
    typeof payload.owner !== "string" ||
    typeof payload.repo !== "string" ||
    typeof payload.pullNumber !== "number" ||
    !Number.isSafeInteger(payload.pullNumber)
  ) {
    return sendJson(res, 400, {
      error:
        'body 要是 {"owner", "repo", "pullNumber"} 形状(pullNumber 是整数),或 {"rangeReviewId"}',
    });
  }
  const { owner, repo, pullNumber } = payload;

  // 目标在请求体里,过滤层看不到,这里自己判:分配外与不存在同形。
  if (!scope.allows(owner, repo)) return sendJson(res, 404, { error: "没有这个仓库" });
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


  const ref = { owner, repo, number: pullNumber };
  let headSha: string;
  try {
    headSha = (await forge.getPullRequest(ref)).headSha;
  } catch {
    return sendJson(res, 404, { error: "PR 读不到:号不对,或 bot 无权限" });
  }
  // 与自动投递调用同一个启动器；快照在 202 响应和后台首批之前已经完整物化。
  let plan: ReviewRunPlan;
  try {
    plan = await buildRunPlan(deps, registered.repoId);
  } catch (error) {
    return sendJson(res, 409, {
      error: `模型覆盖坏了,先改组合再重跑:${error instanceof Error ? error.message : String(error)}`,
    });
  }
  sendJson(res, 202, { pullNumber, headSha });
  void startRun(
    deps,
    forge,
    { platform: "gitea", owner, repo, number: pullNumber, headSha, draft: false, action: "rerun" },
    plan,
    triggeredBy,
  );
}

/**
 * 范围审查阶段的重跑(issue #176):在当前比较项上再跑一轮,新一轮归入同一个范围审查。
 *
 * 比较项取库里那一行,不去 Forge 读容器 PR 的 head:「这个阶段此刻在审什么」的权威就是
 * 这条记录,推进时先推分支再改它。审查完成之后拒绝,与推进同一个理由——终态不再动。
 * 容器 PR 的序号不进响应:它对面板用户透明(CONTEXT.md 容器 PR)。
 */
async function rerunRangeReview(
  res: ServerResponse,
  deps: WebhookServerDeps,
  id: number,
  triggeredBy: string,
  scope: RepoScope,
): Promise<void> {
  const record = withStore(deps.dbPath, (store) => store.getRangeReview(id));
  if (record === undefined || !scope.allows(record.owner, record.repo)) {
    return sendJson(res, 404, { error: "没有这个范围审查" });
  }
  if (record.state !== "in-progress" || record.containerPullNumber === null) {
    return sendJson(res, 409, {
      error:
        record.state === "completed"
          ? "这个范围审查已经审查完成,不再重跑"
          : "这个范围审查没有可用的容器 pull request,重新发起一个",
    });
  }
  const forge = deps.forges.gitea;
  if (forge === undefined) {
    return sendJson(res, 503, { error: "gitea 没有配置 Forge,重跑不了" });
  }
  let plan: ReviewRunPlan;
  try {
    plan = await buildRunPlan(deps, record.repoId);
  } catch (error) {
    return sendJson(res, 409, {
      error: `模型覆盖坏了,先改组合再重跑:${failureText(error)}`,
    });
  }
  sendJson(res, 202, { rangeReviewId: id, headSha: record.comparisonSha });
  void startRun(
    deps,
    forge,
    {
      platform: "gitea",
      owner: record.owner,
      repo: record.repo,
      number: record.containerPullNumber,
      headSha: record.comparisonSha,
      draft: false,
      action: "rerun",
    },
    plan,
    triggeredBy,
    id,
  );
}

/** 处置备注是一句话(CONTEXT.md),给它一个宽松的上限,免得面板变成写长文的地方。 */
const DISPOSITION_NOTE_MAX = 500;

/**
 * 面板处置一条 Finding:resolve / unresolve,可选附一条只存面板的处置备注。
 *
 * 先写 Forge 再落库。Disposition 的权威状态在 Forge 上(ADR 0006),库里那一行只是
 * 缓存;反过来先落库,Forge 那一步失败就留下「面板说已处置、Gitea 上没有」的假象,
 * 而下一轮回填还会把它改回去。Forge 上的 resolver 是服务凭据那个机器人账号,操作人
 * 只记在库里(ADR 0012)。
 */
async function handleDispose(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  findingId: number,
  disposition: "resolved" | "unresolved",
  disposedBy: string,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = body.length === 0 ? {} : safeParse(body);
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return sendJson(res, 400, { error: "body 要是 JSON 对象" });
  }
  const rawNote = (payload as { note?: unknown }).note;
  if (rawNote !== undefined && typeof rawNote !== "string") {
    return sendJson(res, 400, { error: "note 要是字符串" });
  }
  const trimmed = rawNote === undefined ? "" : rawNote.trim();
  if (trimmed.length > DISPOSITION_NOTE_MAX) {
    return sendJson(res, 400, { error: `处置备注最多 ${DISPOSITION_NOTE_MAX} 个字` });
  }
  // 空备注不清掉已有的那条:unresolve 与再次 resolve 都不带备注,备注要留着。
  const note = trimmed === "" ? undefined : trimmed;

  const finding = withStore(deps.dbPath, (store) => store.getFinding(findingId));
  if (finding === undefined) return sendJson(res, 404, { error: "没有这条 Finding" });
  if (finding.commentId === null) {
    return sendJson(res, 409, {
      error: "这条 Finding 只在 review 正文里,没有可处置的行级评论",
    });
  }
  const forge = deps.forges.gitea;
  if (forge === undefined) {
    return sendJson(res, 503, { error: "gitea 没有配置 Forge,处置不了" });
  }
  const ref = { owner: finding.owner, repo: finding.repo };
  try {
    if (disposition === "resolved") await forge.resolveComment(ref, finding.commentId);
    else await forge.unresolveComment(ref, finding.commentId);
  } catch (error) {
    return sendJson(res, 502, {
      error: `Forge 上${disposition === "resolved" ? "处置" : "撤回处置"}失败:${failureText(error)}`,
    });
  }
  const disposedAt = new Date((deps.now ?? Date.now)()).toISOString();
  withStore(deps.dbPath, (store) =>
    store.recordDisposition({
      owner: finding.owner,
      repo: finding.repo,
      commentId: finding.commentId!,
      disposition,
      disposedBy,
      disposedAt,
      ...(note === undefined ? {} : { note }),
    }),
  );
  return sendJson(res, 200, {
    finding: {
      id: finding.id,
      disposition,
      disposedBy,
      disposedAt,
      note: note ?? finding.note,
    },
  });
}

/** 范围审查发起时人填的两端。只收 sha:它同时挡住以 `-` 开头的值被 git 当成选项。 */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

/** 解析失败的三档各自对应一句话,人据此知道是哪一端填错了。 */
const RANGE_REJECTION: Record<Extract<ResolvedRange, { ok: false }>["reason"], string> = {
  "base-unknown": "base 在这个仓库里找不到,确认 commit 已经推上去了",
  "comparison-unknown": "比较项在这个仓库里找不到,确认 commit 已经推上去了",
  "not-descendant": "比较项必须是 base 的后代,而且不能与 base 是同一个 commit",
};

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 发起表单打开时的 base 预填值(issue #177):同一仓库最近一个审查完成的范围审查最后
 * 审到的那个比较项。连续两个阶段因此首尾相接,人不必自己回去找上一段审到哪里。
 *
 * 「最近」按完成时刻算,不按发起先后:先发起的那个完全可能后完成。没有已完成的范围
 * 审查时回 null,表单留空——一个无意义的默认值比空着更容易把人带偏。
 */
function handleRangeReviewPrefill(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
): void {
  const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const owner = query.get("owner");
  const repo = query.get("repo");
  if (owner === null || repo === null) {
    return sendJson(res, 400, { error: "owner 与 repo 都要给" });
  }
  const completed = withStore(deps.dbPath, (store) =>
    store.listRangeReviews({ owner, repo, state: "completed" }),
  );
  let latest: RangeReviewRecord | undefined;
  for (const record of completed) {
    if (latest === undefined || (record.completedAt ?? "") > (latest.completedAt ?? "")) {
      latest = record;
    }
  }
  return sendJson(res, 200, { base: latest?.comparisonSha ?? null });
}

/** commit 选择器一页的提交数上限。人翻页翻的是一段历史,一次给太多只会更难认。 */
const COMMITS_PAGE = 30;
const COMMITS_PAGE_MAX = 100;

/**
 * commit 选择器两个接口的共同前半段:认出是哪个仓库,取到 clone 地址与凭据。
 *
 * 仓库必须已注册,与发起范围审查同一条门禁:未注册的仓库不该因为一次读请求就在服务器
 * 上落一份 clone。前置拒绝时响应已经发出去,回 undefined 让调用方直接返回。
 */
async function resolveRepoGitTarget(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
): Promise<
  { ref: RepoRef; cloneUrl: string; defaultBranch: string; credentials: CloneCredentials } | undefined
> {
  const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const owner = query.get("owner");
  const repo = query.get("repo");
  if (owner === null || repo === null) {
    sendJson(res, 400, { error: "owner 与 repo 都要给" });
    return undefined;
  }
  const registered = withStore(deps.dbPath, (store) => store.listRepos()).some(
    (row) => row.owner === owner && row.repo === repo,
  );
  if (!registered) {
    sendJson(res, 409, { error: "仓库不在注册表里,先注册再读它的分支与提交" });
    return undefined;
  }
  const forge = deps.forges.gitea;
  if (forge === undefined) {
    sendJson(res, 503, { error: "gitea 没有配置 Forge,读不到仓库的分支与提交" });
    return undefined;
  }
  const ref: RepoRef = { owner, repo };
  try {
    const [repository, credentials] = await Promise.all([
      forge.getRepository(ref),
      forge.cloneCredentials(ref),
    ]);
    return {
      ref,
      cloneUrl: repository.cloneUrl,
      defaultBranch: repository.defaultBranch,
      credentials,
    };
  } catch (error) {
    sendJson(res, 502, { error: `读不到仓库或取不回代码:${failureText(error)}` });
    return undefined;
  }
}

/**
 * 仓库的分支列表(issue #178)。commit 选择器的分支下拉读它。
 *
 * 每次都先 fetch(`listBranches`),刚推上去的提交因此立刻选得到。容器 PR 的两条分支
 * 是本工具自己建的,按固定前缀滤掉——它们不是人要审的代码(ADR 0012)。
 */
async function handleRepoBranches(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
): Promise<void> {
  const target = await resolveRepoGitTarget(req, res, deps);
  if (target === undefined) return;

  let names: string[];
  try {
    names = await listBranches({ cacheDir: deps.cacheDir, ...target });
  } catch (error) {
    return sendJson(res, 502, { error: `取不回仓库的分支:${failureText(error)}` });
  }
  const branches = names
    .filter((name) => !isContainerBranch(name))
    .map((name) => ({ name, isDefault: name === target.defaultBranch }));
  return sendJson(res, 200, { branches });
}

/**
 * 一条分支上的提交(issue #178),新的在前,按 `offset` 翻页。
 *
 * 分支查不到就是 404:人手上那份分支列表可能已经过时,而调用方要知道的只是「这条分支
 * 没有了」。
 *
 * 可选的 `base`(issue #179)让每条提交多带一个「是不是 base 的后代」:推进比较项时
 * 选择器据此置灰非后代的行,人在提交之前就知道哪些选择不合法。它与两端一样只收 sha,
 * 这同时挡住以 `-` 开头的值被 git 当成选项;查不到这个 commit 与发起时填错 base 是
 * 同一回事,回同一句话。
 */
async function handleRepoCommits(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
): Promise<void> {
  const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const branch = query.get("branch");
  if (branch === null || branch === "") {
    return sendJson(res, 400, { error: "branch 要给" });
  }
  const offsetRaw = query.get("offset");
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return sendJson(res, 400, { error: "offset 要是非负整数" });
  }
  const limitRaw = query.get("limit");
  const limit = limitRaw === null ? COMMITS_PAGE : Number(limitRaw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > COMMITS_PAGE_MAX) {
    return sendJson(res, 400, { error: `limit 要是 1 到 ${COMMITS_PAGE_MAX} 之间的整数` });
  }
  const base = query.get("base");
  if (base !== null && !COMMIT_SHA.test(base)) {
    return sendJson(res, 400, { error: "base 要是 7 到 40 位的 commit sha" });
  }

  const target = await resolveRepoGitTarget(req, res, deps);
  if (target === undefined) return;

  let listed: BranchCommits;
  try {
    listed = await listBranchCommits({
      cacheDir: deps.cacheDir,
      ...target,
      branch,
      offset,
      limit,
      ...(base === null ? {} : { base }),
    });
  } catch (error) {
    return sendJson(res, 502, { error: `取不回这条分支的提交:${failureText(error)}` });
  }
  if (!listed.ok) {
    return listed.reason === "branch-unknown"
      ? sendJson(res, 404, { error: "这个仓库里没有这条分支" })
      : sendJson(res, 400, { error: RANGE_REJECTION["base-unknown"] });
  }
  // 这一页取满就还有下一页:提交总数要数完整段历史,为一个翻页按钮不值当。
  const nextOffset = listed.commits.length === limit ? offset + limit : null;
  return sendJson(res, 200, { commits: listed.commits, nextOffset });
}

/**
 * 发起一个范围审查(ADR 0012)。
 *
 * 顺序是「先验后写」:解析两端与后代关系、组装运行计划都在碰 Forge 之前完成,填错的
 * 请求因此一条分支都不会留下。落记录先于建分支——分支名由记录 id 推出,而任一步失败
 * 都要有地方记下原因(user story 19)。
 */
async function handleCreateRangeReview(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  createdBy: string,
  scope: RepoScope,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = safeParse(body) as {
    owner?: unknown;
    repo?: unknown;
    title?: unknown;
    base?: unknown;
    comparison?: unknown;
    confirm?: unknown;
  } | null;
  if (
    payload === null ||
    typeof payload.owner !== "string" ||
    typeof payload.repo !== "string" ||
    typeof payload.title !== "string" ||
    typeof payload.base !== "string" ||
    typeof payload.comparison !== "string"
  ) {
    return sendJson(res, 400, {
      error: 'body 要是 {"owner", "repo", "title", "base", "comparison"} 形状的 JSON',
    });
  }
  // 标题是这个阶段在评审记录里的名字(CONTEXT.md 范围审查),空白等于没给。
  const title = payload.title.trim();
  if (title === "") {
    return sendJson(res, 400, { error: "标题必填,发起后不可改" });
  }
  if (!COMMIT_SHA.test(payload.base) || !COMMIT_SHA.test(payload.comparison)) {
    return sendJson(res, 400, { error: "base 与比较项都要是 7 到 40 位的 commit sha" });
  }
  const { owner, repo } = payload;

  // 目标在请求体里,过滤层看不到,这里自己判:分配外与不存在同形。
  if (!scope.allows(owner, repo)) return sendJson(res, 404, { error: "没有这个仓库" });
  const registered = withStore(deps.dbPath, (store) => store.listRepos()).find(
    (row) => row.owner === owner && row.repo === repo,
  );
  if (registered === undefined) {
    return sendJson(res, 409, { error: "仓库不在注册表里,先注册再发起范围审查" });
  }
  const forge = deps.forges.gitea;
  if (forge === undefined) {
    return sendJson(res, 503, { error: "gitea 没有配置 Forge,发起不了范围审查" });
  }

  // 后代关系只有本地 clone 判得了:Gitea 的 compare 端点给不出任意两个 commit 的
  // 祖先关系(ADR 0012)。clone 地址从仓库自己读,这时还没有任何 pull request。
  const ref: RepoRef = { owner, repo };
  let resolved: ResolvedRange;
  try {
    const [repository, credentials] = await Promise.all([
      forge.getRepository(ref),
      forge.cloneCredentials(ref),
    ]);
    resolved = await resolveRange({
      cacheDir: deps.cacheDir,
      ref,
      cloneUrl: repository.cloneUrl,
      credentials,
      base: payload.base,
      comparison: payload.comparison,
    });
  } catch (error) {
    return sendJson(res, 502, { error: `读不到仓库或取不回代码:${failureText(error)}` });
  }
  if (!resolved.ok) {
    return sendJson(res, 400, { error: RANGE_REJECTION[resolved.reason] });
  }
  const { baseSha, comparisonSha } = resolved;

  // 同一 base 不去重,只提醒:确实要并行两个阶段是合法诉求(CONTEXT.md 范围审查)。
  const existing = withStore(deps.dbPath, (store) =>
    store.listRangeReviews({ owner, repo, baseSha, state: "in-progress" }),
  );
  if (existing.length > 0 && payload.confirm !== true) {
    return sendJson(res, 409, {
      error: `这个仓库的同一个 base 上还有 ${existing.length} 个进行中的范围审查`,
      needsConfirmation: true,
      existing,
    });
  }

  // 与投递、重跑同一个启动器:计划在建分支之前固定好,坏组合不会留下半个容器 PR。
  let plan: ReviewRunPlan;
  try {
    plan = await buildRunPlan(deps, registered.repoId);
  } catch (error) {
    return sendJson(res, 409, {
      error: `模型覆盖坏了,先改组合再发起:${failureText(error)}`,
    });
  }

  const createdAt = new Date((deps.now ?? Date.now)()).toISOString();
  const id = withStore(deps.dbPath, (store) =>
    store.createRangeReview({
      repoId: registered.repoId,
      owner,
      repo,
      title,
      baseSha,
      comparisonSha,
      createdBy,
      createdAt,
    }),
  );
  const branches = containerBranches(id);
  const built: string[] = [];
  let containerPullNumber: number;
  try {
    await forge.createBranch(ref, branches.base, baseSha);
    built.push(branches.base);
    await forge.createBranch(ref, branches.head, comparisonSha);
    built.push(branches.head);
    containerPullNumber = await forge.createPullRequest(ref, {
      head: branches.head,
      base: branches.base,
      title: containerPullRequestTitle(baseSha, comparisonSha),
      body: containerPullRequestBody(
        // 范围审查没有自己的页面(issue #180),点进去的是它这个阶段的详情页。
        `${deps.baseUrl}/${deps.panelPrefix}/stages/range:${id}`,
      ),
    });
  } catch (error) {
    const failure = failureText(error);
    // 已经建出来的分支收回去:半建的分支留在仓库里,人重试时看到的是两处残留。
    // 删失败不覆盖原因——原因是「为什么建不出来」,那才是要排查的东西。
    for (const branch of built) {
      await forge.deleteBranch(ref, branch).catch(() => undefined);
    }
    withStore(deps.dbPath, (store) => store.failRangeReview(id, failure));
    return sendJson(res, 502, {
      error: `在 Forge 上建容器 PR 失败:${failure}`,
      rangeReviewId: id,
    });
  }

  const rangeReview = withStore(deps.dbPath, (store) => {
    store.attachRangeReviewContainer(id, containerPullNumber);
    return store.getRangeReview(id)!;
  });
  // 先回 202 再开跑:一轮审查要跑上几分钟,人等的是「已经在跑了」这个回执。
  sendJson(res, 202, { rangeReview });
  void startRun(
    deps,
    forge,
    {
      platform: "gitea",
      owner,
      repo,
      number: containerPullNumber,
      headSha: comparisonSha,
      draft: false,
      action: "range-review",
    },
    plan,
    createdBy,
    id,
  );
}

/**
 * 推进比较项(issue #157)。
 *
 * 校验只要求新比较项是 base 的后代,不要求是上一个比较项的后代:作者 rebase 之后新的
 * 比较项对旧的就是旁支,要求后者会把人挡回去重开一个阶段(CONTEXT.md 比较项)。
 *
 * 先推分支再改记录:分支在 Forge 上,是这个阶段「当前在审什么」的对外事实,推不上去时
 * 记录跟着走就是在说一件没发生的事。推 head 分支会投一次 `synchronized`,那条投递按
 * 分支前缀丢掉(ADR 0012),一次推进只跑一轮。
 */
async function handleAdvanceRangeReview(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  id: number,
  advancedBy: string,
): Promise<void> {
  const body = await readBody(req, res);
  if (body === undefined) return;
  const payload = safeParse(body) as { comparison?: unknown } | null;
  if (payload === null || typeof payload.comparison !== "string") {
    return sendJson(res, 400, { error: 'body 要是 {"comparison"} 形状的 JSON' });
  }
  if (!COMMIT_SHA.test(payload.comparison)) {
    return sendJson(res, 400, { error: "比较项要是 7 到 40 位的 commit sha" });
  }

  const record = withStore(deps.dbPath, (store) => store.getRangeReview(id));
  if (record === undefined) {
    return sendJson(res, 404, { error: "没有这个范围审查" });
  }
  if (record.state !== "in-progress" || record.containerPullNumber === null) {
    return sendJson(res, 409, {
      error:
        record.state === "completed"
          ? "这个范围审查已经审查完成,比较项不再推进"
          : "这个范围审查没有可用的容器 pull request,重新发起一个",
    });
  }
  const forge = deps.forges.gitea;
  if (forge === undefined) {
    return sendJson(res, 503, { error: "gitea 没有配置 Forge,推进不了比较项" });
  }

  const ref: RepoRef = { owner: record.owner, repo: record.repo };
  let resolved: ResolvedRange;
  let cloneUrl: string;
  let credentials: CloneCredentials;
  try {
    const [repository, cloneCredentials] = await Promise.all([
      forge.getRepository(ref),
      forge.cloneCredentials(ref),
    ]);
    cloneUrl = repository.cloneUrl;
    credentials = cloneCredentials;
    resolved = await resolveRange({
      cacheDir: deps.cacheDir,
      ref,
      cloneUrl,
      credentials,
      base: record.baseSha,
      comparison: payload.comparison,
    });
  } catch (error) {
    return sendJson(res, 502, { error: `读不到仓库或取不回代码:${failureText(error)}` });
  }
  if (!resolved.ok) {
    return sendJson(res, 400, { error: RANGE_REJECTION[resolved.reason] });
  }
  const { comparisonSha } = resolved;

  // 计划先固定好,与投递、重跑、发起同一个启动器。
  let plan: ReviewRunPlan;
  try {
    plan = await buildRunPlan(deps, record.repoId);
  } catch (error) {
    return sendJson(res, 409, {
      error: `模型覆盖坏了,先改组合再推进:${failureText(error)}`,
    });
  }

  try {
    await pushBranch({
      cacheDir: deps.cacheDir,
      ref,
      cloneUrl,
      credentials,
      branch: record.headBranch,
      sha: comparisonSha,
    });
  } catch (error) {
    const failure = failureText(error);
    // 状态不动:容器 PR 还在,人改完分支保护再点一次就该继续。
    withStore(deps.dbPath, (store) => store.recordRangeReviewForgeFailure(id, failure));
    return sendJson(res, 502, {
      error: `把容器 PR 的 head 分支推到新比较项失败:${failure}`,
    });
  }

  const advancedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const rangeReview = withStore(deps.dbPath, (store) => {
    store.advanceRangeReview({ id, comparisonSha, advancedBy, advancedAt });
    return store.getRangeReview(id)!;
  });
  // 与发起同一个回执:先回 202 再开跑,人等的是「已经在跑了」。
  sendJson(res, 202, { rangeReview });
  void startRun(
    deps,
    forge,
    {
      platform: "gitea",
      owner: record.owner,
      repo: record.repo,
      number: record.containerPullNumber,
      headSha: comparisonSha,
      draft: false,
      action: "range-review",
    },
    plan,
    advancedBy,
    id,
  );
}

/**
 * 标记审查完成(issue #158)。
 *
 * 一个阶段的终态由人给出:容器 PR 关闭、两条分支删除、记录记下完成人与时刻,并按
 * ADR 0006 的 `closed` 时机做一次全量回填——从此这个阶段上仍然 unknown 的 Finding 进
 * 处置率的分母。PR 触发那条链路的同一个动作来自 pull request 自己的关闭事件。
 *
 * 先关 PR 再删分支:分支还挂着一个开着的 PR 时 Gitea 拒绝删。任一步失败只记原因、状态
 * 不动,人改完权限再点一次即可;终态记在最后,容器 PR 还开着就写完成会让人再也推不动
 * 比较项,而仓库里那两条分支还留着。
 */
async function handleCompleteRangeReview(
  res: ServerResponse,
  deps: WebhookServerDeps,
  id: number,
  completedBy: string,
): Promise<void> {
  const record = withStore(deps.dbPath, (store) => store.getRangeReview(id));
  if (record === undefined) {
    return sendJson(res, 404, { error: "没有这个范围审查" });
  }
  if (record.state !== "in-progress" || record.containerPullNumber === null) {
    return sendJson(res, 409, {
      error:
        record.state === "completed"
          ? "这个范围审查已经审查完成"
          : "这个范围审查没有容器 pull request 可收尾",
    });
  }
  const forge = deps.forges.gitea;
  if (forge === undefined) {
    return sendJson(res, 503, { error: "gitea 没有配置 Forge,收不了尾" });
  }

  const ref: RepoRef = { owner: record.owner, repo: record.repo };
  const container: PullRequestRef = { ...ref, number: record.containerPullNumber };
  try {
    await forge.closePullRequest(container);
    await forge.deleteBranch(ref, record.headBranch);
    await forge.deleteBranch(ref, record.baseBranch);
    await runClosedBackfill(deps, forge, container);
  } catch (error) {
    const failure = failureText(error);
    withStore(deps.dbPath, (store) => store.recordRangeReviewForgeFailure(id, failure));
    return sendJson(res, 502, {
      error: `在 Forge 上收尾容器 pull request 失败:${failure}`,
    });
  }

  const completedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const rangeReview = withStore(deps.dbPath, (store) => {
    store.completeRangeReview({ id, completedBy, completedAt });
    return store.getRangeReview(id)!;
  });
  return sendJson(res, 200, { rangeReview });
}

/** 一天的毫秒数,处置率页的默认时间窗取最近 30 天。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 处置率统计与库体量。时间窗缺省取最近 30 天;口径全在 `store.dispositionStats`
 * (仓库 × category)与 `store.modelParticipation`(模型的参与条数),ADR 0006 与
 * 0015,这里只做参数与打包——页面矩阵与 API 的数字必须同源。
 */
function handleStats(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  scope: RepoScope,
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

  const { cells: allCells, models, usage, tables } = withStore(deps.dbPath, (store) => ({
    cells: store.dispositionStats(from, to),
    models: store.modelParticipation(from, to),
    usage: store.usageStats(from, to) ?? null,
    tables: store.tableCounts(),
  }));
  let fileBytes = 0;
  try {
    fileBytes = statSync(deps.dbPath).size;
  } catch {
    // 库文件还没建出来:没有一次投递的全新部署,体量就是 0。
  }
  // 矩阵一行一个仓库,分配外的那些直接不给:页面上的数字要与人看得到的列表对得上。
  const cells = allCells.filter((cell) => scope.allows(cell.owner, cell.repo));
  return sendJson(res, 200, { from, to, cells, models, usage, database: { fileBytes, tables } });
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

/**
 * 正在后台准备的工作副本,按缓存目录与仓库名做键(issue #184)。重试入口据此告诉人
 * 「正在准备中」;目录本身的互斥与移除前的等待在 `git/worktree.ts` 里。
 */
const preparingWorktrees = new Map<string, Promise<void>>();

function worktreeKey(cacheDir: string, ref: RepoRef): string {
  return `${cacheDir}\u0000${ref.owner}\u0000${ref.repo}`;
}

/**
 * 后台把仓库的工作副本备好(issue #184)。clone 一个大仓库是分钟级的事,注册请求不等
 * 它;备好之后的 Review Run、diff、分支列表与提交列表都落在这份副本上,只 fetch。
 *
 * 准备中途仓库被移除时注册表那一行已经不在,落库改不动任何行——移除会等这一次跑完再
 * 删目录,副本不会留成孤儿。
 */
async function prepareWorktreeInBackground(
  deps: WebhookServerDeps,
  repoId: number,
  ref: RepoRef,
): Promise<void> {
  let failure: string | undefined;
  try {
    const forge = deps.forges.gitea;
    if (forge === undefined) throw new Error("gitea 没有配置 Forge,取不回代码");
    const [repository, credentials] = await Promise.all([
      forge.getRepository(ref),
      forge.cloneCredentials(ref),
    ]);
    await ensureWorktree({
      cacheDir: deps.cacheDir,
      ref,
      cloneUrl: repository.cloneUrl,
      credentials,
    });
  } catch (error) {
    failure = failureText(error);
  }

  try {
    withStore(deps.dbPath, (store) =>
      store.setRepoWorktree(repoId, {
        state: failure === undefined ? "ready" : "failed",
        failure: failure ?? null,
        checkedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      }),
    );
  } catch (error) {
    // 状态写不进去只影响面板显示,副本备成没备成已成事实。这是个后台任务,把未处理的
    // 拒绝抛出去会带走整个进程。
    console.error(`工作副本状态落库失败:${ref.owner}/${ref.repo}:${failureText(error)}`);
  }

  if (deps.onWorktreePrepared !== undefined) {
    deps.onWorktreePrepared(repoId, failure);
  } else if (failure !== undefined) {
    console.error(`工作副本准备失败:${ref.owner}/${ref.repo}:${failure}`);
  }
}

/**
 * 把一次工作副本准备排进后台并当场把状态记成准备中。同一个副本目录已经在准备时返回
 * false,调用方据此告诉人「正在准备中」。
 */
function startWorktreePreparation(
  deps: WebhookServerDeps,
  repoId: number,
  ref: RepoRef,
): boolean {
  const key = worktreeKey(deps.cacheDir, ref);
  if (preparingWorktrees.has(key)) return false;
  withStore(deps.dbPath, (store) =>
    store.setRepoWorktree(repoId, { state: "preparing", failure: null, checkedAt: null }),
  );
  const running = prepareWorktreeInBackground(deps, repoId, ref).finally(() => {
    preparingWorktrees.delete(key);
  });
  preparingWorktrees.set(key, running);
  return true;
}

/**
 * 重新准备工作副本(issue #184)。第一次没备成、或缓存目录被清掉之后,人在仓库页点它;
 * 权限与注册、移除同一格(`repo:write`)。
 */
function handlePrepareWorktree(
  res: ServerResponse,
  deps: WebhookServerDeps,
  repoId: number,
): void {
  const record = withStore(deps.dbPath, (store) => store.getRepo(repoId));
  if (record === undefined) {
    return sendJson(res, 404, { error: `没有 repo id 为 ${repoId} 的注册仓库` });
  }
  const started = startWorktreePreparation(deps, repoId, {
    owner: record.owner,
    repo: record.repo,
  });
  if (!started) return sendJson(res, 409, { error: "工作副本正在准备中,等它跑完再试" });
  return sendJson(res, 202, { state: "preparing" });
}

async function handleRegister(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookServerDeps,
  hookManager: GiteaHookManager | undefined,
  caller: PanelCaller,
): Promise<void> {
  if (!(await setupStatus(deps)).reviewConfigurationReady) {
    return sendJson(res, 409, {
      error: "审查配置尚未就绪，请先到审查策略保存至少一个当前可用模型",
      action: "/settings",
    });
  }
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

  // 模型覆盖跟随注册一起写入，省略即跟随全局；非空覆盖在任何 Gitea 副作用前重查。
  let reviewersJson: string | undefined;
  if (payload.reviewers !== undefined) {
    const context = `${ref.owner}/${ref.repo} 的模型覆盖`;
    const parsed = parseReviewerSpecs(payload.reviewers, context);
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
    if (!await ensureModelCombinationAvailable(res, deps, parsed.reviewers, context)) return;
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
  const registered = withStore(deps.dbPath, (store) =>
    store.registerRepo({
      repoId,
      owner: ref.owner,
      repo: ref.repo,
      generation,
      key,
      ...(reviewersJson === undefined ? {} : { reviewersJson }),
      // 注册者立刻看得到自己接进来的仓库。系统管理员不受分配限制,不留这一行。
      ...(caller.isSystemAdmin ? {} : { assignTo: caller.username }),
    }),
  );
  if (!registered) {
    return sendJson(res, 409, { error: "模型服务状态已经变化，请重新选择仓库模型覆盖" });
  }
  try {
    await hookManager.ensureHook(ref, { url: hookUrl(deps.baseUrl, generation), key });
  } catch (error) {
    withStore(deps.dbPath, (store) => store.removeRepo(repoId));
    return sendJson(res, 502, {
      error: `Gitea 建 hook 失败:${error instanceof Error ? error.message : String(error)}`,
    });
  }
  // 注册到此为止就成了,工作副本在后台备(issue #184):clone 与它的失败都不该让人在
  // 接入仓库这一步等着。状态落库,仓库页显示准备中 / 就绪 / 失败并给得出重试入口。
  startWorktreePreparation(deps, repoId, ref);
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

  // 工作副本随注册一起走(issue #184)。仓库改过名时两个名字下各可能有一份,现名与
  // 注册时的名字各删一次;已经不在的那一份删起来是空操作。目录上还有准备在跑时
  // `removeWorktree` 自己会等它跑完。
  for (const target of [ref, { owner: record.owner, repo: record.repo }]) {
    await removeWorktree(deps.cacheDir, target);
  }
  return send(res, 204);
}

/**
 * 改写模型覆盖：全量替换 reviewers 列表，null 即清除并跟随全局。清除永远可做；非空组合
 * 在落库前按当前模型服务投影重新校验，不能只信浏览器里的候选状态。
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
    const context = `${record.owner}/${record.repo} 的模型覆盖`;
    const parsed = parseReviewerSpecs(payload.reviewers, context);
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
    if (!await ensureModelCombinationAvailable(res, deps, parsed.reviewers, context)) return;
    reviewersJson = parsed.reviewersJson;
  }
  const saved = withStore(deps.dbPath, (store) => store.setRepoReviewers(repoId, reviewersJson));
  if (!saved) {
    return sendJson(res, 409, { error: "模型服务状态已经变化，请重新选择仓库模型覆盖" });
  }
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
  // 进程重启会中断后台的工作副本准备(issue #184),那些行没有谁再去改它。启动时改判
  // 失败,面板因此显示得出结果、也给得出重试入口。
  withStore(deps.dbPath, (store) =>
    store.failInterruptedWorktrees(
      "服务重启,上一次准备没跑完",
      new Date((deps.now ?? Date.now)()).toISOString(),
    ),
  );
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
        const requestId = randomBytes(8).toString("hex");
        console.error(`[panel] request ${requestId} failed:`, error);
        if (!res.headersSent) {
          sendJson(res, 500, {
            error: "内部错误，请按 request id 查看服务日志",
            requestId,
          });
        }
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
