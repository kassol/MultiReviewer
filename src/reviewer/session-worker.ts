/**
 * Agent 会话的常驻子进程入口(issue #333)。
 *
 * 与另三个 worker 的差别只有一处:它不跑完一次 prompt 就退出。收到 `open` 之后建一个 Pi
 * 会话并留在进程里,之后每收一条 `prompt` 就在同一个会话上跑一个回合,跑完回一条「回合
 * 结束」再等下一条。会话记录挂 `message_end` 与 `compaction_end` 的镜像原样回传主进程
 * (ADR 0031),落库、用量累加与广播都在那一侧——这一侧只订阅并转发,不做判断(ADR 0017)。
 *
 * 工具面全部圈在会话根上:`read` 沿用带号读那一份,`grep` / `find` / `ls` 覆盖 Pi 内建并在
 * 执行前判一次根(Pi 内建三者不查根,issue #328),受控 git 按路径前缀选工作树。不注册
 * bash / edit / write。
 */
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import {
  type AgentSession,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { MODEL_API_KEY_ENV, redactModelCredential } from "./env.ts";
import { GIT_TOOL, sessionGitTool } from "./git-tool.ts";
import { sessionOutputTools } from "./session-output-tools.ts";
import {
  AGENT_SESSION_NOTE_CUSTOM_TYPE,
  type OpenSessionRequest,
  type SessionCommand,
  type SessionWorkerMessage,
} from "./session-protocol.ts";
import {
  READ_ONLY_TOOLS,
  factBullet,
  numberedReadTool,
  openAgentSession,
  prepareAgentRuntime,
  ruleBullet,
  sessionThinkingLevel,
} from "./worker-tools.ts";

function send(message: SessionWorkerMessage): void {
  process.send?.(message);
}

/**
 * 这个路径出不出会话根。
 *
 * 先按词法判:绝对路径与含 `..` 的路径在这一步就拒。再按 realpath 判一次——仓库里可以提交
 * 一个指向圈外的符号链接,词法上它就在根里面。解析不出来的路径(不存在)按词法那一判的
 * 结论放行,让工具自己说「路径不存在」:把写错的路径说成出根只会让模型改错地方。
 */
export function outsideSessionRoot(sessionRoot: string, path: string): boolean {
  const root = realpathSync(resolve(sessionRoot));
  const contains = (candidate: string): boolean =>
    candidate === root || candidate.startsWith(root + sep);
  const lexical = resolve(root, path);
  if (!contains(lexical)) return true;
  try {
    return !contains(realpathSync(lexical));
  } catch {
    return false;
  }
}

/**
 * 把 Pi 的一个内建工具定义圈在会话根上:执行之前判一次 `path` 参数,出根当场打回。
 *
 * 同名覆盖内建(与 `numberedReadTool` 同做法),schema 与措辞因此一个字不改,模型的使用
 * 习惯不变。打回走抛错而不是正常返回:出根不是「换个参数再试」的摩擦,而是这个会话读不到
 * 的东西,该让它在工具结果里看到错误。
 */
export function rootedTool(
  sessionRoot: string,
  definition: ToolDefinition<never, never>,
): ToolDefinition<never, never> {
  return {
    ...definition,
    execute: async (id, params, signal, onUpdate, ctx) => {
      const path = (params as { path?: unknown } | null)?.path;
      if (typeof path === "string" && outsideSessionRoot(sessionRoot, path)) {
        throw new Error(
          `cannot use ${path}: every path stays inside the session root, one directory per repository`,
        );
      }
      return definition.execute(id, params, signal, onUpdate, ctx);
    },
  };
}

/** 会话根上的四个只读工具。`read` 是带号读那一份,其余三个是圈过根的内建。 */
export function sessionReadOnlyTools(sessionRoot: string): ToolDefinition<never, never>[] {
  const builtins = [
    createGrepToolDefinition(sessionRoot),
    createFindToolDefinition(sessionRoot),
    createLsToolDefinition(sessionRoot),
  ] as unknown as ToolDefinition<never, never>[];
  return [
    numberedReadTool(sessionRoot) as unknown as ToolDefinition<never, never>,
    ...builtins.map((definition) => rootedTool(sessionRoot, definition)),
  ];
}

/** 这次会话注册的工具清单:只读四件套加受控 git。写工具与 bash 一个都不在。 */
export function sessionTools(): string[] {
  return [...READ_ONLY_TOOLS, GIT_TOOL];
}

/**
 * 会话的系统提示(issue #333)。这是底座那一份:会话是什么、工作区长什么样、工具面到哪里
 * 为止、各仓库的知识集。用途自己那一份提示随用途的 spec 接入,这里只把用途名写成一行。
 */
export function sessionSystemPrompt(request: OpenSessionRequest): string {
  const repos = request.repos.map((repo) => `${repo.owner}/${repo.repo}`);
  const sections = [
    "You are a senior engineer in a continuing conversation with one person about one product. The conversation spans many turns: answer what is asked, say what you are unsure about, and ask when the answer changes what you would do.",
    `This session's purpose: ${request.purpose}.`,
    "",
    "## The workspace",
    "",
    "The working directory is the session root. Each repository of this product is checked out in a directory named <owner>/<repo> directly under it, at the latest commit of its default branch:",
    "",
    ...repos.map((repo) => `- ${repo}`),
    "",
    "Every path you pass to read, grep, find and ls stays inside the session root — an absolute path outside it, or a path that climbs out with .., is refused. The git tool reads one repository per call: every path argument starts with the <owner>/<repo>/ prefix, and that prefix picks the repository.",
    "",
    "Your tools are read-only. You cannot edit files, write files or run shell commands. Read the code before you claim anything about it: the repositories above are the evidence.",
  ];
  for (const repo of request.repos) {
    if (repo.rules.length === 0 && repo.facts.length === 0) continue;
    sections.push("", `## What ${repo.owner}/${repo.repo} has agreed on`);
    if (repo.rules.length > 0) {
      sections.push(
        "",
        "Review rules. They tell you what this repository holds its code to, so you know which details matter. Each rule is listed with its id in brackets and the paths it applies to in parentheses.",
        "",
        ...repo.rules.map(ruleBullet),
      );
    }
    if (repo.facts.length > 0) {
      sections.push(
        "",
        "Project facts: statements about how this codebase, its architecture and its environment actually are. Use them as grounds for judgement — they tell you what you would otherwise have to assume or verify yourself. When the code contradicts a fact, the code wins: say what you read and that the fact no longer holds.",
        "",
        ...repo.facts.map(factBullet),
      );
    }
  }
  return sections.join("\n");
}

/** 这个子进程的会话。`open` 之前是 undefined,之后一直是同一个。 */
let session: AgentSession | undefined;
/** 已经回传过的条目数。镜像按它取新增的那一段。 */
let mirrored = 0;
/** 会话建好之前到的那几条自定义消息(issue #337),建好之后按顺序放进去。 */
const pendingNotes: string[] = [];
let apiKey = "";

/**
 * 把新增的条目回传主进程。
 *
 * Pi 的落盘发生在事件通知**之后**(`message_end` 的监听器里读不到刚写的条目),因此镜像
 * 排到下一个 tick 再读:那时条目已经在会话记录里。`entry_appended` 只为 custom 条目发出,
 * 靠不住,镜像挂的是 `message_end` 与 `compaction_end`(ADR 0031)。
 */
function mirrorEntries(): void {
  if (session === undefined) return;
  const entries = session.sessionManager.getEntries();
  if (entries.length <= mirrored) return;
  send({ kind: "entries", entries: entries.slice(mirrored) });
  mirrored = entries.length;
}

async function open(request: OpenSessionRequest): Promise<void> {
  const thinkingLevel = sessionThinkingLevel(
    request.runtimeModel.reasoning,
    request.thinkingLevel,
  );
  const prepared = await prepareAgentRuntime({
    agentDirPrefix: "multireviewer-agent-session-",
    worktreePath: request.sessionRoot,
    runtimeModel: request.runtimeModel,
    systemPrompt: sessionSystemPrompt(request),
  });
  if ("failure" in prepared) {
    send({ kind: "failed", failure: prepared.failure });
    return;
  }
  apiKey = prepared.apiKey;

  const repos = request.repos.map((repo) => `${repo.owner}/${repo.repo}`);
  // 这个用途的产出工具(issue #337)。清单与定义取同一份:工具名在 `tools` 里没有那一行,
  // Pi 就不把它交给模型,两处各写一遍迟早对不上。
  const outputTools = sessionOutputTools(request.purpose, { repos, send });
  session = await openAgentSession({
    runtime: prepared,
    worktreePath: request.sessionRoot,
    thinkingLevel,
    tools: [...sessionTools(), ...outputTools.map((tool) => tool.name)],
    customTools: [
      ...(sessionReadOnlyTools(request.sessionRoot) as unknown as ToolDefinition[]),
      sessionGitTool(request.sessionRoot, repos),
      ...(outputTools as unknown as ToolDefinition[]),
    ],
    send,
    onEvent: (event) => {
      // 只订阅并转发。条目在通知之后才落进会话记录,镜像因此排到下一个 tick。
      if (event.type === "message_end" || event.type === "compaction_end") {
        setImmediate(mirrorEntries);
      }
    },
  });
  send({ kind: "ready" });
  for (const note of pendingNotes.splice(0)) await customMessage(note);
}

async function prompt(text: string): Promise<void> {
  if (session === undefined) {
    send({ kind: "turn-end", failure: "会话还没建好" });
    return;
  }
  let thrown: string | undefined;
  try {
    await session.prompt(text);
  } catch (error) {
    thrown = String(error instanceof Error ? error.message : error);
  }
  // `prompt()` 在模型调用失败时也正常返回,失败只在会话状态里可见。
  const failure = thrown ?? session.agent.state.errorMessage;
  // 回合的最后一条条目可能还没镜像出去:收尾前补一次,再报回合结束。
  mirrorEntries();
  send({
    kind: "turn-end",
    ...(failure === undefined
      ? {}
      : { failure: redactModelCredential(failure, apiKey) }),
  });
}

/**
 * 放一条进模型上下文的自定义消息(issue #337)。定稿与换版走它:`triggerTurn: false` 即不开
 * 新回合——执行中它排到回合边界再落进会话,空闲时当场落进去。两条路都发 `message_end`,
 * 落库因此仍由镜像那一条路完成,与别的条目同形。
 */
async function customMessage(text: string): Promise<void> {
  // 会话还没建好就先攒着:备会话根要把每个仓库检出一遍,那段时间里人点得动定稿。丢掉这一条
  // 它既不进上下文也不进记录表,而主进程已经按「子进程在」把它交给了这一侧。
  if (session === undefined) {
    pendingNotes.push(text);
    return;
  }
  await session.sendCustomMessage(
    { customType: AGENT_SESSION_NOTE_CUSTOM_TYPE, content: text, display: true },
    { triggerTurn: false },
  );
}

process.on("message", (command: SessionCommand) => {
  const run =
    command.kind === "open"
      ? open(command.request)
      : command.kind === "custom-message"
        ? customMessage(command.text)
        : prompt(command.text);
  run.catch((error: unknown) => {
    const failure = redactModelCredential(
      String(error instanceof Error ? error.message : error),
      process.env[MODEL_API_KEY_ENV],
    );
    if (command.kind === "open") return send({ kind: "failed", failure });
    // 放一条自定义消息失败不动会话状态:回合可能还在跑,报「回合结束」会让主进程以为它空了,
    // 下一条消息就会与在跑的这一轮撞上。
    if (command.kind === "custom-message") {
      console.error(`[session-worker] 自定义消息没放进会话:${failure}`);
      return;
    }
    send({ kind: "turn-end", failure });
  });
});
