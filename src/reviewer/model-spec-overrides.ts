import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import type { ModelSpecOverrides } from "../contracts/model-specs.ts";
import type { DiscoveredModel, TrustedModelFields } from "./model-service-runtime.ts";
import type { RuntimeModelCompat, RuntimeThinkingLevelMap } from "./model-runtime.ts";

export const MODEL_SPEC_FIELDS = ["input", "reasoning", "contextWindow", "maxTokens", "thinkingLevelMap", "compat"] as const;

type Schema = { [key: string]: unknown; properties?: Record<string, Schema>; patternProperties?: Record<string, Schema>; items?: Schema; anyOf?: Schema[]; $ref?: string };
let definitions: Record<string, Schema> | undefined;

function piDefinitions(): Record<string, Schema> {
  return definitions ??= JSON.parse(readFileSync(join(dirname(findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!), "schemas/models.schema.json"), "utf8")).$defs;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 按固定 Pi 版本的公开 schema 校验，所有对象额外拒绝未知键。 */
function matches(value: unknown, schema: Schema): boolean {
  if (schema.$ref !== undefined) return matches(value, piDefinitions()[schema.$ref.split("/").at(-1)!]!);
  if (schema.anyOf !== undefined) return schema.anyOf.some((option) => matches(value, option));
  if (Object.hasOwn(schema, "const") && value !== schema["const"]) return false;
  if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) return false;
  const type = schema["type"];
  if (type === "null") return value === null;
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string") return typeof value === "string" && (typeof schema["minLength"] !== "number" || value.length >= schema["minLength"]);
  if (type === "number" || type === "integer") return typeof value === "number" && Number.isFinite(value) &&
    (type !== "integer" || Number.isSafeInteger(value)) &&
    (typeof schema["minimum"] !== "number" || value >= schema["minimum"]) &&
    (typeof schema["exclusiveMinimum"] !== "number" || value > schema["exclusiveMinimum"]);
  if (type === "array") return Array.isArray(value) &&
    (typeof schema["maxItems"] !== "number" || value.length <= schema["maxItems"]) &&
    value.every((item) => schema.items === undefined || matches(item, schema.items));
  if (type === "object") {
    if (!record(value)) return false;
    if (Array.isArray(schema["required"]) && schema["required"].some((key) => typeof key !== "string" || !Object.hasOwn(value, key))) return false;
    return Object.entries(value).every(([key, item]) => {
      const own = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties![key] : undefined;
      const pattern = Object.entries(schema.patternProperties ?? {}).find(([expression]) => new RegExp(expression).test(key))?.[1];
      return (own ?? pattern) !== undefined && matches(item, (own ?? pattern)!);
    });
  }
  return true;
}

export function validModelSpecOverrides(value: unknown): value is ModelSpecOverrides {
  if (!record(value)) return false;
  return Object.entries(value).every(([key, item]) => {
    switch (key) {
      case "input": return Array.isArray(item) && item.length > 0 && new Set(item).size === item.length && item.every((entry) => entry === "text" || entry === "image");
      case "reasoning": return typeof item === "boolean";
      case "contextWindow": case "maxTokens": return typeof item === "number" && Number.isSafeInteger(item) && item > 0 && item <= 2_147_483_647;
      case "thinkingLevelMap": return matches(item, piDefinitions()["ThinkingLevelMap"]!);
      case "compat": return matches(item, piDefinitions()["ProviderCompat"]!);
      default: return false;
    }
  });
}

export function applyModelSpecOverrides(discovery: DiscoveredModel, overrides: ModelSpecOverrides): DiscoveredModel {
  const fields: TrustedModelFields = { ...discovery.fields, ...overrides,
    ...(overrides.compat === undefined ? {} : { compat: overrides.compat as RuntimeModelCompat }),
    ...(overrides.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: overrides.thinkingLevelMap as RuntimeThinkingLevelMap }),
  };
  const fieldSources = { ...discovery.fieldSources };
  for (const field of MODEL_SPEC_FIELDS) if (Object.hasOwn(overrides, field)) fieldSources[field] = "manual-override";
  return { ...discovery, fields, fieldSources };
}
