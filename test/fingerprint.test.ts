import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  contentFingerprint,
  fileFingerprints,
  fingerprintAnchor,
  parseFingerprintAnchors,
  relocatedLine,
} from "../src/review/fingerprint.ts";
import { testCleanups } from "./support/git-fixture.ts";

test("body 不是字符串时返回空数组,不抛", () => {
  // listReviewBodies 直接把平台读回的 review.body push 进来,理论上可能是 null。
  // 单点在这里挡住:任一条正文异常不该把整轮 Review Run 带崩。
  assert.deepEqual(parseFingerprintAnchors(null as unknown as string), []);
  assert.deepEqual(parseFingerprintAnchors(undefined as unknown as string), []);
});

test("空正文与无锚点正文都返回空数组", () => {
  assert.deepEqual(parseFingerprintAnchors(""), []);
  assert.deepEqual(parseFingerprintAnchors("这个 PR 我看过了,没问题"), []);
});

const A = "a".repeat(64);
const B = "b".repeat(64);

test("行级评论的锚点只有指纹,不带文件路径", () => {
  assert.deepEqual(parseFingerprintAnchors(`说明\n\n${fingerprintAnchor(A)}`), [
    { fingerprint: A, file: undefined },
  ]);
});

test("锚定收敛之前发出去的正文锚点另带文件路径,仍要认得出", () => {
  // 这一形态不再新增(issue #224),存量 PR 的正文里还挂着,跨轮匹配靠它。
  const body = [
    "以下 Finding 的行号落在本次 Review Range 的 diff 之外:",
    `<!-- multireviewer:${A}:src/calc.js -->`,
    `<!-- multireviewer:${B}:src/other.js -->`,
  ].join("\n\n");

  // 取全部而不是第一个:只认第一个会让其余的 Finding 每轮重发。
  assert.deepEqual(parseFingerprintAnchors(body), [
    { fingerprint: A, file: "src/calc.js" },
    { fingerprint: B, file: "src/other.js" },
  ]);
});

/**
 * 每轮开跑时的位置重定位(issue #368)。指纹窗口是 7 行,下面这一块两端各留 3 行,
 * 整扇窗口因此只由这 7 行决定,块外怎么加料都不改它的指纹。
 */
const BLOCK = [
  "const b1 = 1;",
  "const b2 = 2;",
  "const b3 = 3;",
  "const target = 4;",
  "const b5 = 5;",
  "const b6 = 6;",
  "const b7 = 7;",
];

/** 块外的填充行,与块内各行都不同:它们自己那几扇窗口不会与块的指纹撞上。 */
function filler(tag: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `const ${tag}${index} = 0;`);
}

/** 把几行写成一份工作副本里的一个文件,返回那份工作副本的路径。 */
function worktreeWith(lines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-fingerprint-"));
  testCleanups().push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "calc.js"), `${lines.join("\n")}\n`);
  return dir;
}

test("位置重定位:整块下移 10 行,旧指纹解析到新行", () => {
  const before = contentFingerprint(worktreeWith(BLOCK), "calc.js", 4)!;
  const after = fileFingerprints(worktreeWith([...filler("p", 10), ...BLOCK]), "calc.js");

  assert.deepEqual(after.get(before), [14]);
  assert.equal(relocatedLine(after.get(before), 4), 14);
});

test("位置重定位:同一扇窗口出现两次时取离旧位置最近的那一处", () => {
  const before = contentFingerprint(worktreeWith(BLOCK), "calc.js", 4)!;
  const after = fileFingerprints(
    worktreeWith([...filler("p", 3), ...BLOCK, ...filler("q", 3), ...BLOCK]),
    "calc.js",
  );

  // 两块落在 4..10 与 14..20 行,窗口都整扇落在块内,目标行因此是第 7 行与第 17 行。
  assert.deepEqual(after.get(before), [7, 17]);
  assert.equal(relocatedLine(after.get(before), 6), 7);
  assert.equal(relocatedLine(after.get(before), 18), 17);
});

test("位置重定位:两处一样近时位置不变", () => {
  const before = contentFingerprint(worktreeWith(BLOCK), "calc.js", 4)!;
  const after = fileFingerprints(
    worktreeWith([...filler("p", 3), ...BLOCK, ...filler("q", 3), ...BLOCK]),
    "calc.js",
  );

  // 第 12 行离第 7 行与第 17 行各 5 行:挑哪一处都是五五开,不猜。
  assert.equal(relocatedLine(after.get(before), 12), undefined);
});

test("位置重定位:那处代码被改写之后一个指纹都解析不到", () => {
  const before = contentFingerprint(worktreeWith(BLOCK), "calc.js", 4)!;
  const rewritten = BLOCK.map((line) =>
    line === "const target = 4;" ? "const target = compute(4);" : line,
  );
  const after = fileFingerprints(worktreeWith([...filler("p", 10), ...rewritten]), "calc.js");

  assert.equal(after.get(before), undefined);
  assert.equal(relocatedLine(after.get(before), 4), undefined);
});
