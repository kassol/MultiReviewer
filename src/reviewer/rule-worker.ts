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

import type { KnowledgeEntry } from "../review/finding.ts";
import { MODEL_API_KEY_ENV, redactModelCredential } from "./env.ts";
import type {
  DispositionFeedback,
  RuleWorkerMessage,
  RuleWorkerRequest,
} from "./rule-agent.ts";
import { reviewerEventStream } from "./trace-events.ts";
import { numberedReadTool, prepareAgentRuntime, sessionThinkingLevel } from "./worker-tools.ts";

/** 只读靠允许清单强制:未列出的工具 Pi 不会注册,模型没有写入的调用路径。 */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

const PROPOSE_RULE_TOOL = "propose_rule";

const SYSTEM_PROMPT = `You are deriving the knowledge a code reviewer needs about one repository. Explore it with your read tools, then report that knowledge as entries of two kinds.

A **rule** is a normative statement — what the code ought to do. "Handlers must validate request bodies at the boundary" is a rule. Violating a rule is a finding, so a rule has to be something a reviewer would genuinely flag.

A **fact** is a checkable statement about how this repository, its architecture or its environment actually is. "A global interceptor covers every route under /api" is a fact. A fact is never a finding: it is what the reviewer uses to stop guessing, so that it does not report code that the architecture already covers. Report a fact when a reviewer who had not read that part of the codebase would otherwise assume something false.

Give every entry the kind it really is. Do not dress a fact up as an obligation to get it in, and do not report a rule that only restates what the code happens to do today. Leave out file inventories and dependency lists: those go stale without ever changing a review.

Report each entry by calling the propose_rule tool exactly once per entry. Do not describe entries in prose — an entry that is not reported through the tool does not exist.

Order the entries by importance, most important first. Importance means how much a reviewer's judgement improves by having it. Report as many as this repository genuinely warrants and no more: every entry is confirmed by hand, so one that is obvious, that a linter or the type checker already enforces, or that no reviewer would act on costs the reader time and earns nothing.

Write the statement and layer fields in Chinese. The reviewers of this repository read Chinese. Keep identifiers, file paths and code fragments in their original form — do not translate them.

The read tool prefixes every line with its line number, like \`12: code\`. The prefix is not part of the file content.`;

const ruleSchema = Type.Object({
  type: Type.String({
    description:
      "One of exactly: rule, fact. rule is a normative statement — what the code ought to do; violating it is a finding. fact is a checkable statement about how this repository actually is; it is grounds for judgement and never a finding by itself.",
  }),
  statement: Type.String({
    description:
      "One sentence in Chinese. For a rule: what code in this repository must or must not do. For a fact: what is actually the case in this repository, phrased so a reader can check it against the code.",
  }),
  layer: Type.String({
    description:
      "Only for a rule: a short Chinese free-text label grouping it with related rules, such as 架构 / 安全 / 数据 / 测试. Reuse the same label across rules that belong together. Leave it empty for a fact.",
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
        "The id of the agreed entry this change targets, taken from the list of agreed knowledge. Leave it out when you propose an entry that is not in that list.",
    }),
  ),
  retire: Type.Optional(
    Type.Boolean({
      description:
        "Set to true together with rule_id to retire that agreed entry instead of restating it. Restate the entry you want retired in the statement field. Use it for a rule the code no longer justifies, and for a fact the code has outgrown.",
    }),
  ),
});

function send(message: RuleWorkerMessage): void {
  process.send?.(message);
}

/**
 * 现有知识集。首次探索时是空的,这一段因此不渲染;非空即这一次提的是对照它的变更
 * (issue #207),条目带上标识与它是哪一型(issue #222),agent 据此指出改哪一条、
 * 废止哪一条——分不清哪条是规则、哪条是事实,就分不清「改一条标准」与「废止一条过期
 * 事实」。
 */
function existingSection(entries: readonly KnowledgeEntry[]): string {
  return [
    "",
    "This repository already agreed on the following knowledge, each entry with its id and its kind:",
    "",
    ...entries.map(knowledgeBullet),
    "",
    "Report changes against that list, not the list itself. Do not restate an entry that still holds as it stands — an entry you do not report stays in force. For each change, call propose_rule once:",
    "- to reword or narrow an agreed entry, pass its rule_id and the full new statement;",
    "- to retire an agreed entry the code no longer justifies or has outgrown, pass its rule_id, retire=true and restate that entry;",
    "- to add a standard or a fact the list does not cover, leave rule_id out.",
  ].join("\n");
}

/**
 * 现有知识集里的一条给 agent 看的样子:标识、两型之一、作用范围与那一句陈述。与 Reviewer
 * 那侧的 `ruleBullet` 分开:那边按型分两段渲染、事实不给标识,这边是一份要被指名修改的
 * 清单,两型必须在同一份里各自认得出来。
 */
function knowledgeBullet(entry: KnowledgeEntry): string {
  const scope = entry.scope === "" ? "whole repository" : entry.scope;
  return `- [${entry.id}] (${entry.type}) (${scope}) ${entry.statement}`;
}

function rulePrompt(request: Pick<RuleWorkerRequest, "baselineSha" | "existingKnowledge">): string {
  const existing =
    request.existingKnowledge.length === 0 ? "" : `${existingSection(request.existingKnowledge)}\n`;
  return `Derive the review knowledge of the repository as it stands at commit ${request.baselineSha}.
${existing}
Start from the repository's own documentation and configuration, then read the code that matters most: the entry points, the modules everything else depends on, and the places where mistakes would be expensive.

Two things come out of that reading. The conventions the existing code already keeps to become rules, stated as obligations. The load-bearing arrangements a reviewer cannot see from a diff — what a shared layer already guarantees, what the deployment or the data actually look like — become facts.

Report each entry through ${PROPOSE_RULE_TOOL}. When you have reported everything worth confirming, stop.`;
}

/**
 * 处置反哺的提示(issue #208)。同一个 agent、同一套产出协议,输入换成一条处置备注与
 * 它处置掉的那条 Finding:要的是「这条意见该不该成为长期标准」,不是重新推导整套规则。
 *
 * 明写「报不出变更是预期结果」:一条只了结眼前那一条 Finding 的备注不构成规则,而 agent
 * 手里有个报告工具时倾向于用它。
 */
function feedbackPrompt(
  request: Pick<RuleWorkerRequest, "existingKnowledge"> & { feedback: DispositionFeedback },
): string {
  const { note, finding } = request.feedback;
  const existing =
    request.existingKnowledge.length === 0
      ? ""
      : `${existingSection(request.existingKnowledge)}\n`;
  return `A reviewer of this repository just disposed of one finding and left a note explaining the decision. Judge what that note says about the standards this repository should be reviewed by.

Finding: ${finding.title ?? finding.description}
Location: ${finding.file}:${finding.line}
Description: ${finding.description}
Disposition note: ${note}
${existing}
Distil the note by what it says, not by how it is phrased. A note that says this repository should or should not do something is a **rule**. A note that explains why the finding was wrong by pointing at how this repository already is — a shared layer that already covers it, a constraint of the deployment, a property of the data — is a **fact**: report it as one, so the next review has that ground instead of guessing again.

Report only what the note itself justifies. A note that settles this one finding and nothing more justifies no change at all — reporting nothing is an expected outcome. Read the code around the finding when you need it to tell a one-off from a standing rule, or to check a fact before stating it.

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
        type: string;
        statement: string;
        layer: string;
        scope?: string;
        rule_id?: number;
        retire?: boolean;
      };
      send({
        kind: "rule",
        item: {
          // 两型是封闭枚举:认不得的取值当规则收(与升级前逐字一致),服务端仍会再校验
          // 一次陈述与层标签。宽松字符串加归一化是与 report_finding 同一条口径(ADR 0004)。
          type: raw.type === "fact" ? "fact" : "rule",
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
    thinkingLevel: sessionThinkingLevel(request.runtimeModel.reasoning, request.thinkingLevel),
    modelRuntime,
    tools: [...READ_ONLY_TOOLS, PROPOSE_RULE_TOOL],
    customTools: [proposeRule, numberedReadTool(request.worktreePath)],
    resourceLoader,
    sessionManager: SessionManager.inMemory(request.worktreePath),
    settingsManager,
  });

  // 知识轨迹只订阅并转发,不做判断(ADR 0017、issue #214):转换与 Reviewer 那侧共用
  // 同一个,凭据在转换那一步就抹掉。
  const forwardEvent = reviewerEventStream(apiKey, (event) => send({ kind: "event", event }));
  session.subscribe(forwardEvent);

  let thrown: string | undefined;
  try {
    await session.prompt(
      request.feedback === undefined
        ? rulePrompt(request)
        : feedbackPrompt({
            existingKnowledge: request.existingKnowledge,
            feedback: request.feedback,
          }),
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
