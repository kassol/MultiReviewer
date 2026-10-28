/*
 * 复制给外部 AI 的那段简报的单测。它离开面板之后没有任何上下文:位置、状态、三段正文与
 * 最后那句「先读代码确认」少一格,对面那个 AI 就得靠猜;多写一格(空的「影响」小标题、
 * 没发生过的同根因、指着一节不存在的建议)又会把「没给」读成「没有」。
 *
 * 位置只对 `placedRunId` 那一轮的 head 成立:带上网段与短 sha,AI 才知道自己看的是哪一版。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { StageSummaryFinding } from "../../../src/contracts/stage-summary.ts";

import { briefContextOf, findingBrief } from "./finding-brief.ts";

function finding(overrides: Partial<StageSummaryFinding> = {}): StageSummaryFinding {
  return {
    id: 12,
    file: "src/api/orders.ts",
    line: 42,
    placedRunId: 7,
    reportedLine: 42,
    title: "缺少库存校验",
    severity: "P1",
    category: "bug",
    description: "下单前没有核对库存。",
    impact: "并发下单会超卖。",
    suggestion: "在下单事务里先锁库存行再扣减。",
    models: ["claude-opus-5-5"],
    attributions: [],
    carried: [],
    disposition: "unresolved",
    placement: "inline",
    commentId: "100",
    commentHtmlUrl: "https://gitea.example.com/org/repo/pulls/1#issuecomment-100",
    disposedBy: null,
    disposedAt: null,
    note: null,
    continuedFrom: null,
    handoffPending: false,
    lineAuthor: null,
    firstRunId: 3,
    firstReportedAt: "2026-10-20T10:00:00",
    lastRunId: 7,
    lastReportedAt: "2026-10-27T14:32:00",
    rootCause: null,
    ...overrides,
  };
}

test("位置、状态与问题 / 影响 / 建议三段都在,末尾让 AI 先读代码确认", () => {
  const brief = findingBrief(finding());
  assert.equal(
    brief,
    [
      "# 代码审查 Finding #12（P1 · bug）",
      "",
      "- 位置：`src/api/orders.ts:42`",
      "- 状态：待处置",
      "",
      "## 问题",
      "",
      "**缺少库存校验**",
      "",
      "下单前没有核对库存。",
      "",
      "## 影响",
      "",
      "并发下单会超卖。",
      "",
      "## 建议",
      "",
      "在下单事务里先锁库存行再扣减。",
      "",
      "---",
      "",
      "请先读 `src/api/orders.ts` 第 42 行附近的代码，确认问题是否成立；成立则按上面的建议修复，不成立则说明原因。",
    ].join("\n"),
  );
});

test("有场景信息时写明仓库、第几轮与那一轮的短 sha", () => {
  const brief = findingBrief(finding(), {
    repo: "acme/shop",
    round: 3,
    headSha: "7f1a9c2d4e5f60718293a4b5c6d7e8f901234567",
  });
  assert.ok(brief.includes("- 仓库：acme/shop"));
  assert.ok(brief.includes("- 位置：`src/api/orders.ts:42`（第 3 轮 · 7f1a9c2）"));
});

test("没有标题、影响或建议时整段不写,末尾改成让 AI 自己给修复方案", () => {
  const brief = findingBrief(finding({ title: "", impact: null, suggestion: "" }));
  assert.ok(brief.includes("## 问题\n\n下单前没有核对库存。"));
  assert.equal(brief.includes("缺少库存校验"), false);
  assert.equal(brief.includes("## 影响"), false);
  assert.equal(brief.includes("## 建议"), false);
  assert.equal(brief.includes("按上面的建议修复"), false);
  assert.ok(brief.endsWith("成立则给出修复方案并改掉，不成立则说明原因。"));
});

test("代表段没给建议时退回各模型自己的建议,逐条署名", () => {
  const brief = findingBrief(
    finding({
      suggestion: null,
      attributions: [
        { model: "claude-opus-5-5", severity: "P1", category: "bug", description: "问题。", impact: null, suggestion: "先加唯一约束再回填。" },
        { model: "gpt-6-sol", severity: "P1", category: "bug", description: "问题。", impact: null, suggestion: null },
      ],
    }),
  );
  assert.ok(brief.includes("## 建议\n\n- claude-opus-5-5：先加唯一约束再回填。"));
  assert.equal(brief.includes("gpt-6-sol"), false);
  assert.ok(brief.includes("成立则按上面的建议修复"));
});

test("沿用自更早轮次的建议另标一句未经新代码验证,同一句只出现一次", () => {
  const brief = findingBrief(
    finding({
      suggestion: null,
      attributions: [
        { model: "claude-opus-5-5", severity: "P1", category: "bug", description: "问题。", impact: null, suggestion: "抽成共用函数。" },
      ],
      carried: [
        { model: "gpt-6-sol", runId: 3, headSha: "abc1234def", description: "问题。", impact: null, suggestion: "抽成共用函数。" },
        { model: "gpt-6-sol", runId: 3, headSha: "abc1234def", description: "问题。", impact: null, suggestion: "换一个事务边界。" },
      ],
    }),
  );
  assert.equal((brief.match(/抽成共用函数/g) ?? []).length, 1);
  assert.ok(brief.includes("- gpt-6-sol（沿用更早轮次，尚未针对最新代码重新验证）：换一个事务边界。"));
});

test("同根因写进头部,说明这次修复可能不止一处", () => {
  const brief = findingBrief(
    finding({ rootCause: { id: 3, reason: "库存扣减没有放在同一个事务里", memberCount: 4, position: 1 } }),
  );
  assert.ok(brief.includes("- 同根因：库存扣减没有放在同一个事务里（本组 4 处）"));
});

test("处置备注单独一节:它是人留下的「为什么不用改」", () => {
  const brief = findingBrief(
    finding({ disposition: "resolved", note: "上游网关已经兜住了，这里不用改。" }),
  );
  assert.ok(brief.includes("- 状态：人工已处置"));
  assert.ok(brief.includes("## 处置备注\n\n上游网关已经兜住了，这里不用改。"));
});

test("自动处置与空白备注:状态照实写,空白备注不出现", () => {
  const brief = findingBrief(finding({ disposition: "fixed", note: "   " }));
  assert.ok(brief.includes("- 状态：已修复（自动处置）"));
  assert.equal(brief.includes("处置备注"), false);
});

test("未读回 Forge 状态的也按待处置说,与列表里那三档同一个口径", () => {
  assert.ok(findingBrief(finding({ disposition: "unknown" })).includes("- 状态：待处置"));
});

test("简报上下文按位置所属轮次取第几轮与 head,取不到的项不写", () => {
  const roundOf = new Map([[7, 3]]);
  const headOf = new Map([[7, "7f1a9c2d4e5f60"]]);
  assert.deepEqual(briefContextOf(finding(), roundOf, headOf, "acme/shop"), {
    repo: "acme/shop",
    round: 3,
    headSha: "7f1a9c2d4e5f60",
  });
  assert.deepEqual(briefContextOf(finding({ placedRunId: 99 }), roundOf, headOf, undefined), {});
});
