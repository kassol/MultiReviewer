/**
 * 用例的播种入口。这两样都只有用例要:面板写链走整页替换与裁决/草案确认,`Store` 因此
 * 不再带它们(ponytail 审计 #27)。
 */
import { DatabaseSync } from "node:sqlite";

import type { GlobalSettingsValues, ReviewRuleInput, Store } from "../../src/review/store.ts";

/** 按当前版本合并写入几项审查策略。整页替换那一条是生产写链,这里只是省去读版本那一步。 */
export function putGlobalSettings(store: Store, patch: Partial<GlobalSettingsValues>): boolean {
  const { version, ...current } = store.getGlobalSettings();
  return store.replaceGlobalSettings(version, { ...current, ...patch });
}

/**
 * 落一条生效的知识条目,推进一版知识集版本并回那个新版本。写入口只剩裁决与草案确认
 * (issue #299),用例要的现集条目因此按 schema 直接写:走提案采纳会往队列里留一条
 * 采纳过的提案,而用例断言的正是那个队列。
 *
 * `layer` 是退役的层标签,列还在(NOT NULL)但没人读,与生产写入同律写空串。
 */
export function seedReviewRule(
  dbPath: string,
  repoId: number,
  input: ReviewRuleInput,
  origin = "manual",
): number {
  const db = new DatabaseSync(dbPath);
  try {
    const current = db
      .prepare("SELECT MAX(version) AS version FROM rule_set_version WHERE repo_id = ?")
      .get(repoId)?.["version"];
    const version = (current === null || current === undefined ? 0 : Number(current)) + 1;
    const at = new Date().toISOString();
    db.prepare(
      "INSERT INTO rule_set_version (repo_id, version, created_at) VALUES (?, ?, ?)",
    ).run(repoId, version, at);
    db.prepare(
      `INSERT INTO review_rule
         (repo_id, type, scope, statement, layer, state, origin, effective_version, retired_version, created_at)
       VALUES (?, ?, ?, ?, '', 'active', ?, ?, NULL, ?)`,
    ).run(repoId, input.type, input.scope, input.statement, origin, version, at);
    return version;
  } finally {
    db.close();
  }
}
