/**
 * 合并 agent 子进程的入口(issue #228)。
 *
 * 与另外两个子进程同构:一个进程只有它自己那一家厂商的凭据(见 `env.ts`),工具集只读,
 * 产出经一个自定义工具逐条回传主进程。任务本身只有一件——把本轮全部 Finding 分成组,
 * 每组是同一个问题;同文件的历史 Finding 一并给它,判成同一回事的可以进组(issue #240)。
 * 多于一个成员的组另写一份综合说明(issue #279):把成员的说法合成一份正文。
 * 行号、严重度、分类与归属的派生规则不在这里,折叠还是延续也不在,它们都留在编排层。
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { GroupSynthesis } from "../review/dedupe.ts";
import type { Finding, HistoryFinding } from "../review/finding.ts";
import { MODEL_API_KEY_ENV, redactModelCredential } from "./env.ts";
import type { MergeWorkerMessage, MergeWorkerRequest } from "./merge-agent.ts";
import { reviewerEventStream } from "./trace-events.ts";
import {
  READ_ONLY_TOOLS,
  fileLines,
  numberedReadTool,
  oneLine,
  prepareAgentRuntime,
  runAgentWorker,
  sessionThinkingLevel,
} from "./worker-tools.ts";

const PROPOSE_GROUP_TOOL = "propose_merge_group";

const SYSTEM_PROMPT = `You are grouping the findings that several code reviewers reported on one change. Two findings belong in the same group when they are the same problem said twice, in different words. They belong in different groups when they are different problems, even when they sit on the same line or share wording.

Judge by what the finding says, not by how many words the two share. "Removes the balance check" and "removes the type check" are two problems: they share four characters and nothing else. "sub() subtracts one too many" and "the subtraction result is off by one" are one problem stated twice.

Read the code when the wording alone does not settle it. You have read-only tools over the repository at the reviewed commit.

Some groups also get a prior finding. Prior findings were reported on this same code in an earlier round and are listed separately, with an id of their own. Put a prior finding in a group when this round says the same problem it said. The platform then folds this round's report into the old comment, or carries the old finding over to the new position; it never posts the same problem twice. Leave a prior finding out of every group when nothing this round is the same problem — a prior finding does not have to be used.

A prior finding may carry a \`same spot\` line naming the findings of this round that sit on the very code it was reported on, unchanged since. The same spot is not the same problem: a different problem can be reported on the line an earlier one was. Weigh the line as evidence and decide by what the findings say; it is not a verdict, and it does not oblige you to group anything.

Report every group by calling ${PROPOSE_GROUP_TOOL} exactly once per group, including the groups that hold a single finding. These rules are checked by code, and one broken rule discards your whole grouping:

- every finding of this round appears in exactly one group — none left out, none in two groups;
- a prior finding appears in at most one group;
- all members of a group are in the same file, prior findings included;
- every member of a group is within 3 lines of at least one other member of that group. This rule is dropped for a group that holds a prior finding: rewritten code moves a problem far from where it used to be.

Write the reason field in Chinese, one sentence: why these findings are the same problem. A single-member group still needs a reason field; one short clause is enough.

A group that holds more than one finding also needs a synthesis: one Chinese write-up that says the problem once, for the people who read the review. Merge what the members say into a title, a problem statement, an impact and a suggestion. Keep every claim that a member made and drop none of them; add no claim that no member made, and state nothing the members left unsaid. Leave impact or suggestion out when no member said anything about it. A group with a single finding needs no synthesis: its own words are already the body. Do not send a severity or a category; the platform sets both.

Narrate in Chinese too: everything you say between tool calls goes into a trace read by this repository's maintainers.

The read tool prefixes every line with its line number, like \`12: code\`. The prefix is not part of the file content.`;

const groupSchema = Type.Object({
  members: Type.Array(Type.Number(), {
    description:
      "The numbers of the findings in this group, taken from the numbered list. A group with one member is a finding that stands on its own.",
  }),
  history: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        "The ids of the prior findings in this group, taken from the prior findings list. Leave it out when this group is only about findings from this round.",
    }),
  ),
  synthesis: Type.Optional(
    Type.Object(
      {
        title: Type.String({ description: "The problem in one short Chinese line." }),
        description: Type.String({
          description: "The problem itself in Chinese, merged from what the members say.",
        }),
        impact: Type.Optional(
          Type.String({
            description:
              "What it costs the users or the system, in Chinese. Leave it out when no member said.",
          }),
        ),
        suggestion: Type.Optional(
          Type.String({
            description: "How to fix it, in Chinese. Leave it out when no member said.",
          }),
        ),
      },
      {
        description:
          "One write-up for a group that holds more than one finding. Leave it out for a group with a single finding.",
      },
    ),
  ),
  reason: Type.String({
    description:
      "One sentence in Chinese: why these findings are the same problem, or why this one stands alone.",
  }),
});

function send(message: MergeWorkerMessage): void {
  process.send?.(message);
}

/**
 * 一条 Finding 交给 agent 看的样子:编号、位置、等级与四段文本,加上那一行的原文。
 * 影响与建议一并给出(issue #279):综合说明要写这两段,看不到成员怎么说就只能自己编。
 * 模型没给的那一段空着,空段不渲染。
 *
 * 代码片段从工作副本现读,不从 Finding 上取——归一化之后的 Finding 不留 snippet,而
 * 行号已经过锚定核对,这一行就是模型当初抄下来的那一行。读不出来就不给这一格,agent
 * 仍可用 read 工具自己去看。
 */
function findingBullet(finding: Finding, index: number, worktreePath: string): string {
  const lines = fileLines(worktreePath, finding.file);
  const snippet = lines?.[finding.line - 1];
  const head = `[${index}] ${finding.file}:${finding.line} (${finding.severity}) reported by ${finding.model}`;
  return [
    head,
    `    title: ${oneLine(finding.title === "" ? "(none)" : finding.title)}`,
    `    description: ${oneLine(finding.description)}`,
    ...(finding.impact === "" ? [] : [`    impact: ${oneLine(finding.impact)}`]),
    ...(finding.suggestion === "" ? [] : [`    suggestion: ${oneLine(finding.suggestion)}`]),
    ...(snippet === undefined ? [] : [`    code: ${oneLine(snippet)}`]),
  ].join("\n");
}

/**
 * 一条历史 Finding 交给 agent 看的样子(issue #240):它自己的 id、旧位置、处置状态与
 * 两段文本。旧位置的代码可能已经改写,因此不给代码片段——那一行此刻的内容说明不了它。
 * 已处置的历史只有标题(注入侧的体积控制,ADR 0016),正文那一格自会空着。
 *
 * `same spot` 那一行是位置提示(issue #307):它的指纹在本轮 head 上命中了这几条本轮
 * Finding 的落点。一条都没命中就不给这一行。
 */
function historyBullet(entry: HistoryFinding, sameSpot: readonly number[] | undefined): string {
  const disposed = entry.disposition === "resolved" || entry.disposition === "fixed";
  return [
    `[prior ${entry.id}] ${entry.file}:${entry.line} (${disposed ? "already disposed" : "open"})`,
    `    title: ${oneLine(entry.title === "" ? "(none)" : entry.title)}`,
    ...(entry.description === undefined
      ? []
      : [`    description: ${oneLine(entry.description)}`]),
    ...(sameSpot === undefined || sameSpot.length === 0
      ? []
      : [`    same spot: ${sameSpot.map((index) => `[${index}]`).join(", ")}`]),
  ].join("\n");
}

function mergePrompt(request: MergeWorkerRequest): string {
  const priors =
    request.history.length === 0
      ? []
      : [
          `These ${request.history.length} findings were reported on the same files in earlier rounds. Add one to a group when this round reports the same problem again.`,
          request.history
            .map((entry) => historyBullet(entry, request.sameSpot[entry.id]))
            .join("\n\n"),
        ];
  return [
    `Group the following ${request.findings.length} findings. They come from several reviewers looking at the same change, so the same problem may be reported more than once.`,
    request.findings
      .map((finding, index) => findingBullet(finding, index, request.worktreePath))
      .join("\n\n"),
    ...priors,
    `Report each group through ${PROPOSE_GROUP_TOOL}. When every finding of this round is in exactly one reported group, stop.`,
  ].join("\n\n");
}

async function run(request: MergeWorkerRequest): Promise<void> {
  const proposeGroup = defineTool({
    name: PROPOSE_GROUP_TOOL,
    label: "Propose Merge Group",
    description: "Report one group of findings that are the same problem.",
    parameters: groupSchema,
    execute: async (_id, params) => {
      const raw = params as {
        members: number[];
        history?: number[];
        synthesis?: GroupSynthesis;
        reason: string;
      };
      send({
        kind: "group",
        group: {
          members: raw.members,
          ...(raw.history === undefined ? {} : { history: raw.history }),
          ...(raw.synthesis === undefined ? {} : { synthesis: raw.synthesis }),
          reason: raw.reason,
        },
      });
      return { content: [{ type: "text", text: "recorded" }], details: {} };
    },
  });

  const prepared = await prepareAgentRuntime({
    agentDirPrefix: "multireviewer-merge-agent-",
    worktreePath: request.worktreePath,
    runtimeModel: request.runtimeModel,
    systemPrompt: SYSTEM_PROMPT,
  });
  if ("failure" in prepared) {
    send({ kind: "done", failure: prepared.failure });
    return;
  }

  // 审查轨迹只订阅并转发,不做判断(ADR 0017):转换与另两条链路共用同一个。
  const forwardEvent = reviewerEventStream(prepared.apiKey, (event) =>
    send({ kind: "event", event }),
  );

  await runAgentWorker({
    runtime: prepared,
    worktreePath: request.worktreePath,
    thinkingLevel: sessionThinkingLevel(request.runtimeModel.reasoning, request.thinkingLevel),
    tools: [...READ_ONLY_TOOLS, PROPOSE_GROUP_TOOL],
    customTools: [proposeGroup, numberedReadTool(request.worktreePath)],
    prompt: mergePrompt(request),
    send,
    onEvent: forwardEvent,
    done: ({ usage, failure }) =>
      send({ kind: "done", usage, ...(failure === undefined ? {} : { failure }) }),
  });
}

process.on("message", (request: MergeWorkerRequest) => {
  run(request).catch((error: unknown) => {
    send({
      kind: "done",
      failure: redactModelCredential(
        String(error instanceof Error ? error.message : error),
        process.env[MODEL_API_KEY_ENV],
      ),
    });
  });
});
