/**
 * 会话子代理(CONTEXT.md 会话子代理,issue #358)。
 *
 * Agent 会话里的 agent 可以派只读子代理进会话根深读一段代码。执行体与铺法与取证子代理是
 * 同一套(`evidence.ts` 的 `installSubagentKit`):vendor 进镜像的 pi-subagents、同一份只读
 * 四件套扩展、同一道能力天花板与同一道工具边界契约,差的只是 agent 名与它的定义正文——
 * 取证核的是一条因果主张,会话子代理答的是人在对话里问出来的一个问题。圈定的根因此不是
 * 某一个仓库的工作副本,而是整个会话根:一个问题常常横跨这个产品的几个仓库。
 *
 * 会话子代理不设会话总量上限:取证是每批每模型的定向动作,一批派太多次就是在滥派;会话
 * 按天续谈、人就在对面看着,派几次由对话本身决定。扇出上限仍写死。
 *
 * 一次派单的过程要留在会话记录里(ADR 0031):pi-subagents 把子会话的每一步写进 transcript
 * 文件,而那个文件随子进程的临时目录消失,重建时读不回来。子进程因此在 `tool_execution_end`
 * 当场把它读成 `SessionSubagentRun`,落成一条 custom 条目——面板的嵌套卡片、以及回收重启
 * 之后的重建,读的都是这一条。
 */
import type { ThinkingLevel } from "../config.ts";
import {
  installSubagentKit,
  subagentTranscriptEvents,
  SUBAGENT_TOOL,
} from "./evidence.ts";
import type { RuntimeModel } from "./model-service-runtime.ts";
import { READ_ONLY_TOOLS } from "./worker-tools.ts";

export { SUBAGENT_TOOL };

/** 会话里唯一的自定义子代理。内置 agent 全部禁用,能力天花板也只放行这一个名字。 */
export const SESSION_SUBAGENT_AGENT = "explore";

/** 一次派单里一个子代理跑的那一趟,落进会话记录、也走瞬时帧。 */
export type SessionSubagentRun = {
  /** 派给它的那句任务。 */
  task: string;
  /** 在跑、跑完、跑挂。 */
  status: "running" | "done" | "failed";
  /** 它调了几次工具。 */
  steps: number;
  /** 逐次工具调用,与父会话的工具行同形(动词 + 对象由面板翻)。在跑时是空的。 */
  calls: readonly { name: string; args: unknown; error?: string }[];
  /** 它交回来的那段结论。在跑时是空串。 */
  conclusion: string;
};

/**
 * 会话子代理的定义文件。frontmatter 的每一格与取证那一份同义,见 `evidence.ts` 的说明:
 * `tools` 是严格允许清单(子代理工具本身不在其中,单层因此是构造出来的),`extensions`
 * 指向同批铺装的只读四件套,`model: inherit` 与父会话同模型,三个 `inherit*: false` 让它
 * 不吃仓库工作树里的 `AGENTS.md` 与技能目录——那是被读仓库的内容,半可信。
 */
export function sessionSubagentDefinition(options: {
  thinkingLevel: ThinkingLevel;
  /** 会话根下的仓库目录名(`<owner>/<repo>`)。 */
  repos: readonly string[];
}): string {
  return `---
name: ${SESSION_SUBAGENT_AGENT}
description: Read-only investigation of one question about this product's repositories. Give it a single question to answer; it reads the code and comes back with file:line evidence.
tools: ${READ_ONLY_TOOLS.join(", ")}
extensions: ../${SESSION_SUBAGENT_AGENT}-tools.ts
async: false
model: inherit
thinking: ${options.thinkingLevel}
systemPromptMode: replace
inheritProjectContext: false
inheritGlobalContext: false
inheritSkills: false
allowNestedSubagents: false
acceptance: { level: "none", reason: "investigation report, not a deliverable" }
---

You answer one question about this product's code by reading it, and you report what you found. The engineer who sent you is in a conversation with a person; your report is what they answer from.

The working directory is the session root. Each repository of this product is checked out in a directory named <owner>/<repo> directly under it:

${options.repos.map((repo) => `- ${repo}`).join("\n")}

Read as widely as the question requires: callers, callees, sibling branches, configuration, and the other repositories above. Your reading radius is the whole session root. Every path you pass to read, grep, find and ls stays inside it — an absolute path outside it, or a path that climbs out with .., is refused.

Answer with evidence, not with impressions. Every statement you make about the code must name the file and the line you read it on, written as \`<owner>/<repo>/path/to/file.ts:42\`. When you could not settle the question, say exactly what you looked at and what is still missing — an honest "not established" is worth more than a guess.

Keep the report short. What is needed is the answer and the lines it rests on, not a tour of the repositories.

Write the report and everything you say in Chinese. Keep identifiers, file paths and code fragments in their original form.
`;
}

/**
 * 把会话子代理铺进这个会话的临时 agentDir。调用点是 `prepareAgentRuntime` 的 `installKit`,
 * 时机的两道约束见 `installSubagentKit`。
 */
export function installSessionSubagentKit(options: {
  agentDir: string;
  /** 子会话的四件套圈在这里:整个会话根。 */
  sessionRoot: string;
  runtimeModel: RuntimeModel;
  thinkingLevel: ThinkingLevel;
  repos: readonly string[];
}): void {
  installSubagentKit({
    agentDir: options.agentDir,
    root: options.sessionRoot,
    runtimeModel: options.runtimeModel,
    agent: SESSION_SUBAGENT_AGENT,
    definition: sessionSubagentDefinition({
      thinkingLevel: options.thinkingLevel,
      repos: options.repos,
    }),
  });
}

/**
 * 一次派单派出去的那几句任务(issue #358)。**任务只有调用参数里有**:pi-subagents 在返回
 * 之前把 `results[].task` 换成 `[prompt redacted]`,读它拿不到人话。按下标与 `results` 对位。
 */
export function subagentTasks(args: unknown): string[] {
  const call = (args ?? {}) as { task?: unknown; tasks?: unknown };
  if (Array.isArray(call.tasks)) {
    return call.tasks.map((one: unknown) => str((one as { task?: unknown } | null)?.task));
  }
  return [str(call.task)];
}

/** pi-subagents 挂在工具返回(或流式快照)上的每个子任务。只认下面用到的那几个字段。 */
type RunSummary = {
  index?: unknown;
  error?: unknown;
  exitCode?: unknown;
  finalOutput?: unknown;
  transcriptPath?: unknown;
  progress?: { toolCount?: unknown } | null;
};

function summaries(payload: unknown): RunSummary[] {
  const details = (payload as { details?: unknown } | null)?.details;
  const results = (details as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? (results as RunSummary[]) : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 一次 `subagent` 调用的结果转成派出去的那几趟(issue #358)。并行派单一次调用几趟,
 * 因此恒回数组;认不出形状就回空数组——记不下过程是小事,一次派单因此白跑不是。
 *
 * `running` 是流式快照那一档(`tool_execution_update`):那时只有任务与已经调过几次工具,
 * 工具调用与结论要等 transcript 落完才读得到。
 */
export function sessionSubagentRuns(
  payload: unknown,
  options: { running: boolean; tasks: readonly string[] },
): SessionSubagentRun[] {
  return summaries(payload).map((summary, position) => {
    const index = typeof summary.index === "number" ? summary.index : position;
    const task = options.tasks[index] ?? "";
    if (options.running) {
      const toolCount = summary.progress?.toolCount;
      return {
        task,
        status: "running" as const,
        steps: typeof toolCount === "number" ? toolCount : 0,
        calls: [],
        conclusion: "",
      };
    }
    const failure = str(summary.error);
    const calls = subagentTranscriptEvents(str(summary.transcriptPath)).flatMap((event) =>
      event.kind === "tool_call"
        ? [
            {
              name: event.tool,
              args: event.args,
              ...(event.isError ? { error: event.error ?? "" } : {}),
            },
          ]
        : [],
    );
    return {
      task,
      status: failure !== "" || summary.exitCode !== 0 ? ("failed" as const) : ("done" as const),
      steps: calls.length,
      calls,
      conclusion: str(summary.finalOutput) || failure,
    };
  });
}
