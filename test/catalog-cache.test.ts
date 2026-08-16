/**
 * 模型目录的进程内缓存(issue #67)。缓存是模块级状态,所以这一条单独一个文件跑:
 * node:test 一个文件一个进程,第一次读目录的必定是这里的用例,顺序也因此是判据的一部分。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { modelCatalog, type CatalogProvider } from "../src/reviewer/catalog.ts";

const ONE: CatalogProvider[] = [{ id: "acme", name: "Acme", models: [] }];

test("读失败不进缓存:下一次请求重来,读成功之后才只读一次", async () => {
  await assert.rejects(
    modelCatalog(() => Promise.reject(new Error("目录读不到"))),
    /目录读不到/,
  );

  // 失败的 promise 留在缓存里的话,这个进程再也拿不到目录,选择器空白到重启为止。
  let calls = 0;
  const load = (): Promise<CatalogProvider[]> => {
    calls += 1;
    return Promise.resolve(ONE);
  };
  assert.deepEqual(await modelCatalog(load), ONE);
  assert.equal(calls, 1);

  // 读成功的那一份留在缓存里,后续请求不重复解析。
  assert.deepEqual(await modelCatalog(load), ONE);
  assert.equal(calls, 1);
});
