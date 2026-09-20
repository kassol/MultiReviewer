import assert from "node:assert/strict";
import { test } from "node:test";

import { languageOf, splitHighlightedLines } from "./highlight-lines.ts";

test("跨行的 span 在行尾闭合、下一行重开", () => {
  assert.deepEqual(
    splitHighlightedLines('a <span class="c">/* x\n y */</span> b\n<span class="k">if</span>'),
    ['a <span class="c">/* x</span>', '<span class="c"> y */</span> b', '<span class="k">if</span>'],
  );
});

test("嵌套的 span 按原顺序重开", () => {
  assert.deepEqual(splitHighlightedLines('<span class="s">"<span class="e">\\\n</span>"</span>'), [
    '<span class="s">"<span class="e">\\</span></span>',
    '<span class="s"><span class="e"></span>"</span>',
  ]);
});

test("行数与输入的换行数一致,空行保留", () => {
  assert.equal(splitHighlightedLines("a\n\nb").length, 3);
});

test("按扩展名认语言,认不出的不高亮", () => {
  assert.equal(languageOf("ai/src/main/java/Foo.java"), "java");
  assert.equal(languageOf("web/src/a.test.TSX"), "typescript");
  assert.equal(languageOf("Makefile"), "makefile");
  assert.equal(languageOf("LICENSE"), undefined);
  assert.equal(languageOf("data.bin"), undefined);
});
