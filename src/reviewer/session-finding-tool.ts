/**
 * Agent 会话的历史 Finding 查询工具(issue #338)。底座工具面的一件,所有用途都注册。
 *
 * 查询在主进程做:子进程没有库连接,也不该有——判断与落库都在那一侧(ADR 0017 同律)。
 * 这里因此在 IPC 上多一对消息:`finding-query` 带一个 `requestId` 出去,主进程查库,
 * `finding-query-result` 带同一个 id 回来,执行中的那次工具调用凭它兑现。主进程那一侧
 * 恒回一条(查不动时带 `failure`),所以这边不设超时——一个不会来的回应才需要计时。
 *
 * 打回走**正常返回**一句理由,与产出工具同一口径(`session-output-tools.ts`):仓库不在
 * 会话根内、处置状态不是那四个取值之一,都是「换个参数再试」的摩擦,不是这个会话做不到
 * 的事。
 */
import { randomUUID } from "node:crypto";

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { Disposition } from "../review/finding.ts";
import type { RepoFinding } from "../review/store.ts";
import type { SessionWorkerMessage } from "./session-protocol.ts";

export const QUERY_FINDINGS_TOOL = "query_findings";

/** 一次查询回的条数上限(spec #329 的工具面)。 */
export const FINDING_QUERY_LIMIT = 50;

/**
 * 可查的处置状态。取自 Finding 的处置状态,「已延续」不在里面:那一条已经交接到新位置,
 * 查询回的本就是新位置那一条(`listRepoFindings` 的折叠)。
 */
export const QUERYABLE_DISPOSITIONS: readonly Disposition[] = [
  "unknown",
  "unresolved",
  "resolved",
  "fixed",
];

const querySchema = Type.Object({
  repo: Type.String({
    description:
      "The repository to look in, exactly as <owner>/<repo>, copied from the list of this session's repositories",
  }),
  pathGlob: Type.Optional(
    Type.String({
      description:
        "Only findings whose file matches this glob, relative to the root of that repository, without the <owner>/<repo> prefix — for example src/finance/** or src/**/*.ts. Leave it out to look at the whole repository.",
    }),
  ),
  disposition: Type.Optional(
    Type.String({
      description:
        "Only findings in this disposition state. One of exactly: unknown, unresolved, resolved, fixed. unknown and unresolved are still open; resolved was disposed of by a person, fixed was disposed of automatically once the code changed. Leave it out for every state.",
    }),
  ),
});

/** 一次查询的回应。主进程查不动时带 `failure`,`findings` 那时是空的。 */
export type FindingQueryResult = {
  findings: readonly RepoFinding[];
  failure?: string;
};

/** 还没回应的查询。一进程一会话,模型一次只等一个工具结果,这张表常态只有一条。 */
const pending = new Map<string, (result: FindingQueryResult) => void>();

/** 主进程的回应到了:兑现那一次等着的工具调用。认不出的 `requestId` 直接丢掉。 */
export function resolveFindingQuery(requestId: string, result: FindingQueryResult): void {
  const settle = pending.get(requestId);
  pending.delete(requestId);
  settle?.(result);
}

function text(body: string): { content: [{ type: "text"; text: string }]; details: object } {
  return { content: [{ type: "text", text: body }], details: {} };
}

/**
 * 一条历史 Finding 交给模型看的样子。四段正文里缺的那几段不占行(升级前落的行没存过
 * 影响与建议),标题空着写 `(none)`——与合并 agent 那一份历史条目同一形状。
 */
function findingBlock(finding: RepoFinding): string {
  return [
    `${finding.file}:${finding.line} (${finding.severity}, ${finding.disposition})`,
    `    title: ${finding.title === "" ? "(none)" : finding.title}`,
    `    description: ${finding.description}`,
    ...(finding.impact === undefined || finding.impact === ""
      ? []
      : [`    impact: ${finding.impact}`]),
    ...(finding.suggestion === undefined || finding.suggestion === ""
      ? []
      : [`    suggestion: ${finding.suggestion}`]),
  ].join("\n");
}

function renderFindings(repo: string, findings: readonly RepoFinding[]): string {
  if (findings.length === 0) return `No past finding in ${repo} matches that.`;
  const capped =
    findings.length === FINDING_QUERY_LIMIT
      ? ` Only the ${FINDING_QUERY_LIMIT} newest are listed; narrow the path glob or the disposition state to see the rest.`
      : "";
  return [
    `${findings.length} past finding(s) in ${repo}, newest first.${capped}`,
    "",
    findings.map(findingBlock).join("\n\n"),
  ].join("\n");
}

/**
 * 历史 Finding 查询工具。`repos` 是会话根里的 `<owner>/<repo>` 清单:会话读得到的仓库
 * 就是这几个,问别的仓库即打回——Finding 跟着仓库走,读不到那个仓库的代码也不该读到
 * 它的问题(ADR 0018)。
 */
export function sessionFindingTool(options: {
  repos: readonly string[];
  send: (message: SessionWorkerMessage) => void;
}): ToolDefinition<never, never> {
  return defineTool({
    name: QUERY_FINDINGS_TOOL,
    label: "Query Past Findings",
    description:
      "Look up the findings earlier review rounds reported on a part of one repository: the title, the severity, the file and line, the disposition state and the write-up. Use it on the code a change touches, to see what has gone wrong there before. At most 50 findings come back, newest first.",
    parameters: querySchema,
    execute: async (_id, params) => {
      const { repo, pathGlob, disposition } = params as {
        repo: string;
        pathGlob?: string;
        disposition?: string;
      };
      const name = repo.trim();
      if (!options.repos.includes(name)) {
        return text(
          `${name} is not a repository of this session; look in one of: ${options.repos.join(", ")}`,
        );
      }
      const state = disposition?.trim();
      if (
        state !== undefined &&
        state !== "" &&
        !QUERYABLE_DISPOSITIONS.includes(state as Disposition)
      ) {
        return text(
          `${state} is not a disposition state; use one of exactly: ${QUERYABLE_DISPOSITIONS.join(", ")}`,
        );
      }
      const glob = pathGlob?.trim();
      const [owner, repoName] = name.split("/");
      const requestId = randomUUID();
      const result = await new Promise<FindingQueryResult>((settle) => {
        pending.set(requestId, settle);
        options.send({
          kind: "finding-query",
          requestId,
          query: {
            owner: owner!,
            repo: repoName!,
            ...(glob === undefined || glob === "" ? {} : { pathGlob: glob }),
            ...(state === undefined || state === "" ? {} : { disposition: state as Disposition }),
          },
        });
      });
      if (result.failure !== undefined) {
        return text(`could not read the past findings of ${name}: ${result.failure}`);
      }
      return text(renderFindings(name, result.findings));
    },
  }) as unknown as ToolDefinition<never, never>;
}
