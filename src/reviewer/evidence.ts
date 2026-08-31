/**
 * 取证子代理(CONTEXT.md 取证,ADR 0021,issue #226)。
 *
 * Reviewer 在报出跨文件因果主张前派一个只读子代理沿调用链核查。执行体是 vendor 进镜像的
 * `pi-subagents`:建会话时把它与唯一的自定义取证 agent 一起铺进该会话的临时 agentDir。
 * 这是对「空 agentDir 隔绝宿主扩展」的受控例外——铺进去的内容全部由本文件生成或由镜像
 * 构建固定,不来自宿主机运行环境。
 *
 * 三道约束各有各的落点,不要合并:
 * - **禁用内置 agent**:`settings.json` 的 `subagents.disableBuiltins`。worker 能写文件、
 *   researcher 要联网,审查环境不该有它们。
 * - **能力天花板**:`PI_SUBAGENT_CAPABILITY_CEILING_V1` 环境变量,在派出之前判定。它挡的
 *   不是我们自己写的那份 agent 定义,而是被审仓库工作副本里可能存在的 `.pi/agents/*.md`
 *   ——那是半可信输入,agent 定义里写 `tools: bash` 就能把只读会话变成可写会话。
 * - **spawn 预算**:`PI_SUBAGENT_MAX_SPAWNS_PER_RUN`。取证是针对存疑 Finding 的定向动作,
 *   单轮超过 8 次说明在滥派。
 *
 * 子会话与 Reviewer 同模型同凭据同思考档位:子代理跑在另一个 pi 进程里,读不到本进程内存
 * 里注册的那一项模型,因此把同一份运行模型另写一份 `models.json`;凭据写的是环境变量引用
 * 而非明文,子进程从继承来的环境里取。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { ThinkingLevel } from "../config.ts";
import type { ProjectFact, ReviewerEvent, ReviewRule } from "../review/finding.ts";
import { MODEL_API_KEY_ENV } from "./env.ts";
import { ZERO_MODEL_COST } from "./model-runtime.ts";
import type { RuntimeModel } from "./model-service-runtime.ts";
import { factBullet, READ_ONLY_TOOLS, ruleBullet } from "./worker-tools.ts";

/** 取证工具在会话里的名字,由 pi-subagents 注册。 */
export const EVIDENCE_TOOL = "subagent";

/** 唯一的自定义取证 agent。内置 agent 全部禁用,能力天花板也只放行这一个名字。 */
export const EVIDENCE_AGENT = "evidence";

/** 单轮取证次数上限(ADR 0021)。 */
export const EVIDENCE_SPAWN_BUDGET = 8;

const SPAWN_BUDGET_ENV = "PI_SUBAGENT_MAX_SPAWNS_PER_RUN";
const CAPABILITY_CEILING_ENV = "PI_SUBAGENT_CAPABILITY_CEILING_V1";

/** 天花板的来源标签,打回文案里会带上它,让人看得出是谁挡的。 */
const CEILING_SOURCE = "multireviewer";

/**
 * 取证子会话的能力天花板。**白名单写死在这里,不从会话的工具面透传**:透传意味着
 * 「Reviewer 现在有哪些工具」变成子代理有哪些工具的判据,而 `report_finding` 与取证工具
 * 本身都在 Reviewer 那一面上——报不报由 Reviewer 裁决,取证只交证据;取证工具不进子代理
 * 的工具面,单层因此是构造出来的,不靠深度计数。
 */
export function evidenceCeiling(): {
  version: 1;
  allowedTools: string[];
  allowedAgents: string[];
  denyExtensions: boolean;
  sources: string[];
} {
  return {
    version: 1,
    allowedTools: [...READ_ONLY_TOOLS].sort(),
    allowedAgents: [EVIDENCE_AGENT],
    denyExtensions: true,
    sources: [CEILING_SOURCE],
  };
}

/** 天花板的传递形态:base64url 的 JSON,pi-subagents 从环境变量里解出来。 */
export function encodeEvidenceCeiling(): string {
  return Buffer.from(JSON.stringify(evidenceCeiling()), "utf8").toString("base64url");
}

/** vendor 进镜像的 pi-subagents 包根目录。它是一个 pi 包,整个目录交给资源加载器。 */
export function vendoredSubagentsPath(): string {
  return dirname(createRequire(import.meta.url).resolve("pi-subagents"));
}

/**
 * 子进程要读的模型目录。字段逐项取自本轮固定的运行模型,与主进程内存里注册的那一项同源;
 * 凭据写成环境变量引用,明文不落盘。
 */
export function childModelCatalog(model: RuntimeModel): unknown {
  return {
    providers: {
      [model.provider]: {
        name: model.provider,
        baseUrl: model.baseUrl,
        api: model.api,
        apiKey: `$${MODEL_API_KEY_ENV}`,
        models: [
          {
            id: model.id,
            name: model.name,
            reasoning: model.reasoning,
            input: [...model.input],
            cost: { ...ZERO_MODEL_COST },
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            ...(model.thinkingLevelMap === undefined
              ? {}
              : { thinkingLevelMap: model.thinkingLevelMap }),
            ...(model.compat === undefined ? {} : { compat: model.compat }),
          },
        ],
      },
    },
  };
}

/**
 * 取证子会话收到的知识注入(issue #226)。与 Reviewer 那一份是同一批条目、同一套行格式,
 * 措辞按取证的职责改写:子代理不产 Finding,知识对它只是「省下你本来只能猜的那些」。
 */
function knowledgeSection(
  rules: readonly ReviewRule[],
  facts: readonly ProjectFact[],
): string {
  const sections: string[] = [];
  if (rules.length > 0) {
    sections.push(
      "",
      "This repository has an agreed set of review rules. They tell you what the reviewer judges the code against, so you know which details matter. You do not judge and you do not report violations — you only bring back what the code actually does.",
      "",
      ...rules.map(ruleBullet),
    );
  }
  if (facts.length > 0) {
    sections.push(
      "",
      "This repository has also agreed on a set of project facts: statements about how this codebase, its architecture and its environment actually are. Use them as grounds for judgement — they tell you what you would otherwise have to assume or verify yourself. When the code contradicts a fact, the code wins: report what you read and say that the fact no longer holds.",
      "",
      ...facts.map(factBullet),
    );
  }
  return sections.join("\n");
}

/**
 * 取证 agent 的定义文件。frontmatter 是它的行为约束,正文是它的系统提示。
 *
 * `tools` 只有只读四件套:pi-subagents 把它当严格允许清单,取证工具本身与 `report_finding`
 * 都不在其中。`model: inherit` 取父会话那一项模型,`thinking` 与 Reviewer 同档。三个
 * `inherit*: false` 让子会话只拿到这里写下的东西,不吃工作副本里的 `AGENTS.md` 与技能目录
 * ——那是被审仓库的内容,半可信。`acceptance` 关掉验收契约:取证交的是证据,不是交付物。
 */
export function evidenceAgentDefinition(options: {
  thinkingLevel: ThinkingLevel;
  rules: readonly ReviewRule[];
  facts: readonly ProjectFact[];
}): string {
  const knowledge = knowledgeSection(options.rules, options.facts);
  return `---
name: ${EVIDENCE_AGENT}
description: Read-only investigation of one causal claim about this repository. Give it a single claim to check; it reads the code along the call chain and comes back with file:line evidence.
tools: ${READ_ONLY_TOOLS.join(", ")}
model: inherit
thinking: ${options.thinkingLevel}
systemPromptMode: replace
inheritProjectContext: false
inheritGlobalContext: false
inheritSkills: false
allowNestedSubagents: false
acceptance: { level: "none", reason: "evidence report, not a deliverable" }
---

You check one claim about this repository by reading its code, and you report what you found. You do not judge the code and you do not decide whether anything is a problem — the reviewer who sent you does that with your evidence in hand.

Read as widely as the claim requires: callers, callees, sibling branches, configuration, unchanged files. Your reading radius is the whole repository.

Answer with evidence, not with impressions. Every statement you make about the code must name the file and the line you read it on, written as \`path/to/file.ts:42\`. When you could not settle the claim, say exactly what you looked at and what is still missing — an honest "not established" is worth more than a guess.

Keep the report short. The reviewer needs the answer and the lines it rests on, not a tour of the repository.

Write the report and everything you say in Chinese — your words end up in a trace read by this repository's maintainers. Keep identifiers, file paths and code fragments in their original form.
${knowledge}`;
}

/**
 * 把取证子代理铺进这个会话的临时 agentDir,并设好它的两个环境闸。
 *
 * 调用点在 `prepareAgentRuntime` 之后、`createAgentSession` 之前:`models.json` 要在主进程
 * 的模型运行时建好之后再写,免得它反过来盖掉内存里已经注册好的那一项模型;而 agent 定义
 * 与设置要在会话起来之前就位,派出取证时 pi-subagents 现读这两处。
 */
export function installEvidenceKit(options: {
  agentDir: string;
  runtimeModel: RuntimeModel;
  thinkingLevel: ThinkingLevel;
  rules: readonly ReviewRule[];
  facts: readonly ProjectFact[];
}): void {
  const { agentDir } = options;
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ subagents: { disableBuiltins: true } }, null, 2),
  );
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify(childModelCatalog(options.runtimeModel), null, 2),
  );
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(
    join(agentDir, "agents", `${EVIDENCE_AGENT}.md`),
    evidenceAgentDefinition({
      thinkingLevel: options.thinkingLevel,
      rules: options.rules,
      facts: options.facts,
    }),
  );
  process.env[SPAWN_BUDGET_ENV] = String(EVIDENCE_SPAWN_BUDGET);
  process.env[CAPABILITY_CEILING_ENV] = encodeEvidenceCeiling();
}

/**
 * 一次取证调用的结果里,子会话 transcript 的落点(issue #227)。
 *
 * pi-subagents 把子会话的每一条消息、每一次工具调用逐行写成 jsonl,路径放在工具返回的
 * `details.results[].transcriptPath` 上。认不出形状就回空:轨迹记的是过程,读不到嵌套
 * 事件不该让一次取证连带失败。
 */
function transcriptPaths(result: unknown): string[] {
  const details = (result as { details?: unknown } | null)?.details;
  const results = (details as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((entry: unknown) => {
    const path = (entry as { transcriptPath?: unknown } | null)?.transcriptPath;
    return typeof path === "string" && path !== "" ? [path] : [];
  });
}

/** transcript 里的一行。只认下面用到的那几个字段,其余一律不管。 */
type TranscriptRecord = {
  recordType?: unknown;
  role?: unknown;
  text?: unknown;
  ts?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  argsPayload?: unknown;
  isError?: unknown;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * 一份子会话 transcript 转成 Reviewer 事件序列。
 *
 * 形状与外层逐字相同,面板因此用同一个渲染器:模型说的话进 `assistant_message`,工具调用
 * 按 `tool_start` / `tool_end` 配对进 `tool_call`。工具返回的正文照旧不进轨迹,只记长度
 * (ADR 0017)——长度从那条 `toolResult` 消息取,被拒时那段文本才作 `error` 记下来。
 * 派给子代理的那句任务不重复记:它已经原样躺在外层 `tool_call` 的参数里。
 */
function transcriptEvents(lines: readonly string[]): ReviewerEvent[] {
  const events: ReviewerEvent[] = [];
  /** 起了还没配对上的工具调用:参数与开始时刻只有 `tool_start` 那一行有。 */
  const pending = new Map<string, { tool: string; args: unknown; startedAt: number }>();
  /**
   * 工具返回的长度与被拒原因。它由 `toolResult` 消息带来,而那一行**排在 `tool_end`
   * 之后**——因此按 `toolCallId` 记住已经发出的那条事件,读到返回时再回填。
   */
  const emitted = new Map<string, Extract<ReviewerEvent, { kind: "tool_call" }>>();

  for (const line of lines) {
    if (line.trim() === "") continue;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue;
    }
    const at = typeof record.ts === "number" ? record.ts : 0;
    const callId = typeof record.toolCallId === "string" ? record.toolCallId : undefined;

    if (record.recordType === "message") {
      if (record.role === "assistant") {
        const said = text(record.text);
        if (said !== undefined) events.push({ kind: "assistant_message", text: said });
        continue;
      }
      if (record.role === "toolResult" && callId !== undefined) {
        const call = emitted.get(callId);
        if (call !== undefined) {
          const body = typeof record.text === "string" ? record.text : "";
          call.resultLength = body.length;
          if (call.isError) call.error = body === "" ? null : body;
        }
      }
      continue;
    }

    if (record.recordType === "tool_start" && callId !== undefined) {
      let args: unknown = null;
      if (typeof record.argsPayload === "string") {
        try {
          args = JSON.parse(record.argsPayload);
        } catch {
          args = record.argsPayload;
        }
      }
      pending.set(callId, {
        tool: typeof record.toolName === "string" ? record.toolName : "(未命名工具)",
        args,
        startedAt: at,
      });
      continue;
    }

    if (record.recordType !== "tool_end" || callId === undefined) continue;
    const started = pending.get(callId);
    pending.delete(callId);
    const call: Extract<ReviewerEvent, { kind: "tool_call" }> = {
      kind: "tool_call",
      tool: started?.tool ?? (typeof record.toolName === "string" ? record.toolName : "(未命名工具)"),
      args: started?.args ?? null,
      durationMs: started === undefined || at === 0 ? 0 : Math.max(0, at - started.startedAt),
      isError: record.isError === true,
      error: null,
      resultLength: 0,
    };
    emitted.set(callId, call);
    events.push(call);
  }
  return events;
}

/**
 * 一次取证调用的子会话事件(issue #227)。读不到 transcript 就回空数组:少一段嵌套过程
 * 是小事,一次取证因此白跑不是。
 */
export function evidenceTranscriptEvents(result: unknown): ReviewerEvent[] {
  return transcriptPaths(result).flatMap((path) => {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    return transcriptEvents(content.split("\n"));
  });
}
