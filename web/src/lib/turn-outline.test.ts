/*
 * 轮次导航的单测。钉的是「一轮 = 一条用户消息到下一条之前,摘要取这一轮最后一条回复」这条切法。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ConversationGroup } from "./agent-session-records.ts";
import { ROUND_ANSWER_HEAD } from "./session-question-round.ts";
import { plainText, turnOutline } from "./turn-outline.ts";

const user = (seq: number, text: string, images: string[] = []): ConversationGroup => ({
  kind: "user",
  seq,
  at: "",
  text,
  images,
});
const reply = (seq: number, text: string): ConversationGroup => ({ kind: "assistant", seq, at: "", text });

test("每条用户消息起一轮,摘要取这一轮最后一条回复", () => {
  const turns = turnOutline([
    reply(1, "开场白不属于任何一轮"),
    user(2, "\n  第一问\n补充"),
    reply(3, "先说一句"),
    reply(4, "**结论**:没有入口。"),
    user(5, "第二问"),
  ]);
  assert.deepEqual(turns, [
    { seq: 2, question: "第一问", summary: "结论:没有入口。" },
    { seq: 5, question: "第二问", summary: undefined },
  ]);
});

test("答卷与只有图片的消息给一句说法", () => {
  const turns = turnOutline([user(1, `${ROUND_ANSWER_HEAD}\n\n1. a`), user(2, "", ["img"])]);
  assert.deepEqual(
    turns.map((turn) => turn.question),
    ["回答提问轮次", "发了图片"],
  );
});

test("摘要去掉 Markdown 记号与代码围栏", () => {
  assert.equal(
    plainText("## 标题\n\n- 看 `a.ts:12` 与 [文档](http://x)\n\n```ts\nconst a = 1;\n```\n> 引用"),
    "标题 看 a.ts:12 与 文档 引用",
  );
});

test("标识符里的下划线原样保留", () => {
  assert.equal(plainText("权限 `BUTTON_DC_TASK_LIST_DL` 与 __粗__、*斜*"), "权限 BUTTON_DC_TASK_LIST_DL 与 粗、斜");
});
