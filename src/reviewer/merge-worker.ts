/**
 * 合并 agent 子进程的入口(issue #228)。
 *
 * 与另外两个子进程同构:一个进程只有它自己那一家厂商的凭据(见 `env.ts`),工具集只读,
 * 产出经一个自定义工具逐条回传主进程。任务本身只有一件——把本轮全部 Finding 分成组,
 * 每组是同一个问题。行号、严重度、分类与归属的派生规则不在这里,它们留在编排层。
 */
import {
  createAgentSession,
  defineTool,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { Finding } from "../review/finding.ts";
import { MODEL_API_KEY_ENV, redactModelCredential } from "./env.ts";
import type { MergeWorkerMessage, MergeWorkerRequest } from "./merge-agent.ts";
import { reviewerEventStream } from "./trace-events.ts";
import {
  READ_ONLY_TOOLS,
  fileLines,
  numberedReadTool,
  oneLine,
  prepareAgentRuntime,
  sessionFailure,
  sessionThinkingLevel,
} from "./worker-tools.ts";

const PROPOSE_GROUP_TOOL = "propose_merge_group";

const SYSTEM_PROMPT = `You are grouping the findings that several code reviewers reported on one change. Two findings belong in the same group when they are the same problem said twice, in different words. They belong in different groups when they are different problems, even when they sit on the same line or share wording.

Judge by what the finding says, not by how many words the two share. "Removes the balance check" and "removes the type check" are two problems: they share four characters and nothing else. "sub() subtracts one too many" and "the subtraction result is off by one" are one problem stated twice.

Read the code when the wording alone does not settle it. You have read-only tools over the repository at the reviewed commit.

Report every group by calling ${PROPOSE_GROUP_TOOL} exactly once per group, including the groups that hold a single finding. Three rules are checked by code, and one broken rule discards your whole grouping:

- every finding appears in exactly one group — none left out, none in two groups;
- all members of a group are in the same file;
- every member of a group is within 3 lines of at least one other member of that group.

Write the reason field in Chinese, one sentence: why these findings are the same problem. A single-member group still needs a reason field; one short clause is enough.

Narrate in Chinese too: everything you say between tool calls goes into a trace read by this repository's maintainers.

The read tool prefixes every line with its line number, like \`12: code\`. The prefix is not part of the file content.`;

const groupSchema = Type.Object({
  members: Type.Array(Type.Number(), {
    description:
      "The numbers of the findings in this group, taken from the numbered list. A group with one member is a finding that stands on its own.",
  }),
  reason: Type.String({
    description:
      "One sentence in Chinese: why these findings are the same problem, or why this one stands alone.",
  }),
});

function send(message: MergeWorkerMessage): void {
  process.send?.(message);
}

/**
 * 一条 Finding 交给 agent 看的样子:编号、位置、等级与两段文本,加上那一行的原文。
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
    ...(snippet === undefined ? [] : [`    code: ${oneLine(snippet)}`]),
  ].join("\n");
}

function mergePrompt(request: MergeWorkerRequest): string {
  return `Group the following ${request.findings.length} findings. They come from several reviewers looking at the same change, so the same problem may be reported more than once.

${request.findings.map((finding, index) => findingBullet(finding, index, request.worktreePath)).join("\n\n")}

Report each group through ${PROPOSE_GROUP_TOOL}. When every finding is in exactly one reported group, stop.`;
}

async function run(request: MergeWorkerRequest): Promise<void> {
  const proposeGroup = defineTool({
    name: PROPOSE_GROUP_TOOL,
    label: "Propose Merge Group",
    description: "Report one group of findings that are the same problem.",
    parameters: groupSchema,
    execute: async (_id, params) => {
      const raw = params as { members: number[]; reason: string };
      send({ kind: "group", group: { members: raw.members, reason: raw.reason } });
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
  const { agentDir, apiKey, model, modelRuntime, settingsManager, resourceLoader } = prepared;

  const { session } = await createAgentSession({
    cwd: request.worktreePath,
    agentDir,
    model,
    thinkingLevel: sessionThinkingLevel(request.runtimeModel.reasoning, request.thinkingLevel),
    modelRuntime,
    tools: [...READ_ONLY_TOOLS, PROPOSE_GROUP_TOOL],
    customTools: [proposeGroup, numberedReadTool(request.worktreePath)],
    resourceLoader,
    sessionManager: SessionManager.inMemory(request.worktreePath),
    settingsManager,
  });

  // 审查轨迹只订阅并转发,不做判断(ADR 0017):转换与另两条链路共用同一个。
  session.subscribe(reviewerEventStream(apiKey, (event) => send({ kind: "event", event })));

  let thrown: string | undefined;
  try {
    await session.prompt(mergePrompt(request));
  } catch (error) {
    thrown = String(error instanceof Error ? error.message : error);
  }

  // `session.prompt()` 在模型调用失败时也正常返回,失败只在这两处可见。
  const failure = sessionFailure(session, thrown, apiKey);

  // 用量必须在 dispose 之前读:会话销毁后统计随之消失。
  const stats = session.getSessionStats();
  const usage = {
    inputTokens: stats.tokens.input,
    outputTokens: stats.tokens.output,
    cacheReadTokens: stats.tokens.cacheRead,
    cacheWriteTokens: stats.tokens.cacheWrite,
    totalTokens: stats.tokens.total,
  };

  session.dispose();
  send({ kind: "done", usage, ...(failure === undefined ? {} : { failure }) });
  // 显式退出:`dispose()` 之后 Pi 仍可能留着未关闭的 handle,IPC 通道也让事件循环存活。
  process.exit(0);
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
