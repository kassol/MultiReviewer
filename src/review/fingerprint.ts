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

/**
 * 评论正文里的指纹锚点。跨轮次匹配靠它,不靠 comment id——`Forge.createReview`
 * 不回传每条评论的 id,而该接口按 Gitea 的能力定义(ADR 0002),不为此扩张。
 *
 * 两个平台的 markdown 渲染都会剥掉 HTML 注释,人看不见;API 读回的是正文原文,锚点还在。
 */
export function fingerprintAnchor(fingerprint: string): string {
  return `<!-- multireviewer:${fingerprint} -->`;
}

/** 读回评论正文里的锚点。没有锚点即该评论不是本工具发的,不参与匹配。 */
export function parseFingerprintAnchor(body: string): string | undefined {
  return ANCHOR.exec(body)?.[1];
}

const ANCHOR = /<!-- multireviewer:([0-9a-f]{64}) -->/;
