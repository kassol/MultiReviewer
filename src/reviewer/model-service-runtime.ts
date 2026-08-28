import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelIdentity } from "../config.ts";
import {
  loadPiProviderCatalog,
  resolvePiBuiltinProviderTarget,
  type LoadOptions,
  type PiBuiltinProviderTarget,
  type PiProviderCatalog,
} from "./catalog.ts";
import {
  CUSTOM_PROVIDER_APIS,
  isolatedModelRuntime,
  ZERO_MODEL_COST,
  type RuntimeApi,
  type RuntimeModelCompat,
  type RuntimeThinkingLevelMap,
} from "./model-runtime.ts";

export type CustomModelServiceCandidate = {
  kind: "custom";
  provider: string;
  baseUrl: string;
  api: (typeof CUSTOM_PROVIDER_APIS)[number];
  credential: string;
};

export type BuiltinModelServiceCandidate = {
  kind: "builtin";
  provider: string;
  credential: string;
};

export type ModelServiceCandidate =
  | BuiltinModelServiceCandidate
  | CustomModelServiceCandidate;

export type TrustedModelFields = {
  name?: string;
  api?: string;
  baseUrl?: string;
  input?: readonly ("text" | "image")[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: RuntimeThinkingLevelMap;
  compat?: RuntimeModelCompat;
};

export type TrustedModelFieldSource = "service-interface" | "pi-catalog" | "service-target";
export type TrustedModelFieldSources = Partial<
  Record<keyof TrustedModelFields, TrustedModelFieldSource>
>;

export type DiscoveredModel = {
  identity: string;
  provider: string;
  id: string;
  fields: TrustedModelFields;
  fieldSources?: TrustedModelFieldSources;
};

export type ModelOperationFailure = {
  code:
    | "invalid-base-url"
    | "http-error"
    | "invalid-response"
    | "empty-catalog"
    | "timeout"
    | "request-error"
    | "provider-not-found"
    | "model-unconstructable"
    | "inference-failed";
  message: string;
  status?: number;
};

export type ModelDiscoveryResult =
  | { ok: true; models: DiscoveredModel[]; ignoredCount: number }
  | { ok: false; failure: ModelOperationFailure };

export type DiscoverModelsOptions = LoadOptions & {
  signal?: AbortSignal;
};

export const MODEL_RUNTIME_BASELINE = {
  input: ["text"] as const,
  reasoning: false,
  contextWindow: 128_000,
  maxTokens: 16_000,
} as const;

export type RuntimeModel = {
  provider: string;
  id: string;
  name: string;
  api: RuntimeApi;
  baseUrl: string;
  input: readonly ("text" | "image")[];
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: RuntimeThinkingLevelMap;
  compat?: RuntimeModelCompat;
  sources: {
    name: "trusted" | "model-id";
    api: "service-target";
    baseUrl: "service-target";
    input: "trusted" | "runtime-baseline";
    reasoning: "trusted" | "runtime-baseline";
    contextWindow: "trusted" | "runtime-baseline";
    maxTokens: "trusted" | "runtime-baseline";
    thinkingLevelMap?: "trusted";
    compat?: "trusted";
  };
};

export type SynthesizedRuntimeModel = {
  discovery: DiscoveredModel;
  runtime: RuntimeModel;
};

export type RuntimeSynthesisResult =
  | { ok: true; value: SynthesizedRuntimeModel }
  | { ok: false; failure: ModelOperationFailure };

export type InferenceValidationResult =
  | { ok: true }
  | { ok: false; failure: ModelOperationFailure };

export type InferenceValidationOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;

export function normalizeModelServiceBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return undefined;
    }
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

const FAILURE_EXCERPT_LENGTH = 512;

function redactFailureText(value: unknown, secrets: readonly string[]): string {
  let text = String(value instanceof Error ? value.message : value);
  for (const secret of secrets) {
    if (secret !== "") text = text.replaceAll(secret, "[REDACTED]");
  }
  text = text
    .replace(/\bBearer\s+[^\s"',;}]+/giu, "Bearer [REDACTED]")
    .replace(
      /\b(authorization|api[-_ ]?key|credential|ciphertext|master[-_ ]?key)\b\s*[:=]\s*[^,;}\n]+/giu,
      "$1: [REDACTED]",
    );
  return text.slice(0, FAILURE_EXCERPT_LENGTH);
}

function failure(code: ModelOperationFailure["code"], message: string): ModelDiscoveryResult {
  return { ok: false, failure: { code, message } };
}

function discoveredModel(candidate: ModelServiceCandidate, value: DiscoveredModel | string): DiscoveredModel {
  if (typeof value !== "string") return value;
  return {
    identity: modelIdentity({ provider: candidate.provider, model: value }),
    provider: candidate.provider,
    id: value,
    fields: {},
  };
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function trustedInput(value: unknown): value is readonly ("text" | "image")[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => entry === "text" || entry === "image")
  );
}

function customModelVendor(modelId: string): "openai" | "anthropic" | "google" | undefined {
  const bareId = modelId.slice(modelId.lastIndexOf("/") + 1).toLowerCase();
  if (/^(?:gpt(?:[-.]|$)|o\d+(?:[-.]|$))/u.test(bareId)) return "openai";
  if (/^claude(?:[-.]|$)/u.test(bareId)) return "anthropic";
  if (/^gemini(?:[-.]|$)/u.test(bareId)) return "google";
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

async function piModelsForCustomCatalog(
  modelIds: readonly string[],
  options: DiscoverModelsOptions,
): Promise<Map<string, PiProviderCatalog["models"][number]>> {
  const vendors = new Set(modelIds.map(customModelVendor).filter((value) => value !== undefined));
  const models = new Map<string, PiProviderCatalog["models"][number]>();
  for (const vendor of vendors) {
    try {
      const catalog = await loadPiProviderCatalog(vendor, { ...options, allowNetwork: false });
      for (const model of catalog?.models ?? []) models.set(`${vendor}:${model.id}`, model);
    } catch {
      // Pi 目录只补充信息；读不到时保留服务接口的发现结果。
    }
  }
  return models;
}

export function synthesizeRuntimeModel(
  candidate: ModelServiceCandidate,
  modelOrId: DiscoveredModel | string,
  builtinTarget?: PiBuiltinProviderTarget,
): RuntimeSynthesisResult {
  const discovery = discoveredModel(candidate, modelOrId);
  if (discovery.provider !== candidate.provider || discovery.id.trim() === "") {
    return {
      ok: false,
      failure: {
        code: "model-unconstructable",
        message: `模型服务 ${candidate.provider} 无法构造 ${discovery.id || "<empty>"}`,
      },
    };
  }

  const fields = discovery.fields;
  const target = candidate.kind === "builtin" ? builtinTarget : candidate;
  const targetApi = target?.api;
  const targetBaseUrl = target?.baseUrl;
  const baseUrl = typeof targetBaseUrl === "string" ? normalizeModelServiceBaseUrl(targetBaseUrl) : undefined;
  const usableApi =
    typeof targetApi === "string" &&
    targetApi !== "" &&
    (candidate.kind === "builtin" || CUSTOM_PROVIDER_APIS.includes(candidate.api));
  if (baseUrl === undefined || !usableApi) {
    return {
      ok: false,
      failure: {
        code: "model-unconstructable",
        message: `模型服务 ${candidate.provider} 缺少可用的地址或接口协议`,
      },
    };
  }

  // @anthropic-ai/sdk 把 /v1/messages 整段拼在 baseURL 后面:存库与发现都用带 /v1 的
  // 地址(与 OpenAI 系同一种填法),注册运行时前剥掉尾部 /v1,否则拼成 /v1/v1/messages。
  const runtimeBaseUrl = targetApi === "anthropic-messages" ? baseUrl.replace(/\/v1$/u, "") : baseUrl;
  const name = typeof fields.name === "string" && fields.name.trim() !== "" ? fields.name : discovery.id;
  const input = trustedInput(fields.input) ? fields.input : MODEL_RUNTIME_BASELINE.input;
  const reasoning = typeof fields.reasoning === "boolean" ? fields.reasoning : MODEL_RUNTIME_BASELINE.reasoning;
  const contextWindow = positiveInteger(fields.contextWindow)
    ? fields.contextWindow
    : MODEL_RUNTIME_BASELINE.contextWindow;
  const maxTokens = positiveInteger(fields.maxTokens) ? fields.maxTokens : MODEL_RUNTIME_BASELINE.maxTokens;
  const thinkingLevelMap = fields.thinkingLevelMap;
  const compat = fields.compat;

  return {
    ok: true,
    value: {
      discovery,
      runtime: {
        provider: candidate.provider,
        id: discovery.id,
        name,
        api: targetApi,
        baseUrl: runtimeBaseUrl,
        input,
        reasoning,
        contextWindow,
        maxTokens,
        ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
        ...(compat === undefined ? {} : { compat }),
        sources: {
          name: name === fields.name ? "trusted" : "model-id",
          api: "service-target",
          baseUrl: "service-target",
          input: input === fields.input ? "trusted" : "runtime-baseline",
          reasoning: typeof fields.reasoning === "boolean" ? "trusted" : "runtime-baseline",
          contextWindow: contextWindow === fields.contextWindow ? "trusted" : "runtime-baseline",
          maxTokens: maxTokens === fields.maxTokens ? "trusted" : "runtime-baseline",
          ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap: "trusted" as const }),
          ...(compat === undefined ? {} : { compat: "trusted" as const }),
        },
      },
    },
  };
}

async function discoverBuiltinModels(
  candidate: BuiltinModelServiceCandidate,
  options: DiscoverModelsOptions,
): Promise<ModelDiscoveryResult> {
  try {
    const catalog = await loadPiProviderCatalog(candidate.provider, options);
    if (catalog === undefined) {
      return failure("provider-not-found", `Pi 模型目录里没有 ${candidate.provider} 这一家`);
    }

    const models: DiscoveredModel[] = [];
    const seen = new Set<string>();
    let ignoredCount = 0;
    for (const model of catalog.models) {
      const id = model.id.trim();
      if (id === "") {
        ignoredCount += 1;
        continue;
      }
      const identity = modelIdentity({ provider: candidate.provider, model: id });
      if (seen.has(identity)) continue;
      seen.add(identity);
      const fields: TrustedModelFields = {
        ...(model.name.trim() === "" ? {} : { name: model.name }),
        ...(model.api === "" ? {} : { api: model.api }),
        ...(normalizeModelServiceBaseUrl(model.baseUrl) === undefined ? {} : { baseUrl: model.baseUrl }),
        ...(trustedInput(model.input) ? { input: model.input } : {}),
        reasoning: model.reasoning,
        ...(positiveInteger(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
        ...(positiveInteger(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
        ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: model.thinkingLevelMap }),
        ...(model.compat === undefined ? {} : { compat: model.compat }),
      };
      models.push({ identity, provider: candidate.provider, id, fields });
    }
    if (models.length === 0) {
      return failure("empty-catalog", `Pi 模型目录里的 ${candidate.provider} 没有可用 model id`);
    }
    return { ok: true, models, ignoredCount };
  } catch (error) {
    const detail = redactFailureText(error, [candidate.credential]);
    return failure(
      "request-error",
      `Pi 模型目录读取 ${candidate.provider} 失败` + (detail === "" ? "" : ` — ${detail}`),
    );
  }
}

/** Anthropic 端点的日期版本头,值取自官方文档当前版本。 */
const ANTHROPIC_API_VERSION = "2023-06-01";

/**
 * 发现请求按接口协议分派。anthropic-messages 的端点不认 Bearer 形式的 api key,
 * 鉴权走 `x-api-key` 加 `anthropic-version`;再带 `limit=1000`——官方 `/v1/models`
 * 默认一页只回 20 条。两种协议的响应同为 `{data:[{id,…}]}`,解析共用一套。
 */
function discoveryRequest(
  baseUrl: string,
  api: (typeof CUSTOM_PROVIDER_APIS)[number],
  credential: string,
): { url: string; headers: Record<string, string> } {
  if (api === "anthropic-messages") {
    return {
      url: `${baseUrl}/models?limit=1000`,
      headers: {
        accept: "application/json",
        "x-api-key": credential,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
    };
  }
  return {
    url: `${baseUrl}/models`,
    headers: { accept: "application/json", authorization: `Bearer ${credential}` },
  };
}

export async function discoverModels(
  candidate: ModelServiceCandidate,
  options: DiscoverModelsOptions = {},
): Promise<ModelDiscoveryResult> {
  if (candidate.kind === "builtin") return discoverBuiltinModels(candidate, options);
  const baseUrl = normalizeModelServiceBaseUrl(candidate.baseUrl);
  if (baseUrl === undefined) {
    return failure("invalid-base-url", `模型服务 ${candidate.provider} 的 base URL 无效`);
  }

  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  try {
    const request = discoveryRequest(baseUrl, candidate.api, candidate.credential);
    const response = await fetch(request.url, { headers: request.headers, signal });
    const responseText = await response.text();
    if (!response.ok) {
      const excerpt = redactFailureText(responseText, [candidate.credential]);
      return {
        ok: false,
        failure: {
          code: "http-error",
          status: response.status,
          message:
            `模型服务 ${candidate.provider} 发现失败: HTTP ${response.status}` +
            (excerpt === "" ? "" : ` — ${excerpt}`),
        },
      };
    }

    let body: { data?: unknown } | null;
    try {
      body = JSON.parse(responseText) as { data?: unknown } | null;
    } catch {
      return failure("invalid-response", `模型服务 ${candidate.provider} 的 /models 响应不是 JSON`);
    }
    if (!Array.isArray(body?.data)) {
      return failure("invalid-response", `模型服务 ${candidate.provider} 的 /models 响应不兼容`);
    }

    const rows: { id: string; name?: string }[] = [];
    const seen = new Set<string>();
    let ignoredCount = 0;
    for (const row of body.data) {
      const id =
        typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "string"
          ? (row as { id: string }).id.trim()
          : "";
      if (id === "") {
        ignoredCount += 1;
        continue;
      }
      const identity = modelIdentity({ provider: candidate.provider, model: id });
      if (seen.has(identity)) continue;
      seen.add(identity);
      const record = row as { display_name?: unknown; name?: unknown };
      const name = nonEmptyString(record.display_name) ?? nonEmptyString(record.name);
      rows.push(name === undefined ? { id } : { id, name });
    }
    if (rows.length === 0) {
      return failure("empty-catalog", `模型服务 ${candidate.provider} 没有返回可用的 model id`);
    }
    const piModels = await piModelsForCustomCatalog(rows.map((row) => row.id), options);
    const models = rows.map(({ id, name }): DiscoveredModel => {
      const vendor = customModelVendor(id);
      const piModel = vendor === undefined ? undefined : piModels.get(`${vendor}:${id}`);
      const fields: TrustedModelFields = {
        ...(name === undefined
          ? piModel === undefined || piModel.name.trim() === "" ? {} : { name: piModel.name }
          : { name }),
        api: candidate.api,
        baseUrl,
        ...(piModel === undefined || !trustedInput(piModel.input) ? {} : { input: piModel.input }),
        ...(piModel === undefined ? {} : { reasoning: piModel.reasoning }),
        ...(piModel === undefined || !positiveInteger(piModel.contextWindow)
          ? {}
          : { contextWindow: piModel.contextWindow }),
        ...(piModel === undefined || !positiveInteger(piModel.maxTokens)
          ? {}
          : { maxTokens: piModel.maxTokens }),
        ...(piModel?.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: piModel.thinkingLevelMap }),
        ...(piModel?.compat === undefined ? {} : { compat: piModel.compat }),
      };
      const fieldSources: TrustedModelFieldSources = {
        ...(fields.name === undefined ? {} : { name: name === undefined ? "pi-catalog" : "service-interface" }),
        api: "service-target",
        baseUrl: "service-target",
        ...(fields.input === undefined ? {} : { input: "pi-catalog" }),
        ...(fields.reasoning === undefined ? {} : { reasoning: "pi-catalog" }),
        ...(fields.contextWindow === undefined ? {} : { contextWindow: "pi-catalog" }),
        ...(fields.maxTokens === undefined ? {} : { maxTokens: "pi-catalog" }),
        ...(fields.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: "pi-catalog" }),
        ...(fields.compat === undefined ? {} : { compat: "pi-catalog" }),
      };
      return {
        identity: modelIdentity({ provider: candidate.provider, model: id }),
        provider: candidate.provider,
        id,
        fields,
        fieldSources,
      };
    });
    return { ok: true, models, ignoredCount };
  } catch (error) {
    const timedOut = timeout.aborted;
    const detail = timedOut ? "" : redactFailureText(error, [candidate.credential]);
    return failure(
      timedOut ? "timeout" : "request-error",
      `模型服务 ${candidate.provider} 发现${timedOut ? "超时" : "请求失败"}` +
        (detail === "" ? "" : ` — ${detail}`),
    );
  }
}

export async function validateMinimalInference(
  candidate: ModelServiceCandidate,
  modelOrId: DiscoveredModel | string,
  options: InferenceValidationOptions = {},
): Promise<InferenceValidationResult> {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-inference-"));
  try {
    const builtinTarget =
      candidate.kind === "builtin"
        ? await resolvePiBuiltinProviderTarget(candidate.provider)
        : undefined;
    const synthesized = synthesizeRuntimeModel(candidate, modelOrId, builtinTarget);
    if (!synthesized.ok) return synthesized;
    const modelRuntime = await isolatedModelRuntime(dir, undefined);
    if (candidate.credential === "") {
      return {
        ok: false,
        failure: { code: "inference-failed", message: `模型服务 ${candidate.provider} 没有模型凭据` },
      };
    }

    const target = synthesized.value.runtime;
    const model = {
      provider: target.provider,
      id: target.id,
      name: target.name,
      api: target.api,
      baseUrl: target.baseUrl,
      reasoning: target.reasoning,
      input: [...target.input],
      // Pi 的模型必须带这一项,它拿它折算自己的会话统计。产品不读那个数字,给零费率
      // 即可;缺这一项 pi-ai 会在算成本时当场抛。
      cost: ZERO_MODEL_COST,
      contextWindow: target.contextWindow,
      maxTokens: target.maxTokens,
      ...(target.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: target.thinkingLevelMap }),
      ...(target.compat === undefined ? {} : { compat: target.compat }),
    };
    if (candidate.kind === "custom") {
      modelRuntime.registerProvider(candidate.provider, {
        name: candidate.provider,
        api: candidate.api,
        baseUrl: target.baseUrl,
        models: [model],
      });
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
    await modelRuntime.setRuntimeApiKey(candidate.provider, candidate.credential, { signal });
    const response = await modelRuntime.completeSimple(
      model,
      {
        messages: [{ role: "user", content: "Reply exactly OK", timestamp: Date.now() }],
      },
      {
        apiKey: candidate.credential,
        cacheRetention: "none",
        fetch: globalThis.fetch,
        maxRetries: 0,
        maxTokens: 16,
        signal,
        // 不带 temperature:验证只看这一笔请求能不能通,而 adaptive thinking 模型
        // (fable / opus-5)对显式 temperature 直接 400 deprecated。
        timeoutMs,
      },
    );
    if (response.stopReason !== "stop" && response.stopReason !== "length") {
      const detail = redactFailureText(response.errorMessage ?? response.stopReason, [candidate.credential]);
      return {
        ok: false,
        failure: {
          code: timeout.aborted ? "timeout" : "inference-failed",
          message:
            `模型服务 ${candidate.provider} 真实推理${timeout.aborted ? "超时" : "失败"}` +
            (detail === "" ? "" : ` — ${detail}`),
        },
      };
    }
    return { ok: true };
  } catch (error) {
    const detail = redactFailureText(error, [candidate.credential]);
    return {
      ok: false,
      failure: {
        code: "inference-failed",
        message:
          `模型服务 ${candidate.provider} 真实推理失败` + (detail === "" ? "" : ` — ${detail}`),
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
