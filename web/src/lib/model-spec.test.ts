import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelSpecProjection } from "../../../src/contracts/model-specs.ts";
import { modelSpecDraft, modelSpecEditor, modelSpecTargetChanged, parseModelSpecDraft, rebaseModelSpecEditor, sameModelSpecOverrides } from "./model-spec.ts";

const fields = { input: ["text"] as const, reasoning: true, contextWindow: 128000, maxTokens: 16000, thinkingLevelMap: { off: null, high: "high" }, compat: { supportsStore: false } };
const projection: ModelSpecProjection = { currentVersion: 3, targetFingerprint: "target-a", automaticFields: fields, effectiveFields: fields, overrides: {} };
test("自动字段不提交，逐字段恢复自动，显式 false 与空对象保留", () => {
  const draft = modelSpecDraft(projection);
  assert.deepEqual(parseModelSpecDraft(draft).overrides, {});
  draft.enabled.reasoning = true;
  draft.reasoning = false;
  draft.enabled.compat = true;
  draft.compat = "{}";
  draft.enabled.thinkingLevelMap = true;
  draft.thinkingLevelMap = "{}";
  assert.deepEqual(parseModelSpecDraft(draft).overrides, { reasoning: false, compat: {}, thinkingLevelMap: {} });
  draft.enabled.reasoning = false;
  assert.equal(Object.hasOwn(parseModelSpecDraft(draft).overrides, "reasoning"), false);
  assert.deepEqual(projection.overrides, {});
});

test("覆盖初值来自生效规格，maxTokens 对应最大输出且保留七档映射", () => {
  const overrides = { input: ["image"] as const, maxTokens: 384000, thinkingLevelMap: { off: null, minimal: "a", low: "b", medium: "c", high: "d", xhigh: "e", max: "f" } };
  const draft = modelSpecDraft({ ...projection, overrides, effectiveFields: { ...fields, ...overrides } });
  assert.deepEqual(parseModelSpecDraft(draft).overrides, overrides);
});

test("容量拒绝空白、非整数、非十进制与数据库越界值", () => {
  for (const field of ["contextWindow", "maxTokens"] as const) {
    for (const value of ["", " ", "0", "-1", "1.5", "1e3", "0x10", "NaN", "Infinity", "2147483648", "9007199254740993"]) {
      const draft = modelSpecDraft(projection);
      draft.enabled[field] = true;
      draft[field] = value;
      assert.equal(parseModelSpecDraft(draft).valid, false, `${field}: ${value}`);
    }
    for (const value of ["1", "2147483647"]) {
      const draft = modelSpecDraft(projection);
      draft.enabled[field] = true;
      draft[field] = value;
      assert.equal(parseModelSpecDraft(draft).overrides[field], Number(value));
    }
  }
});

test("空输入与重复输入拒绝，高级字段只收对象，映射拒绝未知档位与非法值", () => {
  const draft = modelSpecDraft(projection);
  draft.enabled.input = true;
  for (const input of [[], ["text", "text"]] as const) {
    draft.input = input;
    assert.ok(parseModelSpecDraft(draft).errors.input);
  }
  draft.enabled.input = false;
  for (const field of ["compat", "thinkingLevelMap"] as const) {
    draft.enabled[field] = true;
    for (const text of ["{", "null", "[]", "true", '"value"', "12"]) {
      draft[field] = text;
      assert.ok(parseModelSpecDraft(draft).errors[field]);
    }
    draft.enabled[field] = false;
  }
  draft.enabled.thinkingLevelMap = true;
  for (const text of ['{"unknown":"high"}', '{"high":1}', '{"off":false}']) {
    draft.thinkingLevelMap = text;
    assert.ok(parseModelSpecDraft(draft).errors.thinkingLevelMap);
  }
});

test("409 更新版本和自动值并保留草稿，目标变化及无法确认时封住旧草稿", () => {
  const editor = modelSpecEditor(projection);
  editor.draft.enabled.contextWindow = true;
  editor.draft.contextWindow = "1000000";
  const current = { ...projection, currentVersion: 4, automaticFields: { ...fields, contextWindow: 256000 } };
  const rebased = rebaseModelSpecEditor(editor, current);
  assert.equal(rebased.baseline.currentVersion, 4);
  assert.equal(rebased.baseline.automaticFields.contextWindow, 256000);
  assert.equal(rebased.draft.contextWindow, "1000000");
  assert.equal(modelSpecTargetChanged(rebased, current), false);
  const changed = { ...current, targetFingerprint: "target-b" };
  assert.equal(modelSpecTargetChanged(rebased, changed), true);
  const blocked = rebaseModelSpecEditor(rebased, changed);
  assert.equal(modelSpecTargetChanged(blocked, changed), true);
  assert.equal(modelSpecTargetChanged(rebaseModelSpecEditor(blocked, projection), projection), true);
  assert.equal(modelSpecTargetChanged(rebaseModelSpecEditor(editor, null), projection), true);
  assert.equal(modelSpecTargetChanged(modelSpecEditor(changed), changed), false);
});

test("原样保存判得出来，键序与嵌套键序不影响比较", () => {
  assert.equal(sameModelSpecOverrides({}, {}), true);
  assert.equal(sameModelSpecOverrides({ reasoning: false }, { reasoning: true }), false);
  assert.equal(sameModelSpecOverrides({ reasoning: false }, {}), false);
  assert.equal(sameModelSpecOverrides(
    { compat: { supportsStore: false, thinkingFormat: "deepseek" }, input: ["text", "image"] },
    { input: ["text", "image"], compat: { thinkingFormat: "deepseek", supportsStore: false } },
  ), true);
  assert.equal(sameModelSpecOverrides({ input: ["text", "image"] }, { input: ["image", "text"] }), false);
  assert.equal(sameModelSpecOverrides({ thinkingLevelMap: {} }, { thinkingLevelMap: { off: null } }), false);
});
