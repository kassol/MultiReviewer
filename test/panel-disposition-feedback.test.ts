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

/** 一个已注册、已确认空知识集的仓库,跑完一轮并落下两条带行级评论的 Finding。 */
async function harnessWithFindings(ruleAgent: RuleAgent): Promise<PanelHarness> {
  const h = await startReadyPanelHarness(cleanups, {
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
      store.addReviewRule(GITEA_REPO.id, {
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
    items: [{ type: "rule", scope: "", statement: "一条规范陈述" }],
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
