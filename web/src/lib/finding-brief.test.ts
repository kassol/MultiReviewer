/*
 * 复制给外部 AI 的那段简报的单测。它离开面板之后没有任何上下文:commit、文件与行是
 * 定位的全部依据,问题 / 影响 / 建议是研判的全部依据,其余(轮次、处置状态、同根因、
 * 叮嘱)都是面板自己的上下文,写进去只会把要读的几行挤走。
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

test("只写仓库、commit、文件行与问题 / 影响 / 建议,不带轮次、状态与叮嘱", () => {
  const brief = findingBrief(finding(), {
    repo: "acme/shop",
    headSha: "7f1a9c2d4e5f60718293a4b5c6d7e8f901234567",
  });
  assert.equal(
    brief,
    [
      "repo: acme/shop",
      "commit: 7f1a9c2d4e5f60718293a4b5c6d7e8f901234567",
      "file: src/api/orders.ts:42",
      "",
      "问题（P1 · bug）：缺少库存校验",
      "",
      "下单前没有核对库存。",
      "",
      "影响：并发下单会超卖。",
      "",
      "建议：在下单事务里先锁库存行再扣减。",
    ].join("\n"),
  );
  assert.equal(brief.includes("第 7 轮"), false);
  assert.equal(brief.includes("待处置"), false);
  assert.equal(brief.includes("请先读"), false);
});

test("没有标题时正文那一句就是问题概括,不重复写两遍", () => {
  const brief = findingBrief(finding({ title: "" }), { repo: "acme/shop", headSha: "abc1234def" });
  assert.ok(brief.includes("问题（P1 · bug）：下单前没有核对库存。"));
  assert.equal((brief.match(/下单前没有核对库存/g) ?? []).length, 1);
});

test("没有仓库与 commit 时只留文件与行:取不到的场景信息不编", () => {
  assert.equal(
    findingBrief(finding()),
    [
      "file: src/api/orders.ts:42",
      "",
      "问题（P1 · bug）：缺少库存校验",
      "",
      "下单前没有核对库存。",
      "",
      "影响：并发下单会超卖。",
      "",
      "建议：在下单事务里先锁库存行再扣减。",
    ].join("\n"),
  );
});

test("影响与建议为空时整段不写", () => {
  const brief = findingBrief(finding({ impact: null, suggestion: "" }));
  assert.equal(brief.includes("影响："), false);
  assert.equal(brief.includes("建议："), false);
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
  assert.ok(brief.includes("建议：\n- claude-opus-5-5：先加唯一约束再回填。"));
  assert.equal(brief.includes("gpt-6-sol"), false);
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

test("简报上下文按位置所属轮次取 head,取不到时只留仓库", () => {
  const headOf = new Map([[7, "7f1a9c2d4e5f60"]]);
  assert.deepEqual(briefContextOf(finding(), headOf, "acme/shop"), {
    repo: "acme/shop",
    headSha: "7f1a9c2d4e5f60",
  });
  assert.deepEqual(briefContextOf(finding({ placedRunId: 99 }), headOf, "acme/shop"), {
    repo: "acme/shop",
  });
  assert.deepEqual(briefContextOf(finding({ placedRunId: 99 }), headOf, undefined), {});
});
