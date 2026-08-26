import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("生产面板包含局部滚动、模型增量展示与路由弹窗返回入口", () => {
  const dist = mkdtempSync(join(tmpdir(), "multireviewer-web-build-"));
  try {
    execFileSync(
      "pnpm",
      ["--filter", "@multireviewer/web", "exec", "vite", "build", "--outDir", dist],
      { cwd: process.cwd(), stdio: "pipe" },
    );
    const assets = join(dist, "assets");
    const javascript = readdirSync(assets)
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(join(assets, name), "utf8"))
      .join("\n");
    const stylesheet = readdirSync(assets)
      .filter((name) => name.endsWith(".css"))
      .map((name) => readFileSync(join(assets, name), "utf8"))
      .join("\n");
    const entrySource = readFileSync(join(process.cwd(), "web/src/main.tsx"), "utf8");
    const styleSource = readFileSync(join(process.cwd(), "web/src/styles.css"), "utf8");
    const masterListSource = readFileSync(join(process.cwd(), "web/src/components/master-list-item.tsx"), "utf8");

    assert.match(javascript, /评审记录列表/);
    // 导航收敛成三层之后(issue #189),阶段页只有一种视图:轮次视图与它的两个入口
    // 一起没了。
    for (const gone of ["回到阶段汇总", "去最新一轮 diff", "本轮 diff"]) {
      assert.doesNotMatch(javascript, new RegExp(gone), gone);
    }
    // 首页就是评审记录(issue #194):总览页与 `/runs` 路由一起删了,左栏首项是「全部仓库」。
    assert.doesNotMatch(javascript, /总览/);
    assert.doesNotMatch(javascript, /to:"\/runs"/);
    assert.match(javascript, /全部仓库/);
    // 管仓库不再离开评审记录(issue #195):仓库页与 `/repos` 路由删了,注册入口在首页左栏。
    assert.doesNotMatch(javascript, /to:"\/repos"/);
    assert.match(javascript, /注册仓库/);
    assert.match(javascript, /再显示/);
    assert.match(javascript, /add-model-service-trigger/);
    assert.match(javascript, /configure-builtin-/);
    assert.match(javascript, /configure-custom-/);
    assert.match(stylesheet, /@layer radix\{/);
    const themeLayer = stylesheet.indexOf("@layer theme{");
    const baseLayer = stylesheet.indexOf("@layer base{");
    const radixLayer = stylesheet.indexOf("@layer radix{");
    const utilityLayer = stylesheet.indexOf("@layer utilities{");
    assert.ok(themeLayer >= 0 && themeLayer < baseLayer);
    assert.ok(baseLayer < radixLayer);
    assert.ok(radixLayer < utilityLayer);
    assert.match(styleSource, /@layer theme, base, radix, components, utilities;/);
    assert.doesNotMatch(entrySource, /@radix-ui\/themes\/styles\.css/);
    assert.doesNotMatch(masterListSource, /selection-solid-hover/);
    assert.match(javascript, /to:"\/credentials",activeOptions:\{exact:!0\}/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
