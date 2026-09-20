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
 * `subagentContractExtension` 在工具边界把覆盖钉死。
 *
 * 子会话的 token 用量不在这里读(issue #260):pi-subagents 把子会话的汇总 Usage 挂在
 * `subagent` 工具返回上,Pi 父会话的 `getSessionStats` 按 toolResult 消息一并累加,
 * Reviewer 的 usage 因此已经含它。本文件只把 transcript 转成审查轨迹的嵌套事件。
 *
 * 铺法本身与取证无关,Agent 会话的子代理(CONTEXT.md 会话子代理,issue #358)用的是同一套:
 * 以 `agent` 名区分的那几样(agent 定义、只读工具扩展、能力天花板放行的名字)作参数,其余
 * 逐字共用。`installSubagentKit` / `subagentCeiling` / `subagentContractExtension` 是共用的那
 * 一层,`installEvidenceKit` 是取证在它上面的那一薄层;会话那一层在 `session-subagent.ts`。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  registerSubagentCapabilityCeiling,
  type SubagentCapabilityCeilingHandle,
} from "pi-subagents/capability-ceiling";

import type { ThinkingLevel } from "../config.ts";
import type { ProjectFact, ReviewerEvent, ReviewRule } from "../review/finding.ts";
import { MODEL_API_KEY_ENV } from "./env.ts";
import { ZERO_MODEL_COST } from "./model-runtime.ts";
import type { RuntimeModel } from "./model-service-runtime.ts";
import { turnContent, turnUsage } from "./trace-events.ts";
import { factBullet, READ_ONLY_TOOLS, ruleBullet } from "./worker-tools.ts";

/** 子代理工具在会话里的名字,由 pi-subagents 注册。取证与会话子代理是同一个工具。 */
export const SUBAGENT_TOOL = "subagent";

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

/**
 * 子会话的只读四件套扩展(issue #328),铺在 agentDir 根上。不放进 `extensions/`:那是
 * 环境扩展的发现目录,放进去会连父会话一起加载。文件名按 agent 名取,同一个 agentDir 里
 * 铺两个 agent 时各是各的一份。
 */
function toolsExtensionFile(agent: string): string {
  return `${agent}-tools.ts`;
}

/** 天花板的来源标签,打回文案里会带上它,让人看得出是谁挡的。 */
const CEILING_SOURCE = "multireviewer";

/**
 * 子会话的能力天花板。**白名单写死在这里,不从会话的工具面透传**:透传意味着「父会话
 * 现在有哪些工具」变成子代理有哪些工具的判据,而 `report_finding` 与子代理工具本身都在
 * 父会话那一面上——报不报由 Reviewer 裁决,取证只交证据;子代理工具不进子代理的工具面,
 * 单层因此是构造出来的,不靠深度计数。
 *
 * `denyExtensions` 关着(issue #328):开着时 pi-subagents 把 agent 定义里的 `extensions`
 * 一并清空,子代理就装不上圈根的四件套,子会话只剩 Pi 内建的 grep / find / ls,绝对
 * 路径与 `~` 随便读。它原本挡的是被审仓库自带 agent 定义里的扩展,现在由工具边界补回:
 * `pinSubagentCall` 把发现范围钉成 `user`(只读 agentDir,仓库的 `.pi/agents` 与
 * `.pi/settings.json` 都不进发现),调用参数只放行派单要用的几项。
 */
export function subagentCeiling(agent: string): {
  allowedTools: string[];
  allowedAgents: string[];
  denyExtensions: boolean;
} {
  return {
    allowedTools: [...READ_ONLY_TOOLS].sort(),
    allowedAgents: [agent],
    denyExtensions: false,
  };
}

/**
 * 已经登记过天花板的父会话。pi-subagents 的登记接口每次调用发一枚新令牌,而登记发生在
 * `subagent` 的每一次调用上(见 `subagentContractExtension`),不记住句柄就会在同一个会话
 * 名下叠出一串同样的条目——判定取的是交集,结果不变,表却越长越大。
 *
 * 句柄的 `dispose()` 没有调用点:两条链路的会话都住在一个只服务它一个会话的子进程里,
 * 会话收尾的下一步就是 `process.exit(0)`,登记表随进程一起消失;`AgentSession.dispose()`
 * 不发 `session_shutdown`,扩展里也钩不到会话结束。为它另铺一条生命周期没有收益。
 */
const ceilingHandles = new Map<string, SubagentCapabilityCeilingHandle>();

/**
 * 把天花板登记到这个父会话名下。pi-subagents 派出之前按会话 id 查表,把查到的各条
 * 取交集;同一个会话只登记一次,重复调用不会叠出第二份。
 */
export function registerSubagentCeiling(sessionId: string, agent: string): void {
  if (ceilingHandles.has(sessionId)) return;
  ceilingHandles.set(
    sessionId,
    registerSubagentCapabilityCeiling({
      sessionId,
      source: CEILING_SOURCE,
      ceiling: subagentCeiling(agent),
    }),
  );
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
 * 都不在其中。`extensions` 指向同批铺装的 `evidence-tools.ts`(相对 agent 文件解析),它用
 * 同名注册把这四个名字换成 Reviewer 那一份实现(issue #328)。`model: inherit` 取父会话那一项模型,`thinking` 与 Reviewer 同档。三个
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
extensions: ../${toolsExtensionFile(EVIDENCE_AGENT)}
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
 * 子会话的工具扩展源码(issue #328)。pi-subagents 建子会话时不带 `customTools`,Pi 的
 * 扩展 `registerTool` 同名注册则盖过内建——四件套因此经扩展进子会话,实现直接 import
 * `worker-tools.ts` 的 `sessionReadOnlyTools`,判根逻辑只有那一份。扩展由 Pi 经 jiti 加载,
 * 本仓库的 `.ts` 它加载得了;圈定的根写死进源码,子会话的 cwd 是什么都不影响它。
 */
export function subagentToolsExtension(worktreePath: string): string {
  const workerTools = fileURLToPath(new URL("./worker-tools.ts", import.meta.url));
  return `import { sessionReadOnlyTools } from ${JSON.stringify(workerTools)};

export default function (pi) {
  for (const tool of sessionReadOnlyTools(${JSON.stringify(worktreePath)})) pi.registerTool(tool);
}
`;
}

/**
 * 把一个子代理铺进这个会话的临时 agentDir,并设好它的两个 spawn 预算环境变量
 * (issue #226、#358)。取证与 Agent 会话的子代理共用这一份:按 agent 名区分的是 agent
 * 定义与它的只读工具扩展,其余几样两条链路逐字相同。
 *
 * 调用点是 `prepareAgentRuntime` 的 `installKit`:在主进程的模型运行时建好之后、扩展首次
 * 加载(`resourceLoader.reload()`)之前。前者是 `models.json` 的约束——先写它会反过来盖掉
 * 内存里已经注册好的那一项模型;后者是 `config.json` 的约束(issue #262)——pi-subagents
 * 在扩展注册时读一次 config 并捕获,之后不再读,写晚了 intercom 桥就照默认开着。agent
 * 定义与 `settings.json` 派出子代理时现读,放在这里只是同一处铺装。
 */
export function installSubagentKit(options: {
  agentDir: string;
  /** 子会话的四件套圈在这里。 */
  root: string;
  runtimeModel: RuntimeModel;
  /** 这个 agent 的名字,决定 agent 定义与工具扩展的文件名。 */
  agent: string;
  /** 这个 agent 的定义文件正文。 */
  definition: string;
  /** 一个子进程一次会话累计派几次。不给即不限。 */
  sessionBudget?: number;
}): void {
  const { agentDir, agent } = options;
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ subagents: { disableBuiltins: true } }, null, 2),
  );
  // 一律前台跑(Run 49 实测):异步派单只回一个任务 id,模型轮询不到结果就把同一
  // 主张重跑一遍——双倍花销,而且异步那次的 transcript 不在返回里,过程与用量都进不了
  // 轨迹。三道锁:这份 config 把省参调用的默认改成前台,agent frontmatter 的
  // `async: false` 同义,系统提示再叮嘱一句;显式传 `async: true` 由
  // `subagentContractExtension` 在工具边界改回来。intercom 桥关掉(issue #262):开着时
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
  writeFileSync(join(agentDir, toolsExtensionFile(agent)), subagentToolsExtension(options.root));
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "agents", `${agent}.md`), options.definition);
  // 不给上限时把这一格删掉而不是留着:环境变量是进程全局的,继承来的值会悄悄限住这一条
  // 链路。pi-subagents 读不到它即不限次数。
  if (options.sessionBudget === undefined) delete process.env[SESSION_BUDGET_ENV];
  else process.env[SESSION_BUDGET_ENV] = String(options.sessionBudget);
  process.env[FANOUT_BUDGET_ENV] = String(EVIDENCE_FANOUT_BUDGET);
}

/**
 * 把取证子代理铺进这个会话的临时 agentDir。会话上限取本轮运行计划冻结的那个数,不给即
 * 系统默认(issue #258);扇出上限写死。
 */
export function installEvidenceKit(options: {
  agentDir: string;
  /** 子会话的四件套圈在这里。 */
  worktreePath: string;
  runtimeModel: RuntimeModel;
  thinkingLevel: ThinkingLevel;
  rules: readonly ReviewRule[];
  facts: readonly ProjectFact[];
  /** 每批每模型的取证次数上限。不给即 `EVIDENCE_SESSION_BUDGET`。 */
  sessionBudget?: number;
}): void {
  installSubagentKit({
    agentDir: options.agentDir,
    root: options.worktreePath,
    runtimeModel: options.runtimeModel,
    agent: EVIDENCE_AGENT,
    definition: evidenceAgentDefinition({
      thinkingLevel: options.thinkingLevel,
      rules: options.rules,
      facts: options.facts,
    }),
    sessionBudget: options.sessionBudget ?? EVIDENCE_SESSION_BUDGET,
  });
}

/**
 * 取证调用参数里不归模型定的两项(issue #262)。`intercomBridge` 是 pi-subagents 的
 * 逐次覆盖:给了就整份替换 config 里的桥配置,`mode: "always"` 会把 `contact_supervisor`
 * 加回子会话;`async` 决定前台还是后台,后台那次的过程与用量进不了轨迹。
 */
const EVIDENCE_PINNED_PARAMS = { intercomBridge: { mode: "off" }, async: false } as const;

/**
 * 取证调用放行的参数(issue #328):派单与超时要用的几项,加上钉死的四项。其余一律剥掉——
 * `action`(能新建或改写 agent 定义)、`workflow` / `workflowScript*`(子任务各自带发现范围与
 * cwd,钉不到)这类入口在关掉 `denyExtensions` 之后都能把仓库里的扩展带进 Reviewer 进程。
 * 放行清单比拦截清单短,pi-subagents 加了新参数也默认不放。
 *
 * 剥掉而不是整次打回(issue #404):模型看得到 pi-subagents 工具的完整 schema,第一次调用
 * 常带上几个清单外的键,打回之后它去掉那几项重试一遍就过——一次往返白花。被剥的键到不了
 * pi-subagents,与打回等价。
 */
const EVIDENCE_CALL_KEYS = new Set([
  "agent",
  "task",
  "tasks",
  "chain",
  "concurrency",
  "timeoutMs",
  "maxRuntimeMs",
  "toolTimeoutMs",
  "agentScope",
  "cwd",
  "intercomBridge",
  "async",
]);

/**
 * `tasks[]` / `chain[]` / `parallel` 每一项放行的键(issue #328):派单要用的几项加标签类。
 * 项里的 `output` 是文件路径,绝对路径原样写盘(pi-subagents `single-output.ts`),只读的取证
 * 会话由此往任意位置写;`reads` 把任意路径读进上下文;`model` 换模型;`skill` / `progress`
 * 也读写文件。与顶层同一个做法:清单外的键剥掉。
 */
const EVIDENCE_TASK_KEYS = new Set(["agent", "task", "cwd", "agentScope", "label", "phase", "as", "count"]);
/** chain 一步在任务项之上多的三项:并行子任务、按上一步产出展开、收集展开结果。 */
const EVIDENCE_STEP_KEYS = new Set([...EVIDENCE_TASK_KEYS, "parallel", "expand", "collect"]);

/** 只留放行清单里的键,剥掉的键名记进 `stripped`。 */
function keepAllowed(
  item: object,
  allowed: ReadonlySet<string>,
  stripped: string[],
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (allowed.has(key)) kept[key] = value;
    else stripped.push(key);
  }
  return kept;
}

/**
 * 给一项钉上工作副本,清单外的键剥掉。不是对象的原样留着,形状错由 pi-subagents 自己报。
 */
function pinItem(
  item: unknown,
  allowed: ReadonlySet<string>,
  worktreePath: string,
  stripped: string[],
): unknown {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
  return { ...keepAllowed(item, allowed, stripped), cwd: worktreePath };
}

/**
 * 一次取证调用钉成契约形状(issue #262、#328、#404)。纯函数:给出钉好的参数,与被剥掉的
 * 那些键名。
 *
 * 钉四项:`intercomBridge` 与 `async` 见上;`agentScope` 钉 `user`,发现只读 agentDir——
 * 默认 `both` 时仓库 `.pi/agents` 里同名的 `evidence.md` 优先,带上 `extensions` 就是在
 * Reviewer 进程里跑仓库的代码;`cwd` 钉工作副本,顶层、`tasks[]` 每项、`chain[]` 每项及其
 * `parallel`(任务数组或单个模板)都钉——cwd 决定项目发现从哪读,也是子会话的工作目录。
 * 顶层与每一项各有放行清单,清单外的键剥掉:调用照常派出,那几项到不了 pi-subagents。
 */
export function pinSubagentCall(
  params: Readonly<Record<string, unknown>>,
  worktreePath: string,
): { params: Record<string, unknown>; stripped: string[] } {
  const stripped: string[] = [];
  const pinned: Record<string, unknown> = {
    ...keepAllowed(params, EVIDENCE_CALL_KEYS, stripped),
    ...EVIDENCE_PINNED_PARAMS,
    agentScope: "user",
    cwd: worktreePath,
  };
  if (Array.isArray(params["tasks"])) {
    pinned["tasks"] = params["tasks"].map((task) =>
      pinItem(task, EVIDENCE_TASK_KEYS, worktreePath, stripped),
    );
  }
  if (Array.isArray(params["chain"])) {
    pinned["chain"] = params["chain"].map((step) => {
      const pinnedStep = pinItem(step, EVIDENCE_STEP_KEYS, worktreePath, stripped);
      const parallel = (step as { parallel?: unknown } | null)?.parallel;
      // 不是对象的那一步原样留着,没有 parallel 的那一步已经钉完。
      if (parallel === undefined || pinnedStep === step) return pinnedStep;
      const items = (Array.isArray(parallel) ? parallel : [parallel]).map((task) =>
        pinItem(task, EVIDENCE_TASK_KEYS, worktreePath, stripped),
      );
      return {
        ...(pinnedStep as object),
        parallel: Array.isArray(parallel) ? items : items[0],
      };
    });
  }
  return { params: pinned, stripped };
}

/**
 * 子代理契约在工具边界的那一道(issue #262、#328、#358):与 pi-subagents 一起装进父会话的
 * 进程内扩展,在 `subagent` 工具执行之前做两件事——把能力天花板登记到这个会话名下,把调用
 * 参数按 `pinSubagentCall` 钉成契约形状。能派的一律改参数而不拒调用(issue #404):模型要的是
 * 证据,给它证据,只是不按它写的方式派;放行清单外的参数剥掉就好,到不了 pi-subagents。
 * Pi 的 `tool_call` 钩子对扩展注册的工具同样生效,`event.input` 就地改写后进入执行,
 * 这一层不再校验。被剥的键在审查轨迹上照样看得见:轨迹记的 `args` 取自
 * `tool_execution_start`,而那一帧带的是模型写下的原始参数,在这道钩子之前就发出去了。
 *
 * 天花板挂在这里而不是会话启动时:pi-subagents 派出前按「当前会话 id」查表,而这个 id
 * 在 `tool_call` 的 ctx 里就是它查表用的那一个(有会话文件用文件路径,内存会话用 id),
 * 在派出之前登记就一定查得到。能力天花板管不到另外两项:天花板筛的是 `tools` 允许清单
 * 与 agent 名,而 `contact_supervisor` 由子会话的运行时钩子按桥的开关注册,不经允许清单。
 */
export function subagentContractExtension(
  worktreePath: string,
  agent: string,
): InlineExtension {
  return {
    name: "multireviewer:subagent-contract",
    factory: (pi) => {
      pi.on("tool_call", (event, ctx) => {
        if (event.toolName !== SUBAGENT_TOOL) return undefined;
        const input = event.input as Record<string, unknown>;
        const pinned = pinSubagentCall(input, worktreePath);
        // 剥完没有可派的东西(模型拿 `action: "list"` 之类探能力,issue #404 线上验收):交给
        // pi-subagents 只会得到一句通用的形状报错,模型看不出错在哪。这一档在这里指路。
        if (!["agent", "tasks", "chain"].some((key) => key in pinned.params)) {
          return {
            block: true,
            reason: `subagent has no ${pinned.stripped.join(", ") || "management"} action here; call it with agent "${agent}" and task`,
          };
        }
        registerSubagentCeiling(
          ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId(),
          agent,
        );
        for (const key of Object.keys(input)) delete input[key];
        Object.assign(input, pinned.params);
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
  /** 这一回合的停止原因、错误原文与用量(issue #407)。pi-subagents 取得到才写。 */
  stopReason?: unknown;
  errorMessage?: unknown;
  usage?: unknown;
  /** 这条消息原样那一份。内容构成从它的 `content` 数。 */
  message?: unknown;
};

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
        // 与外层同律,每个回合都落一条(issue #407):子会话同样会读完工具结果就无声
        // 结束。transcript 取得到多少记多少——`text` 空着时 pi-subagents 不写那一格。
        const usage = turnUsage(record.usage);
        const content = (record.message as { content?: unknown } | null)?.content;
        events.push({
          kind: "assistant_message",
          text: typeof record.text === "string" ? record.text : "",
          ...(typeof record.stopReason === "string" ? { stopReason: record.stopReason } : {}),
          ...(typeof record.errorMessage === "string" && record.errorMessage !== ""
            ? { error: record.errorMessage }
            : {}),
          content: turnContent(content),
          ...(usage === undefined ? {} : { usage }),
        });
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
 * 一份子会话 transcript 文件转成事件序列(issue #227、#358)。读不到就回空数组:少一段
 * 嵌套过程是小事,一次子代理因此白跑不是。
 */
export function subagentTranscriptEvents(path: string): ReviewerEvent[] {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return transcriptEvents(content.split("\n"));
}

/** 一次取证调用的子会话事件(issue #227)。一次调用可能派出几个子任务,按顺序接起来。 */
export function evidenceTranscriptEvents(result: unknown): ReviewerEvent[] {
  return transcriptPaths(result).flatMap(subagentTranscriptEvents);
}
