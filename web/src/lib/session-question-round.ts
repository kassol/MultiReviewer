/**
 * 提问轮次的卡片数据与答案文本(CONTEXT.md 提问轮次,issue #359)。
 *
 * 一轮题以 `custom` 条目落在会话记录里(服务端 `reviewer/session-question-tool.ts` 写的那一份),
 * 面板把它渲染成选择卡片;人一次答完整轮,答案合成**一条普通用户消息**经既有的发消息端点发
 * 回去——卡片不另开一条写路径,轮次的答案与人自己打的一段话在会话里是同一种东西。
 *
 * 合成与还原因此是一对:`roundAnswerText` 写出去,`roundAnswersFrom` 从紧随其后的那条用户
 * 消息里读回来,已答的卡片据它显示所选答案。读不回来(格式不对、题数对不上)即这条用户消息
 * 不是这一轮的答案,卡片按过期渲染。
 */

/** 一题的一个选项。每题恰好一个推荐项。 */
export type QuestionRoundOption = { text: string; recommended: boolean };

/** 一道决策题。编号由它在这一轮里的位置给出。 */
export type QuestionRoundQuestion = {
  title: string;
  body: string;
  options: QuestionRoundOption[];
  /** true 即这题可多选。 */
  multiple: boolean;
};

/** agent 一次抛出的一轮题。 */
export type QuestionRound = { questions: QuestionRoundQuestion[] };

/** 答案那条用户消息的首行。还原时按它认出「这是一轮答案」。 */
export const ROUND_ANSWER_HEAD = "提问轮次的回答:";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * 把 `custom` 条目的 `data` 读成一轮题。形状不对回 undefined:后端多落一种 custom 条目不该
 * 让对话流摊出一段 JSON(与别的条目投影同律)。
 */
export function parseQuestionRound(data: unknown): QuestionRound | undefined {
  const questions = (data as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const parsed: QuestionRoundQuestion[] = [];
  for (const one of questions) {
    const row = one as { title?: unknown; body?: unknown; options?: unknown; multiple?: unknown };
    if (!Array.isArray(row.options) || row.options.length === 0) return undefined;
    const title = str(row.title);
    if (title === "") return undefined;
    parsed.push({
      title,
      body: str(row.body),
      options: row.options.map((option: unknown) => ({
        text: str((option as { text?: unknown }).text),
        recommended: (option as { recommended?: unknown }).recommended === true,
      })),
      multiple: row.multiple === true,
    });
  }
  return { questions: parsed };
}

/**
 * 整轮答案合成的那条用户消息:首行一句抬头,之后每题一段——编号加标题一行,所答的每一项
 * 一行。多选因此不必另造分隔符,「其他」自填的那一行与选项同形。
 */
export function roundAnswerText(
  round: QuestionRound,
  answers: readonly (readonly string[])[],
): string {
  const blocks = round.questions.map((question, index) =>
    [
      `${index + 1}. ${question.title}`,
      ...(answers[index] ?? []).map((answer) => `- ${answer}`),
    ].join("\n"),
  );
  return [ROUND_ANSWER_HEAD, "", blocks.join("\n\n")].join("\n");
}

/**
 * 从一条用户消息里读回这一轮的答案。不是这一轮的答案即 undefined:抬头对不上、题数对不上、
 * 或者有题一项都没答,三者都说明这条消息是人另外说的一段话,这张卡片因此是被它顶过期的。
 */
export function roundAnswersFrom(text: string, round: QuestionRound): string[][] | undefined {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== ROUND_ANSWER_HEAD) return undefined;
  const answers: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines.slice(1)) {
    // 「- 」开头的是答案行,先判它:自填的文字本身可能以「1. 」开头。
    if (line.startsWith("- ")) {
      current?.push(line.slice(2).trim());
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      current = [];
      answers.push(current);
    }
  }
  if (answers.length !== round.questions.length) return undefined;
  return answers.every((one) => one.length > 0) ? answers : undefined;
}
