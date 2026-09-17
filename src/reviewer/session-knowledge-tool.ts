/**
 * Agent 会话的知识工具(issue #344、#360)。底座工具面的三件,所有用途都注册:
 * `query_knowledge` 读,`write_knowledge` 与 `withdraw_knowledge` 写产品知识。
 *
 * 知识不进系统提示:提示里只有一份目录,条目由查询工具按需取——一个只动后端的任务不该为
 * 另一个仓库的路由表付 token。产品层按名字读整条(术语条目、产品决策)或整段读仓库关系,
 * 仓库层照旧按仓库与路径 glob 取。
 *
 * 写下即生效(ADR 0035):没有提案态,人在访谈里的回答就是裁决,工具落库即产品页可见。
 * 形状不对的那一次走**正常返回**一句理由打回(定义为空、定义里带路径或类名、决策没有
 * 标题),与产出工具同一口径——模型看见理由就改得动。
 *
 * 三件工具都走同一条请求-回应:查询与落库在主进程做(子进程没有库连接,ADR 0017 同律),
 * IPC 上按 `requestId` 配对,主进程恒回一条,这边因此不设超时。
 */
import { randomUUID } from "node:crypto";

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type {
  SessionKnowledgeEntries,
  SessionKnowledgeWrite,
  SessionProductKnowledge,
  SessionWorkerMessage,
} from "./session-protocol.ts";
import { FINDING_QUERY_LIMIT } from "./session-finding-tool.ts";
import { countOf, oneLine, toolText } from "./worker-tools.ts";

export const QUERY_KNOWLEDGE_TOOL = "query_knowledge";
export const WRITE_KNOWLEDGE_TOOL = "write_knowledge";
export const WITHDRAW_KNOWLEDGE_TOOL = "withdraw_knowledge";

/** 三种条目的取值。工具参数里是一个字符串,认不出的那一次打回。 */
const KINDS = ["term", "relationship", "decision"] as const;

const querySchema = Type.Object({
  repos: Type.Optional(
    Type.Array(
      Type.String({
        description: "One repository, exactly as <owner>/<repo>",
      }),
      {
        description:
          "The repositories whose review rules and project facts you want, each exactly as <owner>/<repo>, copied from the list of this session's repositories. Leave it out when you only want product knowledge.",
      },
    ),
  ),
  pathGlob: Type.Optional(
    Type.String({
      description:
        "Only repository entries whose scope overlaps this glob, relative to the root of a repository, without the <owner>/<repo> prefix — for example src/finance/** or src/**/*.ts. Leave it out for everything those repositories have written down.",
    }),
  ),
  names: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Glossary term names and decision titles to read in full, copied exactly from the table of contents in your prompt.",
    }),
  ),
  relationships: Type.Optional(
    Type.Boolean({
      description:
        "True to read the whole repository-relationship section of this product: how its repositories work together.",
    }),
  ),
});

const annotationSchema = Type.Array(
  Type.Object({
    location: Type.String({
      description:
        "Where you read it, as <owner>/<repo>/path:line — for example acme/orders/src/gateway.ts:42",
    }),
    reason: Type.String({
      description: "One line, in Chinese, saying what that spot shows",
    }),
  }),
  {
    description:
      "Where this entry comes from in the code. Empty array when it comes from what the person told you rather than from a file. These annotations are shown on the product page and never go into a prompt.",
  },
);

const writeSchema = Type.Object({
  kind: Type.String({
    description:
      "Which kind of entry this is: term for a glossary term, relationship for one statement about how repositories of this product work together, decision for a decision record.",
  }),
  name: Type.Optional(
    Type.String({
      description:
        "The term name, or the title of the decision, written in Chinese. A relationship has no name; leave it out.",
    }),
  ),
  body: Type.String({
    description:
      "Written in Chinese. For a term: one or two sentences saying what it is, in the language of the product — no class names, no file paths, no code. For a relationship: one sentence saying who asks what of whom, or which change drags which repository along. For a decision: one to three sentences of context, decision and why.",
  }),
  topic: Type.Optional(
    Type.String({
      description: "The topic this term is grouped under on the product page, in Chinese",
    }),
  ),
  avoided: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Synonyms this product does not use for this term, so that everybody keeps saying the same word",
    }),
  ),
  options: Type.Optional(
    Type.String({
      description: "For a decision: the options that were considered and set aside, in Chinese",
    }),
  ),
  consequences: Type.Optional(
    Type.String({
      description: "For a decision: what follows from it, in Chinese",
    }),
  ),
  annotations: Type.Optional(annotationSchema),
  entryId: Type.Optional(
    Type.Integer({
      description:
        "The id of the entry this call rewrites, copied from a query_knowledge result. Leave it out to write a new entry.",
    }),
  ),
  supersedes: Type.Optional(
    Type.Integer({
      description:
        "For a decision that replaces an earlier one: the id of the decision it replaces. That decision stays readable, marked as superseded.",
    }),
  ),
});

const withdrawSchema = Type.Object({
  entryId: Type.Integer({
    description: "The id of the entry to withdraw, copied from a query_knowledge result",
  }),
});

/** 一次查询的回应。主进程查不动时带 `failure`,两个数组那时都是空的。 */
export type KnowledgeQueryResult = SessionKnowledgeEntries & { failure?: string };

/** 一次写入或撤回的回应。落不下时带 `failure`。 */
export type KnowledgeWriteResult = { entry?: SessionProductKnowledge; failure?: string };

/** 还没回应的查询。一进程一会话,模型一次只等一个工具结果,这张表常态只有一条。 */
const pending = new Map<string, (result: KnowledgeQueryResult) => void>();
/** 还没回应的写入与撤回。与查询分开一张:两种回应的形状不同。 */
const pendingWrites = new Map<string, (result: KnowledgeWriteResult) => void>();

/** 主进程的回应到了:兑现那一次等着的工具调用。认不出的 `requestId` 直接丢掉。 */
export function resolveKnowledgeQuery(requestId: string, result: KnowledgeQueryResult): void {
  const settle = pending.get(requestId);
  pending.delete(requestId);
  settle?.(result);
}

/** 一次写入或撤回的回应到了。与查询那一处同律。 */
export function resolveKnowledgeWrite(requestId: string, result: KnowledgeWriteResult): void {
  const settle = pendingWrites.get(requestId);
  pendingWrites.delete(requestId);
  settle?.(result);
}

/**
 * 一条产品知识交给模型看的样子:id 在最前(改写与撤回要抄它),之后按种类各自成行。
 *
 * 查询结果与产品梳理的系统提示渲染的是同一份(`session-worker.ts`,issue #365):那个用途
 * 整份带着此刻的条目,两处分叉会让它对着两种样子的同一条目自相矛盾。
 */
export function productKnowledgeLine(entry: SessionProductKnowledge): string {
  const at = `- [${entry.id}]`;
  if (entry.kind === "relationship") return `${at} repository relationship: ${oneLine(entry.body)}`;
  if (entry.kind === "term") {
    const topic = entry.topic === null ? "" : ` (topic ${entry.topic})`;
    const avoided =
      entry.avoided.length === 0 ? "" : ` This product does not say: ${entry.avoided.join(", ")}.`;
    return `${at} glossary term ${entry.name}${topic}: ${oneLine(entry.body)}${avoided}`;
  }
  const status =
    entry.supersededBy === null ? "in force" : `superseded by entry ${entry.supersededBy}`;
  const options = entry.options === null ? "" : ` Options considered: ${oneLine(entry.options)}.`;
  const consequences =
    entry.consequences === null ? "" : ` Consequences: ${oneLine(entry.consequences)}.`;
  return `${at} decision ${entry.name} (${status}): ${oneLine(entry.body)}${options}${consequences}`;
}

/** 一条仓库层条目:层与型、所属仓库、作用范围(空串即全仓库)与那一句陈述。 */
function repoLine(entry: SessionKnowledgeEntries["repo"][number]): string {
  const layer = entry.type === "rule" ? "review rule" : "project fact";
  const scope = entry.scope === "" ? "whole repository" : entry.scope;
  return `- ${layer} of ${entry.repo} (${scope}): ${oneLine(entry.statement)}`;
}

/**
 * 一次查询的结果文字。
 *
 * 两层各一段,仓库层满上限时那一段说明还有更多——与历史 Finding 的措辞同一口径。问到的名字
 * 一条都没有时说清「问到了,没有」:空结果与「没查到」是两件事,模型不该以为自己该换个问法
 * 再试一遍。
 */
export function renderKnowledge(
  query: { repos: readonly string[]; names: readonly string[]; relationships: boolean },
  entries: SessionKnowledgeEntries,
): string {
  const sections: string[] = [];
  if (entries.product.length > 0) {
    sections.push(
      `${countOf(entries.product.length, "product knowledge entry", "product knowledge entries")} of this product.`,
      "",
      ...entries.product.map(productKnowledgeLine),
    );
  }
  // 问了名字却一条都没对上:说出是哪几个,模型据它回去对目录,而不是换个措辞再问一遍。
  const missing = query.names.filter(
    (name) => !entries.product.some((entry) => entry.name === name),
  );
  if (missing.length > 0) {
    if (sections.length > 0) sections.push("");
    sections.push(
      `Nothing is written down under ${missing.join(", ")}; the names in the table of contents of your prompt are the ones that exist.`,
    );
  }
  if (query.relationships && !entries.product.some((entry) => entry.kind === "relationship")) {
    if (sections.length > 0) sections.push("");
    sections.push("This product has not written down how its repositories work together yet.");
  }
  if (query.repos.length > 0) {
    const asked = query.repos.join(", ");
    if (sections.length > 0) sections.push("");
    if (entries.repo.length === 0) {
      sections.push(`No review rule or project fact of ${asked} matches.`);
    } else {
      const capped =
        entries.repo.length === FINDING_QUERY_LIMIT
          ? ` Only ${FINDING_QUERY_LIMIT} are listed; narrow the repositories or the path glob to see the rest.`
          : "";
      sections.push(
        `${countOf(entries.repo.length, "review rule or project fact", "review rules and project facts")} of ${asked}.${capped}`,
        "",
        ...entries.repo.map(repoLine),
      );
    }
  }
  return sections.length === 0
    ? "Nothing written down covers that."
    : sections.join("\n");
}

/** 这个字符串里像实现细节的那一处,回一句说得出判据的理由;没有即 undefined。 */
function implementationDetail(text: string): string | undefined {
  if (text.includes("`")) return "it quotes code in backticks";
  // ASCII 的 a/b 形状即路径或仓库名。中文的「订单/退款」两侧不是 ASCII,不算。
  const path = /[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.exec(text);
  if (path !== null) return `it contains the path ${path[0]}`;
  const file = /[A-Za-z0-9_-]+\.(ts|tsx|js|jsx|java|py|go|rs|rb|php|cs|kt|swift|sql|ya?ml|json)\b/.exec(
    text,
  );
  if (file !== null) return `it names the file ${file[0]}`;
  const className = /\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b/.exec(text);
  if (className !== null) return `it names the class ${className[0]}`;
  return undefined;
}

/** 去掉首尾空白,丢掉空项。模型给的列表里常有空串占位。 */
function cleanList(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value !== "");
}

/** 空白即没给。可选文本格一律走它。 */
function optionalText(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? null : text;
}

/** 服务端归一化:文本 trim,列表去空项,可选格的空白落 null。与产出工具同一做法。 */
export function normalizeKnowledgeWrite(params: Record<string, unknown>): SessionKnowledgeWrite {
  const annotations = Array.isArray(params["annotations"]) ? params["annotations"] : [];
  const id = params["entryId"];
  const supersedes = params["supersedes"];
  return {
    kind: String(params["kind"] ?? "").trim() as SessionKnowledgeWrite["kind"],
    name: typeof params["name"] === "string" ? params["name"].trim() : "",
    body: typeof params["body"] === "string" ? params["body"].trim() : "",
    topic: optionalText(params["topic"]),
    avoided: cleanList(Array.isArray(params["avoided"]) ? (params["avoided"] as string[]) : []),
    options: optionalText(params["options"]),
    consequences: optionalText(params["consequences"]),
    annotations: annotations
      .map((one) => ({
        location: optionalText((one as { location?: unknown })?.location) ?? "",
        reason: optionalText((one as { reason?: unknown })?.reason) ?? "",
      }))
      .filter((one) => one.location !== ""),
    ...(Number.isInteger(id) ? { id: id as number } : {}),
    ...(Number.isInteger(supersedes) ? { supersedes: supersedes as number } : {}),
  };
}

/**
 * 这一条要不要打回,要就回一句理由(issue #360 的三道校验)。
 *
 * 只回第一处:一次说一件事,模型改完再写一版,比收到一张清单挑着改可靠。
 */
export function knowledgeWriteRejection(write: SessionKnowledgeWrite): string | undefined {
  if (!(KINDS as readonly string[]).includes(write.kind)) {
    return `kind has to be one of: ${KINDS.join(", ")}`;
  }
  if (write.kind === "term" && write.name === "") {
    return "a glossary term needs its name; write the term itself in name";
  }
  if (write.kind === "decision" && write.name === "") {
    return "a decision needs a title; write it in name";
  }
  if (write.body === "") {
    return write.kind === "term"
      ? "the definition is empty; say in one or two sentences what this term is"
      : "the body is empty; write the statement itself, in Chinese";
  }
  if (write.kind === "term") {
    const detail = implementationDetail(write.body);
    if (detail !== undefined) {
      return `the definition of ${write.name} reads as implementation, not as the product's language: ${detail}. Say what the term is; put the code you read into annotations instead.`;
    }
  }
  if (write.supersedes !== undefined && write.kind !== "decision") {
    return "only a decision supersedes another decision; leave supersedes out";
  }
  return undefined;
}

/**
 * 知识查询工具。`repos` 是会话根里的 `<owner>/<repo>` 清单:会话读得到的仓库就是这几个,
 * 问别的仓库即打回——知识跟着仓库走,读不到那个仓库的代码也不该读到它的约定(ADR 0018)。
 *
 * Reviewer 注册的是同一份定义(issue #362),只是 `repos` 给空数组:它的评审规则与项目事实
 * 已经整段注入了本批提示,这一件工具在那一侧只读产品层。问仓库层时的两句措辞因此分档。
 */
export function sessionKnowledgeTool(options: {
  /** 会话根里的仓库。空数组即这一侧只读产品层(Reviewer 那一档)。 */
  repos: readonly string[];
  /** 只发 `knowledge-query` 一档:两条链路的回传消息类型不同,这里只取交集。 */
  send: (message: Extract<SessionWorkerMessage, { kind: "knowledge-query" }>) => void;
}): ToolDefinition<never, never> {
  return defineTool({
    name: QUERY_KNOWLEDGE_TOOL,
    label: "Query Knowledge",
    description:
      "Read what this product and its repositories have written down. Product knowledge comes back whole: a glossary term or a decision record by name, and the repository-relationship section, which says who asks what of whom and which change drags which repository along. Each repository also has its own review rules (what it holds its code to, so you know which details matter) and project facts (grounds for judgement, so you need not assume — and when the code contradicts a fact, the code wins). Ask before you claim anything about how the pieces fit, about what a term of this product means, or about what this code is held to.",
    parameters: querySchema,
    execute: async (_id, params) => {
      const { repos, pathGlob, names, relationships } = params as {
        repos?: unknown;
        pathGlob?: string;
        names?: unknown;
        relationships?: unknown;
      };
      const asked = cleanList(
        (Array.isArray(repos) ? repos : []).filter((one): one is string => typeof one === "string"),
      );
      const wantedNames = cleanList(
        (Array.isArray(names) ? names : []).filter((one): one is string => typeof one === "string"),
      );
      const wantsRelationships = relationships === true;
      // 仓库层问不到的那一档(Reviewer):两句措辞都不提仓库,提了也没有一个能填进去。
      const repoLayer = options.repos.length > 0;
      if (asked.length === 0 && wantedNames.length === 0 && !wantsRelationships) {
        return toolText(
          repoLayer
            ? `say what to read: names of glossary terms or decisions, relationships: true, or one of this session's repositories (${options.repos.join(", ")})`
            : "say what to read: names of glossary terms or decisions, or relationships: true",
        );
      }
      const outside = asked.filter((one) => !options.repos.includes(one));
      if (outside.length > 0) {
        return toolText(
          repoLayer
            ? `${outside.join(", ")} is not a repository of this session; look in one of: ${options.repos.join(", ")}`
            : "this tool reads only this product's knowledge here; the review rules and project facts of this repository are already in your prompt. Ask by names, or with relationships: true.",
        );
      }
      const glob = pathGlob?.trim();
      const requestId = randomUUID();
      const result = await new Promise<KnowledgeQueryResult>((settle) => {
        pending.set(requestId, settle);
        options.send({
          kind: "knowledge-query",
          requestId,
          query: {
            ...(asked.length === 0 ? {} : { repos: asked }),
            ...(glob === undefined || glob === "" ? {} : { pathGlob: glob }),
            ...(wantedNames.length === 0 ? {} : { names: wantedNames }),
            ...(wantsRelationships ? { relationships: true } : {}),
          },
        });
      });
      if (result.failure !== undefined) {
        return toolText(`could not read what this product has written down: ${result.failure}`);
      }
      return toolText(
        renderKnowledge(
          { repos: asked, names: wantedNames, relationships: wantsRelationships },
          result,
        ),
      );
    },
  }) as unknown as ToolDefinition<never, never>;
}

/**
 * 产品知识的写工具两件(issue #360):写下或改写一条,以及撤回一条。所有用途都注册——会话
 * skill 里的 domain-modeling 写的就是这两件(ADR 0035)。
 */
export function sessionKnowledgeWriteTools(options: {
  send: (message: SessionWorkerMessage) => void;
}): ToolDefinition<never, never>[] {
  const write = defineTool({
    name: WRITE_KNOWLEDGE_TOOL,
    label: "Write Product Knowledge",
    description:
      "Write one entry of this product's knowledge: a glossary term, one statement about how its repositories work together, or a decision record. The entry takes effect the moment this call returns — it is on the product page and every later session reads it, so write it only from what the person confirmed or from code you read yourself. Pass entryId to rewrite an entry you wrote earlier.",
    parameters: writeSchema,
    execute: async (_id, params) => {
      const record = normalizeKnowledgeWrite(params as Record<string, unknown>);
      const rejection = knowledgeWriteRejection(record);
      if (rejection !== undefined) return toolText(rejection);
      const requestId = randomUUID();
      const result = await new Promise<KnowledgeWriteResult>((settle) => {
        pendingWrites.set(requestId, settle);
        options.send({ kind: "knowledge-write", requestId, write: record });
      });
      if (result.entry === undefined) {
        return toolText(result.failure ?? "could not write it down");
      }
      return toolText(
        `written as entry ${result.entry.id}; it is in force now:\n${productKnowledgeLine(result.entry)}`,
      );
    },
  }) as unknown as ToolDefinition<never, never>;

  const withdraw = defineTool({
    name: WITHDRAW_KNOWLEDGE_TOOL,
    label: "Withdraw Product Knowledge",
    description:
      "Withdraw one entry of this product's knowledge: it leaves the product page and no later session reads it. Use it when the person says an entry you wrote is wrong, or when what it says no longer holds.",
    parameters: withdrawSchema,
    execute: async (_id, params) => {
      const entryId = (params as { entryId?: unknown }).entryId;
      if (!Number.isInteger(entryId)) {
        return toolText("entryId has to be the id of an entry, copied from a query_knowledge result");
      }
      const requestId = randomUUID();
      const result = await new Promise<KnowledgeWriteResult>((settle) => {
        pendingWrites.set(requestId, settle);
        options.send({ kind: "knowledge-withdraw", requestId, entryId: entryId as number });
      });
      return toolText(
        result.failure ?? `entry ${String(entryId)} is withdrawn; it is no longer written down`,
      );
    },
  }) as unknown as ToolDefinition<never, never>;

  return [write, withdraw];
}
