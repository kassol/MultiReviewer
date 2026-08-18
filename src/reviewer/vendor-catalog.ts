/**
 * 厂商目录:某一家模型厂商自己公布的模型清单,用来补远程目录仍缺的模型。
 *
 * 这轮只接 OpenRouter。13 家实测里只有它免鉴权就给全量,而且响应自带单价与上下文窗口
 * (`docs/research/vendor-model-catalog-apis.md`):接一家要 key 的会让目录加载反过来依赖
 * 凭据表,「还没配凭据也能看见完整目录」随之失效;缺单价的行会让 Review Run 成本恒为零。
 *
 * 一家一个实现,没有注册表、没有配置项、面板上没有开关。真要接第二家时,这里多一个对象、
 * `catalog.ts` 那边多问它一次,比先造一层注册表便宜。
 */

/** 模型标识 `provider:model` 的前半段,与 Pi 的 provider 登记 id 同名。 */
const OPENROUTER_PROVIDER = "openrouter";

/** OpenRouter 的 v1,与远程目录落盘里那些 OpenRouter 行写的是同一个。 */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * 官网单价是「每 token 多少美元」的字符串,而落盘那一份是每百万 token。差的就是这个
 * 10^6:不换算的话 Review Run 的成本会小六个数量级,统计上等于没花钱。
 */
const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * 官网不给 `max_completion_tokens` 时的回落。Pi 内置表里这样的行(实测 31 条)填的也是
 * 这个数,而 `maxTokens` 在 Pi 的模型类型里是必填的。
 */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * 补进落盘的一行模型。字段形状取自远程目录落进 `models-store.json` 的那些 OpenRouter 行,
 * Reviewer 子进程照它建出模型。
 *
 * 不带 `compat`:pi-ai 在模型没写这一项时按 provider 与 baseUrl 自己推
 * (`api/openai-completions.js` 的 `detectCompat`),推出来的正是远程目录那些行里写着的
 * `thinkingFormat: "openrouter"`、以及 anthropic 那几家的 `cacheControlFormat`。显式抄一份
 * 等于把上游的判断冻在落盘里,上游改了这边还盖着旧的。
 */
export type VendorModel = {
  id: string;
  name: string;
  api: "openai-completions";
  baseUrl: string;
  provider: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

/** 一家厂商的目录。一家一个实现。 */
export type VendorCatalog = {
  provider: string;
  /** 拉一份现货清单。非 2xx、超时、响应不像目录都算没拉到,回 undefined。 */
  fetchModels: (timeoutMs: number) => Promise<VendorModel[] | undefined>;
};

/** 官网响应里本实现读的那几项,字段名照抄官网。 */
type OpenRouterEntry = {
  id: string;
  name: string;
  context_length: number;
  architecture?: { input_modalities?: string[] };
  pricing: Record<string, string | undefined>;
  top_provider?: { context_length?: number; max_completion_tokens?: number };
  supported_parameters?: string[];
};

/**
 * 认得出的那些行。字段缺斤少两的一律跳过而不是补默认值:落盘那一行是子进程建模型的全部
 * 依据,猜出来的上下文窗口或单价比少一个模型难查得多。
 */
function isOpenRouterEntry(value: unknown): value is OpenRouterEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<OpenRouterEntry>;
  return (
    typeof entry.id === "string" &&
    entry.id !== "" &&
    typeof entry.name === "string" &&
    typeof entry.context_length === "number" &&
    typeof entry.pricing === "object" &&
    entry.pricing !== null &&
    Number.isFinite(Number(entry.pricing.prompt)) &&
    Number.isFinite(Number(entry.pricing.completion))
  );
}

function toVendorModel(entry: OpenRouterEntry): VendorModel {
  const perMillion = (price: string | undefined): number =>
    Number.isFinite(Number(price)) ? Number(price) * TOKENS_PER_PRICE_UNIT : 0;
  const modalities = entry.architecture?.input_modalities ?? [];
  return {
    id: entry.id,
    name: entry.name,
    api: "openai-completions",
    baseUrl: OPENROUTER_BASE_URL,
    provider: OPENROUTER_PROVIDER,
    // 官网把「这个模型能不能思考」放在 supported_parameters 里,顶层那个 reasoning 说的是
    // 默认档位与可选档位。
    reasoning: entry.supported_parameters?.includes("reasoning") ?? false,
    // Pi 的模型只认 text 与 image 两种输入,官网还会报 file / audio / video。全部现货都收
    // 文本,图生图之类的能不能当 Reviewer 由 Review Run 自己失败并写原因(issue #75)。
    input: modalities.includes("image") ? ["text", "image"] : ["text"],
    cost: {
      input: perMillion(entry.pricing.prompt),
      output: perMillion(entry.pricing.completion),
      cacheRead: perMillion(entry.pricing["input_cache_read"]),
      cacheWrite: perMillion(entry.pricing["input_cache_write"]),
    },
    // 顶层那个 context_length 是全部上游里最大的一个,`top_provider` 才是实际会被路由到的
    // 那家的窗口。Pi 内置表取的也是后者。
    contextWindow: entry.top_provider?.context_length ?? entry.context_length,
    maxTokens: entry.top_provider?.max_completion_tokens ?? DEFAULT_MAX_TOKENS,
  };
}

/**
 * 拉 OpenRouter 的现货清单。不带 limit 与 offset:它默认就给全量(实测 414 个),带上分页
 * 参数反而要自己翻页。不带凭据:目录加载不读凭据表,读了就等于「还没配凭据就看不见目录」。
 */
async function fetchOpenRouterModels(timeoutMs: number): Promise<VendorModel[] | undefined> {
  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { data?: unknown } | null;
    const entries = body?.data;
    if (!Array.isArray(entries)) return undefined;
    const models = entries.filter(isOpenRouterEntry).map(toVendorModel);
    // 一行都认不出来的响应不是目录,当作没拉到:补零行与拉失败对目录的后果相同,而报成
    // 「拉到了」会让运维照着状态去查别处。
    return models.length === 0 ? undefined : models;
  } catch {
    return undefined;
  }
}

export const openRouterCatalog: VendorCatalog = {
  provider: OPENROUTER_PROVIDER,
  fetchModels: fetchOpenRouterModels,
};
