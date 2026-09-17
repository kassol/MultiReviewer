/**
 * Agent 会话的提问轮次工具(CONTEXT.md 提问轮次,issue #359)。底座工具面的一件,所有用途
 * 都注册——一轮决策题与会话用途无关,梳理、需求拆分与开放对话要问的是同一种东西。
 *
 * 与产出工具(`session-output-tools.ts`)的做法逐条对齐:格式要求写在字段自己的
 * `description` 里、形状宽松、服务端归一化(trim、去空项),不合规走**正常返回**一句理由而
 * 不抛工具错误——模型看见理由就改得动。
 *
 * 两处与产出工具不同:
 * - 这一轮不经 IPC 交主进程,由子进程当场 `appendCustomEntry` 放进 Pi 会话
 *   (`post`)——它要接在这次工具调用后面,落库仍走镜像那条路,与别的条目同形。
 * - 交完这一轮这个回合就结束(`session-worker.ts` 在 `tool_execution_end` 上中止当前这一步):
 *   题抛出去了,答案要等人,继续生成只是对着空气自问自答。
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { toolText } from "./worker-tools.ts";

export const ASK_QUESTION_ROUND_TOOL = "ask_question_round";

/** 一题的一个选项。推荐项每题恰好一个。 */
export type QuestionRoundOption = { text: string; recommended: boolean };

/** 一道决策题:标题、题干、二到四个选项,单选或多选。编号由它在这一轮里的位置给出。 */
export type QuestionRoundQuestion = {
  title: string;
  body: string;
  options: readonly QuestionRoundOption[];
  /** true 即这题可多选。 */
  multiple: boolean;
};

/** 一次抛出的一轮题。 */
export type QuestionRound = { questions: readonly QuestionRoundQuestion[] };

/** 每题的选项数上下界(CONTEXT.md 提问轮次)。 */
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

const roundSchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      title: Type.String({
        description:
          "The decision this question settles, written in Chinese as a short noun phrase of about 20 characters — what is being chosen, not the question mark form",
      }),
      body: Type.String({
        description:
          "What the person needs to know to decide, written in Chinese: what you already read, what hinges on the answer, why you cannot settle it from the code",
      }),
      options: Type.Array(
        Type.Object({
          text: Type.String({
            description: "One answer, written in Chinese as one line the person can pick as is",
          }),
          recommended: Type.Boolean({
            description:
              "true on the one option you would take. Exactly one option of a question is recommended.",
          }),
        }),
        {
          description: `Two to four options, exactly one of them recommended. They are the answers you can already tell apart; the panel adds a free-text 其他 to every question, so do not add one yourself.`,
        },
      ),
      multiple: Type.Boolean({
        description:
          "true when several options can hold at once, false when the person picks exactly one",
      }),
    }),
    {
      description:
        "The questions of this round. Ask what you could not settle by reading, and only what changes what you would do next; the person answers the whole round in one go.",
    },
  ),
});

/** 服务端归一化:文字 trim,空文字的选项丢掉。与产出工具同一做法。 */
export function normalizeQuestionRound(raw: QuestionRound): QuestionRound {
  return {
    questions: raw.questions.map((question) => ({
      title: question.title.trim(),
      body: question.body.trim(),
      options: question.options
        .map((option) => ({ text: option.text.trim(), recommended: option.recommended }))
        .filter((option) => option.text !== ""),
      multiple: question.multiple,
    })),
  };
}

/**
 * 这一轮要不要打回,要就回一句理由。与产出工具同律:只回第一处,一次说一件事。
 */
export function questionRoundRejection(round: QuestionRound): string | undefined {
  if (round.questions.length === 0) {
    return "this round has no questions; ask at least one, or say what you concluded in prose instead";
  }
  for (const [index, question] of round.questions.entries()) {
    const at = `question ${index + 1}`;
    if (question.title === "") {
      return `${at} has no title; name the decision it settles, in Chinese`;
    }
    if (question.options.length < MIN_OPTIONS || question.options.length > MAX_OPTIONS) {
      return `${at} has ${question.options.length} options; a question offers ${MIN_OPTIONS} to ${MAX_OPTIONS} — split it when the answers do not fit in ${MAX_OPTIONS}`;
    }
    const recommended = question.options.filter((option) => option.recommended).length;
    if (recommended !== 1) {
      return `${at} has ${recommended} recommended options; mark exactly one as recommended — the person is told which one you would take`;
    }
  }
  return undefined;
}

/**
 * 提问轮次工具。`post` 把这一轮放进会话记录(子进程那一侧的 `appendCustomEntry`),调用它
 * 之后这个回合由 `session-worker.ts` 收尾。
 */
export function sessionQuestionRoundTool(options: {
  post: (round: QuestionRound) => void;
}): ToolDefinition<never, never> {
  return defineTool({
    name: ASK_QUESTION_ROUND_TOOL,
    label: "Ask Question Round",
    description:
      "Put a round of decision questions to the person as one card. Use it for what you cannot settle by reading — a choice that is the person's to make, a fact only they hold — and gather the whole round into one call: they answer every question with a few clicks and one submit, so a round costs them one interruption. Facts you can read, read. Your turn ends on this call: the person's answer comes back as one message, and you pick up from it.",
    parameters: roundSchema,
    execute: async (_id, params) => {
      const round = normalizeQuestionRound(params as QuestionRound);
      const rejection = questionRoundRejection(round);
      if (rejection !== undefined) return toolText(rejection);
      options.post(round);
      return toolText(
        "asked. This turn ends here: the person answers the whole round in one message, and you pick up from that answer.",
      );
    },
  }) as unknown as ToolDefinition<never, never>;
}
