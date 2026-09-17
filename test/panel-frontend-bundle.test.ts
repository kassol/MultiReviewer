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
    const credentialsSource = readFileSync(join(process.cwd(), "web/src/credentials.tsx"), "utf8");
    const comboboxSource = readFileSync(join(process.cwd(), "web/src/components/editable-model-combobox.tsx"), "utf8");

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
    // 触控命中区(issue #370):44px 地板只写在设计系统层这一处,页面不再各补各的。
    // 这里断言的是产物,不是源码——规则要真的落进未分层的那段 CSS 才盖得过 Radix。
    const coarse = stylesheet.slice(stylesheet.indexOf("@media(pointer:coarse){.radix-themes"));
    assert.ok(coarse.length > 0, "未分层的粗指针规则块");
    for (const covered of [".rt-BaseMenuItem", ".rt-SelectItem", ".rt-BaseTabListTrigger"]) {
      assert.match(coarse, new RegExp(`${covered.replace(".", "\\.")},?[^{]*\\{min-height:44px\\}`), covered);
    }
    assert.match(coarse, /\.rt-Button,\.rt-IconButton\)\{min-width:44px\}/);
    assert.match(coarse, /\[data-slot=command-input\]\)\{height:44px\}/);
    // Checkbox 与 Switch 只长命中区不长视觉:补的是伪元素,不是控件自己的尺寸。
    assert.match(coarse, /:where\(\.rt-BaseCheckboxRoot,\.rt-SwitchRoot\):after\{content:""/);
    assert.doesNotMatch(coarse, /:where\(\.rt-BaseCheckboxRoot,\.rt-SwitchRoot\)\{/);
    assert.match(coarse, /:where\(\.rt-CheckboxGroupItem,\.rt-RadioGroupItem\)\{[^}]*min-height:44px/);
    // 「我的」菜单贴着 Tab 栏开,末项的命中区要离 Tab 栏 8px。
    assert.match(javascript, /sideOffset:8/);
    // 模型标识换行(issue #380):模型服务页与它的模型组合框不再用 `break-all`,
    // 否则 `claude-opus-latest` 在窄屏上被切成 `claude-opus-lat` / `est`。
    for (const source of [credentialsSource, comboboxSource]) {
      assert.doesNotMatch(source, /className="[^"]*break-all/);
      assert.match(source, /wrap-anywhere font-mono/);
    }
    assert.match(stylesheet, /\.wrap-anywhere\{overflow-wrap:anywhere\}/);
    // 配置模型服务向导窄屏顶靠(issue #380):居中会把页脚推进软键盘盖住的那一段。
    // 与 44px 地板同在未分层的那一段,Themes 的居中写在 radix 层里,盖得过。
    assert.match(
      coarse,
      /\(min-width:40rem\)\{\.rt-BaseDialogScrollPadding:has\(>#model-service-setup-dialog\)\{margin-top:0\}/,
    );
    assert.match(javascript, /id:"model-service-setup-dialog"/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
