/*
 * 会话名的单测。左栏、会话页头部与顶栏面包屑读同一份,所以「截断了却不带省略号」会在三处
 * 同时把半句话说成全文。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { railSessions, sessionTitle } from "./agent-sessions.ts";

test("没有标题的会话退回用途名", () => {
  assert.equal(sessionTitle(null, "产品梳理"), "产品梳理");
});

test("没截断的标题原样显示", () => {
  assert.equal(sessionTitle("把权限页改成两栏", "开放对话"), "把权限页改成两栏");
});

test("截到上限的标题补省略号", () => {
  const title = "题".repeat(80);
  assert.equal(sessionTitle(title, "开放对话"), `${title}…`);
});

test("左栏会话卡收着时列前几条,当前那一场不在其中也列出来,并留在原位", () => {
  const rows = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id }));
  const ids = (list: { id: number }[]): number[] => list.map((row) => row.id);
  assert.deepEqual(ids(railSessions(rows, undefined, false, 3)), [1, 2, 3]);
  assert.deepEqual(ids(railSessions(rows, 2, false, 3)), [1, 2, 3]);
  assert.deepEqual(ids(railSessions(rows, 7, false, 3)), [1, 2, 3, 7]);
  assert.deepEqual(ids(railSessions(rows, 7, true, 3)), [1, 2, 3, 4, 5, 6, 7, 8]);
});
