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
 * 工具面全部圈在会话根上:只读四件套是 `worker-tools.ts` 的 `sessionReadOnlyTools`(与另
 * 三个 worker 同一份,issue #328),受控 git 按路径前缀选工作树。不注册 bash / edit / write。
 * 会话子代理(`session-subagent.ts`,issue #358)也在这一面上:铺装与取证共用一套,子会话
 * 的工具面同样是圈在会话根上的那四件,一次派单跑完当场落成一条会话记录。
 */
import { type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { MODEL_API_KEY_ENV, redactModelCredential } from "./env.ts";
import { subagentContractExtension, vendoredSubagentsPath } from "./evidence.ts";
import { GIT_TOOL, sessionGitTool } from "./git-tool.ts";
import {
  QUERY_FINDINGS_TOOL,
  resolveFindingQuery,
  sessionFindingTool,
} from "./session-finding-tool.ts";
import {
  QUERY_KNOWLEDGE_TOOL,
  resolveKnowledgeQuery,
  sessionKnowledgeTool,
} from "./session-knowledge-tool.ts";
import {
  inflateImageRefs,
  readAgentSessionImages,
  type AgentSessionImageRef,
} from "./session-images.ts";
import { sessionOutputTools } from "./session-output-tools.ts";
import { purposeSystemPrompt } from "./session-purposes.ts";
import {
  ASK_QUESTION_ROUND_TOOL,
  sessionQuestionRoundTool,
  type QuestionRound,
} from "./session-question-tool.ts";
import {
  installSessionSubagentKit,
  SESSION_SUBAGENT_AGENT,
  sessionSubagentRuns,
  subagentTasks,
  SUBAGENT_TOOL,
} from "./session-subagent.ts";
import {
  AGENT_SESSION_NOTE_CUSTOM_TYPE,
  AGENT_SESSION_QUESTION_ROUND_CUSTOM_TYPE,
  AGENT_SESSION_SUBAGENT_ENTRY,
  SYSTEM_MESSAGE_ENTRY,
  type AgentSessionMessageMode,
  type OpenSessionRequest,
  type SessionCommand,
  type SessionWorkerMessage,
} from "./session-protocol.ts";
import {
  READ_ONLY_TOOLS,
  countOf,
  openAgentSession,
  prepareAgentRuntime,
  sessionReadOnlyTools,
  sessionThinkingLevel,
} from "./worker-tools.ts";

function send(message: SessionWorkerMessage): void {
  process.send?.(message);
}

/**
 * 这次会话注册的工具清单:只读四件套、受控 git,加历史 Finding 查询(issue #338)、知识
 * 查询(issue #344)、会话子代理(issue #358)与提问轮次(issue #359,任何用途都可用)。
 * 写工具与 bash 一个都不在。
 */
export function sessionTools(): string[] {
  return [
    ...READ_ONLY_TOOLS,
    GIT_TOOL,
    QUERY_FINDINGS_TOOL,
    QUERY_KNOWLEDGE_TOOL,
    SUBAGENT_TOOL,
    ASK_QUESTION_ROUND_TOOL,
  ];
}

/**
 * 会话的系统提示(issue #333)。先是底座那一份:会话是什么、工作区长什么样、工具面到哪里
 * 为止;末尾接用途自己那一段(`session-purposes.ts`,issue #338)。
 *
 * 知识的陈述不进这一份(issue #344):两层各有多少条进提示的目录那一段,陈述由
 * `query_knowledge` 按任务的范围取。整份注入会让一个只动后端的任务也带上别的仓库的约定。
 */
export function sessionSystemPrompt(request: OpenSessionRequest): string {
  // 仓库职责进破折号后面(issue #341):产品里每个仓库干什么,人写一行在这里,agent 据它
  // 挑仓库,不必先把每个 README 读一遍。没写过的那个仓库只有仓库名。
  // 短 sha 紧跟仓库名(issue #351):这棵树停在哪个 commit,agent 被问起时照着这一行说。
  const repos = request.repos.map((repo) => {
    const at = `- ${repo.owner}/${repo.repo} ${repo.headSha.slice(0, 7)}`;
    return repo.role === null ? at : `${at} — ${repo.role}`;
  });
  const sections = [
    "You are a senior engineer in a continuing conversation with one person about one product. The conversation spans many turns: answer what is asked, say what you are unsure about, and ask when the answer changes what you would do.",
    `The product: ${request.productName}.`,
    `This session's purpose: ${request.purpose}.`,
    "",
    "## The workspace",
    "",
    "The working directory is the session root. Each repository of this product is checked out in a directory named <owner>/<repo> directly under it, at the commit written after its name:",
    "",
    ...repos,
    "",
    ...(request.repos.some((repo) => repo.role !== null)
      ? [
          "The note after the dash says what that repository is for in this product; start from it to decide which repository to read.",
          "",
        ]
      : []),
    "Every path you pass to read, grep, find and ls stays inside the session root — an absolute path outside it, or a path that climbs out with .., is refused. The git tool reads one repository per call: every path argument starts with the <owner>/<repo>/ prefix, and that prefix picks the repository.",
    "",
    "Your tools are read-only. You cannot edit files, write files or run shell commands. Read the code before you claim anything about it: the repositories above are the evidence.",
    "",
    `The ${QUERY_FINDINGS_TOOL} tool reads what earlier review rounds reported on one of these repositories: ask it about the part of the code you are about to speak of, and you see what has already gone wrong there.`,
    "",
    // 会话子代理(issue #358):深读一段代码不必占着对话。派单参数由工具边界钉死,这里只说
    // 它是什么、什么时候派,不教它写参数——写错的那几项会被改回来。
    `The ${SUBAGENT_TOOL} tool sends a read-only investigator into these repositories. Call it with agent set to "${SESSION_SUBAGENT_AGENT}" — that is the only agent available — and one question per task; the call waits and returns the investigator's report. Send one when the answer needs a deep read the conversation should not wait through, and send several in one call when the questions are independent. The investigator reads and reports; it decides nothing, and what it brings back is yours to judge.`,
    "",
    "## What this product has written down",
    "",
    "This product and its repositories have written down two layers of knowledge, and neither layer is listed here.",
    "",
    `Product knowledge says how these repositories fit together: who calls whom, over what contract, which change drags which repository along. This product has ${countOf(request.productKnowledgeCount, "active product knowledge entry", "active product knowledge entries")}.`,
    "",
    "Each repository also has its own review rules, which say what it holds its code to, and project facts, which are grounds for judgement:",
    "",
    // 目录那几行只有条数:陈述由 `query_knowledge` 按任务的范围取,一个只动后端的任务不必
    // 为另一个仓库的约定付 token。
    ...request.repos.map(
      (repo) =>
        `- ${repo.owner}/${repo.repo} — ${countOf(repo.ruleCount, "review rule")}, ${countOf(repo.factCount, "project fact")}`,
    ),
    "",
    `Read them with the ${QUERY_KNOWLEDGE_TOOL} tool: it takes the repositories a task touches and an optional path glob, and returns the product entries involving any of them plus those repositories' rules and facts whose scope overlaps the glob.`,
    "",
    "When the task spans repositories or its scope is unclear, query the product layer first; otherwise query the repository and the paths the task touches.",
  ];
  const purpose = purposeSystemPrompt(
    request.purpose,
    request.productKnowledge,
    request.rejectedStatements,
  );
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
/**
 * 收到过的最后一条 prompt 的序号(评审复核)。收到指令时同步记上、再调 Pi:Pi 入队时同步发
 * `queue_update`,那一份因此带得上它。
 */
let lastPromptSeq = 0;
/** 正在处理停止:这期间 Pi 的队列被清空,那一次 `queue_update` 不回传(队列由主进程留存)。 */
let stopping = false;
/**
 * 刚抛出一轮提问(issue #359),这个回合该收尾了。工具自己中止不了这一步——它一返回 Pi 就
 * 接着发下一次模型请求,题已经抛出去了,那一次只是对着空气自问自答。因此工具在这里留一格,
 * `tool_execution_end` 上收掉:那时这次调用的结果已经进了会话记录,中止不会把它截在半路。
 */
let roundAsked = false;

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

/**
 * 每次派单派出去的那几句任务,按 `toolCallId` 记着(issue #358)。只有 `tool_execution_start`
 * 带调用参数,而 pi-subagents 在返回里把任务原文抹掉了——落条目时人话只能从这里取。
 */
const subagentTasksByCall = new Map<string, string[]>();

/**
 * 把一次会话子代理派单落成条目(issue #358)。
 *
 * 子会话的过程只有它那一侧的 transcript 文件记着,而那个文件随子进程的临时目录消失:跑完
 * 当场读成 `SessionSubagentRun` 落进会话记录,重建时面板从这一条重画卡片。派单被工具边界
 * 打回那一次没有子任务,不落条目——那次调用本身已经作一条失败的工具行留在记录里。
 *
 * 排到下一个 tick 再落:`tool_execution_end` 之后 Pi 才把那条 toolResult 写进记录表,当场
 * 落会让这一条插到它前面。`appendCustomEntry` 不进模型上下文,过程模型自己刚经历过。
 */
function recordSubagentRuns(toolCallId: string, result: unknown): void {
  const tasks = subagentTasksByCall.get(toolCallId) ?? [];
  subagentTasksByCall.delete(toolCallId);
  const runs = sessionSubagentRuns(result, { running: false, tasks });
  if (runs.length === 0) return;
  setImmediate(() => {
    session?.sessionManager.appendCustomEntry(AGENT_SESSION_SUBAGENT_ENTRY, { runs });
    mirrorEntries();
  });
}

async function open(request: OpenSessionRequest): Promise<void> {
  const thinkingLevel = sessionThinkingLevel(
    request.runtimeModel.reasoning,
    request.thinkingLevel,
  );
  const repos = request.repos.map((repo) => `${repo.owner}/${repo.repo}`);
  const prepared = await prepareAgentRuntime({
    agentDirPrefix: "multireviewer-agent-session-",
    worktreePath: request.sessionRoot,
    runtimeModel: request.runtimeModel,
    systemPrompt: sessionSystemPrompt(request),
    // 会话子代理(issue #358):执行体与铺装时机与取证那条链路逐字相同,圈定的根是整个
    // 会话根——一个问题常常横跨这个产品的几个仓库。
    extensionPaths: [vendoredSubagentsPath()],
    extensionFactories: [
      subagentContractExtension(request.sessionRoot, SESSION_SUBAGENT_AGENT),
    ],
    installKit: (agentDir) =>
      installSessionSubagentKit({
        agentDir,
        sessionRoot: request.sessionRoot,
        runtimeModel: request.runtimeModel,
        thinkingLevel,
        repos,
      }),
    // 常驻会话开自动 compaction(spec #329):它按天续谈,不压就会撞上上下文上限。
    compaction: true,
  });
  if ("failure" in prepared) {
    send({ kind: "failed", failure: prepared.failure });
    return;
  }
  apiKey = prepared.apiKey;

  // 这个用途的产出工具(issue #337)。清单与定义取同一份:工具名在 `tools` 里没有那一行,
  // Pi 就不把它交给模型,两处各写一遍迟早对不上。
  const outputTools = sessionOutputTools(request.purpose, {
    repos,
    knowledge: request.productKnowledge,
    send,
  });
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
      sessionKnowledgeTool({ repos, send }) as unknown as ToolDefinition,
      sessionQuestionRoundTool({ post: postQuestionRound }) as unknown as ToolDefinition,
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
        // 会话子代理(issue #358):任务原文只有这一档带着,记下来给条目与瞬时帧用。
        if (event.toolName === SUBAGENT_TOOL) {
          subagentTasksByCall.set(event.toolCallId, subagentTasks(event.args));
        }
      }
      // 在跑的那几趟只走瞬时帧,跑完那一版落成条目。
      if (event.type === "tool_execution_update" && event.toolName === SUBAGENT_TOOL) {
        send({
          kind: "subagent",
          runs: sessionSubagentRuns(event.partialResult, {
            running: true,
            tasks: subagentTasksByCall.get(event.toolCallId) ?? [],
          }),
        });
      }
      if (event.type === "tool_execution_end" && event.toolName === SUBAGENT_TOOL) {
        recordSubagentRuns(event.toolCallId, event.result);
      }
      // 刚抛出的那一轮提问到此收尾(issue #359):这次调用的结果已经进了会话记录,中止只掐掉
      // 还没发出的下一次模型请求,`prompt()` 因此当场兑现、会话转空闲等人答题。
      if (
        event.type === "tool_execution_end" &&
        event.toolName === ASK_QUESTION_ROUND_TOOL &&
        roundAsked
      ) {
        roundAsked = false;
        setImmediate(() => void endTurnAfterRound());
      }
      // 停止时清队列那一次不回传:那几条由主进程留存,下次开跑时投递。
      if (event.type === "queue_update" && !stopping) {
        send({
          kind: "queue",
          steering: event.steering,
          followUp: event.followUp,
          seq: lastPromptSeq,
        });
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
 * 收下 agent 抛出的一轮提问(CONTEXT.md 提问轮次,issue #359):`custom` 条目接在这次工具
 * 调用后面,镜像回主进程落库,面板据它渲染选择卡片。
 *
 * 由子进程写而不是经 IPC 交主进程:主进程直接落的条目接不上 Pi 内存里的链,下一条回复仍挂
 * 在它前一条上,这一条成了旁支(产出卡片在线上验收时撞到过)。**不进模型上下文**(ADR 0031)
 * ——题是模型刚自己抛的,答案由人合成的那条用户消息带回来。
 */
function postQuestionRound(round: QuestionRound): void {
  if (session === undefined) return;
  session.sessionManager.appendCustomEntry(AGENT_SESSION_QUESTION_ROUND_CUSTOM_TYPE, round);
  mirrorEntries();
  roundAsked = true;
}

/**
 * 抛完一轮提问就收尾这个回合(issue #359)。与人点停止的差别:不清 Pi 的队列——人在这一轮
 * 之前排过的消息照样该投出去,那条更新的用户消息本来就让这张卡片过期。不落系统消息:对话流
 * 里已经有那张卡片,再加一行「已中止」只是噪音。
 */
async function endTurnAfterRound(): Promise<void> {
  if (session === undefined || !running) return;
  // 与人点停止同一格:这次中止是这条链路自己要的,不是这一轮跑坏了,不该报成回合失败。
  stopped = true;
  await session.abort();
}

/**
 * 中止当前这一步。人点停止与服务排空共用:两处要做的事逐字相同。
 *
 * 先清 Pi 的队列再 abort,顺序要紧:abort 之后 Pi 会接着把队列排空(`continue()` 在末条是
 * assistant 时就从队列取),不清的话这一下会立刻把排队的消息投出去。排队消息因此留在主进程
 * 的镜像里,下次开跑时一并投递。`stopping` 期间不回传 `queue_update`:清掉的那几条由主进程
 * 留存,不该从镜像里消失。
 */
async function abortCurrentStep(live: AgentSession): Promise<void> {
  stopped = true;
  stopping = true;
  try {
    live.clearQueue();
    await live.abort();
  } finally {
    stopping = false;
  }
}

/**
 * 停止:只中止当前这一步。被中止的回复条目由 Pi 照常落下,人点停止另以 custom 条目落同一
 * 张表(ADR 0031),不进模型上下文。
 */
async function stop(): Promise<void> {
  if (session === undefined || !running) return;
  await abortCurrentStep(session);
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
    await abortCurrentStep(session);
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
      lastPromptSeq = command.seq;
      return prompt(command.text, command.mode, command.images ?? []);
    case "custom-message":
      return customMessage(command.text);
    case "custom-entry":
      // 产出卡片标记之类不进上下文的条目:接在当前叶子后面,镜像回主进程落库。
      session?.sessionManager.appendCustomEntry(command.customType, command.data);
      mirrorEntries();
      return Promise.resolve();
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
    case "knowledge-query-result": {
      // 知识查询的回应(issue #344):与上一档同律,兑现等着的那次工具调用。
      const { entries, failure } = command;
      resolveKnowledgeQuery(command.requestId, {
        ...entries,
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
    // 会话建不起来是这个子进程的终局;一个回合跑坏了只报这一回合。别的指令不报回合结束:
    // 那会把一个还在跑的会话说成空闲,下一条消息就会与在跑的这一轮撞上。
    //
    // `prompt` 同样只在**没在跑**时才报——那一档是真正开跑失败,这一回合从来没开始。执行中
    // 的 `prompt` 是入队(`steer` / `followUp`),它抛错时有一个回合正跑着:报回合结束会把它
    // 说成空闲。协议上没有「入队失败」这一档,这一条因此只记日志;它没进 Pi 的队列,下一次
    // `queue_update` 就把镜像对齐回来,面板的排队块里不会留下一条投不出去的消息。
    if (command.kind === "open") send({ kind: "failed", failure });
    else if (command.kind === "prompt" && !running) send({ kind: "turn-end", failure });
    else console.error(`[agent-session] ${command.kind} 没做成:${failure}`);
  });
});
