/**
 * 处置反哺(issue #208)。
 *
 * 一条缝:面板处置端点走真实 HTTP,带备注的处置排一次后台解读,产出经与基点探索同一套
 * 映射入队为修订提案,出处标处置反哺、附注放备注原文。规则 agent 仍用脚本化实现注入,
 * 与 issue #205 / #207 同一个位置;后台任务的结束等服务自己发的回调,不猜时序。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { openStore } from "../src/review/store.ts";
import type { RuleAgent, RuleAgentItem, RuleAgentRequest } from "../src/reviewer/rule-agent.ts";
import { confirmEmptyRuleSet } from "./support/git-fixture.ts";
import { scriptedReviewer } from "./support/memory-forge.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  seedAvailableModelService,
  startReadyPanelHarness,
  type PanelHarness,
  type PanelHarnessOptions,
} from "./support/panel-harness.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const NOTE = "这类越界要在边界上一次判掉,不要每处再判";

type ProposalResponse = {
  id: number;
  change: "add" | "modify" | "retire";
  targetRuleId: number | null;
  scope: string;
  statement: string;
  layer: string;
  source: "baseline-exploration" | "disposition-feedback";
  sourceNote: string | null;
  state: "pending" | "accepted" | "rejected";
};

type RunFinding = { id: number; file: string; line: number; commentId: string | null };

/** 两条落在 diff 里的 Finding,各自一条行级评论:处置要有可处置的载体。 */
const reportingReviewers: NonNullable<PanelHarnessOptions["buildReviewers"]> = (plans) =>
  plans.map((plan) =>
    scriptedReviewer(plan.spec.model, [
      {
        file: "src/answer.ts",
        line: 1,
        severity: "P1",
        category: "bug",
        description: "这里会越界",
      },
      {
        file: "src/other.ts",
        line: 1,
        severity: "P0",
        category: "security",
        description: "这里会注入",
      },
    ]),
  );

/**
 * 脚本化规则 agent,记下每次收到的任务。产出由回调给出:提案要指向的那条现有规则的
 * 标识建库之后才知道,固定值给不出来。
 */
function scriptedRuleAgent(
  produce: () => { items: RuleAgentItem[]; failure?: string },
): RuleAgent & { calls: RuleAgentRequest[] } {
  const calls: RuleAgentRequest[] = [];
  const agent = async (request: RuleAgentRequest) => {
    calls.push(request);
    return produce();
  };
  return Object.assign(agent, { calls });
}

/** 一个已注册、已确认空规则集的仓库,跑完一轮并落下两条带行级评论的 Finding。 */
async function harnessWithFindings(ruleAgent: RuleAgent): Promise<PanelHarness> {
  const h = await startReadyPanelHarness(cleanups, {
    ruleAgent,
    buildReviewers: reportingReviewers,
  });
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );
  // 门禁分代(issue #206):这几条用例要的是审查行为,仓库放到「规则集已确认」那一侧。
  confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);
  assert.equal((await h.deliverViaHook(h.repo.headSha)).status, 200);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);
  return h;
}

async function inlineFindings(h: PanelHarness): Promise<RunFinding[]> {
  const response = await h.api("GET", "/runs");
  assert.equal(response.status, 200);
  const runs = ((await response.json()) as { runs: { findings: RunFinding[] }[] }).runs;
  return runs.flatMap((run) => run.findings).filter((finding) => finding.commentId !== null);
}

async function proposals(h: PanelHarness): Promise<ProposalResponse[]> {
  const response = await h.api("GET", `/repos/${GITEA_REPO.id}/rules`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { proposals: ProposalResponse[] }).proposals;
}

/** 这个仓库留下的规则轨迹事件,按落库顺序。没有列表端点,直接读库。 */
function ruleTraceKinds(h: PanelHarness): string[] {
  const db = new DatabaseSync(h.db.path, { readOnly: true });
  try {
    return db
      .prepare("SELECT kind FROM rule_trace WHERE repo_id = ? ORDER BY task_id, seq")
      .all(GITEA_REPO.id)
      .map((row) => String(row["kind"]));
  } finally {
    db.close();
  }
}

function dispose(h: PanelHarness, findingId: number, note?: string): Promise<Response> {
  return h.api("POST", `/findings/${findingId}/resolve`, note === undefined ? {} : { note });
}

test("带备注的处置排一次反哺:agent 拿到备注与 Finding 上下文,产出入队并标出处", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithFindings(agent);

  // 现集里先有一条:反哺提的是对照它的变更,agent 因此要看得到它。
  const store = openStore(h.db.path);
  let ruleId: number;
  try {
    assert.notEqual(
      store.addReviewRule(GITEA_REPO.id, {
        scope: "",
        statement: "入参要在边界上校验",
        layer: "安全",
      }),
      undefined,
    );
    ruleId = store.getRuleSet(GITEA_REPO.id)!.rules[0]!.id;
  } finally {
    store.close();
  }
  items = [
    { scope: "src/**", statement: "边界上一次判空", layer: "架构" },
    { scope: "", statement: "改写现集里的那一条", layer: "安全", targetRuleId: ruleId },
  ];

  const [target] = await inlineFindings(h);
  assert.notEqual(target, undefined);
  assert.equal((await dispose(h, target!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(1);
  assert.equal(h.dispositionFeedbacks[0]!.failure, undefined);

  assert.equal(agent.calls.length, 1);
  const request = agent.calls[0]!;
  assert.equal(request.feedback?.note, NOTE);
  assert.equal(request.feedback?.finding.file, target!.file);
  assert.equal(request.feedback?.finding.line, target!.line);
  assert.equal(request.feedback?.finding.description, "这里会越界");
  assert.deepEqual(
    request.existingRules.map((rule) => rule.statement),
    ["入参要在边界上校验"],
  );

  const queued = await proposals(h);
  assert.equal(queued.length, 2);
  for (const entry of queued) {
    assert.equal(entry.source, "disposition-feedback");
    assert.equal(entry.sourceNote, NOTE);
    assert.equal(entry.state, "pending");
  }
  assert.deepEqual(
    queued.map((entry) => [entry.change, entry.targetRuleId, entry.statement]),
    [
      ["add", null, "边界上一次判空"],
      ["modify", ruleId, "改写现集里的那一条"],
    ],
  );
});

test("反哺跑完即释放那一份一次性工作树", async () => {
  const agent = scriptedRuleAgent(() => ({ items: [] }));
  const h = await harnessWithFindings(agent);
  const findings = await inlineFindings(h);

  assert.equal((await dispose(h, findings[0]!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(1);
  assert.equal(h.dispositionFeedbacks[0]!.failure, undefined);

  // agent 读过的那份工作副本用完即删(issue #212):留着的话每一条带备注的处置都在缓存
  // 根下堆一份完整工作副本,而它只在这一次解读期间有用。
  assert.equal(agent.calls.length, 1);
  assert.equal(existsSync(agent.calls[0]!.worktreePath), false);
});

test("无备注的处置不触发任何解读", async () => {
  const agent = scriptedRuleAgent(() => ({
    items: [{ scope: "", statement: "一条规范陈述", layer: "架构" }],
  }));
  const h = await harnessWithFindings(agent);
  const findings = await inlineFindings(h);
  assert.ok(findings.length >= 2);

  // 先处置不带备注的那条,再处置带备注的:后者跑完时,前者若触发过也已经在数里。
  assert.equal((await dispose(h, findings[0]!.id)).status, 200);
  assert.equal((await dispose(h, findings[1]!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(1);

  assert.equal(h.dispositionFeedbacks.length, 1);
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0]!.feedback?.note, NOTE);
  assert.equal((await proposals(h)).length, 1);
});

test("反哺沿用最近一次基点探索所用的模型,没探索过就用全局组合第一个", async () => {
  const agent = scriptedRuleAgent(() => ({ items: [] }));
  const h = await harnessWithFindings(agent);
  seedAvailableModelService(h, "second", ["other-model"]);
  const findings = await inlineFindings(h);

  assert.equal((await dispose(h, findings[0]!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(1);
  assert.equal(h.dispositionFeedbacks[0]!.failure, undefined);
  assert.equal(agent.calls[0]!.runtimeModel.provider, "test");
  assert.equal(agent.calls[0]!.runtimeModel.id, "global-model");

  const store = openStore(h.db.path);
  try {
    assert.equal(
      store.startRuleExploration(GITEA_REPO.id, {
        baselineSha: h.repo.baseSha,
        model: "second:other-model",
        startedAt: "2026-08-29T00:00:00.000Z",
      }),
      true,
    );
  } finally {
    store.close();
  }

  assert.equal((await dispose(h, findings[1]!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(2);
  assert.equal(h.dispositionFeedbacks[1]!.failure, undefined);
  assert.equal(agent.calls[1]!.runtimeModel.provider, "second");
  assert.equal(agent.calls[1]!.runtimeModel.id, "other-model");
});

test("从未探索过且全局组合为空:跳过解读留一行原因,零提案", async () => {
  const agent = scriptedRuleAgent(() => ({
    items: [{ scope: "", statement: "一条规范陈述", layer: "架构" }],
  }));
  const h = await harnessWithFindings(agent);
  const findings = await inlineFindings(h);

  const store = openStore(h.db.path);
  try {
    // 空组合走夹具入口:面板写链不收空组合,而「全局组合为空」是这条用例要的局面。
    assert.equal(store.putGlobalSettings({ reviewersJson: "[]", maxChangedLinesPerBatch: null }), true);
  } finally {
    store.close();
  }

  assert.equal((await dispose(h, findings[0]!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(1);
  assert.match(h.dispositionFeedbacks[0]!.failure ?? "", /模型/);
  assert.equal(agent.calls.length, 0);
  assert.deepEqual(await proposals(h), []);
  // 轨迹从任务开始就起(issue #214):选不出模型也是反哺之内的失败,人来这条轨迹就是要
  // 看它卡在哪一步,而不是一片空白。
  assert.deepEqual(ruleTraceKinds(h), ["rule_agent_started", "rule_agent_failed"]);
});

test("解读失败留原因、不重排,产出为空不产生提案", async () => {
  let failure: string | undefined = "厂商拒了这次调用";
  const agent = scriptedRuleAgent(() => ({
    items: [],
    ...(failure === undefined ? {} : { failure }),
  }));
  const h = await harnessWithFindings(agent);
  const findings = await inlineFindings(h);

  assert.equal((await dispose(h, findings[0]!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(1);
  assert.match(h.dispositionFeedbacks[0]!.failure ?? "", /厂商拒了这次调用/);
  assert.deepEqual(await proposals(h), []);

  // 产出为空是合法结果:同样不留提案,也不算失败。
  failure = undefined;
  assert.equal((await dispose(h, findings[1]!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(2);
  assert.equal(h.dispositionFeedbacks[1]!.failure, undefined);
  // 失败的那一次没有重排:两次处置各自只解读一次。
  assert.equal(h.dispositionFeedbacks.length, 2);
  assert.equal(agent.calls.length, 2);
  assert.deepEqual(await proposals(h), []);
});

test("反哺沿用最近一次探索的思考档位,探索没选档位时反哺也不带", async () => {
  const agent = scriptedRuleAgent(() => ({ items: [] }));
  const h = await harnessWithFindings(agent);
  const findings = await inlineFindings(h);

  const startExploration = (thinkingLevel?: "high"): void => {
    const store = openStore(h.db.path);
    try {
      assert.equal(
        store.startRuleExploration(GITEA_REPO.id, {
          baselineSha: h.repo.baseSha,
          model: "test:global-model",
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          startedAt: "2026-08-29T00:00:00.000Z",
        }),
        true,
      );
      // 记录停在运行中就发起不了下一次,这里只关心档位有没有留下来。
      store.finishRuleExploration(GITEA_REPO.id, [], "2026-08-29T00:00:00.000Z");
    } finally {
      store.close();
    }
  };

  startExploration("high");
  assert.equal((await dispose(h, findings[0]!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(1);
  assert.equal(h.dispositionFeedbacks[0]!.failure, undefined);
  assert.equal(agent.calls[0]!.thinkingLevel, "high");

  startExploration();
  assert.equal((await dispose(h, findings[1]!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(2);
  assert.equal(h.dispositionFeedbacks[1]!.failure, undefined);
  assert.equal(agent.calls[1]!.thinkingLevel, undefined);
});
