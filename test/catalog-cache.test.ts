/**
 * 模型目录的进程内缓存(issue #67)。缓存是模块级状态,所以这一条单独一个文件跑:
 * node:test 一个文件一个进程,第一次读目录的必定是这里的用例,顺序也因此是判据的一部分。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  invalidateModelCatalog,
  modelCatalog,
  type Catalog,
} from "../src/reviewer/catalog.ts";

const ONE: Catalog = {
  remote: "ok",
  providers: [{ id: "acme", name: "Acme", models: [] }],
};

test("读失败不进缓存:下一次请求重来,读成功之后才只读一次", async () => {
  await assert.rejects(
    modelCatalog(() => Promise.reject(new Error("目录读不到"))),
    /目录读不到/,
  );

  // 失败的 promise 留在缓存里的话,这个进程再也拿不到目录,选择器空白到重启为止。
  let calls = 0;
  const load = (): Promise<Catalog> => {
    calls += 1;
    return Promise.resolve(ONE);
  };
  assert.deepEqual(await modelCatalog(load), ONE);
  assert.equal(calls, 1);

  // 读成功的那一份留在缓存里,后续请求不重复解析。
  assert.deepEqual(await modelCatalog(load), ONE);
  assert.equal(calls, 1);
});

/**
 * 显式失效。缓存住的是 Pi 的那张模型表,而下一票要往目录里加模型行——加完读到的还是
 * 旧的那一份,写入就等于没发生。
 *
 * 自己播种前置缓存,不吃上一条留下的模块级状态:`--test-name-pattern` 单跑这一条、或
 * `--test-randomize` 把顺序打乱时,借来的前置状态会变成假失败。
 */
test("显式失效之后下一次请求重新读一份,连续失效不出错", async () => {
  const TWO: Catalog = { remote: "off", providers: [] };
  let calls = 0;
  const load = (): Promise<Catalog> => {
    calls += 1;
    return Promise.resolve(TWO);
  };

  invalidateModelCatalog();
  assert.deepEqual(await modelCatalog(() => Promise.resolve(ONE)), ONE);
  assert.equal(calls, 0, "播种那一次不该走到本条的 loader");

  // 缓存里现在是 ONE:不失效的话根本读不到新的那一份。
  assert.deepEqual(await modelCatalog(load), ONE);
  assert.equal(calls, 0);

  invalidateModelCatalog();
  assert.deepEqual(await modelCatalog(load), TWO);
  assert.equal(calls, 1);

  // 失效一次只失效一次:重读之后又回到缓存态。
  assert.deepEqual(await modelCatalog(load), TWO);
  assert.equal(calls, 1);

  // 幂等:连续调用不抛,也不额外触发加载。
  invalidateModelCatalog();
  invalidateModelCatalog();
  assert.deepEqual(await modelCatalog(load), TWO);
  assert.equal(calls, 2);
});

/**
 * 一次读还在飞的时候有人失效了缓存,后来的请求存进一份新的,而先前那一份此刻才失败。
 * 无条件清缓存会把新的一起清掉:一次失效引出两轮加载,而且新的那一份成功了也留不住。
 */
test("在飞的读失败时不清掉失效后存进来的那一份", async () => {
  invalidateModelCatalog();

  let failFirst: (error: Error) => void = () => {};
  const first = modelCatalog(
    () =>
      new Promise<Catalog>((_resolve, reject) => {
        failFirst = reject;
      }),
  );

  // 第一份还没落地就失效,第二份随即存进缓存。
  invalidateModelCatalog();
  let calls = 0;
  const load = (): Promise<Catalog> => {
    calls += 1;
    return Promise.resolve(ONE);
  };
  assert.deepEqual(await modelCatalog(load), ONE);
  assert.equal(calls, 1);

  failFirst(new Error("先前那一份读不到"));
  await assert.rejects(first, /先前那一份读不到/);

  // 第二份必须还在缓存里:被清掉的话这里会再加载一次。
  assert.deepEqual(await modelCatalog(load), ONE);
  assert.equal(calls, 1, "在飞的失败把失效后存进来的那一份也清掉了");
});
