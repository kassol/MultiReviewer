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
    const accessSource = readFileSync(join(process.cwd(), "web/src/access-control.tsx"), "utf8");

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
    // 仓库职责(issue #341):产品页的归属弹窗与每行那一格都带「职责」这个词。
    assert.match(javascript, /职责/);
    // 产品知识(issue #343、#360):产品页右栏那一区的小标题与三段各自的小标题。
    assert.match(javascript, /产品知识/);
    assert.match(javascript, /术语表/);
    assert.match(javascript, /仓库关系/);
    assert.match(javascript, /产品决策/);
    // 默认分支(issue #350):仓库配置弹窗里那个下拉的首项。
    assert.match(javascript, /跟随 Gitea 默认/);
    // 粘性首列(issue #382):横向滚动得发生在 Radix ScrollArea 的视口上,首列的 sticky
    // 才跟着钉住。视口里那层包装默认 `width: fit-content`,横向放不下时把列压成
    // min-content,所以改 max-content——断言产物,这条 utility 要排在 radix layer 之后才盖得过。
    assert.match(stylesheet.slice(utilityLayer), /\.rt-ScrollAreaViewport>\*\{width:max-content\}/);
    // 用户表因此不再自己套一层横向滚动容器。
    assert.doesNotMatch(accessSource, /contain-inline-size/);
    // 确认弹窗关闭有一帧退场动画:`confirm` 清空后再读它,标题就是「删除用户 undefined？」。
    assert.doesNotMatch(accessSource, /删除用户 \$\{confirm\?\./);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
