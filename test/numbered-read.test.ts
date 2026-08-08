/**
 * 带行号的 read 输出。行号是模型报 Finding 时抄的对象,打错号等于把行号漂移
 * 从"模型数错"换成"服务端印错",必须钉死。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { numberedRead } from "../src/reviewer/numbered-read.ts";

test("每行带 1-indexed 行号前缀", () => {
  assert.equal(numberedRead("a\nb\nc"), "1: a\n2: b\n3: c");
});

test("结尾换行不产生幽灵行", () => {
  assert.equal(numberedRead("a\nb\n"), "1: a\n2: b");
});

test("中间的空行保留并占号", () => {
  assert.equal(numberedRead("a\n\nc"), "1: a\n2: \n3: c");
});

test("offset 与 limit 圈定范围,行号仍是文件里的绝对行号", () => {
  assert.equal(numberedRead("a\nb\nc\nd", 2, 2), "2: b\n3: c\n\n[Showing lines 2-3 of 4. Use offset=4 to continue.]");
});

test("读到文件末尾时不出现续读提示", () => {
  assert.equal(numberedRead("a\nb", 2), "2: b");
});

test("offset 超出文件末尾时报错", () => {
  assert.throws(() => numberedRead("a\nb", 5), /beyond end of file/);
});

test("超长文件被截断并给出续读提示", () => {
  const content = Array.from({ length: 1500 }, (_, i) => `line${i + 1}`).join("\n");
  const output = numberedRead(content);
  const lines = output.split("\n");
  assert.equal(lines[0], "1: line1");
  assert.equal(lines[999], "1000: line1000");
  assert.match(output, /\[Showing lines 1-1000 of 1500\. Use offset=1001 to continue\.\]/);
});
