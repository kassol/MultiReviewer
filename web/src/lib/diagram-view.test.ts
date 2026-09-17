/*
 * 图表预览画布变换的单测(issue #377)。缩放的锚点算错一项,表现只是「放大时图往一边飞」;
 * 「适应」算错一项,窄屏上就是一张 25% 的图。两样都在画布里,眼睛回归一次要开好几张图。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clampScale,
  fitView,
  MAX_SCALE,
  MIN_SCALE,
  pinchView,
  zoomAround,
  type DiagramView,
  type PointerPair,
} from "./diagram-view.ts";

/** 画布上的 x 对应图上的哪一处。缩放前后它不变,才叫「绕这个点缩放」。 */
function contentX(view: DiagramView, x: number) {
  return (x - view.x) / view.scale;
}

function near(actual: number, expected: number, what: string) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} ≠ ${expected}`);
}

test("绕锚点缩放:锚点下的那一处留在原地", () => {
  const view: DiagramView = { scale: 1, x: 30, y: -20 };
  const next = zoomAround(view, 2.5, 200, 120);
  assert.equal(next.scale, 2.5);
  near(contentX(next, 200), contentX(view, 200), "锚点横向");
  near((120 - next.y) / next.scale, (120 - view.y) / view.scale, "锚点纵向");
});

test("倍率钳在 0.25 与 8 之间,钳住之后锚点照样不动", () => {
  assert.equal(clampScale(0.01), MIN_SCALE);
  assert.equal(clampScale(99), MAX_SCALE);
  const view: DiagramView = { scale: 1, x: 0, y: 0 };
  const next = zoomAround(view, 99, 50, 50);
  assert.equal(next.scale, MAX_SCALE);
  near(contentX(next, 50), contentX(view, 50), "锚点横向");
});

test("双指张开:间距翻倍即倍率翻倍,中点下的那一处不动", () => {
  const view: DiagramView = { scale: 1, x: 0, y: 0 };
  const from: PointerPair = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];
  const to: PointerPair = [
    { x: -50, y: 0 },
    { x: 150, y: 0 },
  ];
  const next = pinchView(view, from, to);
  assert.equal(next.scale, 2);
  near(contentX(next, 50), contentX(view, 50), "中点横向");
});

test("双指同向平移:倍率不变,图跟着中点走", () => {
  const view: DiagramView = { scale: 1.5, x: 10, y: 10 };
  const next = pinchView(
    view,
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    [
      { x: 10, y: 20 },
      { x: 110, y: 20 },
    ],
  );
  assert.equal(next.scale, 1.5);
  near(next.x, 20, "平移后的 x");
  near(next.y, 30, "平移后的 y");
});

test("逐步算:顶到上界再反向捏,图立刻跟手", () => {
  const spread: PointerPair = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];
  const wide: PointerPair = [
    { x: -50, y: 0 },
    { x: 150, y: 0 },
  ];
  const capped = pinchView({ scale: MAX_SCALE, x: 0, y: 0 }, spread, wide);
  assert.equal(capped.scale, MAX_SCALE);
  assert.equal(pinchView(capped, wide, spread).scale, MAX_SCALE / 2);
});

test("适应:宽画布两轴一起装下并居中", () => {
  const view = fitView({ width: 1200, height: 800 }, { width: 2400, height: 800 });
  assert.equal(view.scale, 0.5);
  assert.equal(view.x, 0);
  assert.equal(view.y, 200);
});

test("适应:窄画布只按宽度装,高度溢出时从顶上开始", () => {
  const canvas = { width: 358, height: 700 };
  const diagram = { width: 1200, height: 3000 };
  const view = fitView(canvas, diagram);
  near(view.scale, canvas.width / diagram.width, "按宽适应的倍率");
  near(view.x, 0, "横向对齐");
  assert.equal(view.y, 0);
  // 两轴一起装的话是 0.233,图上的字认不出来。
  assert.ok(view.scale > canvas.height / diagram.height);
});

test("适应:窄画布上图比画布矮时仍然纵向居中", () => {
  const view = fitView({ width: 358, height: 700 }, { width: 716, height: 400 });
  assert.equal(view.scale, 0.5);
  assert.equal(view.y, 250);
});
