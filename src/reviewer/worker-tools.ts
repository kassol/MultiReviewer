/**
 * Reviewer 与规则 agent 两个子进程共用的会话构件(issue #209)。
 *
 * 两条链路的会话形状不同,读文件这件事却是同一件:只认工作副本里的路径,每行带号交给
 * 模型。规则条目在 prompt 里的行格式同样共用一份——两边写的是同一个 `[id] (scope)`,
 * 分成两份只会让某一天其中一边悄悄改掉。
 */
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { ReviewRule } from "../review/finding.ts";
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
