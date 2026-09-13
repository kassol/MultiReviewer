/**
 * Agent 会话的知识查询工具(issue #344)。底座工具面的一件,所有用途都注册。
 *
 * 知识不再整份进系统提示:提示里只有一份目录(产品名、仓库与职责、各层条数),陈述由这个
 * 工具按任务的范围取——一个只动后端的任务不该为另一个仓库的路由表付 token。
 *
 * 形状与历史 Finding 查询(`session-finding-tool.ts`)逐格对齐:查询在主进程做(子进程没有
 * 库连接,ADR 0017 同律),IPC 上一对 `knowledge-query` / `knowledge-query-result` 按
 * `requestId` 配对,主进程恒回一条,这边因此不设超时。会话根外的仓库走**正常返回**一句
 * 理由打回,与产出工具同一口径。
 */
import { randomUUID } from "node:crypto";

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type {
  SessionKnowledgeEntries,
  SessionWorkerMessage,
} from "./session-protocol.ts";
import { FINDING_QUERY_LIMIT } from "./session-finding-tool.ts";
import { countOf, oneLine, toolText } from "./worker-tools.ts";

export const QUERY_KNOWLEDGE_TOOL = "query_knowledge";

const querySchema = Type.Object({
  repos: Type.Array(
    Type.String({
      description: "One repository, exactly as <owner>/<repo>",
    }),
    {
      description:
        "The repositories this task touches, each exactly as <owner>/<repo>, copied from the list of this session's repositories. Name every repository the task spans; when you are not sure of its scope yet, name them all and read the product entries first.",
    },
  ),
  pathGlob: Type.Optional(
    Type.String({
      description:
        "Only entries whose scope overlaps this glob, relative to the root of a repository, without the <owner>/<repo> prefix — for example src/finance/** or src/**/*.ts. It narrows the repository entries only; product entries always come back whole. Leave it out for everything those repositories have written down.",
    }),
  ),
});

/** 一次查询的回应。主进程查不动时带 `failure`,两个数组那时都是空的。 */
export type KnowledgeQueryResult = SessionKnowledgeEntries & { failure?: string };

/** 还没回应的查询。一进程一会话,模型一次只等一个工具结果,这张表常态只有一条。 */
const pending = new Map<string, (result: KnowledgeQueryResult) => void>();

/** 主进程的回应到了:兑现那一次等着的工具调用。认不出的 `requestId` 直接丢掉。 */
export function resolveKnowledgeQuery(requestId: string, result: KnowledgeQueryResult): void {
  const settle = pending.get(requestId);
  pending.delete(requestId);
  settle?.(result);
}

/** 一条产品知识交给模型看的样子:层、涉及的仓库集合与那一句陈述。 */
function productLine(entry: SessionKnowledgeEntries["product"][number]): string {
  return `- product knowledge (${entry.repos.join(", ")}): ${oneLine(entry.statement)}`;
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
 * 两层各一段,满上限时那一段说明还有更多——与历史 Finding 的措辞同一口径。什么都没有时说
 * 清「问到了,没有」:空结果与「没查到」是两件事,模型不该以为自己该换个问法再试一遍。
 */
export function renderKnowledge(
  repos: readonly string[],
  entries: SessionKnowledgeEntries,
): string {
  const asked = repos.join(", ");
  if (entries.product.length === 0 && entries.repo.length === 0) {
    return `Nothing written down covers that: no product knowledge entry involves ${asked}, and no review rule or project fact of those repositories matches.`;
  }
  const capped = (count: number): string =>
    count === FINDING_QUERY_LIMIT
      ? ` Only ${FINDING_QUERY_LIMIT} are listed; narrow the repositories or the path glob to see the rest.`
      : "";
  const sections: string[] = [];
  if (entries.product.length > 0) {
    sections.push(
      `${countOf(entries.product.length, "product knowledge entry", "product knowledge entries")} involving ${asked}.${capped(entries.product.length)}`,
      "",
      ...entries.product.map(productLine),
    );
  }
  if (entries.repo.length > 0) {
    if (sections.length > 0) sections.push("");
    sections.push(
      `${countOf(entries.repo.length, "review rule or project fact", "review rules and project facts")} of ${asked}.${capped(entries.repo.length)}`,
      "",
      ...entries.repo.map(repoLine),
    );
  }
  return sections.join("\n");
}

/**
 * 知识查询工具。`repos` 是会话根里的 `<owner>/<repo>` 清单:会话读得到的仓库就是这几个,
 * 问别的仓库即打回——知识跟着仓库走,读不到那个仓库的代码也不该读到它的约定(ADR 0018)。
 */
export function sessionKnowledgeTool(options: {
  repos: readonly string[];
  send: (message: SessionWorkerMessage) => void;
}): ToolDefinition<never, never> {
  return defineTool({
    name: QUERY_KNOWLEDGE_TOOL,
    label: "Query Knowledge",
    description:
      "Look up what this product and its repositories have written down about the part of the work you are on. Two layers come back: product knowledge, which says how these repositories fit together — who calls whom, over what contract, which change drags which repository along; and each repository's own review rules (what it holds its code to, so you know which details matter) and project facts (grounds for judgement, so you need not assume — and when the code contradicts a fact, the code wins). Ask before you claim anything about how the pieces fit or about what this code is held to.",
    parameters: querySchema,
    execute: async (_id, params) => {
      const { repos, pathGlob } = params as { repos?: unknown; pathGlob?: string };
      const asked = (Array.isArray(repos) ? repos : [])
        .filter((one): one is string => typeof one === "string")
        .map((one) => one.trim())
        .filter((one) => one !== "");
      if (asked.length === 0) {
        return toolText(
          `name at least one repository of this session: ${options.repos.join(", ")}`,
        );
      }
      const outside = asked.filter((one) => !options.repos.includes(one));
      if (outside.length > 0) {
        return toolText(
          `${outside.join(", ")} is not a repository of this session; look in one of: ${options.repos.join(", ")}`,
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
            repos: asked,
            ...(glob === undefined || glob === "" ? {} : { pathGlob: glob }),
          },
        });
      });
      if (result.failure !== undefined) {
        return toolText(`could not read what ${asked.join(", ")} has written down: ${result.failure}`);
      }
      return toolText(renderKnowledge(asked, result));
    },
  }) as unknown as ToolDefinition<never, never>;
}
