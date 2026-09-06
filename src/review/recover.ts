/**
 * 恢复已有评审记录里缺失的影响与修改建议(issue #268)。
 *
 * 升级前落的归属没有 `impact` / `suggestion` 两列(issue #266),读回是 NULL;延续承接来的
 * 历史说法那张表(issue #267)对升级前合成的延续也是空的。这里从可靠来源找回原文:同一轮
 * 里那个模型成功报出的 `report_finding` 轨迹(参数就是原文),或它自己发出去的那条原评论;
 * 按复核结论合成的延续那一行沿已落库的延续关系从上一处抄历史说法。不调用模型、不重跑、
 * 不写 Forge。
 *
 * 判据只认唯一对应:同一轮同一模型对同一文件同一段问题表述,成功上报的内容恰好一种才补,
 * 有两种不同说法即跳过并说明;评论只认这一行自己发出去的那条——同一条评论之后被折叠上去
 * 的行不是它的作者,不拿旧评论冒充它的说法;延续只认轨迹记了「复核结论给的位置」判据的
 * 那一行。只补 NULL,非空一律不碰;重复执行没有第二份副作用。
 *
 * 预览与执行用同一份计划:预览只读库,`applyRecovery` 在一个事务里写。两边都不经
 * `openStore`——它开库时会补列建表,预览不该有任何写入。
 */
import type { DatabaseSync } from "node:sqlite";

import type { ExistingReviewComment, PullRequestRef } from "../forge/forge.ts";
import type { CarriedAttributionRecord } from "./store.ts";

export type RecoveryScope =
  | { kind: "all" }
  | { kind: "repo"; owner: string; repo: string }
  | { kind: "run"; runId: number };

/** 原评论的来源:按 pull request 列它的行级评论。Forge 的 `listReviewComments` 就是它。 */
export type CommentSource = (ref: PullRequestRef) => Promise<ExistingReviewComment[]>;

export type FillSource = "trace" | "comment" | "continuation";

type Where = {
  findingId: number;
  position: number;
  runId: number;
  model: string;
  file: string;
  line: number;
};

/** 一条归属补成什么,凭什么。 */
export type AttributionFill = Where & {
  source: FillSource;
  impact: string | null;
  suggestion: string | null;
};

/** 一条归属为什么补不了。 */
export type AttributionSkip = Where & { reason: string };

/** 延续合成的那一行要补进的历史说法(它一段都没有时)。 */
export type CarriedInsert = { findingId: number; runId: number; rows: CarriedAttributionRecord[] };

/** 已有的一段历史说法里还缺的两列,从上一处补。 */
export type CarriedFill = {
  findingId: number;
  position: number;
  impact: string | null;
  suggestion: string | null;
};

export type RecoveryPlan = {
  /** 范围里的轮次数与归属总数,给预览报个底。 */
  runs: number;
  attributions: number;
  fills: AttributionFill[];
  skips: AttributionSkip[];
  carriedInserts: CarriedInsert[];
  carriedFills: CarriedFill[];
};

type Said = { impact: string | null; suggestion: string | null };

type FindingRow = {
  id: number;
  runId: number;
  file: string;
  line: number;
  title: string;
  commentId: string | null;
  continuedFrom: string | null;
};

type AttributionRow = Said & {
  findingId: number;
  position: number;
  model: string;
  description: string;
};

type CarriedRow = CarriedAttributionRecord & { findingId: number; position: number };

/** 库有没有升级到带这两列与那张表的版本。没有就先起一次新版本服务,`openStore` 会补。 */
export function assertRecoverySchema(db: DatabaseSync): void {
  const columns = db
    .prepare("PRAGMA table_info(finding_attribution)")
    .all()
    .map((row) => String(row["name"]));
  const table = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'finding_carried_attribution'",
    )
    .get();
  if (!columns.includes("impact") || !columns.includes("suggestion") || table === undefined) {
    throw new Error("数据库还没升级到带影响与建议两列的版本:先用新版本启动一次服务,再来恢复");
  }
}

function scopeWhere(scope: RecoveryScope): { sql: string; params: (string | number)[] } {
  switch (scope.kind) {
    case "all":
      return { sql: "1 = 1", params: [] };
    case "repo":
      return { sql: "owner = ? AND repo = ?", params: [scope.owner, scope.repo] };
    case "run":
      return { sql: "id = ?", params: [scope.runId] };
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** 拼复合键用的分隔符:NUL 不会出现在模型标识、路径与正文里。 */
const SEP = "\u0000";

/** 一轮轨迹里能当恢复依据的两类事件。 */
type TraceIndex = {
  /** 模型 + 文件 + 问题表述 → 成功上报过的内容,按影响 + 建议去重。 */
  reports: Map<string, Map<string, Said>>;
  /** 轨迹记了「复核结论给的位置」判据的延续:文件 + 行 + 标题。 */
  verdictContinued: Set<string>;
};

function reportKey(model: string, file: string, description: string): string {
  return [model, file, description].join(SEP);
}

function placeKey(file: string, line: number, title: string): string {
  return [file, String(line), title].join(SEP);
}

function saidKey(said: Said): string {
  return [said.impact ?? "", said.suggestion ?? ""].join(SEP);
}

function traceIndex(db: DatabaseSync, runId: number): TraceIndex {
  const reports = new Map<string, Map<string, Said>>();
  const verdictContinued = new Set<string>();
  const rows = db
    .prepare(
      `SELECT reviewer, kind, payload FROM review_trace
        WHERE run_id = ? AND kind IN ('tool_call', 'finding_continued') ORDER BY seq`,
    )
    .all(runId);
  for (const row of rows) {
    const payload = JSON.parse(String(row["payload"])) as Record<string, unknown>;
    if (row["kind"] === "finding_continued") {
      const criteria = payload["criteria"] as { kind?: unknown } | undefined;
      if (criteria?.kind !== "verdict") continue;
      verdictContinued.add(
        placeKey(text(payload["file"]), Number(payload["line"]), text(payload["title"])),
      );
      continue;
    }
    // 只认成功的 report_finding:被拒的那次(锚不上、拿事实当规则)没有落成 Finding,
    // 它的参数不是任何一条归属的原文。
    if (payload["tool"] !== "report_finding" || payload["isError"] !== false) continue;
    const args = payload["args"];
    if (args === null || typeof args !== "object") continue;
    const raw = args as Record<string, unknown>;
    const key = reportKey(String(row["reviewer"]), text(raw["file"]), text(raw["description"]));
    const said: Said = { impact: text(raw["impact"]), suggestion: text(raw["suggestion"]) };
    const variants = reports.get(key) ?? new Map<string, Said>();
    variants.set(saidKey(said), said);
    reports.set(key, variants);
  }
  return { reports, verdictContinued };
}

/**
 * 一条评论正文里按模型分的段(`run.ts` 的 `attributionSection` 反过来读):模型标识一行,
 * 之后是它的问题 / 影响 / 建议。等级标题行与「沿用 …」的历史说法段不是模型段。一个字段
 * 的正文可以跨多个空行分隔的段落,读到下一个标签、锚点或延续说明为止。
 */
export function commentSections(
  body: string,
): { model: string; description: string; impact: string; suggestion: string }[] {
  const sections: { model: string; description: string; impact: string; suggestion: string }[] =
    [];
  let current: (typeof sections)[number] | undefined;
  let field: "description" | "impact" | "suggestion" | undefined;
  for (const paragraph of body.split("\n\n")) {
    const heading = /^\*\*(.+)\*\*$/s.exec(paragraph);
    if (heading !== null) {
      const name = heading[1]!;
      field = undefined;
      // 等级标题与「沿用 …」段之后的标签不属于任何模型段。
      current =
        name.startsWith("[") || name.startsWith("沿用 ")
          ? undefined
          : { model: name, description: "", impact: "", suggestion: "" };
      if (current !== undefined) sections.push(current);
      continue;
    }
    if (current === undefined) continue;
    const label = /^\*\*(问题|影响|建议)\*\*:([\s\S]*)$/.exec(paragraph);
    if (label !== null) {
      field = label[1] === "问题" ? "description" : label[1] === "影响" ? "impact" : "suggestion";
      current[field] = label[2]!;
      continue;
    }
    if (field === undefined || paragraph.startsWith("<!--") || paragraph.startsWith("延续自 ")) {
      field = undefined;
      continue;
    }
    current[field] = `${current[field]}\n\n${paragraph}`;
  }
  return sections;
}

/** 两段都是空串的归属没有内容可带;NULL 的照实带(与 `historyPlacements` 同一条口径)。 */
function worthCarrying(said: Said): boolean {
  return !(said.impact === "" && said.suggestion === "");
}

/**
 * 算出这个范围里能补什么、补不了什么。只读库;`comments` 不给即不查原评论(没配 Forge
 * 凭据时),那一档全部按无来源跳过。
 */
export async function planRecovery(
  db: DatabaseSync,
  scope: RecoveryScope,
  comments?: CommentSource,
): Promise<RecoveryPlan> {
  const where = scopeWhere(scope);
  const runs = new Map<number, { owner: string; repo: string; pullNumber: number }>();
  for (const row of db
    .prepare(`SELECT id, owner, repo, pull_number FROM review_run WHERE ${where.sql} ORDER BY id`)
    .all(...where.params)) {
    runs.set(Number(row["id"]), {
      owner: String(row["owner"]),
      repo: String(row["repo"]),
      pullNumber: Number(row["pull_number"]),
    });
  }
  const inScope = `run_id IN (SELECT id FROM review_run WHERE ${where.sql})`;
  const findings: FindingRow[] = db
    .prepare(
      `SELECT id, run_id, file, line, title, comment_id, continued_from FROM finding
        WHERE ${inScope} ORDER BY id`,
    )
    .all(...where.params)
    .map((row) => ({
      id: Number(row["id"]),
      runId: Number(row["run_id"]),
      file: String(row["file"]),
      line: Number(row["line"]),
      title: row["title"] === null ? "" : String(row["title"]),
      commentId: nullable(row["comment_id"]),
      continuedFrom: nullable(row["continued_from"]),
    }));
  const readAttribution = (row: Record<string, unknown>): AttributionRow => ({
    findingId: Number(row["finding_id"]),
    position: Number(row["position"]),
    model: String(row["model"]),
    description: String(row["description"]),
    impact: nullable(row["impact"]),
    suggestion: nullable(row["suggestion"]),
  });
  const readCarried = (row: Record<string, unknown>): CarriedRow => ({
    findingId: Number(row["finding_id"]),
    position: Number(row["position"]),
    model: String(row["model"]),
    runId: Number(row["run_id"]),
    description: String(row["description"]),
    impact: nullable(row["impact"]),
    suggestion: nullable(row["suggestion"]),
  });
  const attributions = new Map<number, AttributionRow[]>();
  for (const row of db
    .prepare(
      `SELECT finding_id, position, model, description, impact, suggestion FROM finding_attribution
        WHERE finding_id IN (SELECT id FROM finding WHERE ${inScope})
        ORDER BY finding_id, position`,
    )
    .all(...where.params)) {
    const said = readAttribution(row);
    const list = attributions.get(said.findingId) ?? [];
    list.push(said);
    attributions.set(said.findingId, list);
  }
  const carried = new Map<number, CarriedRow[]>();
  for (const row of db
    .prepare(
      `SELECT finding_id, position, model, run_id, description, impact, suggestion
         FROM finding_carried_attribution
        WHERE finding_id IN (SELECT id FROM finding WHERE ${inScope})
        ORDER BY finding_id, position`,
    )
    .all(...where.params)) {
    const said = readCarried(row);
    const list = carried.get(said.findingId) ?? [];
    list.push(said);
    carried.set(said.findingId, list);
  }

  const plan: RecoveryPlan = {
    runs: runs.size,
    attributions: [...attributions.values()].reduce((n, list) => n + list.length, 0),
    fills: [],
    skips: [],
    carriedInserts: [],
    carriedFills: [],
  };

  const traces = new Map<number, TraceIndex>();
  const traceOf = (runId: number): TraceIndex => {
    let index = traces.get(runId);
    if (index === undefined) {
      index = traceIndex(db, runId);
      traces.set(runId, index);
    }
    return index;
  };
  const commentCache = new Map<string, Promise<ExistingReviewComment[]>>();
  const commentOf = async (
    runId: number,
    commentId: string,
  ): Promise<ExistingReviewComment | undefined> => {
    if (comments === undefined) return undefined;
    const run = runs.get(runId)!;
    const key = `${run.owner}/${run.repo}#${run.pullNumber}`;
    let pending = commentCache.get(key);
    if (pending === undefined) {
      pending = comments({ owner: run.owner, repo: run.repo, number: run.pullNumber });
      commentCache.set(key, pending);
    }
    return (await pending).find((comment) => comment.id === commentId);
  };
  // 这条评论是谁发的:同一条评论名下 id 最小的那一行。之后折叠上去的行只是挂在它上面。
  const publisherOf = db.prepare("SELECT MIN(id) AS id FROM finding WHERE comment_id = ?");
  // 上一处:延续记下的旧评论地址所在的最新一行(id 小于本行)。
  const predecessorOf = db.prepare(
    "SELECT id, run_id FROM finding WHERE comment_html_url = ? AND id < ? ORDER BY id DESC LIMIT 1",
  );
  const attributionsOf = db.prepare(
    `SELECT finding_id, position, model, description, impact, suggestion FROM finding_attribution
      WHERE finding_id = ? ORDER BY position`,
  );
  const carriedOf = db.prepare(
    `SELECT finding_id, position, model, run_id, description, impact, suggestion
       FROM finding_carried_attribution WHERE finding_id = ? ORDER BY position`,
  );

  // 计划边算边生效:后面那一行从上一处抄历史说法时,读到的是上一处补过之后的值。
  const fillsByAttribution = new Map<string, Said>();
  const withFill = (said: AttributionRow): AttributionRow => {
    const fill = fillsByAttribution.get(`${said.findingId}${SEP}${said.position}`);
    return {
      ...said,
      impact: said.impact ?? fill?.impact ?? null,
      suggestion: said.suggestion ?? fill?.suggestion ?? null,
    };
  };
  const currentAttributions = (findingId: number): AttributionRow[] =>
    (attributions.get(findingId) ?? attributionsOf.all(findingId).map(readAttribution)).map(withFill);
  const plannedCarried = new Map<number, CarriedAttributionRecord[]>();
  const currentCarried = (findingId: number): CarriedAttributionRecord[] => {
    const planned = plannedCarried.get(findingId);
    if (planned !== undefined) return planned;
    const rows = carried.get(findingId) ?? carriedOf.all(findingId).map(readCarried);
    return rows.map(({ findingId: _findingId, position: _position, ...rest }) => rest);
  };

  for (const finding of findings) {
    const trace = traceOf(finding.runId);
    const synthesized =
      finding.continuedFrom !== null &&
      trace.verdictContinued.has(placeKey(finding.file, finding.line, finding.title));
    const place = {
      findingId: finding.id,
      runId: finding.runId,
      file: finding.file,
      line: finding.line,
    };

    for (const said of attributions.get(finding.id) ?? []) {
      if (said.impact !== null && said.suggestion !== null) continue;
      const at = { ...place, position: said.position, model: said.model };
      const fill = (source: FillSource, content: Said): void => {
        plan.fills.push({ ...at, source, ...content });
        fillsByAttribution.set(`${said.findingId}${SEP}${said.position}`, content);
      };

      // 一、成功上报的轨迹:同一轮同一模型对同一文件同一段问题表述的原文。
      const variants = trace.reports.get(reportKey(said.model, finding.file, said.description));
      if (variants !== undefined && variants.size === 1) {
        fill("trace", [...variants.values()][0]!);
        continue;
      }
      if (variants !== undefined) {
        plan.skips.push({
          ...at,
          reason: `同一轮该模型对这段问题有 ${variants.size} 次内容不同的成功上报,对不上是哪一次`,
        });
        continue;
      }
      // 二、延续合成的那一行:给出新位置的模型没有对着新代码给过修法,两段就是空。
      if (synthesized) {
        fill("continuation", { impact: "", suggestion: "" });
        continue;
      }
      // 三、它自己发出去的那条原评论。
      if (finding.commentId === null) {
        plan.skips.push({ ...at, reason: "轨迹里没有这次上报,这一行也没有行级评论" });
        continue;
      }
      const publisher = publisherOf.get(finding.commentId);
      if (Number(publisher?.["id"]) !== finding.id) {
        plan.skips.push({
          ...at,
          reason: "轨迹里没有这次上报,这一行是折叠到旧评论上的,旧评论不是它的原文",
        });
        continue;
      }
      if (comments === undefined) {
        plan.skips.push({ ...at, reason: "轨迹里没有这次上报,没配 Forge 凭据读不到原评论" });
        continue;
      }
      const comment = await commentOf(finding.runId, finding.commentId);
      if (comment === undefined) {
        plan.skips.push({ ...at, reason: "轨迹里没有这次上报,Forge 上找不到它的原评论" });
        continue;
      }
      const matched = new Map<string, Said>();
      for (const section of commentSections(comment.body)) {
        if (section.model !== said.model || section.description !== said.description) continue;
        const content = { impact: section.impact, suggestion: section.suggestion };
        matched.set(saidKey(content), content);
      }
      if (matched.size === 1) {
        fill("comment", [...matched.values()][0]!);
      } else if (matched.size === 0) {
        plan.skips.push({
          ...at,
          reason: "轨迹里没有这次上报,原评论里也没有该模型对这段问题的段落",
        });
      } else {
        plan.skips.push({
          ...at,
          reason: `原评论里该模型对这段问题有 ${matched.size} 段内容不同的说法,对不上是哪一段`,
        });
      }
    }

    // 延续合成的那一行沿延续关系抄历史说法(issue #267 的口径):上一处自己的归属逐段带出处,
    // 再接上它自己承接来的。一段都没有时整份补进;已有的只补还缺的两列。
    if (!synthesized) continue;
    const predecessor = predecessorOf.get(finding.continuedFrom!, finding.id);
    if (predecessor === undefined) continue;
    const predecessorId = Number(predecessor["id"]);
    const predecessorRunId = Number(predecessor["run_id"]);
    const own = currentAttributions(predecessorId)
      .filter(worthCarrying)
      .map((said) => ({
        model: said.model,
        runId: predecessorRunId,
        description: said.description,
        impact: said.impact,
        suggestion: said.suggestion,
      }));
    const expected = [...own, ...currentCarried(predecessorId)];
    const existing = carried.get(finding.id) ?? [];
    if (existing.length === 0) {
      if (expected.length > 0) {
        plan.carriedInserts.push({ findingId: finding.id, runId: finding.runId, rows: expected });
        plannedCarried.set(finding.id, expected);
      }
      continue;
    }
    const filled: CarriedAttributionRecord[] = [];
    for (const row of existing) {
      const source = expected.find(
        (entry) =>
          entry.model === row.model &&
          entry.runId === row.runId &&
          entry.description === row.description,
      );
      const next = {
        model: row.model,
        runId: row.runId,
        description: row.description,
        impact: row.impact ?? source?.impact ?? null,
        suggestion: row.suggestion ?? source?.suggestion ?? null,
      };
      filled.push(next);
      if (
        (row.impact === null && next.impact !== null) ||
        (row.suggestion === null && next.suggestion !== null)
      ) {
        plan.carriedFills.push({
          findingId: finding.id,
          position: row.position,
          impact: next.impact,
          suggestion: next.suggestion,
        });
      }
    }
    plannedCarried.set(finding.id, filled);
  }

  return plan;
}

/**
 * 按计划写库,一个事务。只补 NULL(`COALESCE` 保住已有值),历史说法只在那一行一段都没有
 * 时整份插入——同一份计划跑两遍,第二遍什么都不会改。
 */
export function applyRecovery(db: DatabaseSync, plan: RecoveryPlan): void {
  const fillAttribution = db.prepare(
    `UPDATE finding_attribution
        SET impact = COALESCE(impact, ?), suggestion = COALESCE(suggestion, ?)
      WHERE finding_id = ? AND position = ?`,
  );
  const insertCarried = db.prepare(
    `INSERT INTO finding_carried_attribution
       (finding_id, position, model, run_id, description, impact, suggestion)
     SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM finding_carried_attribution WHERE finding_id = ? AND position = ?)`,
  );
  const fillCarried = db.prepare(
    `UPDATE finding_carried_attribution
        SET impact = COALESCE(impact, ?), suggestion = COALESCE(suggestion, ?)
      WHERE finding_id = ? AND position = ?`,
  );
  db.exec("BEGIN");
  try {
    for (const fill of plan.fills) {
      fillAttribution.run(fill.impact, fill.suggestion, fill.findingId, fill.position);
    }
    for (const insert of plan.carriedInserts) {
      for (const [position, row] of insert.rows.entries()) {
        insertCarried.run(
          insert.findingId,
          position,
          row.model,
          row.runId,
          row.description,
          row.impact,
          row.suggestion,
          insert.findingId,
          position,
        );
      }
    }
    for (const fill of plan.carriedFills) {
      fillCarried.run(fill.impact, fill.suggestion, fill.findingId, fill.position);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
