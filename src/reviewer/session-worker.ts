/**
 * Agent 会话的常驻子进程入口(issue #333)。
 *
 * 与另三个 worker 的差别只有一处:它不跑完一次 prompt 就退出。收到 `open` 之后建一个 Pi
 * 会话并留在进程里,之后每收一条 `prompt` 就在同一个会话上跑一个回合,跑完回一条「回合
 * 结束」再等下一条;执行中收到的那些按模式进 Pi 的插话 / 排队队列,停止只中止当前这一步
 * (issue #334)。会话记录挂 `message_end` 与 `compaction_end` 的镜像原样回传主进程
 * (ADR 0031),落库、用量累加与广播都在那一侧——这一侧只订阅并转发,不做判断(ADR 0017)。
 * 流式 delta 与工具开始也只转发,合并成瞬时帧在主进程。
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
import {
  QUERY_FINDINGS_TOOL,
  resolveFindingQuery,
  sessionFindingTool,
} from "./session-finding-tool.ts";
import {
  inflateImageRefs,
  readAgentSessionImages,
  type AgentSessionImageRef,
} from "./session-images.ts";
import { sessionOutputTools } from "./session-output-tools.ts";
import { purposeSystemPrompt } from "./session-purposes.ts";
import {
  AGENT_SESSION_NOTE_CUSTOM_TYPE,
  SYSTEM_MESSAGE_ENTRY,
  type AgentSessionMessageMode,
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

/**
 * 这次会话注册的工具清单:只读四件套、受控 git,加历史 Finding 查询(issue #338)。写工具
 * 与 bash 一个都不在。
 */
export function sessionTools(): string[] {
  return [...READ_ONLY_TOOLS, GIT_TOOL, QUERY_FINDINGS_TOOL];
}

/**
 * 会话的系统提示(issue #333)。先是底座那一份:会话是什么、工作区长什么样、工具面到哪里
 * 为止、各仓库的知识集;末尾接用途自己那一段(`session-purposes.ts`,issue #338)。
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
    "",
    `The ${QUERY_FINDINGS_TOOL} tool reads what earlier review rounds reported on one of these repositories: ask it about the part of the code you are about to speak of, and you see what has already gone wrong there.`,
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
  const purpose = purposeSystemPrompt(request.purpose);
  if (purpose !== undefined) sections.push("", purpose);
  return sections.join("\n");
}

/** 人点停止留在会话记录里的那一句。 */
const STOPPED_BY_PERSON = "人点了停止:已中止当前这一步,排队的消息保留,下次开跑时投递。";

/** 这个子进程的会话。`open` 之前是 undefined,之后一直是同一个。 */
let session: AgentSession | undefined;
/** 已经回传过的条目数。镜像按它取新增的那一段。 */
let mirrored = 0;
/** 会话建好之前到的那几条自定义消息(issue #337),建好之后按顺序放进去。 */
const pendingNotes: string[] = [];
let apiKey = "";
/**
 * 这个会话此刻在不在跑。Pi 自己的 `isStreaming` 不够用:`prompt()` 在真正开跑之前还有几个
 * await(扩展事件、凭据校验),那一小段里它仍是 false,紧跟着到的第二条消息会因此另起一个
 * 并发的回合。这一格在收到指令时同步置上,窗口因此不存在。
 */
let running = false;
/** 人点过停止。被中止的那一回合不算失败:停止是人的动作,不是这一轮跑坏了。 */
let stopped = false;
/** 正在处理停止:这期间 Pi 的队列被清空,那一次 `queue_update` 不回传(队列由主进程留存)。 */
let stopping = false;

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
    // 常驻会话开自动 compaction(spec #329):它按天续谈,不压就会撞上上下文上限。
    compaction: true,
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
  // 喂回去的那一段已经在记录表里,镜像的起点因此是它的长度——从 0 起会把整段历史再落一遍。
  // 置在建会话之前:建会话本身会追加「这次用哪个模型、哪个思考档位」两条,它们要镜像出去。
  mirrored = request.entries?.length ?? 0;
  session = await openAgentSession({
    runtime: prepared,
    worktreePath: request.sessionRoot,
    thinkingLevel,
    // 记录里的图片是文件引用(issue #336),喂回 Pi 之前读文件填回 base64:文件丢了那一块
    // 换成占位文本,丢一张图不该让整段历史重建不起来。读文件在这一侧,base64 因此不过 IPC。
    ...(request.entries === undefined ? {} : { entries: inflateImageRefs(request.entries) }),
    tools: [...sessionTools(), ...outputTools.map((tool) => tool.name)],
    customTools: [
      ...(sessionReadOnlyTools(request.sessionRoot) as unknown as ToolDefinition[]),
      sessionGitTool(request.sessionRoot, repos),
      sessionFindingTool({ repos, send }) as unknown as ToolDefinition,
      ...(outputTools as unknown as ToolDefinition[]),
    ],
    send,
    onEvent: (event) => {
      // 只订阅并转发。条目在通知之后才落进会话记录,镜像因此排到下一个 tick。
      if (event.type === "message_end" || event.type === "compaction_end") {
        setImmediate(mirrorEntries);
      }
      // 流式帧:正在生成的文字与正在跑的工具各一档,合并与广播都在主进程(issue #334)。
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        send({ kind: "delta", text: event.assistantMessageEvent.delta });
      }
      if (event.type === "tool_execution_start") {
        send({ kind: "tool", tool: event.toolName });
      }
      // 停止时清队列那一次不回传:那几条由主进程留存,下次开跑时投递。
      if (event.type === "queue_update" && !stopping) {
        send({ kind: "queue", steering: event.steering, followUp: event.followUp });
      }
    },
  });
  send({ kind: "ready" });
  for (const note of pendingNotes.splice(0)) await customMessage(note);
}

/**
 * 跑一条消息。
 *
 * 空闲时这一条立刻开跑;执行中按模式进 Pi 的队列——`steer` 在下一个回合边界被消费、不打断
 * 正在跑的工具批次,`followUp` 等 agent 本来要停的那一刻才投。两种队列都由 Pi 的 agent loop
 * 在同一次运行里排空,`prompt()` 因此要到 Pi 真正空闲(`agent_end` 且两条队列都空)才兑现
 * ——**它返回就是这一个回合结束**,排队与插话投出去的那几轮都在它里面。
 *
 * 用 `steer()` / `followUp()` 而不是带 `streamingBehavior` 的 `prompt()`:后者按 Pi 自己的
 * `isStreaming` 分流,那一格在开跑前的几个 await 里还是 false,会另起一个并发的回合。
 *
 * 图片在这里才读成 base64(issue #336):主进程只经 IPC 给了路径。Pi 把它们放进这条用户消息
 * 的内容块里,镜像回去的条目因此带 base64——主进程落库前换回文件引用。
 */
async function prompt(
  text: string,
  mode: AgentSessionMessageMode,
  imageRefs: readonly AgentSessionImageRef[],
): Promise<void> {
  if (session === undefined) {
    send({ kind: "turn-end", failure: "会话还没建好" });
    return;
  }
  // 一张图都没带时不给这一格:空数组与「没有图片」在 Pi 那边不必同义。
  const read = readAgentSessionImages(imageRefs);
  const images = read.length === 0 ? undefined : read;
  if (running) {
    if (mode === "steer") await session.steer(text, images);
    else await session.followUp(text, images);
    return;
  }
  running = true;
  let thrown: string | undefined;
  try {
    await session.prompt(text, images === undefined ? undefined : { images });
  } catch (error) {
    thrown = String(error instanceof Error ? error.message : error);
  }
  // 紧跟着置回:`prompt()` 兑现与这一行之间没有宏任务,晚到的插话因此不会落进一条没人
  // 消费的队列——Pi 只在一次运行里排空队列。
  running = false;
  // `prompt()` 在模型调用失败时也正常返回,失败只在会话状态里可见。人点停止那一次不算失败。
  const failure = stopped ? undefined : thrown ?? session.agent.state.errorMessage;
  stopped = false;
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

/**
 * 停止:只中止当前这一步。
 *
 * 先清 Pi 的队列再 abort,顺序要紧:abort 之后 Pi 会接着把队列排空(`continue()` 在末条是
 * assistant 时就从队列取),不清的话「停止」会立刻把排队的消息投出去。排队消息因此留在主
 * 进程的镜像里,下次开跑时一并投递。被中止的回复条目由 Pi 照常落下,人点停止另以 custom
 * 条目落同一张表(ADR 0031),不进模型上下文。
 */
async function stop(): Promise<void> {
  if (session === undefined || !running) return;
  stopped = true;
  stopping = true;
  try {
    session.clearQueue();
    await session.abort();
  } finally {
    stopping = false;
  }
  session.sessionManager.appendCustomEntry(SYSTEM_MESSAGE_ENTRY, { text: STOPPED_BY_PERSON });
  mirrorEntries();
}

/**
 * 服务在排空(issue #335):中止当前这一步,再退出。
 *
 * 与人点停止的差别只有两处:不落那条系统消息(「被排空中止」由主进程落库——这个进程正
 * 要没了,再等一次镜像往返只是赌时序),以及跑完就 `process.exit(0)`。被中止的回复仍由
 * Pi 照常落下,收尾前补一次镜像把它送出去;排队的消息由主进程落库,重启后惰性重建时投递。
 *
 * 显式退出:`dispose()` 之后 Pi 仍可能留着未关的 handle,IPC 通道本身也让事件循环活着,
 * 进程不会自己结束,排空就要一直等到宽限期满(与 `runAgentWorker` 同一条理由)。
 */
async function drain(): Promise<void> {
  if (session !== undefined && running) {
    stopped = true;
    stopping = true;
    try {
      session.clearQueue();
      await session.abort();
    } finally {
      stopping = false;
    }
    mirrorEntries();
  }
  process.exit(0);
}

/** 整队清空。Pi 只给这一个动作,单条撤回它不支持。 */
function clearQueue(): void {
  session?.clearQueue();
}

function handle(command: SessionCommand): Promise<void> {
  switch (command.kind) {
    case "open":
      return open(command.request);
    case "prompt":
      return prompt(command.text, command.mode, command.images ?? []);
    case "custom-message":
      return customMessage(command.text);
    case "stop":
      return stop();
    case "drain":
      return drain();
    case "clear-queue":
      clearQueue();
      return Promise.resolve();
    case "finding-query-result": {
      // 历史 Finding 查询的回应(issue #338):兑现等着的那次工具调用,没有别的事要做。
      const { findings, failure } = command;
      resolveFindingQuery(command.requestId, {
        findings,
        ...(failure === undefined ? {} : { failure }),
      });
      return Promise.resolve();
    }
  }
}

process.on("message", (command: SessionCommand) => {
  handle(command).catch((error: unknown) => {
    const failure = redactModelCredential(
      String(error instanceof Error ? error.message : error),
      process.env[MODEL_API_KEY_ENV],
    );
    // 会话建不起来是这个子进程的终局;一个回合跑坏了只报这一回合。放自定义消息、停止与清空
    // 队列不报回合结束:那会把一个还在跑的会话说成空闲,下一条消息就会与在跑的这一轮撞上。
    if (command.kind === "open") send({ kind: "failed", failure });
    else if (command.kind === "prompt") send({ kind: "turn-end", failure });
    else console.error(`[agent-session] ${command.kind} 没做成:${failure}`);
  });
});
