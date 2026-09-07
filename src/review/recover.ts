/**
 * 恢复已有评审记录里缺失的影响与修改建议(issue #268)。
 *
 * 升级前落的归属没有 `impact` / `suggestion` 两列(issue #266),读回是 NULL;延续承接来的
 * 历史说法那张表(issue #267)对升级前合成的延续也是空的。这里从可靠来源找回原文:同一轮
 * 里那个模型成功报出的 `report_finding` 轨迹(参数就是原文),或它自己发出去的那条原评论;
 * 按复核结论合成的延续那一行沿已落库的延续关系从上一处抄历史说法。不调用模型、不重跑、
 * 不写 Forge。
 *
 * 判据只认唯一且一致:同一轮同一模型对同一文件同一段问题表述,成功上报的内容恰好一种才算
 * 一个候选,有两种不同说法即跳过并说明;评论只认这一行自己发出去的那条——同一条评论之后
 * 折叠上去的行不是它的作者,不拿旧评论冒充它的说法;延续只认轨迹记了「复核结论给的位置」
 * 判据的那一行,合成的那一行自己的归属只能是两段空,轨迹里同一模型对同一段问题的另一次
 * 上报不算它的。几处来源都能确认时它们必须说的一样,与这一行已有的非空内容也必须一样,
 * 任一处矛盾即跳过——两列只补 NULL 的那一格,补出来的不能是两个来源拼成的混合内容。
 * 有延续关系却没有延续事件可查的行(2026-09-04 前的轮次)分不清是合成的还是重报的,
 * 不推断,列出来说明。重复执行没有第二份副作用。
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

/** 一条归属补成什么,凭什么。`evidence` 写明每一处对上的来源,事后能按它回查。 */
export type AttributionFill = Where & {
  source: FillSource;
  evidence: string;
  impact: string | null;
  suggestion: string | null;
};

/** 一条归属为什么补不了。 */
export type AttributionSkip = Where & { reason: string };

/** 延续合成的那一行要补进的历史说法(它一段都没有时),连同抄自哪一行。 */
export type CarriedInsert = {
  findingId: number;
  runId: number;
  predecessorId: number;
  rows: CarriedAttributionRecord[];
};

/** 已有的一段历史说法里还缺的两列,从上一处补。 */
export type CarriedFill = {
  findingId: number;
  position: number;
  predecessorId: number;
  impact: string | null;
  suggestion: string | null;
};

/** 已有的一段历史说法为什么补不了。 */
export type CarriedSkip = {
  findingId: number;
  position: number;
  model: string;
  runId: number;
  reason: string;
};

/** 一条延续的历史说法整份都恢复不了,为什么。 */
export type CarriedUnrecoverable = { findingId: number; runId: number; reason: string };

export type RecoveryPlan = {
  /** 范围里的轮次数与归属总数,给预览报个底。 */
  runs: number;
  attributions: number;
  fills: AttributionFill[];
  skips: AttributionSkip[];
  carriedInserts: CarriedInsert[];
  carriedFills: CarriedFill[];
  carriedSkips: CarriedSkip[];
  carriedUnrecoverable: CarriedUnrecoverable[];
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

/**
 * 轨迹参数里的一段文本,按 `reviewer/normalize.ts` 同一道规则取:字符串就 trim,不是字符串
 * 即空串。落库的原文就是归一化之后的,这样取出来的才与归属上存的逐字相同。
 */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** 拼复合键用的分隔符:NUL 不会出现在模型标识、路径与正文里。 */
const SEP = String.fromCharCode(0);

/** 一次成功上报的内容与它在轨迹里的序号——序号是事后回查的凭据。 */
type Reported = Said & { seqs: number[] };

/** 一轮轨迹里能当恢复依据的两类事件。 */
type TraceIndex = {
  /** 模型 + 文件 + 问题表述 → 成功上报过的内容,按影响 + 建议去重。 */
  reports: Map<string, Map<string, Reported>>;
  /** 延续事件:文件 + 行 + 标题 → 事件序号与它记的判据(`content` / `verdict` / `agent`)。 */
  continued: Map<string, { seq: number; criterion: string | undefined }>;
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

function sameSaid(a: Said, b: Said): boolean {
  return a.impact === b.impact && a.suggestion === b.suggestion;
}

function traceIndex(db: DatabaseSync, runId: number): TraceIndex {
  const reports = new Map<string, Map<string, Reported>>();
  const continued = new Map<string, { seq: number; criterion: string | undefined }>();
  const rows = db
    .prepare(
      `SELECT seq, reviewer, kind, payload FROM review_trace
        WHERE run_id = ? AND kind IN ('tool_call', 'finding_continued') ORDER BY seq`,
    )
    .all(runId);
  for (const row of rows) {
    const seq = Number(row["seq"]);
    const payload = JSON.parse(String(row["payload"])) as Record<string, unknown>;
    if (row["kind"] === "finding_continued") {
      const criteria = payload["criteria"] as { kind?: unknown } | undefined;
      continued.set(
        placeKey(text(payload["file"]), Number(payload["line"]), text(payload["title"])),
        { seq, criterion: typeof criteria?.kind === "string" ? criteria.kind : undefined },
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
    const variants = reports.get(key) ?? new Map<string, Reported>();
    const known = variants.get(saidKey(said));
    if (known === undefined) variants.set(saidKey(said), { ...said, seqs: [seq] });
    else known.seqs.push(seq);
    reports.set(key, variants);
  }
  return { reports, continued };
}

/**
 * 一行承接了旧位置之后,它是哪一档:`none` 没承接;`verdict` 按复核结论合成(自己的归属
 * 只有位置复核者、两段为空,历史说法从上一处抄);`reported` 本轮自己重报的一条(词法配对
 * 或合并 agent 命中,内容是它自己的);`unknown` 只有 `continued_from`、轨迹里没有延续事件
 * 或事件没记判据(2026-09-04 前的轮次),分不清前两档,不推断。
 */
type ContinuationKind = "none" | "verdict" | "reported" | "unknown";

function continuationOf(
  trace: TraceIndex,
  finding: FindingRow,
): { kind: ContinuationKind; seq?: number } {
  if (finding.continuedFrom === null) return { kind: "none" };
  const event = trace.continued.get(placeKey(finding.file, finding.line, finding.title));
  if (event === undefined || event.criterion === undefined) return { kind: "unknown" };
  return { kind: event.criterion === "verdict" ? "verdict" : "reported", seq: event.seq };
}

const UNPROVEN_CONTINUATION =
  "这一行承接了旧位置,但轨迹没记延续事件或判据(2026-09-04 前的轮次),分不清是按复核结论合成的还是本轮重报的,不推断";

export type CommentSection = {
  model: string;
  description: string;
  impact: string;
  suggestion: string;
};

/** 一段的正文按逐归属分段那种正文的同一格式拼回去,回写校验用。 */
function renderSection(section: CommentSection): string {
  const parts = [`**${section.model}**`, `**问题**:${section.description}`];
  if (section.impact !== "") parts.push(`**影响**:${section.impact}`);
  if (section.suggestion !== "") parts.push(`**建议**:${section.suggestion}`);
  return parts.join("\n\n");
}

/** 只含一对粗体星号、整段就是一个标题的段落,取它的文字;含内嵌 `**` 或不是整段粗体即不是。 */
function boldOnly(paragraph: string): string | undefined {
  return /^\*\*([^*]+)\*\*$/.exec(paragraph)?.[1];
}

/** 这一段里有几行围栏(```` ``` ```` 或 `~~~`)起止。奇数即从这一段起进出围栏一次。 */
function fenceLines(paragraph: string): number {
  return paragraph.split("\n").filter((line) => /^\s*(```|~~~)/.test(line)).length;
}

/**
 * 一条评论正文里按模型分的段(逐归属分段那种正文反过来读,issue #278 之前发出去的都是
 * 这个形状;之后的正文只有一份代表段,拆不出各模型原文,整条不给)。保守解析,不做
 * 完整 Markdown:标签行(`**问题**:` / `**影响**:` / `**建议**:`)先认;模型标题只认整段
 * 粗体、不含内嵌 `**` 且正好是这条 Finding 某个归属模型标识的段落;段落正文可以跨多个空行
 * 分隔的段落,遇到下一个标签、模型标题、「沿用 …」段、延续说明或锚点为止,正文里的粗体行
 * (`**边界处理**`)照原样接上;围栏代码跨段落跟踪,围栏里的每一段不论长什么样都是正文,
 * 围栏没闭合即不可靠。解析完两道核对:按同一格式拼回去与原文逐字比对;拆出的段与这条
 * Finding 的归属(模型 + 问题表述,按首报先后)一一对应——正文里出现 `**模型**` 形状的
 * 段落会多拆出一段,段数对不上就整条不给。任一道不过即返回 undefined——宁可不补,也不写进
 * 截断或错位的内容。
 */
export function commentSections(
  body: string,
  attributions: readonly { model: string; description: string }[],
): CommentSection[] | undefined {
  type Block = { kind: "verbatim"; text: string } | { kind: "section"; section: CommentSection };
  const models = new Set(attributions.map((entry) => entry.model));
  const blocks: Block[] = [];
  let mode: "start" | "section" | "carried" | "tail" = "start";
  let section: CommentSection | undefined;
  let field: "description" | "impact" | "suggestion" | undefined;
  let fenced = false;
  const verbatim = (paragraph: string): void => {
    blocks.push({ kind: "verbatim", text: paragraph });
    section = undefined;
    field = undefined;
  };
  /** 把一段放到它该在的位置;放不下即整条不可靠。 */
  const place = (index: number, paragraph: string): boolean => {
    if (fenced) {
      // 围栏里的段落一律是正文,不管它长得像标签还是模型标题。
      if (mode !== "section" || field === undefined) return false;
      section![field] = `${section![field]}\n\n${paragraph}`;
      return true;
    }
    const label = /^\*\*(问题|影响|建议)\*\*:([\s\S]*)$/.exec(paragraph);
    if (label !== null && mode === "section") {
      field = label[1] === "问题" ? "description" : label[1] === "影响" ? "impact" : "suggestion";
      section![field] = label[2]!;
      return true;
    }
    const heading = boldOnly(paragraph);
    if (heading !== undefined && models.has(heading)) {
      section = { model: heading, description: "", impact: "", suggestion: "" };
      blocks.push({ kind: "section", section });
      mode = "section";
      field = undefined;
      return true;
    }
    if (mode === "section" && field !== undefined) {
      // 段落正文的续段:粗体行照原样接上;只有真正的结构标记才结束这一段。
      const structural =
        (heading !== undefined && heading.startsWith("沿用 ")) ||
        paragraph.startsWith("<!--") ||
        paragraph.startsWith("延续自 ");
      if (!structural) {
        section![field] = `${section![field]}\n\n${paragraph}`;
        return true;
      }
    }
    if (heading !== undefined && heading.startsWith("沿用 ")) {
      verbatim(paragraph);
      mode = "carried";
      return true;
    }
    if (paragraph.startsWith("<!--") || paragraph.startsWith("延续自 ")) {
      verbatim(paragraph);
      mode = "tail";
      return true;
    }
    if (index === 0 && heading !== undefined && heading.startsWith("[")) {
      verbatim(paragraph);
      return true;
    }
    if (mode === "carried") {
      verbatim(paragraph);
      return true;
    }
    // 挂不到任何段上的段落:模型标题后没有问题标签、结尾之后还有正文、开头不是等级标题。
    return false;
  };
  for (const [index, paragraph] of body.split("\n\n").entries()) {
    if (!place(index, paragraph)) return undefined;
    if (fenceLines(paragraph) % 2 === 1) fenced = !fenced;
  }
  if (fenced) return undefined;
  const rendered = blocks
    .map((block) => (block.kind === "verbatim" ? block.text : renderSection(block.section)))
    .join("\n\n");
  if (rendered !== body) return undefined;
  const sections = blocks.flatMap((block) => (block.kind === "section" ? [block.section] : []));
  if (
    sections.length !== attributions.length ||
    sections.some(
      (entry, index) =>
        entry.model !== attributions[index]!.model ||
        entry.description !== attributions[index]!.description,
    )
  ) {
    return undefined;
  }
  return sections;
}

/** 两段都是空串的归属没有内容可带;NULL 的照实带(与 `historyPlacements` 同一条口径)。 */
function worthCarrying(said: Said): boolean {
  return !(said.impact === "" && said.suggestion === "");
}

/** 这些候选说的是不是同一件事。 */
function agree(candidates: readonly Said[]): boolean {
  return candidates.every((said) => sameSaid(said, candidates[0]!));
}

/**
 * 候选与这一行已有的非空内容矛盾吗。只补 NULL 的那一格,所以已有的那一格必须与候选逐字
 * 相同,否则补出来的是两个来源拼成的混合内容。
 */
function contradictsExisting(existing: Said, candidate: Said): string | undefined {
  if (existing.impact !== null && existing.impact !== candidate.impact) return "影响";
  if (existing.suggestion !== null && existing.suggestion !== candidate.suggestion) return "建议";
  return undefined;
}

/**
 * 算出这个范围里能补什么、补不了什么。只读库;`comments` 不给即不查原评论(没配 Forge
 * 凭据时),轨迹也没有的那一档按无来源跳过。
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
  const readFinding = (row: Record<string, unknown>): FindingRow => ({
    id: Number(row["id"]),
    runId: Number(row["run_id"]),
    file: String(row["file"]),
    line: Number(row["line"]),
    title: row["title"] === null ? "" : String(row["title"]),
    commentId: nullable(row["comment_id"]),
    continuedFrom: nullable(row["continued_from"]),
  });
  const FINDING_COLUMNS = "id, run_id, file, line, title, comment_id, continued_from";
  const findings: FindingRow[] = db
    .prepare(`SELECT ${FINDING_COLUMNS} FROM finding WHERE ${inScope} ORDER BY id`)
    .all(...where.params)
    .map(readFinding);
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
    carriedSkips: [],
    carriedUnrecoverable: [],
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
    `SELECT ${FINDING_COLUMNS} FROM finding
      WHERE comment_html_url = ? AND id < ? ORDER BY id DESC LIMIT 1`,
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
  /**
   * 范围内每条延续合成的行,它的历史说法在这份计划里最终是什么:整份补进的、补齐过的或
   * 原样;`undefined` 即这一行的历史说法没能恢复(上一处导不进来),往后承接它的也导不了。
   */
  const resolvedCarried = new Map<number, CarriedAttributionRecord[] | undefined>();

  /**
   * 这一行自己发出去的原评论里,该模型对这段问题的说法。`unavailable` 即没法确认(没配
   * Forge、这一行不是评论的作者、评论找不到、正文拆不开或没有对上的段落),`conflict` 即
   * 评论里有几段不同的说法。能确认的那一档带评论 id 作凭据。
   */
  type CommentSaid =
    | { kind: "unavailable"; why: string }
    | { kind: "conflict"; count: number }
    | { kind: "said"; said: Said; commentId: string };
  const commentSaid = async (finding: FindingRow, said: AttributionRow): Promise<CommentSaid> => {
    if (finding.commentId === null) return { kind: "unavailable", why: "这一行没有行级评论" };
    const publisher = publisherOf.get(finding.commentId);
    if (Number(publisher?.["id"]) !== finding.id) {
      return { kind: "unavailable", why: "这一行是折叠到旧评论上的,旧评论不是它的原文" };
    }
    if (comments === undefined) return { kind: "unavailable", why: "没配 Forge 凭据读不到原评论" };
    const comment = await commentOf(finding.runId, finding.commentId);
    if (comment === undefined) return { kind: "unavailable", why: "Forge 上找不到它的原评论" };
    const sections = commentSections(comment.body, attributions.get(finding.id) ?? []);
    if (sections === undefined) {
      return {
        kind: "unavailable",
        why: "原评论正文拆不开(有像标签或标题的行、围栏没闭合,或段落与归属对不上),不拿它当依据",
      };
    }
    const matched = new Map<string, Said>();
    for (const section of sections) {
      if (section.model !== said.model || section.description !== said.description) continue;
      const content = { impact: section.impact, suggestion: section.suggestion };
      matched.set(saidKey(content), content);
    }
    if (matched.size === 0) {
      return { kind: "unavailable", why: "原评论里没有该模型对这段问题的段落" };
    }
    if (matched.size > 1) return { kind: "conflict", count: matched.size };
    return { kind: "said", said: [...matched.values()][0]!, commentId: comment.id };
  };

  /**
   * 从上一处能抄来什么历史说法:上一处自己的归属逐段带出处(它自己是合成的那一档没有——
   * 位置复核者不是作者),再接上它自己承接来的。上一处不在本次范围里时只认已经落库完整的:
   * 延续判据要可追溯,合成的要有自己的历史说法;否则中间那一轮的位置复核者会被当成原作者、
   * 更早的原作者永远丢掉,拒绝导入并说明。
   */
  const importFrom = (
    predecessor: FindingRow,
  ): { rows: CarriedAttributionRecord[] } | { reason: string } => {
    const kind = continuationOf(traceOf(predecessor.runId), predecessor).kind;
    if (kind === "unknown") {
      return { reason: `上一处(finding ${predecessor.id})的延续判据不可追溯,分不清它自己的归属是不是原作者` };
    }
    const own =
      kind === "verdict"
        ? []
        : currentAttributions(predecessor.id)
            .filter(worthCarrying)
            .map((said) => ({
              model: said.model,
              runId: predecessor.runId,
              description: said.description,
              impact: said.impact,
              suggestion: said.suggestion,
            }));
    if (kind !== "verdict") return { rows: own };
    if (runs.has(predecessor.runId)) {
      const resolved = resolvedCarried.get(predecessor.id);
      if (resolved === undefined) {
        return { reason: `上一处(finding ${predecessor.id})自己的历史说法在这份计划里没能恢复` };
      }
      return { rows: resolved };
    }
    const stored = carriedOf.all(predecessor.id).map(readCarried);
    if (stored.length === 0) {
      return {
        reason: `上一处(finding ${predecessor.id},第 ${predecessor.runId} 轮)不在本次范围里,它自己的历史说法还没恢复;先把那一轮或整个仓库一起恢复`,
      };
    }
    return {
      rows: stored.map(({ findingId: _findingId, position: _position, ...rest }) => rest),
    };
  };

  for (const finding of findings) {
    const trace = traceOf(finding.runId);
    const continuation = continuationOf(trace, finding);
    const place = {
      findingId: finding.id,
      runId: finding.runId,
      file: finding.file,
      line: finding.line,
    };

    for (const said of attributions.get(finding.id) ?? []) {
      if (said.impact !== null && said.suggestion !== null) continue;
      const at = { ...place, position: said.position, model: said.model };
      const skip = (reason: string): void => {
        plan.skips.push({ ...at, reason });
      };
      if (continuation.kind === "unknown") {
        skip(UNPROVEN_CONTINUATION);
        continue;
      }

      // 合成的那一行自己的归属只能是两段空:给出新位置的模型没有对着新代码给过修法。
      // 轨迹里它对同一段问题的另一次上报(标题不相似、没被词法配对的那条)是另一行的,不算它的。
      const candidates: { source: FillSource; said: Said; evidence: string }[] = [];
      if (continuation.kind === "verdict") {
        candidates.push({
          source: "continuation",
          said: { impact: "", suggestion: "" },
          evidence: `延续事件 seq ${continuation.seq}`,
        });
      } else {
        // 轨迹(同一轮同一模型对这段问题的成功上报)与原评论各出一个候选。
        const variants = trace.reports.get(reportKey(said.model, finding.file, said.description));
        if (variants !== undefined && variants.size > 1) {
          skip(`同一轮该模型对这段问题有 ${variants.size} 次内容不同的成功上报,对不上是哪一次`);
          continue;
        }
        const fromComment = await commentSaid(finding, said);
        if (fromComment.kind === "conflict") {
          skip(`原评论里该模型对这段问题有 ${fromComment.count} 段内容不同的说法,对不上是哪一段`);
          continue;
        }
        if (variants !== undefined) {
          const reported = [...variants.values()][0]!;
          candidates.push({
            source: "trace",
            said: reported,
            evidence: `轨迹 seq ${reported.seqs.join("、")}`,
          });
        }
        if (fromComment.kind === "said") {
          candidates.push({
            source: "comment",
            said: fromComment.said,
            evidence: `原评论 ${fromComment.commentId}`,
          });
        }
        if (candidates.length === 0) {
          skip(`轨迹里没有这次上报,${fromComment.kind === "unavailable" ? fromComment.why : ""}`);
          continue;
        }
      }
      // 几处来源都能确认时必须说的一样;与已有的非空内容也必须一样。
      if (!agree(candidates.map((candidate) => candidate.said))) {
        skip(
          `来源矛盾:${candidates
            .map(
              (candidate) =>
                `${candidate.evidence}说「${candidate.said.impact}」/「${candidate.said.suggestion}」`,
            )
            .join(",")}`,
        );
        continue;
      }
      const chosen = candidates[0]!;
      const contradiction = contradictsExisting(said, chosen.said);
      if (contradiction !== undefined) {
        skip(`${chosen.evidence}给出的${contradiction}与这一行已有的${contradiction}不一致,不拼混合内容`);
        continue;
      }
      plan.fills.push({
        ...at,
        source: chosen.source,
        evidence: candidates.map((candidate) => candidate.evidence).join(";"),
        ...chosen.said,
      });
      fillsByAttribution.set(`${said.findingId}${SEP}${said.position}`, chosen.said);
    }

    // 延续的历史说法只有按复核结论合成的那一档才有。判据不可追溯的列出来,不推断。
    if (continuation.kind === "unknown") {
      plan.carriedUnrecoverable.push({
        findingId: finding.id,
        runId: finding.runId,
        reason: UNPROVEN_CONTINUATION,
      });
      continue;
    }
    if (continuation.kind !== "verdict") continue;
    const existing = carried.get(finding.id) ?? [];
    const predecessorRow = predecessorOf.get(finding.continuedFrom!, finding.id);
    if (predecessorRow === undefined) {
      resolvedCarried.set(finding.id, existing.length === 0 ? undefined : existing);
      plan.carriedUnrecoverable.push({
        findingId: finding.id,
        runId: finding.runId,
        reason: "延续记下的旧评论地址在库里找不到上一处",
      });
      continue;
    }
    const predecessor = readFinding(predecessorRow);
    const imported = importFrom(predecessor);
    if ("reason" in imported) {
      // 已有的那些原样留着;一段都没有的这一行往后也导不出去。
      resolvedCarried.set(finding.id, existing.length === 0 ? undefined : existing);
      plan.carriedUnrecoverable.push({ findingId: finding.id, runId: finding.runId, reason: imported.reason });
      continue;
    }
    const expected = imported.rows;
    if (existing.length === 0) {
      if (expected.length > 0) {
        plan.carriedInserts.push({
          findingId: finding.id,
          runId: finding.runId,
          predecessorId: predecessor.id,
          rows: expected,
        });
      }
      resolvedCarried.set(finding.id, expected);
      continue;
    }
    // 已有的只补还缺的两列,且只认唯一对上的那一段——同一模型对同一段问题有几段不同说法时
    // 分不清哪段是它,跳过并说明。
    const filled: CarriedAttributionRecord[] = [];
    for (const row of existing) {
      const kept = { model: row.model, runId: row.runId, description: row.description };
      const asIs = { ...kept, impact: row.impact, suggestion: row.suggestion };
      if (row.impact !== null && row.suggestion !== null) {
        filled.push(asIs);
        continue;
      }
      const sources = new Map<string, Said>();
      for (const entry of expected) {
        if (
          entry.model !== row.model ||
          entry.runId !== row.runId ||
          entry.description !== row.description
        ) {
          continue;
        }
        sources.set(saidKey(entry), { impact: entry.impact, suggestion: entry.suggestion });
      }
      const at = { findingId: finding.id, position: row.position, model: row.model, runId: row.runId };
      if (sources.size !== 1) {
        filled.push(asIs);
        plan.carriedSkips.push({
          ...at,
          reason:
            sources.size === 0
              ? `上一处(finding ${predecessor.id})没有该模型对这段问题的说法`
              : `上一处(finding ${predecessor.id})该模型对这段问题有 ${sources.size} 段内容不同的说法,对不上是哪一段`,
        });
        continue;
      }
      const source = [...sources.values()][0]!;
      const contradiction = contradictsExisting(row, source);
      if (contradiction !== undefined) {
        filled.push(asIs);
        plan.carriedSkips.push({
          ...at,
          reason: `上一处(finding ${predecessor.id})的${contradiction}与这一段已有的${contradiction}不一致,不拼混合内容`,
        });
        continue;
      }
      const next = {
        ...kept,
        impact: row.impact ?? source.impact,
        suggestion: row.suggestion ?? source.suggestion,
      };
      filled.push(next);
      if (
        (row.impact === null && next.impact !== null) ||
        (row.suggestion === null && next.suggestion !== null)
      ) {
        plan.carriedFills.push({
          findingId: finding.id,
          position: row.position,
          predecessorId: predecessor.id,
          impact: next.impact,
          suggestion: next.suggestion,
        });
      }
    }
    resolvedCarried.set(finding.id, filled);
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
