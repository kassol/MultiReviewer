import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { isoTimestamp, jsonText } from "./columns.ts";

/**
 * 仓库注册表。主键是 Forge 的数值 repo id:改名与转移 owner 后凭 payload 里的 id 仍能匹配,
 * owner/repo 只是注册时的名字,不参与准入。因此这一格不是 identity 列,由调用方写入。
 */
export const repo = pgTable("repo", {
  id: integer().primaryKey(),
  owner: text().notNull(),
  repo: text().notNull(),
  /** 模型覆盖(ReviewerSpec 的 JSON 数组),NULL 即跟随全局模型组合。 */
  reviewers: jsonText(),
  /** 工作副本的准备状态(issue #184):preparing / ready / failed,NULL 按 unknown 读。 */
  worktreeState: text("worktree_state"),
  worktreeFailure: text("worktree_failure"),
  worktreeCheckedAt: isoTimestamp("worktree_checked_at"),
  registeredAt: isoTimestamp("registered_at").notNull(),
  /** 这个仓库自己的辅助模型覆盖,NULL 即跟随全局。 */
  auxiliaryModel: jsonText("auxiliary_model"),
  /** 最低报告等级覆盖(issue #273),NULL 即跟随全局。 */
  minReportSeverity: text("min_report_severity"),
  /** 默认分支(ADR 0033,issue #350),NULL 即跟随 Gitea 的默认分支。 */
  defaultBranch: text("default_branch"),
  /** 仓库配置的整块版本号(issue #302),从 0 起。 */
  settingsVersion: integer("settings_version").notNull().default(0),
});

/**
 * 仓库的 key。明文存库:HMAC 验签需要原始值,这是密码学约束,不是疏忽。代次单调递增并写进
 * hook URL 的 ?k=,轮转期间一个仓库最多两把并存(ADR 0007)。
 */
export const repoKey = pgTable(
  "repo_key",
  {
    repoId: integer("repo_id")
      .notNull()
      .references(() => repo.id),
    generation: integer().notNull(),
    key: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.generation] })],
);

export const webhookDelivery = pgTable(
  "webhook_delivery",
  {
    id: integer().generatedByDefaultAsIdentity().primaryKey(),
    owner: text().notNull(),
    repo: text().notNull(),
    headSha: text("head_sha").notNull(),
    claimedAt: isoTimestamp("claimed_at").notNull(),
  },
  (t) => [unique("webhook_delivery_owner_repo_head_sha_key").on(t.owner, t.repo, t.headSha)],
);

/**
 * 审查策略,一项一行。库是唯一的配置面(issue #66),没有配置文件与它竞争。
 * value 不是 jsonb:一部分项存的是 JSON(模型组合、辅助模型),另一部分是裸字符串(上限、
 * 严重度、版本号),同一列两种形状,存成文本最省事。
 */
export const globalSetting = pgTable("global_setting", {
  key: text().primaryKey(),
  value: text().notNull(),
});

export const modelService = pgTable(
  "model_service",
  {
    provider: text().primaryKey(),
    serviceType: text("service_type").notNull(),
    version: integer().notNull(),
    baseUrl: text("base_url"),
    api: text(),
    targetFingerprint: text("target_fingerprint"),
    disabledReason: text("disabled_reason"),
    createdAt: isoTimestamp("created_at").notNull(),
    updatedAt: isoTimestamp("updated_at").notNull(),
    /** 这一版绑定的调用目标集合(ADR 0027,issue #261)。自定义服务与升级前的内置版本是 NULL。 */
    targetsJson: jsonText("targets_json"),
  },
  (t) => [
    check("model_service_type", sql`${t.serviceType} IN ('builtin', 'custom')`),
    check("model_service_version_positive", sql`${t.version} > 0`),
    check(
      "model_service_disabled_reason",
      sql`${t.disabledReason} IS NULL OR ${t.disabledReason} = 'name-conflict'`,
    ),
    check(
      "model_service_target_shape",
      sql`(${t.serviceType} = 'custom' AND ${t.baseUrl} IS NOT NULL AND ${t.api} IS NOT NULL
        AND ${t.targetFingerprint} IS NOT NULL)
      OR (${t.serviceType} = 'builtin' AND ${t.baseUrl} IS NULL AND ${t.api} IS NULL)`,
    ),
  ],
);

export const modelServiceCredential = pgTable(
  "model_service_credential",
  {
    provider: text().primaryKey(),
    state: text().notNull(),
    apiKeyEncrypted: text("api_key_encrypted"),
    updatedAt: isoTimestamp("updated_at"),
    verifiedAt: isoTimestamp("verified_at"),
    validationModel: text("validation_model"),
    verificationSource: text("verification_source"),
  },
  (t) => [
    check(
      "model_service_credential_state",
      sql`${t.state} IN ('unconfigured', 'pending-reverification', 'verified')`,
    ),
    check(
      "model_service_credential_verification_source",
      sql`${t.verificationSource} IS NULL OR ${t.verificationSource} IN (
        'legacy-provider-check', 'legacy-review-run', 'inference'
      )`,
    ),
    check(
      "model_service_credential_shape",
      sql`(${t.state} = 'unconfigured' AND ${t.apiKeyEncrypted} IS NULL AND ${t.updatedAt} IS NULL
        AND ${t.verifiedAt} IS NULL AND ${t.validationModel} IS NULL
        AND ${t.verificationSource} IS NULL)
      OR (${t.state} = 'pending-reverification' AND ${t.apiKeyEncrypted} IS NOT NULL
        AND ${t.updatedAt} IS NOT NULL AND ${t.verifiedAt} IS NULL
        AND ${t.validationModel} IS NULL AND ${t.verificationSource} IS NULL)
      OR (${t.state} = 'verified' AND ${t.apiKeyEncrypted} IS NOT NULL
        AND ${t.updatedAt} IS NOT NULL AND ${t.verifiedAt} IS NOT NULL
        AND ${t.verificationSource} IS NOT NULL)`,
    ),
  ],
);

export const modelDirectory = pgTable(
  "model_directory",
  {
    provider: text().primaryKey(),
    serviceVersion: integer("service_version").notNull(),
    state: text().notNull(),
    lastAttemptAt: isoTimestamp("last_attempt_at"),
    lastSuccessAt: isoTimestamp("last_success_at"),
    failure: text(),
    ignoredModelCount: integer("ignored_model_count").notNull().default(0),
  },
  (t) => [
    check("model_directory_service_version_positive", sql`${t.serviceVersion} > 0`),
    check(
      "model_directory_state",
      sql`${t.state} IN ('undiscovered', 'available', 'refresh-failed', 'discovery-failed')`,
    ),
    check("model_directory_ignored_model_count", sql`${t.ignoredModelCount} >= 0`),
    check(
      "model_directory_shape",
      sql`(${t.state} = 'undiscovered' AND ${t.lastAttemptAt} IS NULL
        AND ${t.lastSuccessAt} IS NULL AND ${t.failure} IS NULL AND ${t.ignoredModelCount} = 0)
      OR (${t.state} = 'available' AND ${t.lastAttemptAt} IS NOT NULL
        AND ${t.lastSuccessAt} IS NOT NULL AND ${t.failure} IS NULL)
      OR (${t.state} = 'refresh-failed' AND ${t.lastAttemptAt} IS NOT NULL
        AND ${t.lastSuccessAt} IS NOT NULL AND ${t.failure} IS NOT NULL)
      OR (${t.state} = 'discovery-failed' AND ${t.lastAttemptAt} IS NOT NULL
        AND ${t.lastSuccessAt} IS NULL AND ${t.failure} IS NOT NULL)`,
    ),
  ],
);

export const modelDirectoryModel = pgTable(
  "model_directory_model",
  {
    provider: text().notNull(),
    model: text().notNull(),
    serviceVersion: integer("service_version").notNull(),
    name: text(),
    api: text(),
    baseUrl: text("base_url"),
    inputJson: jsonText("input_json"),
    reasoning: boolean(),
    contextWindow: integer("context_window"),
    maxTokens: integer("max_tokens"),
    fieldSourcesJson: jsonText("field_sources_json"),
    thinkingLevelMapJson: jsonText("thinking_level_map_json"),
    compatJson: jsonText("compat_json"),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.model] }),
    check("model_directory_model_not_empty", sql`${t.model} <> ''`),
    check("model_directory_model_service_version_positive", sql`${t.serviceVersion} > 0`),
  ],
);

export const modelSupplement = pgTable(
  "model_supplement",
  {
    provider: text().notNull(),
    model: text().notNull(),
    source: text().notNull(),
    targetFingerprint: text("target_fingerprint"),
    createdAt: isoTimestamp("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.model] }),
    check("model_supplement_model_not_empty", sql`${t.model} <> ''`),
    check("model_supplement_source", sql`${t.source} IN ('manual', 'migration-retention')`),
    check(
      "model_supplement_shape",
      sql`(${t.source} = 'manual' AND ${t.targetFingerprint} IS NOT NULL)
      OR (${t.source} = 'migration-retention' AND ${t.targetFingerprint} IS NULL)`,
    ),
  ],
);

export const modelServiceModelState = pgTable(
  "model_service_model_state",
  {
    provider: text().notNull(),
    model: text().notNull(),
    enabled: boolean().notNull().default(true),
    updatedAt: isoTimestamp("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.model] }),
    check("model_service_model_state_model_not_empty", sql`${t.model} <> ''`),
  ],
);
