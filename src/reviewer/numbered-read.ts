/**
 * 带行号的文件读取,给 Reviewer 会话里的 `read` 工具用。
 *
 * Pi 内建的 `read` 返回裸内容,模型报 Finding 时只能自己数行,实测在 55 行的文件上
 * 就会数偏(PR #3 里 RCE 评论挂到了别的函数上)。成熟实现的共同做法是让行号可抄
 * 不可数:pr-agent 与 ai-pr-reviewer 在 diff 每行预打行号,claude-code-action 靠
 * Read 工具自带的 cat -n 前缀。这里取后一种,worker 用它注册同名工具覆盖内建。
 */

/** 与 Pi 内建 read 的默认截断同一量级,防止一次读取撑爆审查会话的上下文。 */
const MAX_LINES = 1000;
const MAX_BYTES = 48 * 1024;

/**
 * 把文件内容渲染成 `N: content` 的带号文本。`offset` 是 1-indexed 起始行。
 *
 * 行号前缀不对齐、不补零:模型抄号不需要对齐,少一格是一格 token。
 */
export function numberedRead(content: string, offset?: number, limit?: number): string {
  const lines = content.split("\n");
  // 结尾换行符 split 出的尾部空串是幽灵行,cat -n 也不数它。
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  const start = offset === undefined ? 1 : offset;
  if (!Number.isInteger(start) || start < 1) {
    throw new Error(`offset 必须是 1 起的整数: ${offset}`);
  }
  if (start > lines.length) {
    throw new Error(`Offset ${start} is beyond end of file (${lines.length} lines total)`);
  }

  const requestedEnd =
    limit === undefined ? lines.length : Math.min(start + limit - 1, lines.length);
  const cappedEnd = Math.min(requestedEnd, start + MAX_LINES - 1);

  const out: string[] = [];
  let bytes = 0;
  let end = start - 1;
  for (let n = start; n <= cappedEnd; n += 1) {
    const numbered = `${n}: ${lines[n - 1]}`;
    bytes += Buffer.byteLength(numbered, "utf8") + 1;
    if (bytes > MAX_BYTES && out.length > 0) break;
    out.push(numbered);
    end = n;
  }

  if (end < lines.length) {
    // 措辞照 Pi 内建工具:模型见过这个提示,知道怎么续读。
    out.push("", `[Showing lines ${start}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`);
  }
  return out.join("\n");
}
