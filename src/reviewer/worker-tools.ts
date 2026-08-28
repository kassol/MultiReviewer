/**
 * Reviewer 与规则 agent 两个子进程共用的会话构件(issue #209)。
 *
 * 两条链路的会话形状不同,读文件这件事却是同一件:只认工作副本里的路径,每行带号交给
 * 模型。规则条目在 prompt 里的行格式同样共用一份——两边写的是同一个 `[id] (scope)`,
 * 分成两份只会让某一天其中一边悄悄改掉。会话跑起来之前那一套运行时同理。
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import {
  DefaultResourceLoader,
  defineTool,
  type ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { ReviewRule } from "../review/finding.ts";
import { MODEL_API_KEY_ENV, PI_AGENT_DIR_ENV } from "./env.ts";
import { isolatedPinnedModelRuntime } from "./model-runtime.ts";
import type { RuntimeModel } from "./model-service-runtime.ts";
import { numberedRead } from "./numbered-read.ts";

/** worktree 内文件的行数组。路径出圈或读不出来返回 undefined,交给调用方措辞。 */
export function fileLines(worktreePath: string, file: string): string[] | undefined {
  const root = resolve(worktreePath);
  const abs = resolve(root, file);
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

/** 一条规则:标识在最前,模型自报命中时抄的就是它;作用范围空串即全仓库。 */
export function ruleBullet(rule: ReviewRule): string {
  const scope = rule.scope === "" ? "whole repository" : rule.scope;
  return `- [${rule.id}] (${scope}) ${rule.statement}`;
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

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1 },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.worktreePath,
    agentDir,
    settingsManager,
    systemPromptOverride: () => options.systemPrompt,
  });
  await resourceLoader.reload();

  return { agentDir, apiKey, model, modelRuntime, settingsManager, resourceLoader };
}
