/**
 * 规则 agent 子进程的入口(issue #205)。
 *
 * 与 Reviewer 子进程同构:一个进程只有它自己那一家厂商的凭据(见 `env.ts`),工具集只
 * 读不写,产出经一个自定义工具逐条回传主进程。区别只在任务本身——这里读的是基点 commit
 * 上的仓库全貌,产出的是规范性陈述,不是 Finding。
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { ReviewRule } from "../review/finding.ts";
import { MODEL_API_KEY_ENV, PI_AGENT_DIR_ENV, redactModelCredential } from "./env.ts";
import { isolatedPinnedModelRuntime } from "./model-runtime.ts";
import { numberedRead } from "./numbered-read.ts";
import { RULE_LIMIT, type RuleWorkerMessage, type RuleWorkerRequest } from "./rule-agent.ts";

/** 只读靠允许清单强制:未列出的工具 Pi 不会注册,模型没有写入的调用路径。 */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

const PROPOSE_RULE_TOOL = "propose_rule";

const SYSTEM_PROMPT = `You are deriving the review rules of one repository. Explore it with your read tools, then report the rules a code reviewer should judge this repository by.

A rule is a normative statement — what the code ought to do. "Handlers must validate request bodies at the boundary" is a rule. "Handlers live in src/api" is a description of the current code, not a rule: never report descriptions, file inventories, dependency lists or architecture maps. If you cannot phrase something as an obligation, leave it out.

Report each rule by calling the propose_rule tool exactly once per rule. Do not describe rules in prose — a rule that is not reported through the tool does not exist.

Report at most ${RULE_LIMIT} rules, most important first. Importance means how much damage a violation does in this repository. Prefer few rules that matter over many that are obvious; a reviewer has to confirm every one of them by hand. Do not restate what a linter or the type checker already enforces.

Write the statement and layer fields in Chinese. The reviewers of this repository read Chinese. Keep identifiers, file paths and code fragments in their original form — do not translate them.

The read tool prefixes every line with its line number, like \`12: code\`. The prefix is not part of the file content.`;

const ruleSchema = Type.Object({
  statement: Type.String({
    description:
      "One normative sentence in Chinese: what code in this repository must or must not do. Not a description of what the code currently is.",
  }),
  layer: Type.String({
    description:
      "A short Chinese free-text label grouping this rule with related ones, such as 架构 / 安全 / 数据 / 测试. Reuse the same label across rules that belong together.",
  }),
  scope: Type.Optional(
    Type.String({
      description:
        "A glob limiting the paths this rule applies to, such as `src/api/**`. Leave it out when the rule applies to the whole repository.",
    }),
  ),
});

function send(message: RuleWorkerMessage): void {
  process.send?.(message);
}

/** 现有规则集。首次探索时是空的,这一段因此不渲染。 */
function existingSection(rules: readonly ReviewRule[]): string {
  return [
    "",
    "This repository already agreed on the following rules. Do not repeat them; report only what they do not cover.",
    "",
    ...rules.map((rule) => `- (${rule.scope === "" ? "whole repository" : rule.scope}) ${rule.statement}`),
  ].join("\n");
}

export function rulePrompt(request: Pick<RuleWorkerRequest, "baselineSha" | "existingRules">): string {
  const existing =
    request.existingRules.length === 0 ? "" : `${existingSection(request.existingRules)}\n`;
  return `Derive the review rules of the repository as it stands at commit ${request.baselineSha}.
${existing}
Start from the repository's own documentation and configuration, then read the code that matters most: the entry points, the modules everything else depends on, and the places where mistakes would be expensive. Look for the conventions the existing code already keeps to, and state them as obligations.

Report each rule through ${PROPOSE_RULE_TOOL}. When you have reported everything worth confirming, stop.`;
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

async function run(request: RuleWorkerRequest): Promise<void> {
  const proposeRule = defineTool({
    name: PROPOSE_RULE_TOOL,
    label: "Propose Rule",
    description: "Report one review rule this repository should be judged by.",
    parameters: ruleSchema,
    execute: async (_id, params) => {
      const raw = params as { statement: string; layer: string; scope?: string };
      send({
        kind: "rule",
        item: {
          scope: raw.scope ?? "",
          statement: raw.statement,
          layer: raw.layer,
        },
      });
      return { content: [{ type: "text", text: "recorded" }], details: {} };
    },
  });

  /** 覆盖 Pi 内建的 read,与 Reviewer 子进程同一个实现:每行带 `N: ` 前缀。 */
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
      return {
        content: [{ type: "text", text: numberedRead(lines.join("\n"), offset, limit) }],
        details: {},
      };
    },
  });

  // 空的 agentDir:不让宿主机上的全局扩展、skill、设置与凭据渗进探索会话。
  const agentDir = mkdtempSync(join(tmpdir(), "multireviewer-rule-agent-"));
  process.env[PI_AGENT_DIR_ENV] = agentDir;

  const apiKey = process.env[MODEL_API_KEY_ENV];
  if (apiKey === undefined || apiKey === "") {
    send({ kind: "done", failure: "缺少模型凭据" });
    return;
  }

  const runtime = request.runtimeModel;
  const modelRuntime = await isolatedPinnedModelRuntime(agentDir, runtime);
  await modelRuntime.setRuntimeApiKey(runtime.provider, apiKey);
  const model = modelRuntime.getModel(runtime.provider, runtime.id);
  if (!model) {
    send({ kind: "done", failure: `固定运行模型无法加载: ${runtime.provider}/${runtime.id}` });
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
    tools: [...READ_ONLY_TOOLS, PROPOSE_RULE_TOOL],
    customTools: [proposeRule, numberedReadTool],
    resourceLoader,
    sessionManager: SessionManager.inMemory(request.worktreePath),
    settingsManager,
  });

  let thrown: string | undefined;
  try {
    await session.prompt(rulePrompt(request));
  } catch (error) {
    thrown = String(error instanceof Error ? error.message : error);
  }

  // `session.prompt()` 在模型调用失败时也正常返回,失败只在这两处可见。
  const lastAssistant = session.messages.findLast((m) => m.role === "assistant");
  const stopReasonFailure =
    lastAssistant?.stopReason === "error"
      ? (lastAssistant.errorMessage ?? "stopReason=error")
      : undefined;
  const rawFailure = thrown ?? session.agent.state.errorMessage ?? stopReasonFailure;
  const failure =
    rawFailure === undefined ? undefined : redactModelCredential(rawFailure, apiKey);

  session.dispose();
  send({ kind: "done", ...(failure === undefined ? {} : { failure }) });
  // 显式退出:`dispose()` 之后 Pi 仍可能留着未关闭的 handle,IPC 通道也让事件循环存活。
  process.exit(0);
}

process.on("message", (request: RuleWorkerRequest) => {
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
