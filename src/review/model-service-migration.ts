import { createHash } from "node:crypto";
import { closeSync, openSync, rmSync } from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";

import {
  assertReviewerSpecs,
  GLOBAL_REVIEWERS_CONTEXT,
  modelIdentity,
  type ReviewerSpec,
} from "../config.ts";
import { decryptCredential } from "../panel/credential-crypto.ts";
import { MODEL_SERVICE_SCHEMA, STORE_SCHEMA } from "./store.ts";

export const MODEL_SERVICE_SCHEMA_VERSION = 1;
const SUMMARY_KEY = "model_service_migration_summary_v1";
const BUSY_TIMEOUT_MS = 5_000;

export type ModelServiceMigrationSummary = {
  schemaVersion: number;
  backupPath: string;
  modelServices: number;
  verifiedCredentials: number;
  pendingCredentials: number;
  unconfiguredCredentials: number;
  manualSupplements: number;
  migrationRetentions: number;
  globalCombinationModels: number;
  repositoryOverrides: number;
  /** 旧 model_row 里带着新 schema 仍保留的事实(上下文窗口 / 最大输出)却被丢掉的行数;单价事实已随 issue #188 消失,不计。 */
  discardedLegacyModelFactRows: number;
};

export type ModelServiceMigrationResult =
  | { status: "migrated"; summary: ModelServiceMigrationSummary }
  | { status: "projection-pending"; summary: ModelServiceMigrationSummary }
  | { status: "current" };

export type ModelServiceMigrationOptions = {
  dbPath: string;
  credentialMasterKey?: string;
  builtinProviderNames: ReadonlySet<string>;
};

type LegacyCustomProvider = { name: string; baseUrl: string; api: string; createdAt: string };
type LegacyCredential = { provider: string; ciphertext: string; updatedAt: string; verified: boolean };
type LegacyModelRow = { provider: string; model: string; createdAt: string };
type SuccessfulOutcome = { model: string; finishedAt: string };
type PendingSupplement = {
  provider: string;
  model: string;
  source: "manual" | "migration-retention";
  targetFingerprint: string | null;
  createdAt: string;
};

export function modelServiceTargetFingerprint(baseUrl: string, api: string): string {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  return createHash("sha256")
    .update(normalizedBaseUrl, "utf8")
    .update("\0")
    .update(api.trim(), "utf8")
    .digest("hex");
}

function schemaVersion(db: DatabaseSync): number {
  return Number(db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0);
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function migrationSummary(db: DatabaseSync): ModelServiceMigrationSummary | undefined {
  if (!tableExists(db, "global_setting")) return undefined;
  const row = db.prepare("SELECT value FROM global_setting WHERE key = ?").get(SUMMARY_KEY);
  if (row === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(String(row["value"]));
  } catch (error) {
    throw new Error("模型服务迁移的一次性摘要标记不是合法 JSON", { cause: error });
  }
  if (typeof value !== "object" || value === null) throw new Error("模型服务迁移的一次性摘要标记形状不对");
  const summary = value as Record<string, unknown>;
  const numericFields = [
    "schemaVersion", "modelServices", "verifiedCredentials", "pendingCredentials",
    "unconfiguredCredentials", "manualSupplements", "migrationRetentions",
    "globalCombinationModels", "repositoryOverrides", "discardedLegacyModelFactRows",
  ] as const;
  if (typeof summary["backupPath"] !== "string" || numericFields.some((field) => typeof summary[field] !== "number")) {
    throw new Error("模型服务迁移的一次性摘要标记形状不对");
  }
  return summary as ModelServiceMigrationSummary;
}

export function readPendingModelServiceMigration(dbPath: string): ModelServiceMigrationSummary | undefined {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try { return migrationSummary(db); } finally { db.close(); }
}

export function acknowledgeModelServiceMigration(dbPath: string): void {
  const db = new DatabaseSync(dbPath, { timeout: BUSY_TIMEOUT_MS });
  try {
    if (tableExists(db, "global_setting")) db.prepare("DELETE FROM global_setting WHERE key = ?").run(SUMMARY_KEY);
  } finally { db.close(); }
}

function reserveBackupPath(dbPath: string): string {
  const base = `${dbPath}.pre-model-service-v${MODEL_SERVICE_SCHEMA_VERSION}.sqlite`;
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}.${suffix}`;
    try {
      closeSync(openSync(candidate, "wx", 0o600));
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new Error(`无法为模型服务迁移创建唯一备份文件 ${candidate}`, { cause: error });
    }
  }
  throw new Error(`模型服务迁移备份重名过多：${base}`);
}

async function createMigrationBackup(db: DatabaseSync, dbPath: string): Promise<string> {
  const backupPath = reserveBackupPath(dbPath);
  try {
    await backup(db, backupPath);
    return backupPath;
  } catch (error) {
    rmSync(backupPath, { force: true });
    throw new Error(`模型服务迁移前备份失败：${backupPath}`, { cause: error });
  }
}

function parseCombination(raw: string, context: string, allowEmpty: boolean): ReviewerSpec[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch (error) { throw new Error(`${context}不是合法 JSON`, { cause: error }); }
  return assertReviewerSpecs(value, context, allowEmpty ? { allowEmpty: true } : {});
}

function assertLegacySchema(db: DatabaseSync): void {
  for (const table of ["custom_provider", "model_credential", "model_row", "global_setting", "repo", "review_run", "reviewer_outcome"]) {
    if (!tableExists(db, table)) throw new Error(`旧数据库缺少 ${table} 表，不能执行模型服务迁移`);
  }
}

function countRows(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get()?.["c"] ?? 0);
}

function assertCount(db: DatabaseSync, table: string, expected: number): void {
  const actual = countRows(db, table);
  if (actual !== expected) throw new Error(`模型服务迁移计数校验失败：${table} 应为 ${expected} 行，实际 ${actual} 行`);
}

function readLegacyCustomProviders(db: DatabaseSync): LegacyCustomProvider[] {
  return db.prepare("SELECT name, base_url, api, created_at FROM custom_provider ORDER BY name").all().map((row) => ({
    name: String(row["name"]), baseUrl: String(row["base_url"]), api: String(row["api"]), createdAt: String(row["created_at"]),
  }));
}

function readLegacyCredentials(db: DatabaseSync): LegacyCredential[] {
  return db.prepare("SELECT provider, api_key_encrypted, updated_at, verified FROM model_credential ORDER BY provider").all().map((row) => ({
    provider: String(row["provider"]), ciphertext: String(row["api_key_encrypted"]), updatedAt: String(row["updated_at"]), verified: Number(row["verified"]) === 1,
  }));
}

function readLegacyModelRows(db: DatabaseSync): LegacyModelRow[] {
  return db.prepare("SELECT provider, model, created_at FROM model_row ORDER BY provider, model").all().map((row) => ({
    provider: String(row["provider"]), model: String(row["model"]), createdAt: String(row["created_at"]),
  }));
}

function readSuccessfulOutcomes(db: DatabaseSync): SuccessfulOutcome[] {
  return db.prepare(`SELECT o.model, r.finished_at FROM reviewer_outcome o JOIN review_run r ON r.id = o.run_id
    WHERE o.failure IS NULL AND r.finished_at IS NOT NULL ORDER BY r.finished_at DESC, o.id DESC`).all().map((row) => ({
    model: String(row["model"]), finishedAt: String(row["finished_at"]),
  }));
}

export async function migrateModelServiceDatabase(options: ModelServiceMigrationOptions): Promise<ModelServiceMigrationResult> {
  const db = new DatabaseSync(options.dbPath, { timeout: BUSY_TIMEOUT_MS });
  try {
    const currentVersion = schemaVersion(db);
    if (currentVersion > MODEL_SERVICE_SCHEMA_VERSION) throw new Error(`数据库 schema 版本 ${currentVersion} 高于本程序支持的 ${MODEL_SERVICE_SCHEMA_VERSION}`);
    if (currentVersion === MODEL_SERVICE_SCHEMA_VERSION) {
      const summary = migrationSummary(db);
      return summary === undefined ? { status: "current" } : { status: "projection-pending", summary };
    }
    if (currentVersion !== 0) throw new Error(`不支持从数据库 schema 版本 ${currentVersion} 迁移模型服务`);
    const existingTables = Number(
      db.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).get()?.["count"] ?? 0,
    );
    if (existingTables === 0) {
      db.exec(STORE_SCHEMA);
      db.exec(MODEL_SERVICE_SCHEMA);
      db.exec(`PRAGMA user_version = ${MODEL_SERVICE_SCHEMA_VERSION}`);
      return { status: "current" };
    }
    assertLegacySchema(db);
    const backupPath = await createMigrationBackup(db, options.dbPath);
    const migratedAt = new Date().toISOString();

    db.exec("BEGIN IMMEDIATE");
    try {
      if (schemaVersion(db) !== 0) throw new Error("模型服务迁移期间数据库 schema 版本已变化");
      const globalRow = db.prepare("SELECT value FROM global_setting WHERE key = 'reviewers'").get();
      const globalSpecs = globalRow === undefined ? [] : parseCombination(String(globalRow["value"]), GLOBAL_REVIEWERS_CONTEXT, true);
      const repositoryCombinations: ReviewerSpec[][] = [];
      for (const row of db.prepare("SELECT id, owner, repo, reviewers FROM repo WHERE reviewers IS NOT NULL ORDER BY id").all()) {
        const context = `仓库 ${String(row["owner"])}/${String(row["repo"])}（id ${Number(row["id"])}）的模型覆盖`;
        repositoryCombinations.push(parseCombination(String(row["reviewers"]), context, false));
      }

      const customProviders = readLegacyCustomProviders(db);
      const credentials = readLegacyCredentials(db);
      const modelRows = readLegacyModelRows(db);
      const successfulOutcomes = readSuccessfulOutcomes(db);
      const customByName = new Map(customProviders.map((entry) => [entry.name, entry]));
      const credentialByProvider = new Map(credentials.map((entry) => [entry.provider, entry]));
      const providers = new Set([...customProviders.map((entry) => entry.name), ...credentials.map((entry) => entry.provider)]);

      db.exec(MODEL_SERVICE_SCHEMA);
      for (const table of ["model_service", "model_service_credential", "model_directory", "model_directory_model", "model_supplement"]) {
        if (countRows(db, table) !== 0) throw new Error(`模型服务迁移目标表 ${table} 不是空表`);
      }

      const serviceTargets = new Map<string, string | null>();
      const insertService = db.prepare(`INSERT INTO model_service
        (provider, service_type, version, base_url, api, target_fingerprint, disabled_reason, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`);
      const insertCredential = db.prepare(`INSERT INTO model_service_credential
        (provider, state, api_key_encrypted, updated_at, verified_at, validation_model, verification_source)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const insertDirectory = db.prepare(`INSERT INTO model_directory
        (provider, service_version, state, last_attempt_at, last_success_at, failure, ignored_model_count)
        VALUES (?, 1, 'undiscovered', null, null, null, 0)`);
      let verifiedCredentials = 0;
      let pendingCredentials = 0;
      let unconfiguredCredentials = 0;

      for (const provider of [...providers].sort()) {
        const custom = customByName.get(provider);
        const credential = credentialByProvider.get(provider);
        const targetFingerprint = custom === undefined ? null : modelServiceTargetFingerprint(custom.baseUrl, custom.api);
        serviceTargets.set(provider, targetFingerprint);
        insertService.run(
          provider, custom === undefined ? "builtin" : "custom", custom?.baseUrl ?? null, custom?.api ?? null,
          targetFingerprint, custom !== undefined && options.builtinProviderNames.has(provider) ? "name-conflict" : null,
          custom?.createdAt ?? credential!.updatedAt, credential?.updatedAt ?? custom!.createdAt,
        );
        const plaintext = credential === undefined || options.credentialMasterKey === undefined || options.credentialMasterKey === ""
          ? undefined : decryptCredential(options.credentialMasterKey, credential.ciphertext);
        if (credential === undefined || plaintext === undefined) {
          insertCredential.run(provider, "unconfigured", null, null, null, null, null);
          unconfiguredCredentials += 1;
        } else if (credential.verified) {
          insertCredential.run(provider, "verified", credential.ciphertext, credential.updatedAt, credential.updatedAt, null, "legacy-provider-check");
          verifiedCredentials += 1;
        } else {
          const evidence = custom === undefined ? undefined : successfulOutcomes.find((outcome) =>
            outcome.model.startsWith(`${provider}:`) && outcome.finishedAt > credential.updatedAt && outcome.finishedAt > custom.createdAt);
          if (evidence === undefined) {
            insertCredential.run(provider, "pending-reverification", credential.ciphertext, credential.updatedAt, null, null, null);
            pendingCredentials += 1;
          } else {
            insertCredential.run(provider, "verified", credential.ciphertext, credential.updatedAt, evidence.finishedAt, evidence.model, "legacy-review-run");
            verifiedCredentials += 1;
          }
        }
        insertDirectory.run(provider);
      }

      const supplements = new Map<string, PendingSupplement>();
      for (const row of modelRows) {
        const manual = customByName.has(row.provider);
        supplements.set(modelIdentity(row), {
          provider: row.provider, model: row.model, source: manual ? "manual" : "migration-retention",
          targetFingerprint: manual ? serviceTargets.get(row.provider)! : null, createdAt: row.createdAt,
        });
      }
      for (const specs of [globalSpecs, ...repositoryCombinations]) {
        for (const spec of specs) {
          const identity = modelIdentity(spec);
          if (!supplements.has(identity)) supplements.set(identity, {
            provider: spec.provider, model: spec.model, source: "migration-retention", targetFingerprint: null, createdAt: migratedAt,
          });
        }
      }
      const insertSupplement = db.prepare(`INSERT INTO model_supplement
        (provider, model, source, target_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)`);
      for (const supplement of [...supplements.values()].sort((left, right) => modelIdentity(left).localeCompare(modelIdentity(right)))) {
        insertSupplement.run(supplement.provider, supplement.model, supplement.source, supplement.targetFingerprint, supplement.createdAt);
      }
      for (const specs of [globalSpecs, ...repositoryCombinations]) {
        for (const spec of specs) if (!supplements.has(modelIdentity(spec))) throw new Error(`模型服务迁移后缺少 ${modelIdentity(spec)} 的来源`);
      }

      const manualSupplements = [...supplements.values()].filter((entry) => entry.source === "manual").length;
      const migrationRetentions = supplements.size - manualSupplements;
      const legacyFactColumns = new Set(
        db.prepare("PRAGMA table_info(model_row)").all().map((row) => String(row["name"])),
      );
      const discardedPredicates = ["context_window", "max_output_tokens"]
        .filter((column) => legacyFactColumns.has(column))
        .map((column) => `"${column}" IS NOT NULL`);
      const discardedLegacyModelFactRows = discardedPredicates.length === 0 ? 0 : Number(
        db.prepare(`SELECT COUNT(*) AS c FROM model_row WHERE ${discardedPredicates.join(" OR ")}`).get()?.["c"] ?? 0,
      );
      const summary: ModelServiceMigrationSummary = {
        schemaVersion: MODEL_SERVICE_SCHEMA_VERSION, backupPath, modelServices: providers.size,
        verifiedCredentials, pendingCredentials, unconfiguredCredentials, manualSupplements, migrationRetentions,
        globalCombinationModels: globalSpecs.length, repositoryOverrides: repositoryCombinations.length,
        discardedLegacyModelFactRows,
      };

      assertCount(db, "model_service", providers.size);
      assertCount(db, "model_service_credential", providers.size);
      assertCount(db, "model_directory", providers.size);
      assertCount(db, "model_directory_model", 0);
      assertCount(db, "model_supplement", supplements.size);
      const wrongDirectoryVersion = Number(db.prepare(`SELECT COUNT(*) AS c FROM model_directory d
        JOIN model_service s ON s.provider = d.provider WHERE d.service_version <> s.version`).get()?.["c"] ?? 0);
      if (wrongDirectoryVersion !== 0) throw new Error("模型目录版本引用校验失败");

      db.prepare(`INSERT INTO global_setting (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(SUMMARY_KEY, JSON.stringify(summary));
      db.exec(`PRAGMA user_version = ${MODEL_SERVICE_SCHEMA_VERSION}`);
      db.exec("DROP TABLE model_row; DROP TABLE model_credential; DROP TABLE custom_provider;");
      db.exec("COMMIT");
      return { status: "migrated", summary };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally { db.close(); }
}
