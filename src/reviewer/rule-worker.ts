/**
 * 规则 agent 子进程的入口(issue #205)。
 *
 * 与 Reviewer 子进程同构:一个进程只有它自己那一家厂商的凭据(见 `env.ts`),工具集只
 * 读不写,产出经一个自定义工具逐条回传主进程。区别只在任务本身——这里读的是基点 commit
 * 上的仓库全貌,产出的是规范性陈述,不是 Finding。
 */
import {
  createAgentSession,
  defineTool,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { ReviewRule } from "../review/finding.ts";
import { MODEL_API_KEY_ENV, redactModelCredential } from "./env.ts";
import {
  RULE_LIMIT,
  type DispositionFeedback,
  type RuleWorkerMessage,
  type RuleWorkerRequest,
} from "./rule-agent.ts";
import { numberedReadTool, prepareAgentRuntime, ruleBullet } from "./worker-tools.ts";

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
  rule_id: Type.Optional(
    Type.Number({
      description:
        "The id of the agreed rule this change targets, taken from the list of agreed rules. Leave it out when you propose a rule that is not in that list.",
    }),
  ),
  retire: Type.Optional(
    Type.Boolean({
      description:
        "Set to true together with rule_id to retire that agreed rule instead of restating it. Restate the rule you want retired in the statement field.",
    }),
  ),
});

function send(message: RuleWorkerMessage): void {
  process.send?.(message);
}

/**
 * 现有规则集。首次探索时是空的,这一段因此不渲染;非空即这一次提的是对照它的变更
 * (issue #207),条目带上标识,agent 据此指出改哪一条、废止哪一条。
 */
function existingSection(rules: readonly ReviewRule[]): string {
  return [
    "",
    "This repository already agreed on the following rules, each with its id:",
    "",
    ...rules.map(ruleBullet),
    "",
    "Report changes against that list, not the list itself. Do not restate a rule that still holds as it stands — a rule you do not report stays in force. For each change, call propose_rule once:",
    "- to reword or narrow an agreed rule, pass its rule_id and the full new statement;",
    "- to retire an agreed rule the code no longer justifies, pass its rule_id, retire=true and restate that rule;",
    "- to add a standard the list does not cover, leave rule_id out.",
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

/**
 * 处置反哺的提示(issue #208)。同一个 agent、同一套产出协议,输入换成一条处置备注与
 * 它处置掉的那条 Finding:要的是「这条意见该不该成为长期标准」,不是重新推导整套规则。
 *
 * 明写「报不出变更是预期结果」:一条只了结眼前那一条 Finding 的备注不构成规则,而 agent
 * 手里有个报告工具时倾向于用它。
 */
export function feedbackPrompt(
  request: Pick<RuleWorkerRequest, "existingRules"> & { feedback: DispositionFeedback },
): string {
  const { note, finding } = request.feedback;
  const existing =
    request.existingRules.length === 0 ? "" : `${existingSection(request.existingRules)}\n`;
  return `A reviewer of this repository just disposed of one finding and left a note explaining the decision. Judge what that note says about the standards this repository should be reviewed by.

Finding: ${finding.title ?? finding.description}
Location: ${finding.file}:${finding.line}
Description: ${finding.description}
Disposition note: ${note}
${existing}
Report only what the note itself justifies. A note that settles this one finding and nothing more justifies no change at all — reporting nothing is an expected outcome. Read the code around the finding when you need it to tell a one-off from a standing obligation.

Report each change through ${PROPOSE_RULE_TOOL}. When you have nothing more to report, stop.`;
}

async function run(request: RuleWorkerRequest): Promise<void> {
  const proposeRule = defineTool({
    name: PROPOSE_RULE_TOOL,
    label: "Propose Rule",
    description: "Report one review rule this repository should be judged by.",
    parameters: ruleSchema,
    execute: async (_id, params) => {
      const raw = params as {
        statement: string;
        layer: string;
        scope?: string;
        rule_id?: number;
        retire?: boolean;
      };
      send({
        kind: "rule",
        item: {
          scope: raw.scope ?? "",
          statement: raw.statement,
          layer: raw.layer,
          ...(raw.rule_id === undefined ? {} : { targetRuleId: raw.rule_id }),
          ...(raw.retire === true ? { retire: true } : {}),
        },
      });
      return { content: [{ type: "text", text: "recorded" }], details: {} };
    },
  });

  const prepared = await prepareAgentRuntime({
    agentDirPrefix: "multireviewer-rule-agent-",
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
    thinkingLevel: "off",
    modelRuntime,
    tools: [...READ_ONLY_TOOLS, PROPOSE_RULE_TOOL],
    customTools: [proposeRule, numberedReadTool(request.worktreePath)],
    resourceLoader,
    sessionManager: SessionManager.inMemory(request.worktreePath),
    settingsManager,
  });

  let thrown: string | undefined;
  try {
    await session.prompt(
      request.feedback === undefined
        ? rulePrompt(request)
        : feedbackPrompt({ existingRules: request.existingRules, feedback: request.feedback }),
    );
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
