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

    assert.match(javascript, /评审记录列表/);
    assert.match(javascript, /再显示/);
    assert.match(javascript, /add-model-service-trigger/);
    assert.match(javascript, /configure-builtin-/);
    assert.match(javascript, /configure-custom-/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
