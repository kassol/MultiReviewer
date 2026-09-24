import type { ConversationGroup } from "./agent-session-records.ts";
import { ROUND_ANSWER_HEAD } from "./session-question-round.ts";

/** 轮次导航里的一轮:从一条用户消息起,到下一条用户消息之前。 */
export interface TurnOutline {
  /** 这一轮起头那条用户消息的 seq,导航按它找到那一行。 */
  seq: number;
  /** 问题的头一行。答卷与只有图片的消息没有能当问题的文字,给一句说法。 */
  question: string;
  /** 这一轮最后一条 agent 回复的开头,去掉 Markdown 记号;还没回复即 undefined。 */
  summary: string | undefined;
}

/** 摘要最多取这么多字:卡片只画三行,多取的只是白白拼字符串。 */
const SUMMARY_CHARS = 160;

export function turnOutline(groups: readonly ConversationGroup[]): TurnOutline[] {
  const turns: TurnOutline[] = [];
  for (const group of groups) {
    if (group.kind === "user") {
      turns.push({ seq: group.seq, question: questionLine(group), summary: undefined });
    } else if (group.kind === "assistant" && turns.length > 0) {
      turns.at(-1)!.summary = plainText(group.text).slice(0, SUMMARY_CHARS);
    }
  }
  return turns;
}

function questionLine(group: Extract<ConversationGroup, { kind: "user" }>): string {
  const first = group.text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
  if (group.answering !== undefined || first === ROUND_ANSWER_HEAD) return "回答提问轮次";
  if (first === "") return group.images.length > 0 ? "发了图片" : "(空消息)";
  return first;
}

/** 摘要用的纯文本:代码围栏整段丢掉,标题、列表、引用、强调、行内代码与链接只留文字。 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    // 只去成对的强调记号:单个下划线属于 `BUTTON_DC_TASK` 这类标识符,不能删。
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
