/*
 * 阶段行警示文案的单测(issue #424)。三档任意组合共七种,而看得见的那几个字要把每一档
 * 都说出来——少说一档,人就按「只有模型没跑成」去排障,收尾失败那一半从此没人知道。
 * 七种全钉住,拼句子的规则因此改不坏。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { stageAlertDetail, stageAlertText, type StageRunAlert } from "./stage-alert.ts";

/** 三档的开关拼成一个警示。收尾失败那一档带原因第一行,它非空即这一档成立。 */
function alert(model: boolean, batch: boolean, closing: string | null): StageRunAlert {
  return { modelFailed: model, batchFailed: batch, closingFailure: closing };
}

test("徽章文案:七种组合各说各的,每一档都落在看得见的字里", () => {
  assert.equal(stageAlertText(alert(true, false, null)), "上一轮有模型没跑成");
  assert.equal(stageAlertText(alert(false, true, null)), "上一轮有批次没跑成");
  assert.equal(stageAlertText(alert(true, true, null)), "上一轮有模型与批次没跑成");
  assert.equal(stageAlertText(alert(false, false, "x")), "上一轮没有正常收尾");
  assert.equal(stageAlertText(alert(true, false, "x")), "上一轮有模型没跑成，没有正常收尾");
  assert.equal(stageAlertText(alert(false, true, "x")), "上一轮有批次没跑成，没有正常收尾");
  assert.equal(stageAlertText(alert(true, true, "x")), "上一轮有模型与批次没跑成，没有正常收尾");
});

test("悬停整句:收尾失败那一档带上原因,其余两档不受影响", () => {
  const detail = stageAlertDetail(alert(true, false, "发布 review 失败：Gitea 回了 500"));
  assert.match(detail, /有模型整轮没跑成/);
  assert.match(detail, /发布 review 失败：Gitea 回了 500$/);
  assert.doesNotMatch(stageAlertDetail(alert(true, true, null)), /收尾/);
});
