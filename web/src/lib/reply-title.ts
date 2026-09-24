import { ROUND_ANSWER_HEAD } from "./session-question-round.ts";

/**
 * 阅读视图头部的标题:这条回复答的那个问题(这一轮里它之前最近的一条用户消息)。问题说得出
 * 「这篇回答的是什么」,正文开头那个标题已经在正文第一行,头部再摆一次是重复。
 * 两种问题当不了标题,退回正文第一个 Markdown 标题:提问轮次的答卷(第一行是固定抬头,每轮
 * 都一样)与只有图片的消息(没有文字)。正文也没有标题时写一句通用的说法,不留空标题。
 */
export function replyTitle(question: string | undefined, text: string): string {
  const asked = question?.trim() ?? "";
  if (asked !== "" && asked.split("\n")[0]!.trim() !== ROUND_ANSWER_HEAD) return asked;
  for (const rawLine of text.split("\n")) {
    const match = /^#{1,6}\s+(.+)/.exec(rawLine.trim());
    if (match !== null) return match[1]!.trim();
  }
  return "agent 回复";
}

/** 下载的 `.md` 文件名:标题的头一行去掉文件系统不认的字符,截 60 字;剩不下字就用回复时刻。 */
export function replyFileName(title: string, at: string): string {
  const base = title
    .split("\n")[0]!
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return `${base === "" ? `agent-reply-${at.replace(/[:.]/g, "-")}` : base}.md`;
}
