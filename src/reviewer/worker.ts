/**
 * Reviewer 子进程的入口。
 *
 * 每个 Reviewer 一个进程,进程的环境里只有它自己那一家厂商的凭据(见 `env.ts`)。
 * 这里跑一个 Pi 会话,把模型经 `report_finding` 报出的每条原始条目立即回传主进程。
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { RawFinding } from "../review/finding.ts";
import { anchorFinding } from "./anchor.ts";
import { MODEL_API_KEY_ENV, PI_AGENT_DIR_ENV } from "./env.ts";
import { numberedRead } from "./numbered-read.ts";
import type { ReviewerRequest, WorkerMessage } from "./protocol.ts";

/**
 * 只读靠允许清单强制:未列出的工具 Pi 不会注册,模型没有写入的调用路径。
 * `read` 在清单里但实际注册的是下面的自定义实现——customTools 同名覆盖内建。
 */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

const REPORT_FINDING_TOOL = "report_finding";

const SYSTEM_PROMPT = `You are a code reviewer. Explore the repository with your read tools, then report every problem you find.

Cover correctness, security, maintainability and design. You may open any file in the repository, not only the changed ones — check callers, other branches of a changed function, and the conventions already established in the same module.

Report each problem by calling the report_finding tool exactly once per problem. Do not describe problems in prose — a problem that is not reported through the tool does not exist. When you have reported everything, stop.

The read tool prefixes every line with its line number, like \`12: code\`. These numbers are the only valid source for the line field of report_finding — copy the number, never count lines yourself. The prefix is not part of the file content. In the snippet field, copy the exact text of the line the problem starts on, without the line number prefix. Pick the most distinctive line of the problem, not a bare brace. A finding whose snippet does not match the file at the reported line is rejected back to you.

Write the title, description, impact and suggestion fields in Chinese. The reviewers of this repository read Chinese. Keep identifiers, file paths, and code fragments in their original form — do not translate them. The severity and category fields stay in the exact English values listed for them.`;

/**
 * 枚举字段必须在自身的 `description` 里写明允许值。prototype 实测:仅用字面量联合
 * 罗列时模型会自造词汇,Pi 逐条拒绝,而模型连续收到校验错误也不改正,正确的
 * Finding 因此全部丢失。宽松字符串加服务端归一化是配套的另一半。
 */
const findingSchema = Type.Object({
  file: Type.String({ description: "Repository-relative path of the file" }),
  line: Type.Integer({
    description:
      "1-indexed line the problem starts on, copied from the read tool's line number prefix",
  }),
  snippet: Type.String({
    description:
      "The exact text of that line, copied from the file without the line number prefix",
  }),
  severity: Type.String({
    description:
      "One of exactly: P0, P1, P2. P0 breaks correctness or security and must be fixed before merge. P1 is a real defect with a smaller blast radius. P2 is maintainability or style.",
  }),
  category: Type.String({
    description: "One of exactly: security, bug, maintainability, design",
  }),
  title: Type.String({
    description: "A short Chinese title naming the problem, about 20 characters",
  }),
  description: Type.String({
    description: "What is wrong and why, written in Chinese",
  }),
  impact: Type.String({
    description:
      "The blast radius, written in Chinese: in which situation it breaks and what the consequence is",
  }),
  suggestion: Type.String({
    description: "How to fix it, written in Chinese",
  }),
});

function send(message: WorkerMessage): void {
  process.send?.(message);
}

function reviewPrompt(request: ReviewerRequest): string {
  const files = request.range.files.map((f) => `- ${f}`).join("\n");
  return `Review the changes between commit ${request.range.baseSha} and commit ${request.range.headSha}.

The following files changed. Review the changes in them, using the rest of the repository as context:

${files}

Use \`git diff ${request.range.baseSha}..${request.range.headSha}\` reasoning from the files themselves — read each changed file and judge the current state of the code.`;
}

/** worktree 内文件的行数组。路径出圈或读不出来返回 undefined,交给调用方措辞。 */
function fileLines(worktreePath: string, file: string): string[] | undefined {
  const root = resolve(worktreePath);
  const abs = resolve(root, file);
  if (!abs.startsWith(root + sep)) return undefined;
  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function run(request: ReviewerRequest): Promise<void> {
  let rejectedToolCalls = 0;

  const reportFinding = defineTool({
    name: REPORT_FINDING_TOOL,
    label: "Report Finding",
    description: "Report one problem found in the code under review.",
    parameters: findingSchema,
    execute: async (_id, params) => {
      // 打回走正常返回而非工具错误:rejectedToolCalls 只统计 Pi 的 schema 校验
      // 失败,即"契约失配"信号,锚定失败是另一回事,混进去信号就没了。
      const raw = params as RawFinding;
      const lines = fileLines(request.worktreePath, raw.file);
      if (lines === undefined) {
        return {
          content: [
            { type: "text", text: `NOT recorded: cannot read ${raw.file}. Check the path and report again.` },
          ],
          details: {},
        };
      }
      const anchored = anchorFinding(lines, raw.line, raw.snippet);
      if (!anchored.ok) {
        return {
          content: [
            { type: "text", text: `NOT recorded: ${anchored.reason} Re-read the file and report again with the line number copied from the read output.` },
          ],
          details: {},
        };
      }
      send({ kind: "finding", raw: { ...raw, line: anchored.line } });
      return { content: [{ type: "text", text: "recorded" }], details: {} };
    },
  });

  /**
   * 覆盖 Pi 内建的 read:内建实现返回裸内容,模型只能自己数行,行号漂移就从这来。
   * schema 与内建一致,模型的使用习惯不变,唯一区别是每行带 `N: ` 前缀。
   */
  const numberedReadTool = defineTool({
    name: "read",
    label: "Read",
    description:
      "Read the contents of a text file. Every line is prefixed with its 1-indexed line number, like `12: code`. Output is truncated for large files; use offset/limit to continue.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(
        Type.Number({ description: "Line number to start reading from (1-indexed)" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
    }),
    execute: async (_id, { path, offset, limit }) => {
      const lines = fileLines(request.worktreePath, path);
      if (lines === undefined) {
        throw new Error(`cannot read ${path}: not a readable file inside the repository`);
      }
      const text = numberedRead(lines.join("\n"), offset, limit);
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // 空的 agentDir:不让宿主机上的全局扩展、skill、设置与凭据渗进审查会话。
  const agentDir = mkdtempSync(join(tmpdir(), "multireviewer-agent-"));
  process.env[PI_AGENT_DIR_ENV] = agentDir;

  const apiKey = process.env[MODEL_API_KEY_ENV];
  if (apiKey === undefined || apiKey === "") {
    send({ kind: "done", rejectedToolCalls: 0, failure: "缺少模型凭据" });
    return;
  }

  // authPath 与 modelsPath 都指进这个空目录。默认值在 `~/.pi/agent` 下,那里的
  // auth.json 存着宿主机上配置过的每一家厂商的凭据,读到就等于凭据分割白做。
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  await modelRuntime.setRuntimeApiKey(request.provider, apiKey);

  const model = modelRuntime.getModel(request.provider, request.model);
  if (!model) {
    send({
      kind: "done",
      rejectedToolCalls: 0,
      failure: `模型不存在: ${request.provider}/${request.model}`,
    });
    return;
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1 },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: request.worktreePath,
    agentDir,
    settingsManager,
    systemPromptOverride: () => SYSTEM_PROMPT,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: request.worktreePath,
    agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    tools: [...READ_ONLY_TOOLS, REPORT_FINDING_TOOL],
    customTools: [reportFinding, numberedReadTool],
    resourceLoader,
    sessionManager: SessionManager.inMemory(request.worktreePath),
    settingsManager,
  });

  session.subscribe((event) => {
    // 只数 report_finding 的失败。read 或 grep 出错是模型在探索仓库时的正常摩擦,
    // 把它们算进来会让"契约失配"这个信号失去意义。
    if (
      event.type === "tool_execution_end" &&
      event.isError &&
      event.toolName === REPORT_FINDING_TOOL
    ) {
      rejectedToolCalls += 1;
    }
  });

  let thrown: string | undefined;
  try {
    await session.prompt(reviewPrompt(request));
  } catch (error) {
    thrown = String(error instanceof Error ? error.message : error);
  }

  // `session.prompt()` 在模型调用失败时也正常返回,失败只在这两处可见。
  // 失败标在 assistant 消息上,而消息序列的末尾可能是一条 tool result,故反向找。
  const lastAssistant = session.messages.findLast((m) => m.role === "assistant");
  const stopReasonFailure =
    lastAssistant?.stopReason === "error"
      ? (lastAssistant.errorMessage ?? "stopReason=error")
      : undefined;
  const failure = thrown ?? session.agent.state.errorMessage ?? stopReasonFailure;

  // 用量必须在 dispose 之前读:会话销毁后统计随之消失。
  // 成本由 Pi 自带的定价表折算,该表内置在包里,不受空的 modelsPath 影响。
  const stats = session.getSessionStats();
  const usage = {
    inputTokens: stats.tokens.input,
    outputTokens: stats.tokens.output,
    cacheReadTokens: stats.tokens.cacheRead,
    cacheWriteTokens: stats.tokens.cacheWrite,
    totalTokens: stats.tokens.total,
    costUsd: stats.cost,
  };

  session.dispose();
  send({
    kind: "done",
    rejectedToolCalls,
    usage,
    ...(failure === undefined ? {} : { failure }),
  });
  // 显式退出。`dispose()` 之后 Pi 仍可能留着未关闭的 handle,加上 IPC 通道本身
  // 会让事件循环存活,进程不会自己结束,主进程就一直等不到 exit。
  process.exit(0);
}

process.on("message", (request: ReviewerRequest) => {
  run(request).catch((error: unknown) => {
    send({
      kind: "done",
      rejectedToolCalls: 0,
      failure: String(error instanceof Error ? error.message : error),
    });
  });
});
