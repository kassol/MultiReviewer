/*
 * 阅读视图标题与下载文件名的单测。钉的是「问题优先、答卷与空问题退回正文标题」这一条取法。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { replyFileName, replyTitle } from "./reply-title.ts";
import { ROUND_ANSWER_HEAD } from "./session-question-round.ts";

const BODY = "前言一句\n\n## 结论\n\n正文";

test("有问题时标题取问题全文", () => {
  assert.equal(replyTitle("  汇率取哪一天的?\n补充一句  ", BODY), "汇率取哪一天的?\n补充一句");
});

test("提问轮次的答卷与空问题退回正文第一个标题", () => {
  assert.equal(replyTitle(`${ROUND_ANSWER_HEAD}\n\n1. 汇率\n- 提交当天`, BODY), "结论");
  assert.equal(replyTitle("   ", BODY), "结论");
  assert.equal(replyTitle(undefined, BODY), "结论");
});

test("问题与正文标题都没有时用通用说法", () => {
  assert.equal(replyTitle(undefined, "只有正文"), "agent 回复");
});

test("文件名取标题头一行、去掉非法字符并截 60 字", () => {
  assert.equal(replyFileName("a/b: c?\n第二行", "2026-09-24T02:00:00.000Z"), "a b c.md");
  assert.equal(replyFileName("字".repeat(80), "x").length, 63);
  assert.equal(replyFileName(" /?\n", "2026-09-24T02:00:00.000Z"), "agent-reply-2026-09-24T02-00-00-000Z.md");
});
