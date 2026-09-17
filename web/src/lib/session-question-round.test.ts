/*
 * 提问轮次的答案文本单测(CONTEXT.md 提问轮次,issue #359)。
 *
 * 钉的是合成与还原这一对:整轮答案写出去是一条普通用户消息,已答的卡片再从那条消息里把答案
 * 读回来。读不回来即这条消息不是这一轮的答案,卡片按过期渲染——三态全靠这一个判据。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseQuestionRound,
  roundAnswerText,
  roundAnswersFrom,
  type QuestionRound,
} from "./session-question-round.ts";

const ROUND: QuestionRound = {
  questions: [
    {
      title: "汇率取哪一天的",
      body: "两处代码都取提交当天",
      options: [
        { text: "提交当天", recommended: true },
        { text: "月末统一", recommended: false },
      ],
      multiple: false,
    },
    {
      title: "撤回之后谁收到通知",
      body: "现在只有审批人一条路",
      options: [
        { text: "审批人", recommended: true },
        { text: "抄送人", recommended: false },
      ],
      multiple: true,
    },
  ],
};

test("整轮答案合成一条消息:每题一段,编号加标题一行,所答各项一行", () => {
  const text = roundAnswerText(ROUND, [["月末统一"], ["审批人", "抄送人"]]);
  assert.equal(
    text,
    [
      "提问轮次的回答:",
      "",
      "1. 汇率取哪一天的",
      "- 月末统一",
      "",
      "2. 撤回之后谁收到通知",
      "- 审批人",
      "- 抄送人",
    ].join("\n"),
  );
});

test("合成的消息读得回原答案,自填的「其他」与选项同形", () => {
  const answers = [["按结账日,财务那边以它为准"], ["审批人"]];
  const back = roundAnswersFrom(roundAnswerText(ROUND, answers), ROUND);
  assert.deepEqual(back, answers);
});

test("自填文字本身以编号开头也读得回来:答案行先判「- 」", () => {
  const answers = [["1. 先按提交当天,下个季度再说"], ["抄送人"]];
  const back = roundAnswersFrom(roundAnswerText(ROUND, answers), ROUND);
  assert.deepEqual(back, answers);
});

test("不是这一轮答案的消息一律读不回来:卡片据此渲染成过期", () => {
  // 人自己打的一段话。
  assert.equal(roundAnswersFrom("先别管汇率,把撤回做了", ROUND), undefined);
  // 抬头对得上,题数对不上(另一轮的答案)。
  const other: QuestionRound = { questions: [ROUND.questions[0]!] };
  assert.equal(roundAnswersFrom(roundAnswerText(other, [["月末统一"]]), ROUND), undefined);
  // 有题一项都没答。
  assert.equal(roundAnswersFrom(roundAnswerText(ROUND, [["月末统一"], []]), ROUND), undefined);
});

test("条目里的一轮题形状不对即认不出来:不摊成一段 JSON", () => {
  assert.deepEqual(parseQuestionRound({ questions: [] }), undefined);
  assert.deepEqual(parseQuestionRound({ questions: [{ title: "", options: [{ text: "a" }] }] }), undefined);
  assert.deepEqual(parseQuestionRound({ questions: [{ title: "问", options: [] }] }), undefined);
  assert.deepEqual(parseQuestionRound("提问"), undefined);
  assert.deepEqual(
    parseQuestionRound({
      questions: [{ title: "问", body: "干", options: [{ text: "甲", recommended: true }] }],
    }),
    {
      questions: [
        { title: "问", body: "干", options: [{ text: "甲", recommended: true }], multiple: false },
      ],
    },
  );
});
