/**
 * Reviewer 子进程的入口。
 *
 * 每个 Reviewer 一个进程,进程的环境里只有它自己那一家厂商的凭据(见 `env.ts`)。
 * 这里跑一个 Pi 会话,把模型经 `report_finding` 报出的每条原始条目立即回传主进程。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { MODEL_API_KEY_ENV, PI_AGENT_DIR_ENV } from "./env.ts";
import type { ReviewerRequest, WorkerMessage } from "./protocol.ts";

/** 只读靠允许清单强制:未列出的工具 Pi 不会注册,模型没有写入的调用路径。 */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

const REPORT_FINDING_TOOL = "report_finding";

const SYSTEM_PROMPT = `You are a code reviewer. Explore the repository with your read tools, then report every problem you find.

Cover correctness, security, maintainability and design. You may open any file in the repository, not only the changed ones — check callers, other branches of a changed function, and the conventions already established in the same module.

Report each problem by calling the report_finding tool exactly once per problem. Do not describe problems in prose — a problem that is not reported through the tool does not exist. When you have reported everything, stop.`;

/**
 * 枚举字段必须在自身的 `description` 里写明允许值。prototype 实测:仅用字面量联合
 * 罗列时模型会自造词汇,Pi 逐条拒绝,而模型连续收到校验错误也不改正,正确的
 * Finding 因此全部丢失。宽松字符串加服务端归一化是配套的另一半。
 */
const findingSchema = Type.Object({
  file: Type.String({ description: "Repository-relative path of the file" }),
  line: Type.Integer({ description: "1-indexed line the problem starts on" }),
  severity: Type.String({ description: "One of exactly: high, medium, low" }),
  category: Type.String({
    description: "One of exactly: security, bug, maintainability, design",
  }),
  description: Type.String({ description: "What is wrong and why it matters" }),
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

async function run(request: ReviewerRequest): Promise<void> {
  let rejectedToolCalls = 0;

  const reportFinding = defineTool({
    name: REPORT_FINDING_TOOL,
    label: "Report Finding",
    description: "Report one problem found in the code under review.",
    parameters: findingSchema,
    execute: async (_id, params) => {
      send({ kind: "finding", raw: params as never });
      return { content: [{ type: "text", text: "recorded" }], details: {} };
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
    customTools: [reportFinding],
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

  session.dispose();
  send({
    kind: "done",
    rejectedToolCalls,
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
