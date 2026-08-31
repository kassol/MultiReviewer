/**
 * Reviewer 子进程的入口。
 *
 * 每个 Reviewer 一个进程,进程的环境里只有它自己那一家厂商的凭据(见 `env.ts`)。
 * 这里跑一个 Pi 会话,把模型经 `report_finding` 报出的每条原始条目立即回传主进程。
 */
import {
  createAgentSession,
  defineTool,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type {
  HistoryFinding,
  ProjectFact,
  RawFinding,
  ReviewIntent,
  ReviewRule,
} from "../review/finding.ts";
import { anchorReport, anchorVerdict } from "./anchor.ts";
import { MODEL_API_KEY_ENV, redactModelCredential } from "./env.ts";
import {
  EVIDENCE_AGENT,
  EVIDENCE_TOOL,
  evidenceTranscriptEvents,
  installEvidenceKit,
  vendoredSubagentsPath,
} from "./evidence.ts";
import { GIT_TOOL, gitTool } from "./git-tool.ts";
import type { ReviewerRequest, WorkerMessage } from "./protocol.ts";
import { reviewerEventStream } from "./trace-events.ts";
import {
  factBullet,
  factRuleIdRejection,
  fileLines,
  numberedReadTool,
  prepareAgentRuntime,
  READ_ONLY_TOOLS,
  ruleBullet,
  sessionThinkingLevel,
} from "./worker-tools.ts";

const REPORT_FINDING_TOOL = "report_finding";

/** 复核工具,与 report_finding 并列(ADR 0016)。只在本阶段有历史时注册。 */
const REVIEW_PRIOR_FINDING_TOOL = "review_prior_finding";

const SYSTEM_PROMPT = `You are a code reviewer. Explore the repository with your read tools, then report every problem you find.

Cover correctness, security, maintainability and design. You may open any file in the repository, not only the changed ones — check callers, other branches of a changed function, and the conventions already established in the same module.

Report each problem by calling the report_finding tool exactly once per problem. Do not describe problems in prose — a problem that is not reported through the tool does not exist. When you have reported everything, stop.

The read tool prefixes every line with its line number, like \`12: code\`. These numbers are the only valid source for the line field of report_finding — copy the number, never count lines yourself. The prefix is not part of the file content. In the snippet field, copy the exact text of the line the problem starts on, without the line number prefix. Pick the most distinctive line of the problem, not a bare brace. A finding whose snippet does not match the file at the reported line is rejected back to you.

Never assert anything about code you have not read. A finding that depends on how another file behaves — that a caller passes an unchecked value, that no middleware already handles this, that an annotation is missing, that this value never reaches the database — is only reportable once you have read the code it depends on. Before you report a claim like that, send an ${EVIDENCE_AGENT} investigation with the ${EVIDENCE_TOOL} tool: state the single claim you want checked, and it comes back with file:line evidence. Read the evidence and decide yourself whether the problem holds; the investigator does not decide, and it never reports findings. Investigate the claims that carry a finding, not every passing thought.

Every finding must be anchored on a line this change actually touches. Read as widely as you need — callers, other branches, unchanged files — but report the problem at the end of its causal chain on the changed side: the changed line that is wrong, or the changed line that depends on the unchanged code you object to. A finding anchored outside the diff is rejected back to you, and a finding you never re-anchor is lost.

Write the title, description, impact and suggestion fields in Chinese. The reviewers of this repository read Chinese. Keep identifiers, file paths, and code fragments in their original form — do not translate them. The severity and category fields stay in the exact English values listed for them.

Narrate in Chinese too: everything you say between tool calls goes into a review trace read by the same people, so write those sentences in Chinese — one short line on what you are about to check and why, before each group of tool calls.

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
 * 注入过评审规则的那一批才多这一个字段(issue #204)。空知识集下工具的形状与这一票
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

/**
 * 这个仓库既定的项目事实(CONTEXT.md 项目事实,issue #221)。三句语义缺一不可:它是
 * 判断依据(省下你本来只能猜的那些)、它本身不产 Finding、它与代码矛盾时以代码为准。
 *
 * 与规则段并列而不合并:两者对模型的要求相反——规则是拿来判违反的,事实是拿来免于臆断
 * 的,写在同一段里模型会把事实也当成可违反的标准去报。
 */
function factsSection(facts: readonly ProjectFact[]): string {
  return [
    "",
    "This repository has also agreed on a set of project facts: statements about how this codebase, its architecture and its environment actually are. Use them as grounds for judgement — they tell you what you would otherwise have to assume or verify yourself.",
    "A fact is never a finding on its own. Do not report a fact as a problem, and do not report code merely for relying on one. Facts carry no ids: never pass one as ruleId.",
    "When the code contradicts a fact, the code wins — judge the code as you read it. Say that the fact no longer holds only inside a finding whose problem is that contradiction.",
    "Each fact is listed with the paths it describes in parentheses.",
    "",
    ...facts.map(factBullet),
  ].join("\n");
}

/**
 * 本轮指令(CONTEXT.md,issue #225):发起重审的人对这一轮附的一次性要求。
 *
 * 三样声明缺一不可。**只作用于这一轮**:模型不该把它当成这个仓库的长期标准,那种要求
 * 该沉淀成知识条目。**优先于常规范围**:「只报 P0」与「覆盖正确性、安全、可维护性、
 * 设计」是直接冲突的,不说清听谁的,模型会各自发挥。**不改变证据标准**:「重点看并发」
 * 很容易被读成「并发那块可以放宽取证」,而放宽取证正是误报的第一根因。
 */
function directiveSection(directive: string): string {
  return [
    "",
    "The reviewer who started this review round asked for the following. It applies to this review round only — it is not a standing rule of this repository. Where it conflicts with the general scope above, it takes priority: follow it. It does not change the evidence standard — every finding still needs the same grounding in code you have actually read.",
    "",
    directive,
  ].join("\n");
}

export function reviewPrompt(
  request: Pick<
    ReviewerRequest,
    "range" | "history" | "intent" | "rules" | "facts" | "directive"
  >,
): string {
  const files = request.range.files.map((f) => `- ${f}`).join("\n");
  const history =
    request.history.length === 0 ? "" : `\n${historySection(request.history)}\n`;
  const intent = request.intent === undefined ? "" : `${intentSection(request.intent)}\n`;
  // 空知识集与没有知识集同一条路径:两者都不渲染规则段。事实段同律,两型各判各的——
  // 只有事实没有规则的知识集同样成立。
  const rules =
    request.rules === undefined || request.rules.length === 0
      ? ""
      : `${rulesSection(request.rules)}\n`;
  const facts =
    request.facts === undefined || request.facts.length === 0
      ? ""
      : `${factsSection(request.facts)}\n`;
  // 指令段排在知识两段之后、文件清单之前:它是这一轮的要求,读到文件清单之前就该知道。
  const directive =
    request.directive === undefined || request.directive === ""
      ? ""
      : `${directiveSection(request.directive)}\n`;
  return `Review the changes between commit ${request.range.baseSha} and commit ${request.range.headSha}.
${intent}${rules}${facts}${directive}
The following files changed. Review the changes in them, using the rest of the repository as context:

${files}

Start with the git tool: \`diff ${request.range.baseSha}..${request.range.headSha} --stat\` for the shape of the change, then per-file diffs — that is the only way to see removed lines and deleted files. Then read the changed files and judge the current state of the code.
${history}`;
}

async function run(request: ReviewerRequest): Promise<void> {
  const hasRules = request.rules !== undefined && request.rules.length > 0;
  /** 本批注入的事实标识(issue #221)。模型拿它们当 `ruleId` 报出时这次调用被打回。 */
  const factIds = new Set((request.facts ?? []).map((fact) => fact.id));
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
      // 事实型条目不是 ruleId 的合法取值(ADR 0020):拿事实当命中的规则报出来,这条
      // Finding 的依据本身就不成立,打回并说明理由,由模型改报或不报。
      const factRejection = factRuleIdRejection(raw.ruleId, factIds);
      if (factRejection !== undefined) {
        // 与锚定打回同一条口径记进被拒集合:不记的话,这次打回在轨迹上与一次正常
        // 调用长得一模一样,模型不重报时那条 Finding 就无声消失了。
        anchorRejectedCalls.add(id);
        return { content: [{ type: "text", text: factRejection }], details: {} };
      }
      const result = anchorReport(
        fileLines(request.worktreePath, raw.file),
        request.commentable,
        raw,
      );
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
      const anchored = anchorVerdict(
        fileLines(request.worktreePath, entry.file),
        request.commentable,
        { file: entry.file, line: raw.line, snippet: raw.snippet },
      );
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

  const thinkingLevel = sessionThinkingLevel(
    request.runtimeModel.reasoning,
    request.thinkingLevel,
  );

  const prepared = await prepareAgentRuntime({
    agentDirPrefix: "multireviewer-agent-",
    worktreePath: request.worktreePath,
    runtimeModel: request.runtimeModel,
    systemPrompt: SYSTEM_PROMPT,
    extensionPaths: [vendoredSubagentsPath()],
  });
  if ("failure" in prepared) {
    send({ kind: "done", rejectedToolCalls: 0, anchorRejections: 0, failure: prepared.failure });
    return;
  }
  const { agentDir, apiKey, model, modelRuntime, settingsManager, resourceLoader } = prepared;

  // 取证子代理的铺装(issue #226)。知识注入与 Reviewer 拿到的是同一批条目。
  installEvidenceKit({
    agentDir,
    runtimeModel: request.runtimeModel,
    thinkingLevel,
    rules: request.rules ?? [],
    facts: request.facts ?? [],
  });

  const { session } = await createAgentSession({
    cwd: request.worktreePath,
    agentDir,
    model,
    thinkingLevel,
    modelRuntime,
    // 本阶段没有历史时不注册复核工具:一个无事可复核的工具只会让模型多绕一圈。
    tools: [
      ...READ_ONLY_TOOLS,
      GIT_TOOL,
      REPORT_FINDING_TOOL,
      EVIDENCE_TOOL,
      ...(request.history.length === 0 ? [] : [REVIEW_PRIOR_FINDING_TOOL]),
    ],
    customTools: [
      reportFinding,
      numberedReadTool(request.worktreePath),
      gitTool(request.worktreePath),
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
    // 取证子会话的过程嵌进这一次调用(issue #227):子代理跑在另一个进程里,它说过的话与
    // 调过的工具只有从它的 transcript 读回来才进得了审查轨迹。
    (toolName, result) =>
      toolName === EVIDENCE_TOOL ? evidenceTranscriptEvents(result) : [],
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
