/**
 * 前缀下的页面与静态产物(issue #33)。
 *
 * 前端逻辑不做程序化测试(布局与交互由原型定稿),这里压的是服务端可测的两半:
 * index.html 的前缀注入与 `/assets` 的文件服务。深层路由刷新、注入形状、路径穿越
 * 都在 HTTP 缝上验。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createWebhookServer } from "../src/webhook/server.ts";
import { makeCacheDir, makeDbPath } from "./support/git-fixture.ts";

const PREFIX = "pages-prefix";

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
    panelPrefix: PREFIX,
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

test("前缀页面返回注入了前缀全局变量的 index.html", async () => {
  const h = await startPages();

  const response = await h.get(`/${PREFIX}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const html = await response.text();
  // 注入形状与 dev 的 Vite 插件逐字一致——前端只认这一个全局变量。
  assert.match(html, /window\.__MULTIREVIEWER__ = \{"prefix":"pages-prefix"\};/);
  assert.match(html, /<div id="root">/);
});

test("深层路由刷新不白屏:任意前缀下路径都回同一份注入过的 index.html", async () => {
  const h = await startPages();

  for (const path of [`/${PREFIX}/`, `/${PREFIX}/repos`, `/${PREFIX}/runs/deep/route`]) {
    const response = await h.get(path);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /window\.__MULTIREVIEWER__/);
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
  for (const path of [
    "/assets/%2e%2e/secret.txt",
    "/assets/%2e%2e%2fsecret.txt",
    "/assets/..%2fsecret.txt",
  ]) {
    const response = await h.get(path);
    assert.equal(response.status, 404, path);
  }
});

test("前端产物缺失时页面回 503 并说明部署缺口,不与 404 混淆", async () => {
  const h = await startPages({ withDist: false });

  const page = await h.get(`/${PREFIX}/repos`);
  assert.equal(page.status, 503);
  assert.match(await page.text(), /web\/dist|MULTIREVIEWER_PANEL_DIST/);

  // 前缀猜错仍是裸 404:503 只出现在真前缀下。
  assert.equal((await h.get("/wrong-prefix/repos")).status, 404);
  assert.equal((await h.get("/assets/app.js")).status, 404);
});
