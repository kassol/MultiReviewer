/*
 * 「复制为 Markdown」的拼接单测(issue #337)。格式是 spec #330 定的那一份,逐字对:人把它
 * 贴进禅道或文档就直接用,少一行标题或多一个空行都要人手改。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  currentFinalization,
  requirementBreakdownMarkdown,
  type AgentSessionOutputFinalization,
  type RequirementBreakdown,
} from "./agent-session-outputs.ts";

const BREAKDOWN: RequirementBreakdown = {
  summary: "报销单支持多币种:员工按原币录入,提交时锁定当月汇率。",
  assumptions: ["月结汇率由财务手工维护", "单据提交后汇率锁定"],
  openQuestions: ["历史单据要不要补币种字段"],
  items: [
    {
      title: "月结汇率表与维护接口",
      description: "新增月结汇率表,按年月与币种唯一。",
      repo: "expense/backend",
      locations: ["src/finance/exchange-rate/", "src/finance/rate.ts"],
      dependsOn: [],
      acceptance: ["同一年月同一币种只存一条", "改历史月份不影响已提交单据"],
    },
    {
      title: "填单页币种选择",
      description: "填单页加币种下拉。",
      repo: "expense/frontend",
      locations: ["src/pages/claim/ClaimForm.tsx"],
      dependsOn: [1],
      acceptance: ["切币种后折算金额即时刷新"],
    },
  ],
};

test("定稿版:标题带「定稿」,总述三段与全部条目六字段按面板顺序", () => {
  const text = requirementBreakdownMarkdown({
    version: 2,
    finalized: true,
    breakdown: BREAKDOWN,
  });
  assert.equal(
    text,
    [
      "# 需求拆分 v2 · 定稿",
      "",
      "## 需求概要",
      "报销单支持多币种:员工按原币录入,提交时锁定当月汇率。",
      "",
      "## 假设",
      "- 月结汇率由财务手工维护",
      "- 单据提交后汇率锁定",
      "",
      "## 未决问题",
      "- 历史单据要不要补币种字段",
      "",
      "## 拆分条目",
      "",
      "### 1. 月结汇率表与维护接口",
      "- 所属仓库:expense/backend",
      "- 描述:新增月结汇率表,按年月与币种唯一。",
      "- 落点:src/finance/exchange-rate/, src/finance/rate.ts",
      "- 依赖条目:无",
      "- 验收要点:",
      "  - 同一年月同一币种只存一条",
      "  - 改历史月份不影响已提交单据",
      "",
      "### 2. 填单页币种选择",
      "- 所属仓库:expense/frontend",
      "- 描述:填单页加币种下拉。",
      "- 落点:src/pages/claim/ClaimForm.tsx",
      "- 依赖条目:1",
      "- 验收要点:",
      "  - 切币种后折算金额即时刷新",
    ].join("\n"),
  );
});

test("没定稿的那一版标题不带「定稿」,空的假设与未决问题段落照留、写「无」", () => {
  const text = requirementBreakdownMarkdown({
    version: 1,
    finalized: false,
    breakdown: { ...BREAKDOWN, assumptions: [], openQuestions: [], items: [] },
  });
  assert.equal(
    text,
    [
      "# 需求拆分 v1",
      "",
      "## 需求概要",
      BREAKDOWN.summary,
      "",
      "## 假设",
      "无",
      "",
      "## 未决问题",
      "无",
      "",
      "## 拆分条目",
    ].join("\n"),
  );
});

test("多个依赖条目按序号列出,落点与验收要点为空写「无」", () => {
  const text = requirementBreakdownMarkdown({
    version: 3,
    finalized: false,
    breakdown: {
      ...BREAKDOWN,
      items: [
        { ...BREAKDOWN.items[0]!, locations: [], acceptance: [] },
        { ...BREAKDOWN.items[1]!, dependsOn: [1, 3] },
        BREAKDOWN.items[1]!,
      ],
    },
  });
  assert.match(text, /- 落点:无\n- 依赖条目:无\n- 验收要点:\n  无\n/);
  assert.match(text, /- 依赖条目:1, 3\n/);
});

test("当前定稿的那一次就是换版记录的最后一条", () => {
  const rows: AgentSessionOutputFinalization[] = [
    {
      kind: "requirement-breakdown",
      seq: 1,
      fromVersion: null,
      toVersion: 1,
      finalizedBy: "member",
      finalizedAt: "2026-09-12T00:00:00.000Z",
    },
    {
      kind: "requirement-breakdown",
      seq: 2,
      fromVersion: 1,
      toVersion: 2,
      finalizedBy: "member",
      finalizedAt: "2026-09-12T01:00:00.000Z",
    },
  ];
  assert.equal(currentFinalization([]), undefined);
  assert.equal(currentFinalization(rows)?.toVersion, 2);
});
