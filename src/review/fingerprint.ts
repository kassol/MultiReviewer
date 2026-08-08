import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

/** 指纹窗口取 Finding 指向行的前后各 3 行,共 7 行,在文件首尾自然截断。 */
const CONTEXT_LINES = 3;

/**
 * Finding 指向位置的内容指纹。
 *
 * 归一化掉空白与空行再 hash:同一处代码在两轮之间常常只是缩进或折行变了,
 * 按原文 hash 会把它读成一处新代码。
 */
export function contentFingerprint(
  worktreePath: string,
  file: string,
  line: number,
): string | undefined {
  // 路径由模型给出,属半可信输入(ADR 0004),不能让它读到工作副本之外。
  const root = resolve(worktreePath);
  const full = resolve(root, file);
  if (full !== root && !full.startsWith(root + sep)) return undefined;

  let content: string;
  try {
    content = readFileSync(full, "utf8");
  } catch {
    // 模型报出的路径可能指不到仓库里的文件,此时没有指纹可算。
    return undefined;
  }

  const window = content
    .split("\n")
    .slice(Math.max(0, line - 1 - CONTEXT_LINES), line + CONTEXT_LINES)
    .map((text) => text.trim().replace(/\s+/g, " "))
    .filter((text) => text !== "");
  if (window.length === 0) return undefined;

  return createHash("sha256").update(window.join("\n")).digest("hex");
}
