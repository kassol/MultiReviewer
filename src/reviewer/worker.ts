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
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type {
  HistoryFinding,
  RawFinding,
  ReviewIntent,
  ReviewRule,
} from "../review/finding.ts";
import { anchorReport, anchorVerdict } from "./anchor.ts";
import { MODEL_API_KEY_ENV, PI_AGENT_DIR_ENV, redactModelCredential } from "./env.ts";
import { isolatedPinnedModelRuntime } from "./model-runtime.ts";
import type { ReviewerRequest, WorkerMessage } from "./protocol.ts";
import { reviewerEventStream } from "./trace-events.ts";
import { fileLines, numberedReadTool, ruleBullet } from "./worker-tools.ts";

/**
 * 只读靠允许清单强制:未列出的工具 Pi 不会注册,模型没有写入的调用路径。
 * `read` 在清单里但实际注册的是下面的自定义实现——customTools 同名覆盖内建。
 */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

const REPORT_FINDING_TOOL = "report_finding";

/** 复核工具,与 report_finding 并列(ADR 0016)。只在本阶段有历史时注册。 */
const REVIEW_PRIOR_FINDING_TOOL = "review_prior_finding";

const SYSTEM_PROMPT = `You are a code reviewer. Explore the repository with your read tools, then report every problem you find.

Cover correctness, security, maintainability and design. You may open any file in the repository, not only the changed ones — check callers, other branches of a changed function, and the conventions already established in the same module.

Report each problem by calling the report_finding tool exactly once per problem. Do not describe problems in prose — a problem that is not reported through the tool does not exist. When you have reported everything, stop.

The read tool prefixes every line with its line number, like \`12: code\`. These numbers are the only valid source for the line field of report_finding — copy the number, never count lines yourself. The prefix is not part of the file content. In the snippet field, copy the exact text of the line the problem starts on, without the line number prefix. Pick the most distinctive line of the problem, not a bare brace. A finding whose snippet does not match the file at the reported line is rejected back to you.

Write the title, description, impact and suggestion fields in Chinese. The reviewers of this repository read Chinese. Keep identifiers, file paths, and code fragments in their original form — do not translate them. The severity and category fields stay in the exact English values listed for them.

When the prompt lists findings reported earlier in this review stage, call review_prior_finding exactly once for every one of them that is still open, and never report one of them again through report_finding. When one of them is still there but its code was rewritten or moved, give the verdict present with the line and snippet of the place it sits now.`;

/**
 * 枚举字段必须在自身的 `description` 里写明允许值。prototype 实测:仅用字面量联合
 * 罗列时模型会自造词汇,Pi 逐条拒绝,而模型连续收到校验错误也不改正,正确的
 * Finding 因此全部丢失。宽松字符串加服务端归一化是配套的另一半。
 */
const FINDING_FIELDS = {
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
};

const findingSchema = Type.Object(FINDING_FIELDS);

/**
 * 注入过评审规则的那一批才多这一个字段(issue #204)。空规则集下工具的形状与这一票
 * 之前逐字一致:没有规则可命中时留着一个规则标识字段,只会请模型编一个填进来。
 */
const findingWithRuleSchema = Type.Object({
  ...FINDING_FIELDS,
  ruleId: Type.Optional(
    Type.Integer({
      description:
        "Only when this problem violates one of the review rules listed in the prompt: the id of that rule, copied from its [id] prefix. Leave it out otherwise — never invent an id.",
    }),
  ),
});

/** 复核结论的枚举同样写在字段自己的 description 里,理由同 findingSchema。 */
const verdictSchema = Type.Object({
  id: Type.Integer({
    description: "The id of the prior finding, copied from the list in the prompt",
  }),
  verdict: Type.String({
    description:
      "One of exactly: present, fixed, unclear. present means the problem is still in the code — and if its lines were rewritten or moved, also give line and snippet of the place it sits now. fixed means the code has been changed and the problem is gone. unclear means you cannot tell.",
  }),
  line: Type.Optional(
    Type.Integer({
      description:
        "Only with present, and only when the problem moved: the 1-indexed line it sits on now, copied from the read tool's line number prefix",
    }),
  ),
  snippet: Type.Optional(
    Type.String({
      description:
        "The exact text of that line, copied from the file without the line number prefix. Give it whenever you give line — a line without a matching snippet is dropped.",
    }),
  ),
});

function send(message: WorkerMessage): void {
  process.send?.(message);
}

/** 一条已处置的历史条目只占一行:阶段很长时这是唯一的体积控制(ADR 0016)。 */
function disposedLine(entry: HistoryFinding): string {
  const note = entry.note === undefined ? "" : ` 处置备注:${entry.note}`;
  return `- [${entry.id}] ${entry.file}:${entry.line} ${entry.title} (already disposed:${
    entry.disposition
  })${note}`;
}

/** 未处置的条目给全文:模型要据此判断这个问题还在不在。 */
function openBlock(entry: HistoryFinding): string {
  const lines = [
    `- [${entry.id}] ${entry.file}:${entry.line} [${entry.severity}/${entry.category}] ${entry.title}`,
    `  ${entry.description}`,
  ];
  if (entry.note !== undefined) lines.push(`  处置备注:${entry.note}`);
  return lines.join("\n");
}

/**
 * 本阶段的历史。未处置的逐条复核,已处置的只是背景——同类误报不必再犯,但不必回结论。
 */
function historySection(history: readonly HistoryFinding[]): string {
  const open = history.filter(
    (entry) => entry.disposition === "unresolved" || entry.disposition === "unknown",
  );
  const disposed = history.filter(
    (entry) => entry.disposition === "resolved" || entry.disposition === "fixed",
  );
  const sections = [
    "",
    "The following findings were already reported in this review stage. Do not report any of them again through report_finding while the lines they point at are unchanged.",
    "One exception: when the code of a still-open finding was rewritten or moved so that its original lines no longer exist but the problem is still there, give the verdict present and add the line it sits on now together with the snippet of that line. That is how a finding follows the code; without the new line it stays pinned to a line that is gone. The new position in the verdict is enough — you do not have to report it again through report_finding.",
  ];
  if (open.length > 0) {
    sections.push(
      "",
      `Still open — call ${REVIEW_PRIOR_FINDING_TOOL} exactly once for each of these ${open.length}, with its id and your verdict:`,
      "",
      ...open.map(openBlock),
    );
  }
  if (disposed.length > 0) {
    sections.push(
      "",
      "Already disposed — no verdict needed. Take the notes as guidance on what this repository does not consider a problem:",
      "",
      ...disposed.map(disposedLine),
    );
  }
  return sections.join("\n");
}

/** 一条 commit message:首行做条目,其余行缩进跟在下面,多行信息因此不会散成几条。 */
function commitBullet(message: string): string {
  return `- ${message.split("\n").join("\n  ")}`;
}

/**
 * 这一轮声称要做的事(issue #201)。它是作者的主张,不是代码的事实——模型要拿它当
 * 判据去对照代码,而不是当成代码已经做到的描述。
 */
function intentSection(intent: ReviewIntent): string {
  const lines = [
    "",
    "The author claims this change does the following. This is intent, not a description of what the code actually does. Judge the code against it: behaviour that is claimed but missing, and behaviour that is present but never claimed, are both problems — report them through report_finding like any other.",
  ];
  if (intent.title !== "") lines.push("", `Title: ${intent.title}`);
  if (intent.body !== undefined) lines.push("", "Description:", "", intent.body);
  if (intent.commits.length > 0) {
    lines.push("", "Commit messages in this range, newest first:", "");
    lines.push(...intent.commits.map(commitBullet));
    // 截断过就说清楚,否则模型会把这几条当成这个范围的全部改动。
    if (intent.omittedCommits > 0) {
      lines.push(`- (${intent.omittedCommits} older commit messages omitted)`);
    }
  }
  return lines.join("\n");
}

/**
 * 这个仓库既定的评审规则(issue #204)。它是团队定下的标准,不是模型的临场判断:
 * 违反规则的地方优先按规则判,规则没覆盖到的照常自行判断。
 */
function rulesSection(rules: readonly ReviewRule[]): string {
  return [
    "",
    "This repository has an agreed set of review rules. Judge the code against them first: code that violates one of them is a finding, whatever you would have thought of it otherwise. They do not narrow your review — report problems they do not cover as usual.",
    "Each rule is listed with its id in brackets and the paths it applies to in parentheses. When a finding violates one of these rules, pass that rule's id as ruleId in report_finding. Never invent an id, and leave the field out when no rule applies.",
    "",
    ...rules.map(ruleBullet),
  ].join("\n");
}

export function reviewPrompt(
  request: Pick<ReviewerRequest, "range" | "history" | "intent" | "rules">,
): string {
  const files = request.range.files.map((f) => `- ${f}`).join("\n");
  const history =
    request.history.length === 0 ? "" : `\n${historySection(request.history)}\n`;
  const intent = request.intent === undefined ? "" : `${intentSection(request.intent)}\n`;
  // 空规则集与没有规则集同一条路径:两者都不渲染规则段。
  const rules =
    request.rules === undefined || request.rules.length === 0
      ? ""
      : `${rulesSection(request.rules)}\n`;
  return `Review the changes between commit ${request.range.baseSha} and commit ${request.range.headSha}.
${intent}${rules}
The following files changed. Review the changes in them, using the rest of the repository as context:

${files}

Use \`git diff ${request.range.baseSha}..${request.range.headSha}\` reasoning from the files themselves — read each changed file and judge the current state of the code.
${history}`;
}

async function run(request: ReviewerRequest): Promise<void> {
  const hasRules = request.rules !== undefined && request.rules.length > 0;
  let rejectedToolCalls = 0;
  /**
   * 锚定打回的那几次调用,按 toolCallId 记(issue #187)。它同时是两样东西:收尾事件
   * 的「锚定被拒」就是它的大小,轨迹据它把这几次标成被拒。两条打回路径
   * (`report_finding` 与 `review_prior_finding`)记同一份,口径因此只有一个。
   */
  const anchorRejectedCalls = new Set<string>();

  const reportFinding = defineTool({
    name: REPORT_FINDING_TOOL,
    label: "Report Finding",
    description: "Report one problem found in the code under review.",
    parameters: hasRules ? findingWithRuleSchema : findingSchema,
    execute: async (id, params) => {
      const raw = params as RawFinding;
      const result = anchorReport(fileLines(request.worktreePath, raw.file), raw);
      if (!result.ok) {
        // 打回走正常返回而非工具错误:rejectedToolCalls 只统计 Pi 的 schema 校验
        // 失败,即"契约失配"信号,锚定失败是另一回事,混进去信号就没了。因此另记
        // 一个数——模型不重报时这条 Finding 就静默消失了,没有它谁都不知道丢过。
        anchorRejectedCalls.add(id);
        return { content: [{ type: "text", text: result.message }], details: {} };
      }
      send({ kind: "finding", raw: { ...raw, line: result.line } });
      return { content: [{ type: "text", text: "recorded" }], details: {} };
    },
  });

  const historyById = new Map(request.history.map((entry) => [entry.id, entry]));
  const reviewPriorFinding = defineTool({
    name: REVIEW_PRIOR_FINDING_TOOL,
    label: "Review Prior Finding",
    description:
      "Give your verdict on one finding reported earlier in this review stage: is it still present, fixed, or can you not tell? When it is still present but its code was rewritten or moved, give the line and snippet of the place it sits now instead of reporting it again.",
    parameters: verdictSchema,
    execute: async (id, params) => {
      const raw = params as { id: number; verdict: string; line?: number; snippet?: string };
      // 编出来的 id 对不到任何历史条目,打回让模型改用列表里的那个:静默收下会让
      // 一条真实的历史 Finding 少一个结论,而模型自己不会知道。
      const entry = historyById.get(raw.id);
      if (entry === undefined) {
        return {
          content: [
            {
              type: "text",
              text: `no prior finding with id ${raw.id}; use one of the ids listed in the prompt`,
            },
          ],
          details: {},
        };
      }
      if (raw.line === undefined) {
        send({ kind: "verdict", raw: { id: raw.id, verdict: raw.verdict } });
        return { content: [{ type: "text", text: "recorded" }], details: {} };
      }
      // 新位置与 report_finding 的行号同一道核对(issue #170):模型数行会数偏,抄下来的
      // 代码不会。锚不上只丢这个位置,结论本身照收——「这个问题还在」是模型给的证据,
      // 不该因为它把行号抄错而一起作废。
      const anchored = anchorVerdict(fileLines(request.worktreePath, entry.file), {
        file: entry.file,
        line: raw.line,
        snippet: raw.snippet,
      });
      if (!anchored.ok) {
        send({ kind: "verdict", raw: { id: raw.id, verdict: raw.verdict } });
        // 与 report_finding 的锚定失败同一口径(issue #187):记进「锚定被拒」,轨迹里
        // 留一条被拒记录。不记的话模型一直把新位置抄错时,延续一直触发不了,而线上
        // 看起来像模型根本没给过位置。
        anchorRejectedCalls.add(id);
        return { content: [{ type: "text", text: anchored.message }], details: {} };
      }
      send({ kind: "verdict", raw: { id: raw.id, verdict: raw.verdict, line: anchored.line } });
      return { content: [{ type: "text", text: "recorded" }], details: {} };
    },
  });

  // 空的 agentDir:不让宿主机上的全局扩展、skill、设置与凭据渗进审查会话。
  const agentDir = mkdtempSync(join(tmpdir(), "multireviewer-agent-"));
  process.env[PI_AGENT_DIR_ENV] = agentDir;

  const apiKey = process.env[MODEL_API_KEY_ENV];
  if (apiKey === undefined || apiKey === "") {
    send({ kind: "done", rejectedToolCalls: 0, anchorRejections: 0, failure: "缺少模型凭据" });
    return;
  }

  // 只从 IPC 里的本轮快照注册这一项运行模型。子进程不读共享的当前模型投影，因此模型服务
  // 在 Review Run 中途切版也不会改掉后续批次的地址、协议或模型字段。
  const runtime = request.runtimeModel;
  const modelRuntime = await isolatedPinnedModelRuntime(agentDir, runtime);
  await modelRuntime.setRuntimeApiKey(runtime.provider, apiKey);

  const model = modelRuntime.getModel(runtime.provider, runtime.id);
  if (!model) {
    send({
      kind: "done",
      rejectedToolCalls: 0,
      anchorRejections: 0,
      failure: `固定运行模型无法加载: ${runtime.provider}/${runtime.id}`,
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
    // 本阶段没有历史时不注册复核工具:一个无事可复核的工具只会让模型多绕一圈。
    tools: [
      ...READ_ONLY_TOOLS,
      REPORT_FINDING_TOOL,
      ...(request.history.length === 0 ? [] : [REVIEW_PRIOR_FINDING_TOOL]),
    ],
    customTools: [
      reportFinding,
      numberedReadTool(request.worktreePath),
      ...(request.history.length === 0 ? [] : [reviewPriorFinding]),
    ],
    resourceLoader,
    sessionManager: SessionManager.inMemory(request.worktreePath),
    settingsManager,
  });

  // 审查轨迹只订阅并转发,不做判断(ADR 0017)。凭据在转换那一步就抹掉;锚不上是本进程
  // 自己的判定,按 toolCallId 交下去,由转换那一层标成被拒(issue #187)。
  const forwardEvent = reviewerEventStream(
    apiKey,
    (event) => send({ kind: "event", event }),
    Date.now,
    (toolCallId) => anchorRejectedCalls.has(toolCallId),
  );

  session.subscribe((event) => {
    forwardEvent(event);
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
  const rawFailure = thrown ?? session.agent.state.errorMessage ?? stopReasonFailure;
  const failure =
    rawFailure === undefined ? undefined : redactModelCredential(rawFailure, apiKey);

  // 用量必须在 dispose 之前读:会话销毁后统计随之消失。只取 token 明细,`stats.cost`
  // 是 Pi 按自带价目表折算的估算,产品不记账,读它没有意义。
  const stats = session.getSessionStats();
  const usage = {
    inputTokens: stats.tokens.input,
    outputTokens: stats.tokens.output,
    cacheReadTokens: stats.tokens.cacheRead,
    cacheWriteTokens: stats.tokens.cacheWrite,
    totalTokens: stats.tokens.total,
  };

  session.dispose();
  send({
    kind: "done",
    rejectedToolCalls,
    anchorRejections: anchorRejectedCalls.size,
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
      anchorRejections: 0,
      failure: redactModelCredential(
        String(error instanceof Error ? error.message : error),
        process.env[MODEL_API_KEY_ENV],
      ),
    });
  });
});
