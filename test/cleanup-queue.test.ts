/**
 * 测试收尾队列(`test/support/git-fixture.ts`)。
 *
 * 一条收尾抛错不能让排在它后面的收尾不跑:队列后半截关的是 HTTP 服务与假 Gitea,跳过
 * 它们,监听中的 server 就留在事件循环里——用例全过而测试进程停在 0% CPU 再也退不出去。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { runCleanups } from "./support/git-fixture.ts";

test("一条收尾抛错,后面的收尾照样跑完,失败一起抛出来", async () => {
  const ran: string[] = [];
  const failure = new Error("删临时目录失败");
  await assert.rejects(
    runCleanups([
      () => {
        ran.push("抛错之前");
      },
      () => {
        throw failure;
      },
      async () => {
        ran.push("抛错之后");
      },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure]);
      return true;
    },
  );
  assert.deepEqual(ran, ["抛错之前", "抛错之后"]);
});
