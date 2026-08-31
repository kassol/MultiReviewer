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
  const lines = readLines(worktreePath, file);
  if (lines === undefined) return undefined;
  return windowFingerprint(lines, line);
}

/**
 * 一个文件此刻算得出的全部指纹。
 *
 * 「所指代码是不是已改写」的判据:上一轮的指纹落在这个集合里,那处代码就还在原样,
 * 不论它被上下挪了多少行。按历史评论记的行号原地重算做不到这一点——作者在上面插
 * 几行,整个文件的 Finding 都会被读成已改写。
 *
 * 自 ADR 0016 起它不再是自动处置的证据(那由复核结论决定),只作「已延续」的判据:
 * 复核判仍在而旧指纹在这里算不出,那处代码就是被改写了,同一条 Finding 要交接到新位置。
 */
export function fileFingerprints(worktreePath: string, file: string): Set<string> {
  const fingerprints = new Set<string>();
  const lines = readLines(worktreePath, file);
  // 文件被删掉或改名时读不到,一个指纹都算不出:那处代码确实已经不在了。
  if (lines === undefined) return fingerprints;
  for (let line = 1; line <= lines.length; line += 1) {
    const fingerprint = windowFingerprint(lines, line);
    if (fingerprint !== undefined) fingerprints.add(fingerprint);
  }
  return fingerprints;
}

/** 读工作副本里的一个文件,按行切开。读不到即没有指纹可算。 */
function readLines(worktreePath: string, file: string): string[] | undefined {
  // 路径由模型给出,属半可信输入(ADR 0004),不能让它读到工作副本之外。
  const root = resolve(worktreePath);
  const full = resolve(root, file);
  if (full !== root && !full.startsWith(root + sep)) return undefined;

  try {
    return readFileSync(full, "utf8").split("\n");
  } catch {
    // 模型报出的路径可能指不到仓库里的文件,此时没有指纹可算。
    return undefined;
  }
}

/** 指定行那一扇窗口的指纹。窗口整扇为空(文件尾的空行)时没有指纹可算。 */
function windowFingerprint(lines: readonly string[], line: number): string | undefined {
  const window = lines
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
 *
 * 只埋在行级评论上:锚定收敛之后 Finding 一律是行级评论(issue #224),路径由 API 一并
 * 读回,锚点自己不必带。历史 review 正文里那种另带路径的锚点仍要认得出,解析那一侧留着。
 */
export function fingerprintAnchor(fingerprint: string): string {
  return `<!-- multireviewer:${fingerprint} -->`;
}

/**
 * 读回正文里的全部锚点。没有锚点即那段正文不是本工具发的,不参与匹配。
 *
 * 取全部而不是第一个:锚定收敛之前发出去的 review 正文里可能有多个 diff 外条目,各带
 * 一个锚点,只认第一个会让其余的 Finding 每轮重发。
 */
export function parseFingerprintAnchors(
  body: string,
): { fingerprint: string; file: string | undefined }[] {
  // `listReviewBodies` 把平台读回的 `review.body` 直接喂进来,理论上可能是 null。这里是
  // 所有调用方的唯一汇聚点,挡在这一处:一条正文异常不该在 `matchAll` 上把整轮 Run 带崩。
  if (typeof body !== "string") return [];
  return [...body.matchAll(ANCHOR)].map((match) => ({
    fingerprint: match[1]!,
    file: match[2],
  }));
}

// 路径这一段可选:issue #11 之前发出去的锚点没有它,那些评论要照常匹配得上。
const ANCHOR = /<!-- multireviewer:([0-9a-f]{64})(?::([^\n]*?))? -->/g;
