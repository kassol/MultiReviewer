/**
 * 根路径下的页面与静态产物(issue #33)。
 *
 * 前端逻辑不做程序化测试(布局与交互由原型定稿),这里压的是服务端可测的两半:
 * index.html 的 SPA fallback 与 `/assets` 的文件服务。深层路由刷新、路径穿越都在
 * HTTP 缝上验。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createWebhookServer } from "../src/webhook/server.ts";
import { makeCacheDir, makeDbPath } from "./support/git-fixture.ts";

const INDEX_HTML = `<!doctype html>
<html><head><title>MultiReviewer</title></head><body><div id="root"></div></body></html>
`;
const APP_JS = "console.log('panel');\n";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

async function startPages(options: { withDist?: boolean } = {}) {
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(cache.cleanup, db.cleanup);

  const dist = mkdtempSync(join(tmpdir(), "multireviewer-dist-"));
  cleanups.push(() => rmSync(dist, { recursive: true, force: true }));
  if (options.withDist !== false) {
    writeFileSync(join(dist, "index.html"), INDEX_HTML);
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "assets", "app.js"), APP_JS);
    // dist 根下的文件只有 index.html 会被服务,其他文件不经 /assets 暴露。
    writeFileSync(join(dist, "secret.txt"), "not-served");
  }

  const server = createWebhookServer({
    forges: {},
    buildReviewers: () => [],
    cacheDir: cache.dir,
    dbPath: db.path,
    bootstrapSecret: "pages-bootstrap",
    baseUrl: "https://reviewer.example.test",
    panelDist: options.withDist === false ? join(dist, "missing") : dist,
    onDelivery: () => {},
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });

  return {
    get: (path: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual" }),
  };
}

test("根路径返回 index.html", async () => {
  const h = await startPages();

  const response = await h.get("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await response.text(), /<div id="root">/);
});

test("深层路由刷新不白屏:任意页面路径都回同一份 index.html", async () => {
  const h = await startPages();

  // 阶段详情的地址把阶段标识编码成一段(issue #175),刷新它同样要回到 index.html。
  // 侧滑与列表的仓库过滤都写在地址上(issue #189、#194),刷新它们也是同一份 index.html。
  // 首页就是评审记录,选中的仓库写在它的查询参数上(issue #194);仓库页与 `/repos`
  // 路由已经没了(issue #195),管仓库在首页左栏的行操作里做。
  for (const path of [
    `/`,
    `/stats`,
    `/?owner=acme&repo=widgets&status=active`,
    `/stages/${encodeURIComponent("pr:acme/widgets/7")}?finding=42`,
    `/stages/${encodeURIComponent("pr:acme/widgets/7")}?trace=3`,
  ]) {
    const response = await h.get(path);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /<div id="root">/, path);
  }
});

test("/assets 服务构建产物,带正确的内容类型", async () => {
  const h = await startPages();

  const response = await h.get("/assets/app.js");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/javascript/);
  assert.equal(await response.text(), APP_JS);

  assert.equal((await h.get("/assets/missing.js")).status, 404);
});

test("/assets 的路径穿越被挡住", async () => {
  const h = await startPages();

  // fetch 会把裸 ../ 归一化掉,编码形式才真正打到服务端的解码与包含检查上。
  // 仍落在 `/assets/` 下的一律 404;被 URL 归一化甩出 `/assets/` 的那种走 SPA fallback
  // 回 index.html。断言压在「dist 根下那个文件一个字都出不来」上,而不是状态码。
  for (const path of [
    "/assets/%2e%2e/secret.txt",
    "/assets/%2e%2e%2fsecret.txt",
    "/assets/..%2fsecret.txt",
  ]) {
    const response = await h.get(path);
    assert.equal((await response.text()).includes("not-served"), false, path);
  }

  assert.equal((await h.get("/assets/%2e%2e%2fsecret.txt")).status, 404);
});

test("前端产物缺失时页面回 503 并说明部署缺口,不与 404 混淆", async () => {
  const h = await startPages({ withDist: false });

  const page = await h.get(`/stats`);
  assert.equal(page.status, 503);
  assert.match(await page.text(), /web\/dist|MULTIREVIEWER_PANEL_DIST/);

  // `/assets` 与 webhook 入口不走 SPA fallback:产物缺失时仍是裸 404。
  assert.equal((await h.get("/assets/app.js")).status, 404);
  assert.equal((await h.get("/webhook")).status, 404);
});
