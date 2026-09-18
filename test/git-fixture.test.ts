/**
 * 夹具仓库的隔离(issue #400)。同一份选项的仓库由一份模板复制而来,复制之后两份仓库
 * 必须互不相干:一条用例的提交、分支与删除落在自己那份上,别的用例读不到。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { makeRepo } from "./support/git-fixture.ts";

const OPTIONS = {
  base: { "src/a.ts": "export const a = 1;\n" },
  head: { "src/a.ts": "export const a = 2;\n" },
};

test("同一份选项建两个仓库:两端相同,而各自的写入互不可见", () => {
  const first = makeRepo(OPTIONS);
  const second = makeRepo(OPTIONS);

  assert.notEqual(first.dir, second.dir);
  assert.equal(first.baseSha, second.baseSha);
  assert.equal(first.headSha, second.headSha);

  // 往第一份推一个提交:第二份的 head 分支一动不动。
  const pushed = first.pushToHead({ "src/a.ts": "export const a = 3;\n" });
  assert.equal(first.branchSha("feature"), pushed);
  assert.equal(second.branchSha("feature"), second.headSha);

  // 建分支与删分支同样只落在自己那一份上。
  first.setBranch("only-first", first.baseSha);
  assert.equal(second.branchSha("only-first"), undefined);
  second.deleteBranch("feature");
  assert.equal(first.branchSha("feature"), pushed);

  first.cleanup();
  second.cleanup();
});
