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
 * - **能力天花板**:按父会话注册进 pi-subagents 的进程内登记表,在派出之前判定。它挡的
 *   不是我们自己写的那份 agent 定义,而是被审仓库工作副本里可能存在的 `.pi/agents/*.md`
 *   ——那是半可信输入,agent 定义里写 `tools: bash` 就能把只读会话变成可写会话。
 * - **spawn 预算**:两道,作用域不同,不要互相顶替。`PI_SUBAGENT_MAX_SPAWNS_PER_SESSION`
 *   限一个 Reviewer 子进程一次会话累计派几次取证(即每批每模型),取证是针对存疑 Finding
 *   的定向动作,一批派太多次就是在滥派;它的值是审查策略的一格(issue #258),默认 3,
 *   随运行计划在开跑时冻结、经 `ReviewerRequest.maxEvidenceCallsPerBatch` 进到这里;
 *   `PI_SUBAGENT_MAX_SPAWNS_PER_RUN` 限的是单次 `subagent` 调用内部展开的子任务数,
 *   每次调用重新计数,挡的是一次调用扇出过宽,写死不进策略。
 * - **模型排除表关进 agentDir**:`PI_MODEL_EXCLUSIONS_PATH`(issue #262)。子会话的模型调用
 *   一旦以可重试的原因失败(连接错误、429、5xx),pi-subagents 会把这个模型记进一份排除表,
 *   默认 24 小时内不再派给它;这份表默认落在 `os.tmpdir()/pi-subagents-uid-<uid>/` 下,
 *   全机同 uid 的 Reviewer 子进程共用——一批里的一次瞬时失败会让之后每一轮的每一次取证
 *   都以「No usable subagent models remain」被拒,直到过期。指到这次会话的 agentDir 里,
 *   排除表就与会话同生同灭,失败只影响这一批。
 *
 * 子会话与 Reviewer 同模型同凭据同思考档位。pi-subagents 0.65 起前台子代理是 Reviewer
 * 子进程内的原生 `AgentSession`(issue #262,ADR 0021 附记),不再另起 pi 进程;但它的模型
 * 运行时是 pi-subagents 自己按 agentDir 建的一份,读不到本进程 `isolatedPinnedModelRuntime`
 * 里注册的那一项模型,因此仍把同一份运行模型另写一份 `models.json`;凭据写的是环境变量
 * 引用而非明文,子会话与 Reviewer 同一个进程,从同一份环境里取。
 *
 * 前台子会话与父会话同进程带来一道新的扩权口子:pi-subagents 的 intercom 桥默认开着
 * (`intercomBridge.mode: "always"`),会给子会话追加 `contact_supervisor` 工具——它是父子
 * 会话通话用的,不在只读四件套里,能力天花板也拦不住它(它由子会话的运行时钩子注册,
 * 不走 `tools` 允许清单)。两处一起关:`config.json` 把桥关掉,而这份 config 只在扩展注册时
 * 读一次,所以铺装必须在扩展首次加载之前;调用参数又能整份覆盖这份 config,因此
 * `evidenceContractExtension` 在工具边界把覆盖钉死。
 *
 * 子会话的 token 用量不在这里读(issue #260):pi-subagents 把子会话的汇总 Usage 挂在
 * `subagent` 工具返回上,Pi 父会话的 `getSessionStats` 按 toolResult 消息一并累加,
 * Reviewer 的 usage 因此已经含它。本文件只把 transcript 转成审查轨迹的嵌套事件。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { InlineExtension } from "@earendil-works/pi-coding-agent";

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

/**
 * 一个 Reviewer 子进程一次会话的取证次数上限,即每批每模型的总量(ADR 0021)。这是系统
 * 默认值:审查策略里「每批每模型取证上限」没配自定义值时用它(issue #258)。
 */
export const EVIDENCE_SESSION_BUDGET = 3;

/** 单次 `subagent` 调用内部的 fan-out 上限,每次调用重新计数(ADR 0021)。 */
export const EVIDENCE_FANOUT_BUDGET = 8;

const SESSION_BUDGET_ENV = "PI_SUBAGENT_MAX_SPAWNS_PER_SESSION";
const FANOUT_BUDGET_ENV = "PI_SUBAGENT_MAX_SPAWNS_PER_RUN";
const MODEL_EXCLUSIONS_PATH_ENV = "PI_MODEL_EXCLUSIONS_PATH";

/** 天花板的来源标签,打回文案里会带上它,让人看得出是谁挡的。 */
const CEILING_SOURCE = "multireviewer";

/**
 * pi-subagents 能力天花板的进程内登记表(`src/runs/shared/capability-ceiling.ts`):挂在
 * `globalThis[Symbol.for(key)]` 上的 `Map<会话 id, Map<symbol, { source, ceiling }>>`,
 * 键名里带版本号。它设计成全局符号表,就是为了让不同模块实例共用一份——pi-subagents 由
 * Pi 经 jiti 加载,本项目的代码由 Node 原生加载,两边各有一份模块,而 Node 不给
 * node_modules 里的 `.ts` 剥类型,`pi-subagents/capability-ceiling` 这个入口在本进程里
 * 导入不了,只能直接写这张表。0.65 之前走 `PI_SUBAGENT_CAPABILITY_CEILING_V1` 环境变量,
 * 0.65.1 已不读它(issue #262)。
 */
const CEILING_REGISTRY_KEY = "pi-subagents.capability-ceiling.v1";

/** 登记表里的一条:与 pi-subagents `registerSubagentCapabilityCeiling` 写下的逐字同形。 */
type CeilingRegistration = {
  source: string;
  ceiling: {
    version: 1;
    allowedTools: string[];
    allowedAgents: string[];
    denyExtensions: boolean;
    sources: string[];
  };
};

/**
 * 取证子会话的能力天花板。**白名单写死在这里,不从会话的工具面透传**:透传意味着
 * 「Reviewer 现在有哪些工具」变成子代理有哪些工具的判据,而 `report_finding` 与取证工具
 * 本身都在 Reviewer 那一面上——报不报由 Reviewer 裁决,取证只交证据;取证工具不进子代理
 * 的工具面,单层因此是构造出来的,不靠深度计数。
 */
export function evidenceCeiling(): {
  allowedTools: string[];
  allowedAgents: string[];
  denyExtensions: boolean;
} {
  return {
    allowedTools: [...READ_ONLY_TOOLS].sort(),
    allowedAgents: [EVIDENCE_AGENT],
    denyExtensions: true,
  };
}

/**
 * 把取证天花板登记到这个父会话名下。pi-subagents 派出之前按会话 id 查表,把查到的各条
 * 取交集;同一个来源只留一条,重复调用不会叠出第二份。
 */
export function registerEvidenceCeiling(sessionId: string): void {
  const key = Symbol.for(CEILING_REGISTRY_KEY);
  const store = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const existing = store[key];
  const registry: Map<string, Map<symbol, CeilingRegistration>> =
    existing instanceof Map ? existing : new Map();
  if (!(existing instanceof Map)) store[key] = registry;
  const session = registry.get(sessionId) ?? new Map<symbol, CeilingRegistration>();
  registry.set(sessionId, session);
  session.set(Symbol.for(CEILING_SOURCE), {
    source: CEILING_SOURCE,
    ceiling: { version: 1, ...evidenceCeiling(), sources: [CEILING_SOURCE] },
  });
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
async: false
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
 * 把取证子代理铺进这个会话的临时 agentDir,并设好它的几个环境变量。会话上限取本轮运行
 * 计划冻结的那个数,不给即系统默认(issue #258);扇出上限写死;模型排除表指进 agentDir。
 *
 * 调用点是 `prepareAgentRuntime` 的 `installKit`:在主进程的模型运行时建好之后、扩展首次
 * 加载(`resourceLoader.reload()`)之前。前者是 `models.json` 的约束——先写它会反过来盖掉
 * 内存里已经注册好的那一项模型;后者是 `config.json` 的约束(issue #262)——pi-subagents
 * 在扩展注册时读一次 config 并捕获,之后不再读,写晚了 intercom 桥就照默认开着。agent
 * 定义与 `settings.json` 派出取证时现读,放在这里只是同一处铺装。
 */
export function installEvidenceKit(options: {
  agentDir: string;
  runtimeModel: RuntimeModel;
  thinkingLevel: ThinkingLevel;
  rules: readonly ReviewRule[];
  facts: readonly ProjectFact[];
  /** 每批每模型的取证次数上限。不给即 `EVIDENCE_SESSION_BUDGET`。 */
  sessionBudget?: number;
}): void {
  const { agentDir } = options;
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ subagents: { disableBuiltins: true } }, null, 2),
  );
  // 取证一律前台跑(Run 49 实测):异步派单只回一个任务 id,模型轮询不到结果就把同一
  // 主张重跑一遍——双倍花销,而且异步那次的 transcript 不在返回里,过程与用量都进不了
  // 轨迹。三道锁:这份 config 把省参调用的默认改成前台,agent frontmatter 的
  // `async: false` 同义,系统提示再叮嘱一句;显式传 `async: true` 由
  // `evidenceContractExtension` 在工具边界改回来。intercom 桥关掉(issue #262):开着时
  // 子会话会多一个 `contact_supervisor` 工具,超出只读四件套的契约。
  mkdirSync(join(agentDir, "extensions", "subagent"), { recursive: true });
  writeFileSync(
    join(agentDir, "extensions", "subagent", "config.json"),
    JSON.stringify({ asyncByDefault: false, intercomBridge: { mode: "off" } }, null, 2),
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
  process.env[SESSION_BUDGET_ENV] = String(options.sessionBudget ?? EVIDENCE_SESSION_BUDGET);
  process.env[FANOUT_BUDGET_ENV] = String(EVIDENCE_FANOUT_BUDGET);
  process.env[MODEL_EXCLUSIONS_PATH_ENV] = join(agentDir, "model-exclusions.json");
}

/**
 * 取证调用参数里不归模型定的两项(issue #262)。`intercomBridge` 是 pi-subagents 的
 * 逐次覆盖:给了就整份替换 config 里的桥配置,`mode: "always"` 会把 `contact_supervisor`
 * 加回子会话;`async` 决定前台还是后台,后台那次的过程与用量进不了轨迹。
 */
const EVIDENCE_PINNED_PARAMS = { intercomBridge: { mode: "off" }, async: false } as const;

/**
 * 取证契约在工具边界的那一道(issue #262):与 pi-subagents 一起装进 Reviewer 会话的进程内
 * 扩展,在 `subagent` 工具执行之前做两件事——把能力天花板登记到这个会话名下,把调用参数
 * 里的 `intercomBridge` 与 `async` 钉成契约值。改参数而不拒调用:模型要的是证据,给它
 * 证据,只是不按它写的方式派。Pi 的 `tool_call` 钩子对扩展注册的工具同样生效,
 * `event.input` 就地改写后进入执行,这一层不再校验。
 *
 * 天花板挂在这里而不是会话启动时:pi-subagents 派出前按「当前会话 id」查表,而这个 id
 * 在 `tool_call` 的 ctx 里就是它查表用的那一个(有会话文件用文件路径,内存会话用 id),
 * 在派出之前登记就一定查得到。能力天花板管不到另外两项:天花板筛的是 `tools` 允许清单
 * 与 agent 名,而 `contact_supervisor` 由子会话的运行时钩子按桥的开关注册,不经允许清单。
 */
export function evidenceContractExtension(): InlineExtension {
  return {
    name: "multireviewer:evidence-contract",
    factory: (pi) => {
      pi.on("tool_call", (event, ctx) => {
        if (event.toolName !== EVIDENCE_TOOL) return undefined;
        registerEvidenceCeiling(
          ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId(),
        );
        Object.assign(event.input, EVIDENCE_PINNED_PARAMS);
        return undefined;
      });
    },
  };
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
