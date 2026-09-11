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
import { test } from "node:test";

import { openStore } from "../src/review/store.ts";
import type { RuleAgent, RuleAgentItem } from "../src/reviewer/rule-agent.ts";
import { confirmEmptyRuleSet } from "./support/git-fixture.ts";
import { scriptedReviewer, scriptedRuleAgent } from "./support/memory-forge.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  PANEL_ADMIN_USERNAME,
  seedAvailableModelService,
  startReadyPanelHarness,
  type PanelHarness,
  type PanelHarnessOptions,
} from "./support/panel-harness.ts";
import { putGlobalSettings, seedReviewRule } from "./support/store-seed.ts";

const NOTE = "这类越界要在边界上一次判掉,不要每处再判";

type ProposalResponse = {
  id: number;
  /** 两型之一(ADR 0020,issue #222)。规范性结论提为规则,描述性结论提为事实。 */
  type: "rule" | "fact";
  change: "add" | "modify" | "retire";
  targetRuleIds: number[];
  scope: string;
  statement: string;
  /** 出处附注列表(issue #281)。反哺产出的各带一条处置反哺附注。 */
  sources: {
    origin: "baseline-exploration" | "disposition-feedback" | "knowledge-consolidation";
    note: string | null;
    /** agent 为这一条给出的理由与代码证据(issue #287)。 */
    evidence: string | null;
    findingId: number | null;
    findingStageId: string | null;
    traceTaskId: number | null;
  }[];
  state: "pending" | "accepted" | "rejected";
};

type RunFinding = { id: number; file: string; line: number; commentId: string | null };

/** 知识集读取里的一条修订意图(issue #296)。反哺产生的那一行目标为 Finding。 */
type RevisionIntent = {
  id: number;
  text: string;
  submittedBy: string;
  targetKind: "none" | "rule" | "proposal" | "draft" | "finding";
  targetId: number | null;
  /** 目标 Finding 所在的阶段标识,面板据此开 `?finding=` 侧滑。 */
  targetStageId: string | null;
  state: "running" | "failed" | "completed";
  failure: string | null;
  /** 这一次沿反哺规则选出的模型标识。选不出来即 null。 */
  model: string | null;
  traceTaskId: number | null;
  produced: { proposalIds: number[]; draftItemIds: number[] };
};

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
/** 一个已注册、已确认空知识集的仓库,跑完一轮并落下两条带行级评论的 Finding。 */
async function harnessWithFindings(ruleAgent: RuleAgent): Promise<PanelHarness> {
  const h = await startReadyPanelHarness({
    ruleAgent,
    buildReviewers: reportingReviewers,
  });
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );
  // 门禁分代(issue #206):这几条用例要的是审查行为,仓库放到「知识集已确认」那一侧。
  confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);
  assert.equal((await h.deliverViaHook(h.repo.headSha)).status, 200);
  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);
  return h;
}

/**
 * 直接写审查策略里那一处辅助模型(issue #304)。夹具入口不设可用性门:面板写链只收当前
 * 可用的模型,而这几条用例要的正是「设了它、反哺就用它」这一件事。
 */
function setGlobalAuxiliaryModel(
  h: PanelHarness,
  spec: { provider: string; model: string; thinkingLevel?: string },
): void {
  const store = openStore(h.db.path);
  try {
    assert.equal(putGlobalSettings(store, { auxiliaryModelJson: JSON.stringify(spec) }), true);
  } finally {
    store.close();
  }
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

/** 这个仓库此刻列出的修订意图(issue #296):反哺与人工提议同一份读取。 */
async function intents(h: PanelHarness): Promise<RevisionIntent[]> {
  const response = await h.api("GET", `/repos/${GITEA_REPO.id}/rules`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { intents: RevisionIntent[] }).intents;
}

/** 这个仓库留下的知识轨迹事件,按落库顺序。没有列表端点,直接读库。 */
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

/** 这个仓库知识轨迹上每一条丢弃事件的 payload,按落库顺序。 */
function ruleTraceDrops(h: PanelHarness): unknown[] {
  const db = new DatabaseSync(h.db.path, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT payload FROM rule_trace WHERE repo_id = ? AND kind = 'rule_proposal_dropped' ORDER BY task_id, seq",
      )
      .all(GITEA_REPO.id)
      .map((row) => JSON.parse(String(row["payload"])) as unknown);
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
      seedReviewRule(h.db.path, GITEA_REPO.id, {
        type: "rule",
        scope: "",
        statement: "入参要在边界上校验",
      }),
      undefined,
    );
    ruleId = store.getRuleSet(GITEA_REPO.id)!.rules[0]!.id;
  } finally {
    store.close();
  }
  items = [
    { type: "rule", scope: "src/**", statement: "边界上一次判空", reason: "  越界在三处都有  " },
    {
      type: "rule",
      scope: "",
      statement: "改写现集里的那一条",
      targetRuleIds: [ruleId],
      reason: "现集那条只说了入参",
    },
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
    request.existingKnowledge.map((rule) => rule.statement),
    ["入参要在边界上校验"],
  );

  const queued = await proposals(h);
  assert.equal(queued.length, 2);
  for (const entry of queued) {
    assert.equal(entry.state, "pending");
    // 一条处置反哺附注:备注原文、引发它的那条 Finding 与这一次反哺的轨迹都在上面,
    // 面板据此把人送回那条 Finding 的侧滑(issue #281)。
    assert.equal(entry.sources.length, 1);
    assert.equal(entry.sources[0]!.origin, "disposition-feedback");
    assert.equal(entry.sources[0]!.note, NOTE);
    assert.equal(entry.sources[0]!.findingId, target!.id);
    assert.equal(
      entry.sources[0]!.findingStageId,
      `pr:${HARNESS_PR.owner}/${HARNESS_PR.repo}/${HARNESS_PR.number}`,
    );
    assert.equal(typeof entry.sources[0]!.traceTaskId, "number");
  }
  // 依据是 agent 给这一条的理由,去掉首尾空白(issue #287):陈述只留结论,证据在这一格。
  assert.deepEqual(
    queued.map((entry) => entry.sources[0]!.evidence),
    ["越界在三处都有", "现集那条只说了入参"],
  );
  assert.deepEqual(
    queued.map((entry) => [entry.change, entry.targetRuleIds, entry.statement]),
    [
      ["add", [], "边界上一次判空"],
      ["modify", [ruleId], "改写现集里的那一条"],
    ],
  );
});

test("描述性备注蒸馏为事实提案,采纳后进知识集并注入下一轮", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithFindings(agent);

  // 这条备注说的是「这个仓库已经是怎样」,不是「代码应当怎样」:它该成为一条事实,
  // 让下一轮的 Reviewer 有这块地面可站,而不是又一条谁也判不了违反的规则。
  const note = "这里有全局拦截器兜底,/api 下的路由都过它";
  items = [
    { type: "fact", scope: "src/api/**", statement: "全局拦截器覆盖 /api 下的全部路由" },
  ];

  const [target] = await inlineFindings(h);
  assert.equal((await dispose(h, target!.id, note)).status, 200);
  await h.dispositionFeedbackAtLeast(1);
  assert.equal(h.dispositionFeedbacks[0]!.failure, undefined);

  const queued = await proposals(h);
  assert.deepEqual(
    queued.map((entry) => [entry.type, entry.change, entry.statement]),
    [["fact", "add", "全局拦截器覆盖 /api 下的全部路由"]],
  );
  assert.deepEqual(
    queued[0]!.sources.map((entry) => [entry.origin, entry.note]),
    [["disposition-feedback", note]],
  );

  // 裁决采纳:事实进知识集,并成为启动快照里注入 Reviewer 的那一份。
  assert.equal(
    (await h.api("POST", `/repos/${GITEA_REPO.id}/rule-proposals/${queued[0]!.id}/accept`)).status,
    200,
  );
  const store = openStore(h.db.path);
  try {
    assert.deepEqual(
      store.getRuleSet(GITEA_REPO.id)!.rules.map((entry) => [entry.type, entry.origin]),
      [["fact", "disposition-feedback"]],
    );
    const snapshot = store.getReviewRunSnapshot(GITEA_REPO.id);
    assert.deepEqual(snapshot.rules, []);
    assert.deepEqual(
      snapshot.facts.map((fact) => [fact.scope, fact.statement]),
      [["src/api/**", "全局拦截器覆盖 /api 下的全部路由"]],
    );
  } finally {
    store.close();
  }
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
    items: [{ type: "rule", scope: "", statement: "一条规范陈述" }],
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
  // 意图行同样零触发:没有备注的处置写不出意图原文(issue #296)。
  const listed = await intents(h);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.targetId, findings[1]!.id);
});

test("反哺用这个仓库生效的辅助模型,探索记录里的模型不再影响它", async () => {
  const agent = scriptedRuleAgent(() => ({ items: [] }));
  const h = await harnessWithFindings(agent);
  seedAvailableModelService(h, "second", ["other-model"]);
  const findings = await inlineFindings(h);

  // 探索记录里的模型只作历史(issue #304):最近一次探索用的是另一家,两处配置都没设的
  // 反哺仍走解析的退路——这个仓库生效组合的第一个(ADR 0029)。
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
    store.finishRuleExploration(GITEA_REPO.id, [], "2026-08-29T00:00:00.000Z");
  } finally {
    store.close();
  }

  assert.equal((await dispose(h, findings[0]!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(1);
  assert.equal(h.dispositionFeedbacks[0]!.failure, undefined);
  assert.equal(agent.calls[0]!.runtimeModel.provider, "test");
  assert.equal(agent.calls[0]!.runtimeModel.id, "global-model");

  // 审查策略里设了辅助模型:这才换得了模型。
  setGlobalAuxiliaryModel(h, { provider: "second", model: "other-model" });
  assert.equal((await dispose(h, findings[1]!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(2);
  assert.equal(h.dispositionFeedbacks[1]!.failure, undefined);
  assert.equal(agent.calls[1]!.runtimeModel.provider, "second");
  assert.equal(agent.calls[1]!.runtimeModel.id, "other-model");
});

test("选不出辅助模型时:跳过解读留一行原因,零提案", async () => {
  const agent = scriptedRuleAgent(() => ({
    items: [{ type: "rule", scope: "", statement: "一条规范陈述" }],
  }));
  const h = await harnessWithFindings(agent);
  const findings = await inlineFindings(h);

  const store = openStore(h.db.path);
  try {
    // 清成没配走夹具入口:面板写链在配过非空之后不再收空组合(spec #300),而「全局组合
    // 为空」是这条用例要的局面。
    assert.equal(putGlobalSettings(store, { reviewersJson: null, maxChangedLinesPerBatch: null }), true);
  } finally {
    store.close();
  }

  assert.equal((await dispose(h, findings[0]!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(1);
  // 失败原因指向两处配置(issue #304):没有别的地方可以设模型了。
  assert.match(h.dispositionFeedbacks[0]!.failure ?? "", /审查策略/);
  assert.match(h.dispositionFeedbacks[0]!.failure ?? "", /仓库配置/);
  assert.equal(agent.calls.length, 0);
  assert.deepEqual(await proposals(h), []);
  // 轨迹从任务开始就起(issue #214):选不出模型也是反哺之内的失败,人来这条轨迹就是要
  // 看它卡在哪一步,而不是一片空白。
  assert.deepEqual(ruleTraceKinds(h), ["rule_agent_started", "rule_agent_failed"]);
  // 选不出模型不再静默:意图行照样落一条,失败带原因,人在修订意图 tab 看得到(issue #296、#317)。
  const [intent] = await intents(h);
  assert.equal(intent!.state, "failed");
  assert.match(intent!.failure ?? "", /审查策略/);
  assert.equal(intent!.model, null);
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

test("反哺用辅助模型那一处的思考档位,没选档位时反哺也不带", async () => {
  const agent = scriptedRuleAgent(() => ({ items: [] }));
  const h = await harnessWithFindings(agent);
  // 档位要这个模型自己支持得了才收得下(CONTEXT.md 思考档位)。
  seedAvailableModelService(h, "second", ["other-model"], { reasoning: true });
  const findings = await inlineFindings(h);

  setGlobalAuxiliaryModel(h, {
    provider: "second",
    model: "other-model",
    thinkingLevel: "high",
  });
  assert.equal((await dispose(h, findings[0]!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(1);
  assert.equal(h.dispositionFeedbacks[0]!.failure, undefined);
  assert.equal(agent.calls[0]!.thinkingLevel, "high");

  setGlobalAuxiliaryModel(h, { provider: "second", model: "other-model" });
  assert.equal((await dispose(h, findings[1]!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(2);
  assert.equal(h.dispositionFeedbacks[1]!.failure, undefined);
  assert.equal(agent.calls[1]!.thinkingLevel, undefined);
});

test("认出队列里已有的一件事即并入那一条:队列仍一条,陈述被覆盖,附注两条", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithFindings(agent);
  const findings = await inlineFindings(h);
  assert.ok(findings.length >= 2);

  // 第一条备注排进一条新增提案。
  items = [
    { type: "rule", scope: "src/**", statement: "边界上一次判空", reason: "第一次的依据" },
  ];
  assert.equal((await dispose(h, findings[0]!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(1);
  assert.equal(h.dispositionFeedbacks[0]!.failure, undefined);
  const queuedId = (await proposals(h))[0]!.id;

  // 第二条备注说的是同一件事:agent 指名并入那一条,并给出合成后的新陈述。
  const second = "边界那一处也一样,别每个 handler 再判一遍";
  items = [
    {
      type: "rule",
      scope: "src/api/**",
      statement: "越界与判空都在边界上一次判掉",
      proposalId: queuedId,
      reason: "并入这一次的依据",
    },
  ];
  assert.equal((await dispose(h, findings[1]!.id, second)).status, 200);
  await h.dispositionFeedbackAtLeast(2);
  assert.equal(h.dispositionFeedbacks[1]!.failure, undefined);

  // 反哺 agent 在现集之外拿到了待裁决队列,连标识、变更类型、目标与陈述。
  assert.deepEqual(agent.calls[1]!.pendingProposals, [
    { id: queuedId, change: "add", targetRuleIds: [], statement: "边界上一次判空" },
  ]);

  // 队列仍一条:两条说同一件事的备注只留一条提案,人裁决一次。
  const queued = await proposals(h);
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.id, queuedId);
  assert.equal(queued[0]!.state, "pending");
  assert.equal(queued[0]!.statement, "越界与判空都在边界上一次判掉");
  // 作用范围与型不随并入覆盖:并入的输入里没有它们(队列只给标识、变更类型、目标与
  // 陈述),拿一份只看新备注写出的作用范围去覆盖会把这条提案缩到说不上话的范围。
  assert.equal(queued[0]!.scope, "src/**");
  assert.equal(queued[0]!.type, "rule");
  // 附注由一条变两条,新那条带备注原文与这一次的 Finding。
  assert.deepEqual(
    queued[0]!.sources.map((entry) => [entry.origin, entry.note, entry.findingId]),
    [
      ["disposition-feedback", NOTE, findings[0]!.id],
      ["disposition-feedback", second, findings[1]!.id],
    ],
  );
  // 并入追加的那条附注同样带自己的依据(issue #287):两次各凭什么提的都留得下来。
  assert.deepEqual(
    queued[0]!.sources.map((entry) => entry.evidence),
    ["第一次的依据", "并入这一次的依据"],
  );
  for (const entry of queued[0]!.sources) {
    assert.equal(
      entry.findingStageId,
      `pr:${HARNESS_PR.owner}/${HARNESS_PR.repo}/${HARNESS_PR.number}`,
    );
    assert.equal(typeof entry.traceTaskId, "number");
  }

  // 并入后的提案在下一次重探索中留下:它的附注不全是基点探索(issue #281)。
  const store = openStore(h.db.path);
  try {
    store.finishRuleExplorationAsProposals(
      GITEA_REPO.id,
      [
        {
          type: "rule",
          change: "add",
          targetRuleIds: [],
          scope: "",
          statement: "新一轮探索提的",
          sources: [
            {
              origin: "baseline-exploration",
              note: null,
              evidence: null,
              findingId: null,
              traceTaskId: null,
            },
          ],
        },
      ],
      "2026-09-08T00:00:00.000Z",
    );
  } finally {
    store.close();
  }
  assert.deepEqual(
    (await proposals(h)).map((entry) => entry.statement),
    ["越界与判空都在边界上一次判掉", "新一轮探索提的"],
  );
});

test("并入指向已裁决或不存在的提案:那一条退回按新增处理", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithFindings(agent);
  const findings = await inlineFindings(h);

  items = [{ type: "rule", scope: "", statement: "边界上一次判空" }];
  assert.equal((await dispose(h, findings[0]!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(1);
  const queuedId = (await proposals(h))[0]!.id;
  assert.equal(
    (await h.api("POST", `/repos/${GITEA_REPO.id}/rule-proposals/${queuedId}/reject`)).status,
    200,
  );

  // 一条指向那条已驳回的提案,一条指向根本不存在的:两条都按新增排进队列。
  items = [
    { type: "rule", scope: "", statement: "指向已裁决的那一条", proposalId: queuedId },
    { type: "rule", scope: "", statement: "指向不存在的那一条", proposalId: queuedId + 9999 },
  ];
  assert.equal((await dispose(h, findings[1]!.id, "又一条备注")).status, 200);
  await h.dispositionFeedbackAtLeast(2);
  assert.equal(h.dispositionFeedbacks[1]!.failure, undefined);

  const queued = await proposals(h);
  assert.deepEqual(
    queued.map((entry) => [entry.change, entry.statement, entry.state, entry.sources.length]),
    [
      ["add", "边界上一次判空", "rejected", 1],
      ["add", "指向已裁决的那一条", "pending", 1],
      ["add", "指向不存在的那一条", "pending", 1],
    ],
  );
});

test("并入缺陈述:那一条丢掉,轨迹里留原因", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithFindings(agent);
  const findings = await inlineFindings(h);

  items = [{ type: "rule", scope: "", statement: "边界上一次判空" }];
  assert.equal((await dispose(h, findings[0]!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(1);
  const queuedId = (await proposals(h))[0]!.id;

  // 并入要覆盖队列里那条的陈述,没有新陈述可写的并入不成其为一次并入:整条丢掉。
  items = [{ type: "rule", scope: "", statement: "   ", proposalId: queuedId }];
  assert.equal((await dispose(h, findings[1]!.id, "又一条备注")).status, 200);
  await h.dispositionFeedbackAtLeast(2);
  assert.equal(h.dispositionFeedbacks[1]!.failure, undefined);

  const queued = await proposals(h);
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.statement, "边界上一次判空");
  assert.equal(queued[0]!.sources.length, 1);
  // 轨迹里说得出丢掉的是一次并入,以及为什么:那道按型收窄只会静默丢掉空陈述。
  assert.deepEqual(
    ruleTraceKinds(h).filter((kind) => kind === "rule_proposal_dropped"),
    ["rule_proposal_dropped"],
  );
});

test("反哺产出超过 100 字的陈述:新增那条不入队,并入那条不覆盖原陈述", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithFindings(agent);
  const findings = await inlineFindings(h);

  // 边界那一条正好 101 字:100 字的留下,101 字的丢掉(CONTEXT.md 陈述形状)。
  items = [
    { type: "rule", scope: "", statement: "长".repeat(100) },
    { type: "rule", scope: "", statement: "长".repeat(101), reason: "整段论证写进了陈述" },
  ];
  assert.equal((await dispose(h, findings[0]!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(1);
  assert.equal(h.dispositionFeedbacks[0]!.failure, undefined);

  const queuedId = (await proposals(h))[0]!.id;
  assert.deepEqual(
    (await proposals(h)).map((entry) => entry.statement),
    ["长".repeat(100)],
  );
  assert.deepEqual(ruleTraceDrops(h), [{ reason: "陈述超过 100 字" }]);

  // 并入给出的新陈述超长同样丢掉:它会覆盖队列里那条的陈述,超长的一句盖上去等于绕开
  // 这道闸。原提案的陈述与附注因此一行不动。
  items = [{ type: "rule", scope: "", statement: "长".repeat(101), proposalId: queuedId }];
  assert.equal((await dispose(h, findings[1]!.id, "又一条备注")).status, 200);
  await h.dispositionFeedbackAtLeast(2);
  assert.equal(h.dispositionFeedbacks[1]!.failure, undefined);

  const queued = await proposals(h);
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.statement, "长".repeat(100));
  assert.equal(queued[0]!.sources.length, 1);
  assert.deepEqual(ruleTraceDrops(h), [
    { reason: "陈述超过 100 字" },
    { proposalId: queuedId, reason: "陈述超过 100 字" },
  ]);
});

test("带备注的处置建一条以那条 Finding 为锚的意图行:原文即备注、提交人即处置人", async () => {
  let items: RuleAgentItem[] = [];
  const agent = scriptedRuleAgent(() => ({ items }));
  const h = await harnessWithFindings(agent);
  const [target] = await inlineFindings(h);
  assert.notEqual(target, undefined);

  items = [{ type: "rule", scope: "src/**", statement: "边界上一次判空", reason: "越界在三处都有" }];
  assert.equal((await dispose(h, target!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(1);
  assert.equal(h.dispositionFeedbacks[0]!.failure, undefined);

  const [intent] = await intents(h);
  assert.notEqual(intent, undefined);
  assert.equal(intent!.text, NOTE);
  assert.equal(intent!.submittedBy, PANEL_ADMIN_USERNAME);
  assert.equal(intent!.targetKind, "finding");
  assert.equal(intent!.targetId, target!.id);
  // Finding 引用走既有的 `?finding=` 侧滑:阶段标识与提案附注上那一格同一个字面形状。
  assert.equal(
    intent!.targetStageId,
    `pr:${HARNESS_PR.owner}/${HARNESS_PR.repo}/${HARNESS_PR.number}`,
  );
  assert.equal(intent!.state, "completed");
  assert.equal(intent!.failure, null);
  assert.equal(typeof intent!.traceTaskId, "number");

  // 产出记在意图行上,附注的来源仍是处置反哺:并入修订意图改的是运行状态,不是来源。
  const queued = await proposals(h);
  assert.equal(queued.length, 1);
  assert.deepEqual(intent!.produced, { proposalIds: [queued[0]!.id], draftItemIds: [] });
  assert.equal(queued[0]!.sources[0]!.origin, "disposition-feedback");
  assert.equal(queued[0]!.sources[0]!.note, NOTE);
});

test("反哺解读失败:意图行失败带原因,处置本身照旧成功", async () => {
  const agent = scriptedRuleAgent(() => ({ items: [], failure: "厂商拒了这次调用" }));
  const h = await harnessWithFindings(agent);
  const [target] = await inlineFindings(h);

  assert.equal((await dispose(h, target!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(1);

  const [intent] = await intents(h);
  assert.equal(intent!.state, "failed");
  assert.match(intent!.failure ?? "", /厂商拒了这次调用/);
  assert.equal(intent!.targetKind, "finding");
});

test("重试失败的处置反哺:仍停在那条 Finding 报出时的 head,附注仍记处置反哺并挂那条 Finding", async () => {
  let attempt = 0;
  const agent = scriptedRuleAgent(() => {
    attempt += 1;
    return attempt === 1
      ? { items: [], failure: "Connection error." }
      : { items: [{ type: "rule", scope: "src/**", statement: "边界上一次判空", reason: "越界在三处都有" }] };
  });
  const h = await harnessWithFindings(agent);
  const [target] = await inlineFindings(h);

  assert.equal((await dispose(h, target!.id, NOTE)).status, 200);
  await h.dispositionFeedbackAtLeast(1);
  const [failed] = await intents(h);
  assert.equal(failed!.state, "failed");

  // 同一条 Finding 上另有一条在跑:finding 那一档不查互斥,与处置时同一个例外(issue #316)。
  const store = openStore(h.db.path);
  try {
    assert.notEqual(
      store.startRuleIntent(GITEA_REPO.id, {
        text: "同一条 Finding 上的另一条备注",
        submittedBy: PANEL_ADMIN_USERNAME,
        targetKind: "finding",
        targetId: target!.id,
        model: "test:global-model",
        startedAt: "2026-09-11T00:00:00.000Z",
      }),
      undefined,
    );
  } finally {
    store.close();
  }

  const response = await h.api(
    "POST",
    `/repos/${GITEA_REPO.id}/revision-intents/${failed!.id}/retry`,
  );
  assert.equal(response.status, 202);
  await h.dispositionFeedbackAtLeast(2);
  assert.equal(h.dispositionFeedbacks[1]!.findingId, target!.id);
  assert.equal(h.dispositionFeedbacks[1]!.failure, undefined);

  // 两次拿到的是同一份 Finding 上下文、同一个 head,走的仍是反哺那一段。
  assert.equal(agent.calls.length, 2);
  assert.equal(agent.calls[1]!.baselineSha, h.repo.headSha);
  assert.equal(agent.calls[1]!.baselineSha, agent.calls[0]!.baselineSha);
  assert.deepEqual(agent.calls[1]!.feedback, agent.calls[0]!.feedback);
  assert.equal(agent.calls[1]!.intent, undefined);

  const intent = (await intents(h)).find((row) => row.id === failed!.id)!;
  assert.equal(intent.state, "completed");
  assert.equal(intent.text, NOTE);
  assert.equal(intent.targetKind, "finding");
  assert.equal(intent.targetId, target!.id);
  assert.notEqual(intent.traceTaskId, null);
  assert.notEqual(intent.traceTaskId, failed!.traceTaskId);
  const queued = await proposals(h);
  assert.equal(queued.length, 1);
  assert.deepEqual(intent.produced, { proposalIds: [queued[0]!.id], draftItemIds: [] });
  assert.deepEqual(
    queued[0]!.sources.map((source) => [
      source.origin,
      source.note,
      source.findingId,
      source.traceTaskId,
    ]),
    [["disposition-feedback", NOTE, target!.id, intent.traceTaskId]],
  );
});
