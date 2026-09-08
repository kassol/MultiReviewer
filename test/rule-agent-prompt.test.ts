/**
 * 规则 agent 的两份任务提示(issue #292)。整理与反哺的提示文本由 `rule-worker.ts` 拼,
 * 而规则 agent 是子进程,面板那条缝只看得到 `RuleAgentRequest`,拿不到提示本身;这两个
 * 纯函数因此直接调用,断言里只钉本票要的那几句关键短语。
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { KnowledgeEntry } from "../src/review/finding.ts";
import { AGENT_STATEMENT_LIMIT } from "../src/reviewer/rule-agent.ts";
import type { ConsolidationProposal, DispositionFeedback } from "../src/reviewer/rule-agent.ts";
import { consolidationPrompt, feedbackPrompt } from "../src/reviewer/rule-worker.ts";

/** 恰好超一个字的一句陈述。 */
const OVERLONG = "长".repeat(AGENT_STATEMENT_LIMIT + 1);

/** 某一行上的字数标注。 */
function mark(id: number, statement: string, over: boolean): RegExp {
  return new RegExp(`\\[${id}\\].*${statement.length} characters${over ? ", over limit" : ""}\\)`);
}

function entry(id: number, statement: string): KnowledgeEntry {
  return { id, type: "fact", scope: "", statement };
}

function proposal(id: number, statement: string): ConsolidationProposal {
  return {
    id,
    type: "rule",
    change: "add",
    targetRuleIds: [],
    scope: "",
    statement,
    sources: [{ origin: "disposition-feedback", note: "误报" }],
  };
}

test("整理提示里现集每条带字数,超限的带标记", () => {
  const prompt = consolidationPrompt(
    [proposal(7, "Controller 必须标注 @SaCheckLogin")],
    [entry(1, OVERLONG), entry(2, "雪花 id 全库唯一")],
  );
  assert.match(prompt, mark(1, OVERLONG, true));
  assert.match(prompt, mark(2, "雪花 id 全库唯一", false));
  assert.doesNotMatch(prompt, /\[2\].*over limit/);
});

test("有超限条目时提示多一段:每条都要出现在至少一条提案里", () => {
  const prompt = consolidationPrompt([proposal(7, "短陈述")], [entry(1, OVERLONG)]);
  assert.match(prompt, /must appear in at least one proposal/);
});

test("超限条目为零时不出现必须处理那一段,也没有一条带标记", () => {
  const prompt = consolidationPrompt([proposal(7, "短陈述")], [entry(1, "雪花 id 全库唯一")]);
  assert.doesNotMatch(prompt, /must appear in at least one proposal/);
  assert.doesNotMatch(prompt, /over limit/);
});

test("队列里的提案同样标字数,超限的由裁决的人手改", () => {
  const prompt = consolidationPrompt([proposal(7, OVERLONG)], [entry(1, "雪花 id 全库唯一")]);
  assert.match(prompt, mark(7, OVERLONG, true));
  assert.match(prompt, /shortened by the person who rules on it/);
});

test("反哺提示分型里有限定类规则那一档", () => {
  const feedback: DispositionFeedback = {
    note: "测试目录不按凭据泄露上报",
    finding: { file: "src/x.ts", line: 3, title: null, description: "凭据可能泄露" },
  };
  const prompt = feedbackPrompt({ existingKnowledge: [], feedback });
  assert.match(prompt, /not worth reporting/);
  assert.match(prompt, /imperative/);
  assert.match(prompt, /scope/);
});
