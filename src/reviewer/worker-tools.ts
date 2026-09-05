/**
 * Reviewer 与规则 agent 两个子进程共用的会话构件(issue #209)。
 *
 * 两条链路的会话形状不同,读文件这件事却是同一件:只认工作副本里的路径,每行带号交给
 * 模型。规则条目在 prompt 里的行格式同样共用一份——两边写的是同一个 `[id] (scope)`,
 * 分成两份只会让某一天其中一边悄悄改掉。会话跑起来之前那一套运行时同理。
 */
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import {
  DefaultResourceLoader,
  defineTool,
  type InlineExtension,
  type ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { ThinkingLevel } from "../config.ts";
import type { ProjectFact, ReviewRule } from "../review/finding.ts";
import { MODEL_API_KEY_ENV, PI_AGENT_DIR_ENV, redactModelCredential } from "./env.ts";
import { isolatedPinnedModelRuntime } from "./model-runtime.ts";
import type { RuntimeModel } from "./model-service-runtime.ts";
import { numberedRead } from "./numbered-read.ts";

/**
 * 只读靠允许清单强制:未列出的工具 Pi 不会注册,模型没有写入的调用路径。两个子进程与
 * 取证子代理的工具面同以这四样为基础,分成三份只会让某一天其中一处悄悄多出一个能写的
 * 工具。Reviewer 在此之上另有受控 git 工具(`git-tool.ts`),它是自定义工具,进不了
 * 取证子代理的工具面——那是 pi-subagents 另建的一个会话,只认自己 agent 定义里的清单。
 *
 * `read` 在清单里,但两个子进程实际注册的是下面那个带行号的自定义实现——customTools
 * 同名覆盖内建。取证子会话没有这份 customTools,拿到的是 Pi 的内建 `read`。
 */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

/**
 * worktree 内文件的行数组。路径出圈或读不出来返回 undefined,交给调用方措辞。
 *
 * 包含判定按 realpath 之后的真实位置做,不是词法路径:被审仓库可以提交一个指向圈外的
 * 符号链接,词法上它就在 worktree 里,`readFileSync` 却会跟着链接读到圈外的文件。根也要
 * realpath——macOS 的 tmpdir 本身就是符号链接,只解析一侧会把全部合法路径误拒。
 */
export function fileLines(worktreePath: string, file: string): string[] | undefined {
  let root: string;
  let abs: string;
  try {
    root = realpathSync(resolve(worktreePath));
    abs = realpathSync(resolve(root, file));
  } catch {
    // 文件不存在时 realpath 就抛:与"读不出来"同一档,被删的文件本来就该走 undefined。
    return undefined;
  }
  if (!abs.startsWith(root + sep)) return undefined;
  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 覆盖 Pi 内建的 read:内建实现返回裸内容,模型只能自己数行,行号漂移就从这来。
 * schema 与内建一致,模型的使用习惯不变,唯一区别是每行带 `N: ` 前缀。
 */
export function numberedReadTool(worktreePath: string) {
  return defineTool({
    name: "read",
    label: "Read",
    description:
      "Read the contents of a text file. Every line is prefixed with its 1-indexed line number, like `12: code`. Output is truncated for large files; use offset/limit to continue.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(
        Type.Number({ description: "Line number to start reading from (1-indexed)" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
    }),
    execute: async (_id, { path, offset, limit }) => {
      const lines = fileLines(worktreePath, path);
      if (lines === undefined) {
        throw new Error(`cannot read ${path}: not a readable file inside the repository`);
      }
      const text = numberedRead(lines.join("\n"), offset, limit);
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}

/**
 * 陈述压成单行再进 prompt:录入侧是多行输入框,而注入是一行一条的列表,
 * 换行会把一条陈述拆成几条残句。
 */
export function oneLine(statement: string): string {
  return statement.replace(/\s*\n+\s*/g, " ");
}

/** 一条规则:标识在最前,模型自报命中时抄的就是它;作用范围空串即全仓库。 */
export function ruleBullet(rule: ReviewRule): string {
  const scope = rule.scope === "" ? "whole repository" : rule.scope;
  return `- [${rule.id}] (${scope}) ${oneLine(rule.statement)}`;
}

/**
 * 一条项目事实(issue #221):只有作用范围与那一句陈述,**不给标识**。事实不是 `ruleId`
 * 的合法取值,列出标识只会请模型编一个填进来。
 */
export function factBullet(fact: ProjectFact): string {
  const scope = fact.scope === "" ? "whole repository" : fact.scope;
  return `- (${scope}) ${oneLine(fact.statement)}`;
}

/**
 * 模型自报的规则标识指向了一条项目事实时的打回理由(issue #221)。事实是判断依据,
 * 本身不构成 Finding,拿它当命中的规则报出来说明这条 Finding 的依据就不成立——静默置空
 * 会让模型以为自己报对了,理由要回给它,让它改报或不报。
 *
 * 与锚定打回同一条口径:返回一句话交给模型,`report_finding` 本身不抛错。
 */
export function factRuleIdRejection(
  ruleId: number | undefined,
  factIds: ReadonlySet<number>,
): string | undefined {
  if (ruleId === undefined || !factIds.has(ruleId)) return undefined;
  return `rejected: ${ruleId} is a project fact, not a review rule. Facts are grounds for judgement and are never findings by themselves. Report this problem without ruleId, or cite the review rule it actually violates.`;
}

/**
 * 复核工具收到一个本次没注入过的历史 id 时的打回理由(issue #235)。编出来的 id 与
 * 落在别的批次里的 id 同一口径:这一次注入的清单是它唯一的合法取值——静默收下会让一条
 * 真实的历史 Finding 少一个结论,而这个模型这一批压根没看过那条历史所在的文件。
 *
 * 与 `factRuleIdRejection` 同一条口径:返回一句话交给模型,工具本身不抛错。
 */
export function priorFindingRejection(
  id: number,
  historyById: ReadonlyMap<number, unknown>,
): string | undefined {
  if (historyById.has(id)) return undefined;
  return `no prior finding with id ${id}; use one of the ids listed in the prompt`;
}

/**
 * 这次会话实际用的思考档位。模型不声明推理能力时落回 `off` 照常跑:档位挂在模型引用处,
 * 而同一处引用可能在模型信息更新后不再声明推理能力——那时该跑的仍然要跑,不是配置错误。
 */
export function sessionThinkingLevel(
  reasoning: boolean,
  level: ThinkingLevel | undefined,
): ThinkingLevel {
  if (!reasoning) return "off";
  return level ?? "off";
}

/**
 * 会话收尾时的失败原因:先取跑 prompt 时抛出的异常,再取 agent 状态里的错误,最后取
 * 末条 assistant 消息上的 `stopReason=error`;凭据一律先抹掉。三个子进程收尾同一句话,
 * 分三份只会让某一天其中一处悄悄改掉。
 */
export function sessionFailure(
  session: {
    messages: readonly { role: string; stopReason?: string; errorMessage?: string }[];
    agent: { state: { errorMessage?: string } };
  },
  thrown: string | undefined,
  apiKey: string,
): string | undefined {
  const lastAssistant = session.messages.findLast((m) => m.role === "assistant");
  const stopReasonFailure =
    lastAssistant?.stopReason === "error"
      ? (lastAssistant.errorMessage ?? "stopReason=error")
      : undefined;
  const rawFailure = thrown ?? session.agent.state.errorMessage ?? stopReasonFailure;
  return rawFailure === undefined ? undefined : redactModelCredential(rawFailure, apiKey);
}

/** 会话跑起来所需的那一套。两个子进程各自的 `createAgentSession` 从这里取。 */
export type AgentRuntime = {
  agentDir: string;
  apiKey: string;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  resourceLoader: DefaultResourceLoader;
};

/**
 * 备好会话运行时:空的 agentDir、只认本轮快照那一项模型的私有运行时、以及会话设置与
 * 资源加载器。两条链路对这几样的要求逐字相同,分成两份只会让某一天其中一边悄悄改掉。
 *
 * 备不成时回 `{ failure }` 而不自己发消息:两个子进程的 `done` 消息形状不同,措辞由
 * 调用方给。
 */
export async function prepareAgentRuntime(options: {
  /** 临时目录前缀,只为在 `tmpdir` 里认得出是哪条链路留下的。 */
  agentDirPrefix: string;
  worktreePath: string;
  runtimeModel: RuntimeModel;
  systemPrompt: string;
  /**
   * 额外铺进这个会话的扩展(issue #226)。空 agentDir 的隔离对它开一个受控例外:路径由
   * 调用方给出、指向镜像里 vendor 好的包,不来自宿主机的全局扩展目录。
   */
  extensionPaths?: readonly string[];
  /**
   * 与上面那些扩展一起装进会话的进程内扩展(issue #262):由本项目代码构造,不读任何
   * 目录。取证契约在工具边界的那一道钩子从这里进。
   */
  extensionFactories?: readonly InlineExtension[];
  /**
   * 往 agentDir 里铺东西的时机(issue #262):模型运行时已建好、扩展还没加载。pi-subagents
   * 在扩展注册时读一次自己的 config 并捕获,之后不再读——要生效的配置必须在
   * `resourceLoader.reload()` 之前就位;而 `models.json` 又要在运行时建好之后再写,免得
   * 反过来盖掉内存里注册的那一项模型。两条约束只有这一个窗口同时满足。
   */
  installKit?: (agentDir: string) => void;
}): Promise<AgentRuntime | { failure: string }> {
  // 空的 agentDir:不让宿主机上的全局扩展、skill、设置与凭据渗进会话。
  const agentDir = mkdtempSync(join(tmpdir(), options.agentDirPrefix));
  process.env[PI_AGENT_DIR_ENV] = agentDir;

  const apiKey = process.env[MODEL_API_KEY_ENV];
  if (apiKey === undefined || apiKey === "") return { failure: "缺少模型凭据" };

  // 只从 IPC 里的本轮快照注册这一项运行模型。子进程不读共享的当前模型投影，因此模型服务
  // 在 Review Run 中途切版也不会改掉后续批次的地址、协议或模型字段。
  const runtime = options.runtimeModel;
  const modelRuntime = await isolatedPinnedModelRuntime(agentDir, runtime);
  await modelRuntime.setRuntimeApiKey(runtime.provider, apiKey);

  const model = modelRuntime.getModel(runtime.provider, runtime.id);
  if (!model) return { failure: `固定运行模型无法加载: ${runtime.provider}/${runtime.id}` };

  options.installKit?.(agentDir);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1 },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.worktreePath,
    agentDir,
    settingsManager,
    ...(options.extensionPaths === undefined || options.extensionPaths.length === 0
      ? {}
      : { additionalExtensionPaths: [...options.extensionPaths] }),
    ...(options.extensionFactories === undefined || options.extensionFactories.length === 0
      ? {}
      : { extensionFactories: [...options.extensionFactories] }),
    systemPromptOverride: () => options.systemPrompt,
  });
  await resourceLoader.reload();

  return { agentDir, apiKey, model, modelRuntime, settingsManager, resourceLoader };
}
