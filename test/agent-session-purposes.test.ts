/**
 * Agent 会话每个用途的那一面(issue #366、#365、#364、#358、#359、#361):同一条真实链路
 * (`POST /messages → 常驻子进程 → Pi 会话 → 假模型服务 → 会话记录`),看的是用途决定的
 * 那几样——工具清单里有哪几件、题落成了哪条条目、术语与 spec / 票落进库没有、退役了的产出
 * 工具在不在。公用 harness 在 `support/agent-session.ts`(issue #399)。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { openStore } from "../src/review/store.ts";
import {
  AGENT_SESSION_QUESTION_ROUND_CUSTOM_TYPE,
  SYSTEM_MESSAGE_ENTRY,
} from "../src/reviewer/session-protocol.ts";
import { COMPLETE_SURVEY_TOOL } from "../src/reviewer/session-output-tools.ts";
import { ASK_QUESTION_ROUND_TOOL } from "../src/reviewer/session-question-tool.ts";
import {
  agentSessionContextGap,
  disposeAgentSessions,
} from "../src/webhook/agent-session.ts";
import { GITEA_REPO, type PanelHarness } from "./support/panel-harness.ts";
import { type StubTurn } from "./support/model-stub.ts";
import {
  AT,
  bodyOf,
  idle,
  MESSAGE,
  messagesAtLeast,
  POLL_ATTEMPTS,
  POLL_MS,
  queueOf,
  records,
  requestsAtLeast,
  send,
  startSessionHarness,
  type Record,
} from "./support/agent-session.ts";

/** 任意 JSON 对象。改坏一份好参数时按键改,不为此造一套类型。 */
type Json = globalThis.Record<string, unknown>;

/** 会话子代理条目里的一趟(issue #358)。与 `src/reviewer/session-subagent.ts` 那一份同形。 */
type SubagentRunRecord = {
  task: string;
  status: string;
  steps: number;
  calls: { name: string; error?: string }[];
  conclusion: string;
};

/**
 * 需求拆分那一条链路(CONTEXT.md 需求拆分,ADR 0035):按轮问 → 人答 → 从答案写术语 →
 * 写 spec、拆票、连阻塞边。脚本化的模型照这个顺序走一遍,压的是外部事实:题落成条目、
 * 答案回来是一条用户消息、术语与 spec / 票落进库,以及退役了的产出工具不在工具清单里。
 */
test("需求拆分:一轮提问、从答案写术语、写 spec 与两张票并连上阻塞边", async () => {
  const [SPEC, FIRST, SECOND] = [1, 1, 2];
  const turns: StubTurn[] = [
    {
      toolCall: {
        name: ASK_QUESTION_ROUND_TOOL,
        args: {
          questions: [
            {
              title: "按哪个汇率折算",
              body: "报销单提交之后汇率变了,折算金额跟不跟着变",
              options: [
                { text: "锁定提交当月的月结汇率", recommended: true },
                { text: "每次读当天汇率", recommended: false },
              ],
              multiple: false,
            },
          ],
        },
      },
      usage: { input: 100, output: 20 },
    },
    // 答案就是裁决:当轮把定下来的术语写进产品知识。
    {
      toolCall: {
        name: "write_knowledge",
        args: {
          kind: "term",
          name: "月结汇率",
          body: "每个月为每种币种定一次、当月不再变的折算汇率。",
          avoided: ["汇率快照"],
        },
      },
      usage: { input: 40, output: 8 },
    },
    {
      toolCall: {
        name: "tracker_create_spec",
        args: {
          title: "报销单按原币录入",
          body: "## Problem Statement\n\n外币报销现在要人手算折算金额。",
        },
      },
      usage: { input: 40, output: 8 },
    },
    {
      toolCall: {
        name: "tracker_create_ticket",
        args: { spec: SPEC, title: "月结汇率表", body: "按年月与币种唯一", label: "ready-for-agent" },
      },
      usage: { input: 30, output: 6 },
    },
    {
      toolCall: {
        name: "tracker_create_ticket",
        args: {
          spec: SPEC,
          title: "报销单按原币录入",
          body: "提交时锁定当月汇率",
          label: "ready-for-agent",
        },
      },
      usage: { input: 30, output: 6 },
    },
    {
      toolCall: { name: "tracker_block", args: { ticket: SECOND, blockedBy: FIRST } },
      usage: { input: 20, output: 4 },
    },
    { text: "写好了一条 spec 与两张票", usage: { input: 20, output: 4 } },
  ];
  const { h, cookie, sessionId, productId, requests, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    const asked = await roundsAtLeast(h, cookie, sessionId, 1);
    await idle(h, cookie, sessionId);
    assert.equal(asked.length, 1);
    assert.match(JSON.stringify(asked[0]!.entry), /锁定提交当月的月结汇率/);

    // 退役的产出工具不在工具清单里:这一场的产出落在产品知识与产品 tracker 上。
    assert.ok(!requests[0]!.tools.includes("submit_requirement_breakdown"));
    assert.ok(requests[0]!.tools.includes("tracker_create_spec"));

    // 答这一轮:合成的那条用户消息走与输入区同一条发消息路径。
    assert.equal(
      (await send(h, cookie, sessionId, "c2", "1. 按哪个汇率折算\n- 锁定提交当月的月结汇率")).status,
      202,
    );
    await idle(h, cookie, sessionId);

    const store = openStore(h.db.path);
    try {
      // 答案落成一条术语,写下即生效。
      assert.deepEqual(
        (await store
          .listProductKnowledge(productId))
          .map((entry) => [entry.kind, entry.name, entry.writtenBySessionId]),
        [["term", "月结汇率", sessionId]],
      );
      // spec 与它的两张票落在这个产品下,记着写下它们的这一场会话。
      assert.deepEqual(
        (await store.listProductSpecs(productId)).map((spec) => [spec.id, spec.title, spec.sessionId]),
        [[SPEC, "报销单按原币录入", sessionId]],
      );
      assert.deepEqual(
        (await store
          .listProductTickets(productId))
          .map((one) => [one.id, one.title, one.blockedBy, one.sessionId]),
        [
          [FIRST, "月结汇率表", [], sessionId],
          [SECOND, "报销单按原币录入", [FIRST], sessionId],
        ],
      );
    } finally {
      await store.close();
    }
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

const SURVEY_REPO_ID = 909;
const SURVEY_REPO = { repoId: SURVEY_REPO_ID, owner: "acme", repo: "alpha" };
const ACTIVE_STATEMENT = "acme/widgets 的订单接口由 acme/alpha 的网关转发,契约是 OpenAPI";

/** 产品页读到的一条产品知识(CONTEXT.md 产品知识,issue #360)。 */
type KnowledgeEntry = {
  id: number;
  kind: "term" | "relationship" | "decision";
  name: string;
  body: string;
  topic: string | null;
  avoided: string[];
  options: string | null;
  consequences: string | null;
  supersededBy: number | null;
  annotations: { location: string; reason: string }[];
};

/** 这个产品此刻的产品知识(CONTEXT.md 产品知识)。 */
async function productKnowledge(h: PanelHarness, productId: number): Promise<KnowledgeEntry[]> {
  const response = await h.api("GET", `/products/${productId}`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { knowledge: KnowledgeEntry[] }).knowledge;
}

/** 落一条产品知识,不经子进程。压提示与改写的那几例用它播种。 */
async function seedKnowledge(
  dbPath: string,
  productId: number,
  record: { kind: "term" | "relationship" | "decision"; name?: string; body: string },
): Promise<number> {
  const store = openStore(dbPath);
  try {
    return (await store.writeProductKnowledge({
      productId,
      kind: record.kind,
      name: record.name ?? "",
      body: record.body,
      topic: null,
      avoided: [],
      options: null,
      consequences: null,
      annotations: [],
      at: AT,
      sessionId: null,
    }))!.id;
  } finally {
    await store.close();
  }
}

/**
 * 产品梳理的整条访谈(CONTEXT.md 产品梳理,issue #365):派子代理出候选 → 抛一轮题 → 人答
 * → 把答案写成条目 → 宣告共识调完成工具。钉的是桩测不到的那几件——提示带的是**整份**产品
 * 知识(不是三行目录)、带着 skill 替代说明那一段、种子消息真的进了第一次模型请求、这四样
 * 动作各自落成会话记录,以及完成那一格落在会话上。
 *
 * 子代理那一趟走真实的 pi-subagents(先例:同文件「会话里派一个子代理」),因此脚本里夹着
 * 子会话自己那两轮。
 */
const SURVEY_TURNS: StubTurn[] = [
  {
    text: "先派个子代理读一遍",
    toolCall: {
      name: "subagent",
      args: { agent: "explore", task: "acme/widgets 里「订单」这个词指的是什么" },
    },
    usage: { input: 40, output: 10 },
  },
  // 子会话:读一个文件,回一句结论。
  {
    text: "读目标文件",
    toolCall: {
      name: "read",
      args: { path: `${GITEA_REPO.owner}/${GITEA_REPO.repo}/src/answer.ts` },
    },
    usage: { input: 12, output: 4 },
  },
  { text: "answer.ts:1 写着 export const answer = 1;", usage: { input: 18, output: 8 } },
  // 拿着候选抛第一轮题,回合就地收尾等人答。
  {
    text: "候选出来了,先问你一轮",
    toolCall: {
      name: ASK_QUESTION_ROUND_TOOL,
      args: {
        questions: [
          {
            title: "订单指的是哪一层",
            body: "代码里 order 同时指请求体与聚合根,读不出哪个是这个产品说的那个",
            options: [
              { text: "下单后的那张单据", recommended: true },
              { text: "购物车里的一次结算请求", recommended: false },
            ],
            multiple: false,
          },
        ],
      },
    },
    usage: { input: 90, output: 18 },
  },
  // 答案回来:当场写成一条术语条目。
  {
    toolCall: {
      name: "write_knowledge",
      args: {
        kind: "term",
        name: "订单",
        body: "人下单之后生成的那张单据,从待审批走到已结清",
        topic: "报销",
        avoided: ["单子"],
      },
    },
    usage: { input: 30, output: 8 },
  },
  // frontier 空了:宣告共识并调完成工具。
  {
    text: "问不出新的了",
    toolCall: { name: COMPLETE_SURVEY_TOOL, args: {} },
    usage: { input: 20, output: 6 },
  },
  { text: "这个产品现在写下了「订单」这一条", usage: { input: 10, output: 4 } },
];

/** 面板把那一轮的答案合成的那条用户消息。 */
const SURVEY_ANSWER = ["提问轮次的回答:", "", "1. 订单指的是哪一层", "- 下单后的那张单据"].join(
  "\n",
);

test("产品梳理:提示带整份产品知识与替代说明,子代理、一轮题、写下的条目与完成标记都落库", async () => {
  const { h, productId, requests, close } = await startSessionHarness(SURVEY_TURNS, {
    extraRepo: SURVEY_REPO,
  });
  try {
    // 先落一条仓库关系与一条术语:梳理的提示带的是整条正文,不是目录里的一个名字。
    assert.equal(
      await seedKnowledge(h.db.path, productId, { kind: "relationship", body: ACTIVE_STATEMENT }),
      1,
    );
    assert.equal(
      await seedKnowledge(h.db.path, productId, {
        kind: "term",
        name: "结算",
        body: "把一张已审批的单据划给财务付款的那一步",
      }),
      2,
    );

    const opened = await h.api("POST", `/products/${productId}/survey`);
    const openedText = await opened.text();
    assert.equal(opened.status, 201, openedText);
    const { session } = JSON.parse(openedText) as { session: { id: number; createdBy: string } };
    await roundsAtLeast(h, h.cookie, session.id, 1);
    await idle(h, h.cookie, session.id);

    const system = requests[0]!.messages.filter((message) => message.role === "system");
    assert.equal(system.length, 1);
    assert.match(system[0]!.content, /^## This session: interviewing the person about this product$/m);
    // 整份产品知识,不是三行目录:那一条仓库关系带着它的 id 与正文出现在提示里。
    assert.match(
      system[0]!.content,
      new RegExp(`^- \\[1\\] repository relationship: ${ACTIVE_STATEMENT}$`, "m"),
    );
    assert.match(
      system[0]!.content,
      /^- \[2\] glossary term 结算: 把一张已审批的单据划给财务付款的那一步$/m,
    );
    // 目录那一行只给别的用途:这个用途看得到自己可能改写的每一条正文。
    assert.doesNotMatch(system[0]!.content, /^- Glossary terms:/m);
    // skill 替代说明那一段(issue #364)同在。
    assert.match(system[0]!.content, /^## The skills in this session$/m);
    // 这个用途的工具面:只读四件套、git、历史 Finding 查询、知识三件、提问轮次、会话子代理
    // 与无参的完成工具。**产品 tracker 那九件不在**(评审复核):梳理谈的是这个产品是什么,
    // 产出是产品知识条目,给它那九件只会让访谈中途拐去开票。
    assert.deepEqual([...requests[0]!.tools].sort(), [
      "ask_question_round",
      COMPLETE_SURVEY_TOOL,
      "find",
      "git",
      "grep",
      "ls",
      "query_findings",
      "query_knowledge",
      "read",
      "subagent",
      "withdraw_knowledge",
      "write_knowledge",
    ]);
    // 底座那一段 tracker 说明跟着工具面走:手上没有的工具不该在提示里写成「yours to write」。
    assert.doesNotMatch(system[0]!.content, /This product also has a tracker/);
    // 种子消息:开场投的那一条在第一次请求的用户消息里,它要的是先派子代理再抛第一轮题。
    const seed = requests[0]!.messages.find(
      (message) => message.role === "user" && message.content.includes("Survey this product with me"),
    );
    assert.ok(seed, "种子消息没进模型请求");
    assert.match(seed.content, /send subagents into the repositories/);

    // 子代理那一趟落成一条记录,提问轮次落成另一种条目。
    const drafted = await records(h, h.cookie, session.id);
    const dispatched = drafted.filter(
      (one) => (one.entry as { customType?: string }).customType === "multireviewer-session-subagent",
    );
    assert.equal(dispatched.length, 1, "子代理派单没落成条目");
    const { runs } = (dispatched[0]!.entry as unknown as { data: { runs: SubagentRunRecord[] } })
      .data;
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "done");

    // 一轮题抛出去就收尾:这一刻还没写下新条目。
    assert.equal(
      (await productKnowledge(h, productId)).map((row) => row.kind).join(","),
      "term,relationship",
    );

    // 人答完这一轮:答案当场写成一条术语条目,接着 agent 宣告共识。
    assert.equal(
      (
        await fetch(`${h.serverUrl}/api/agent-sessions/${session.id}/messages`, {
          method: "POST",
          headers: { cookie: h.cookie, "content-type": "application/json" },
          body: JSON.stringify({ clientMessageId: "c2", text: SURVEY_ANSWER }),
        })
      ).status,
      202,
    );
    await idle(h, h.cookie, session.id);

    assert.deepEqual(
      (await productKnowledge(h, productId)).map((row) => [row.kind, row.name, row.topic]),
      [
        ["term", "结算", null],
        ["term", "订单", "报销"],
        ["relationship", "", null],
      ],
    );

    // 完成标记落在会话上:同一个产品的下一场因此开得起来。
    const read = await h.api("GET", `/agent-sessions/${session.id}`);
    assert.equal(read.status, 200);
    const completedAt = (
      (await read.json()) as { session: { completedAt: string | null } }
    ).session.completedAt;
    assert.notEqual(completedAt, null);

    // 谈完的会话照旧续得了:创建者再发一条,接口收下它。
    const again = await h.api("POST", `/products/${productId}/survey`);
    assert.equal(again.status, 201, await again.text());
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

/** 一次知识写入的脚本响应。 */
function writeKnowledge(args: globalThis.Record<string, unknown>): StubTurn {
  return { toolCall: { name: "write_knowledge", args }, usage: { input: 10, output: 2 } };
}

test("知识工具:三种条目写下即生效,改写与撤回算数,形状不对的带理由打回", async () => {
  const annotation = { location: "acme/widgets/src/order.ts:42", reason: "状态机在这里" };
  const turns: StubTurn[] = [
    // 定义里带路径:打回,说得出判据。
    writeKnowledge({ kind: "term", name: "订单", body: "src/order.ts 里的那个聚合根" }),
    // 决策没有标题:打回。
    writeKnowledge({ kind: "decision", body: "签名换成 HMAC,因为对称密钥好轮换" }),
    // 定义为空:打回。
    writeKnowledge({ kind: "term", name: "订单", body: "   " }),
    writeKnowledge({
      kind: "term",
      name: "订单",
      body: "一次可以付钱的购买请求,付款成功之后才进履约。",
      topic: "交易",
      avoided: ["单子", ""],
      annotations: [annotation],
    }),
    writeKnowledge({ kind: "relationship", body: "网关向订单服务要状态,订单服务不回调网关。" }),
    writeKnowledge({
      kind: "decision",
      name: "签名统一用 HMAC",
      body: "两个仓库各签各的,轮换一次要改两处;统一成 HMAC,密钥一处轮换。",
      options: "考虑过非对称签名,私钥分发更麻烦。",
      consequences: "两侧都要读同一份密钥。",
    }),
    // 改写第一条:定义换一版,id 不变。
    writeKnowledge({
      kind: "term",
      entryId: 1,
      name: "订单",
      body: "一次可以付钱的购买请求,取消之前都改得动。",
      topic: "交易",
    }),
    {
      toolCall: {
        name: "query_knowledge",
        args: { names: ["订单", "签名统一用 HMAC"], relationships: true },
      },
      usage: { input: 10, output: 2 },
    },
    {
      toolCall: { name: "withdraw_knowledge", args: { entryId: 2 } },
      usage: { input: 10, output: 2 },
    },
    { text: "写完了", usage: { input: 8, output: 2 } },
  ];
  const { h, cookie, sessionId, productId, requests, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await idle(h, cookie, sessionId);

    // 三件知识工具都在工具面上,所有用途都注册。
    for (const tool of ["query_knowledge", "write_knowledge", "withdraw_knowledge"]) {
      assert.ok(requests[0]!.tools.includes(tool), `工具面里没有 ${tool}`);
    }

    const rows = await records(h, cookie, sessionId);
    const results = rows
      .filter((row) => row.entry.message?.role === "toolResult")
      .map((row) => JSON.stringify(row.entry.message?.content));
    assert.equal(results.length, 9, `工具结果条数不对:${results.join("\n")}`);
    // 三道打回各说一句能改得动的理由。
    assert.match(results[0]!, /reads as implementation/);
    assert.match(results[0]!, /it contains the path src\/order.ts/);
    assert.match(results[1]!, /a decision needs a title/);
    assert.match(results[2]!, /the definition is empty/);
    // 落下来的那三条各回自己的 id:改写与撤回按它指。
    assert.match(results[3]!, /written as entry 1/);
    assert.match(results[4]!, /written as entry 2/);
    assert.match(results[5]!, /written as entry 3/);

    // 按名字读整条:术语带分组、决策带状态与备选项,仓库关系整段回。
    assert.match(results[7]!, /\[1\] glossary term 订单 \(topic 交易\)/);
    assert.match(results[7]!, /一次可以付钱的购买请求,取消之前都改得动。/);
    assert.match(results[7]!, /\[2\] repository relationship: 网关向订单服务要状态/);
    assert.match(results[7]!, /\[3\] decision 签名统一用 HMAC \(in force\)/);
    assert.match(results[7]!, /Options considered: 考虑过非对称签名/);
    // 出处附注只在产品页上看得到,一次查询里不回(ADR 0035)。
    assert.equal(results[7]!.includes(annotation.location), false);
    assert.equal(results[7]!.includes(annotation.reason), false);

    // 产品页读到的最终形状:改写落在同一条上,撤回那一条不在了,附注在。
    const knowledge = await productKnowledge(h, productId);
    assert.deepEqual(
      knowledge.map((row) => [row.id, row.kind, row.name]),
      [
        [1, "term", "订单"],
        [3, "decision", "签名统一用 HMAC"],
      ],
    );
    const term = knowledge[0]!;
    assert.equal(term.body, "一次可以付钱的购买请求,取消之前都改得动。");
    assert.equal(term.topic, "交易");
    // 改写是整条替换:上一版列出的避免词没留在这一版上。
    assert.deepEqual(term.avoided, []);
    assert.deepEqual(term.annotations, []);
    const decision = knowledge[1]!;
    assert.equal(decision.supersededBy, null);
    assert.equal(decision.consequences, "两侧都要读同一份密钥。");
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

/**
 * 产品 tracker 的工具面(CONTEXT.md 产品 tracker,issue #361)。
 *
 * 票号在脚本里是写死的:临时库里两张表都从 1 起自增,别的产品那一条 spec 与那一张票在会话
 * 开跑之前先落库,因此占掉 1 号,这一场写下的 spec 是 2 号、两张票是 2 与 3 号。
 */
test("tracker 工具:写 spec 与票、加阻塞边、改正文、关票与评论,自指与跨产品的边被打回", async () => {
  const FOREIGN_TICKET = 1;
  const SPEC = 2;
  const [FIRST, SECOND] = [2, 3];
  const turns: StubTurn[] = [
    {
      toolCall: {
        name: "tracker_create_spec",
        args: { title: "  报销单可以撤回  ", body: "## Problem Statement\n\n提交之后改不了。" },
      },
      usage: { input: 100, output: 20 },
    },
    {
      toolCall: {
        name: "tracker_create_ticket",
        args: { spec: SPEC, title: "撤回接口", body: "PATCH /expenses/{id}", label: "ready-for-agent" },
      },
      usage: { input: 30, output: 5 },
    },
    {
      toolCall: {
        name: "tracker_create_ticket",
        args: { spec: SPEC, title: "撤回按钮", body: "列表页每行一颗", label: "needs-info" },
      },
      usage: { input: 30, output: 5 },
    },
    {
      toolCall: { name: "tracker_block", args: { ticket: SECOND, blockedBy: FIRST } },
      usage: { input: 20, output: 4 },
    },
    {
      toolCall: {
        name: "tracker_update_body",
        args: { kind: "ticket", id: FIRST, body: "PATCH /expenses/{id};重复撤回回 409。" },
      },
      usage: { input: 20, output: 4 },
    },
    {
      toolCall: { name: "tracker_close", args: { kind: "ticket", id: FIRST } },
      usage: { input: 20, output: 4 },
    },
    {
      toolCall: {
        name: "tracker_comment",
        args: { ticket: SECOND, body: "财务确认了只有草稿态能撤回。" },
      },
      usage: { input: 20, output: 4 },
    },
    // 自指的边。
    {
      toolCall: { name: "tracker_block", args: { ticket: SECOND, blockedBy: SECOND } },
      usage: { input: 20, output: 4 },
    },
    // 别的产品那张票。
    {
      toolCall: { name: "tracker_block", args: { ticket: SECOND, blockedBy: FOREIGN_TICKET } },
      usage: { input: 20, output: 4 },
    },
    { toolCall: { name: "tracker_list", args: {} }, usage: { input: 20, output: 4 } },
    { text: "写完了", usage: { input: 20, output: 4 } },
  ];
  const { h, cookie, sessionId, productId, close } = await startSessionHarness(turns);
  try {
    // 别的产品的 spec 与票:跨产品的边要打回的正是指向它的那一条。
    const store = openStore(h.db.path);
    let foreignProductId: number;
    try {
      foreignProductId = (await store.createProduct({ name: "结算系统", createdAt: AT })).id;
      const foreignSpec = await store.createProductSpec({
        productId: foreignProductId,
        title: "对账",
        body: "别的产品的 spec",
        sessionId: null,
        at: AT,
      });
      assert.equal(
        (await store.createProductTicket({
          specId: foreignSpec.id,
          title: "对账明细",
          body: "别的产品的票",
          label: "needs-triage",
          sessionId: null,
          at: AT,
        })).id,
        FOREIGN_TICKET,
      );
    } finally {
      await store.close();
    }

    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await idle(h, cookie, sessionId);

    const after = openStore(h.db.path);
    try {
      // spec 与票都落在这个产品下,标题两头的空白去掉了。
      const specs = await after.listProductSpecs(productId);
      assert.deepEqual(
        specs.map((spec) => [spec.id, spec.title, spec.state, spec.sessionId]),
        [[SPEC, "报销单可以撤回", "open", sessionId]],
      );
      assert.match(specs[0]!.body, /提交之后改不了。/);

      const tickets = await after.listProductTickets(productId);
      assert.deepEqual(
        tickets.map((one) => [one.id, one.title, one.label, one.state, one.blockedBy]),
        [
          [FIRST, "撤回接口", "ready-for-agent", "closed", []],
          [SECOND, "撤回按钮", "needs-info", "open", [FIRST]],
        ],
      );
      // 改正文改的就是那一张票。
      assert.match(tickets[0]!.body, /重复撤回回 409/);
      // 评论记在写它的那个会话名下。
      assert.deepEqual(
        (await after.listProductTicketComments(SECOND)).map((one) => [one.body, one.sessionId]),
        [["财务确认了只有草稿态能撤回。", sessionId]],
      );
      // 打回的那两条一条边都没加上,别的产品那张票也没被牵进来。
      assert.deepEqual((await after.getProductTicket(FOREIGN_TICKET))?.blockedBy, []);
      assert.equal((await after.listProductSpecs(foreignProductId)).length, 1);
    } finally {
      await after.close();
    }

    // 两次打回各自的理由在记录表里的工具结果上,打回走的是正常返回。
    const results = (await records(h, cookie, sessionId))
      .filter((row) => row.entry.message?.role === "toolResult")
      .map((row) => JSON.stringify(row.entry));
    assert.equal(results.length, turns.length - 1);
    assert.match(results[7]!, /cannot block itself/);
    assert.match(results[8]!, new RegExp(`there is no ticket ${FOREIGN_TICKET} in this product`));
    // 列表看得到这条 spec 与它的两张票,阻塞关系也在。
    assert.match(results[9]!, new RegExp(`spec ${SPEC}`));
    assert.match(results[9]!, new RegExp(`blocked by ticket ${FIRST}`));
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

/**
 * 会话 skill(CONTEXT.md 会话 skill,issue #364)。
 *
 * 这一条是真实 SDK 的回归:铺进 agentDir 的那几个 skill 由 Pi 自己扫出来、写进系统提示的
 * `<available_skills>`,桩测验不到这一步。同时钉住「恰好是这几个」——Pi 默认还扫
 * `~/.agents/skills`,开发机上那一堆宿主机 skill 不能渗进会话。
 */
test("会话 skill:铺进 agentDir 的那几个被 Pi 列进系统提示,替代说明跟在用途那一段后面", async () => {
  const turns: StubTurn[] = [{ text: "在", usage: { input: 10, output: 2 } }];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns, {
    purpose: "open-conversation",
  });
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", "这个产品是做什么的")).status, 202);
    await idle(h, cookie, sessionId);

    const system = requests[0]!.messages.find((message) => message.role === "system")!.content;
    const listed = [...system.matchAll(/<name>([^<]+)<\/name>/g)].map((match) => match[1]);
    // 开放对话那五个,加 pi-subagents 这个包自带的两份派单说明——它作为 pi 包铺进会话
    // (issue #358),Pi 连它 `skills/` 下的两个一起收。宿主机的全局 skill 目录一个都不在。
    assert.deepEqual(
      [...listed].sort(),
      [
        "ask-matt",
        "council-mode",
        "domain-modeling",
        "grilling",
        "pi-subagents",
        "to-spec",
        "to-tickets",
      ],
      "开放对话这一档列出的 skill 不对",
    );
    // 正文的位置也在提示里:模型据它用 read 打开,而 read 放行了这一段路径。
    for (const name of ["ask-matt", "domain-modeling", "grilling", "to-spec", "to-tickets"]) {
      assert.match(system, new RegExp(`<location>.*/skills/${name}/SKILL\\.md</location>`), name);
    }
    assert.match(system, /^## The skills in this session$/m);
    assert.match(system, /^## This session: an open conversation about this product$/m);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

/**
 * 开放对话走同一条流程(CONTEXT.md 开放对话,issue #364):说「grill 这个」得到一轮提问,
 * 说「收成 spec」把 spec 与票写进产品 tracker,想写文件被工具面挡回去。
 */
test("开放对话:grill 得到提问轮次,收成 spec 写进 tracker,写文件被工具面打回", async () => {
  const [SPEC, TICKET] = [1, 1];
  const turns: StubTurn[] = [
    {
      toolCall: {
        name: ASK_QUESTION_ROUND_TOOL,
        args: {
          questions: [
            {
              title: "撤回到哪一步为止",
              body: "已经进了财务复核的单子还能不能撤回",
              options: [
                { text: "只有草稿态能撤回", recommended: true },
                { text: "复核前都能撤回", recommended: false },
              ],
              multiple: false,
            },
          ],
        },
      },
      usage: { input: 100, output: 20 },
    },
    {
      toolCall: {
        name: "tracker_create_spec",
        args: { title: "报销单可以撤回", body: "## Problem Statement\n\n提交之后改不了。" },
      },
      usage: { input: 40, output: 8 },
    },
    {
      toolCall: {
        name: "tracker_create_ticket",
        args: { spec: SPEC, title: "撤回接口", body: "PATCH /expenses/{id}", label: "ready-for-agent" },
      },
      usage: { input: 30, output: 6 },
    },
    { text: "写好了一条 spec 与一张票", usage: { input: 20, output: 4 } },
    {
      toolCall: { name: "write", args: { path: "notes.md", content: "撤回规则" } },
      usage: { input: 20, output: 4 },
    },
    { text: "这里写不了文件", usage: { input: 20, output: 4 } },
  ];
  const { h, cookie, sessionId, productId, close } = await startSessionHarness(turns, {
    purpose: "open-conversation",
  });
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", "grill 这个:报销单可以撤回")).status, 202);
    // 一轮提问落成一条自己那一种的条目,会话就此转空闲等人答题。
    const asked = await roundsAtLeast(h, cookie, sessionId, 1);
    await idle(h, cookie, sessionId);
    assert.equal(asked.length, 1);
    assert.match(JSON.stringify(asked[0]!.entry), /只有草稿态能撤回/);

    assert.equal((await send(h, cookie, sessionId, "c2", "收成 spec")).status, 202);
    await idle(h, cookie, sessionId);
    const store = openStore(h.db.path);
    try {
      assert.deepEqual(
        (await store.listProductSpecs(productId)).map((spec) => [spec.id, spec.title, spec.sessionId]),
        [[SPEC, "报销单可以撤回", sessionId]],
      );
      assert.deepEqual(
        (await store.listProductTickets(productId)).map((one) => [one.id, one.title, one.label]),
        [[TICKET, "撤回接口", "ready-for-agent"]],
      );
    } finally {
      await store.close();
    }

    // 写文件那一次:`write` 一开始就没注册,调用它拿回的是一条错误的工具结果。
    assert.equal((await send(h, cookie, sessionId, "c3", "顺手写份笔记进仓库")).status, 202);
    await idle(h, cookie, sessionId);
    const results = (await records(h, cookie, sessionId))
      .filter((row) => row.entry.message?.role === "toolResult")
      .map((row) => JSON.stringify(row.entry));
    assert.match(results[results.length - 1]!, /"isError":true/);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

/**
 * 会话子代理的真实 SDK 回归(issue #358),先例是 `reviewer-evidence-session.test.ts`:
 * `POST /messages → 常驻子进程 → pi-subagents → 子会话 → transcript → 会话记录`,整条走
 * 一遍。钉的是桩测不到的几件事——子代理的工具面恰是只读四件套(派单工具本身不在其中)、
 * 出会话根的路径被拒、它读到的文件内容回到了它自己的模型请求里,以及这一趟的任务、状态、
 * 步数、工具调用与结论作一条记录落进了库,回收重建之后仍在。
 */
const SUBAGENT_TURNS: StubTurn[] = [
  {
    text: "这一段得深读,派个子代理",
    toolCall: {
      name: "subagent",
      args: { agent: "explore", task: "answer.ts 的第 1 行写的是什么" },
    },
    usage: { input: 40, output: 10 },
  },
  // 子会话第一步:一次出根的 grep 与一次正常的读。出根那一次由铺进 agentDir 的只读四件套
  // 扩展拒掉,子会话照常往下走。
  {
    text: "先看看系统目录",
    toolCall: { name: "grep", args: { pattern: "root", path: "/etc" } },
    usage: { input: 12, output: 4 },
  },
  {
    text: "读目标文件",
    toolCall: {
      name: "read",
      args: { path: `${GITEA_REPO.owner}/${GITEA_REPO.repo}/src/answer.ts` },
    },
    usage: { input: 12, output: 4 },
  },
  { text: "answer.ts:1 写着 export const answer = 2;", usage: { input: 18, output: 8 } },
  { text: "子代理带回来了:answer 是 2", usage: { input: 20, output: 6 } },
];

test("会话里派一个子代理:工具面是只读四件套、出根被拒,过程与结论落成会话记录(issue #358)", async () => {
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(SUBAGENT_TURNS);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await requestsAtLeast(requests, 5);
    await idle(h, cookie, sessionId);

    // 父会话的工具面有派单工具;子会话的恰是只读四件套——派单工具、git、两种查询与
    // pi-subagents 自己的 contact_supervisor 一个都不在。单层靠工具面构造出来。
    assert.ok(requests[0]!.tools.includes("subagent"));
    assert.deepEqual([...requests[1]!.tools].sort(), ["find", "grep", "ls", "read"]);

    // 子会话第三次请求里那条工具返回就是文件内容:证明 read 真读到了会话根里的工作树。
    const readResult = requests[3]!.messages.findLast((message) => message.role === "tool");
    assert.ok(readResult, "子会话第三次请求没带 read 的返回");
    assert.match(readResult.content, /^1: export const answer = 1;/m);

    // 这一趟落成一条记录:任务、状态、步数、逐次工具调用与结论。出根的那次 grep 带着原因。
    const landed = await records(h, cookie, sessionId);
    const dispatched = landed.filter(
      (one) => (one.entry as { customType?: string }).customType === "multireviewer-session-subagent",
    );
    assert.equal(dispatched.length, 1, "子代理派单没落成条目");
    const { runs } = (dispatched[0]!.entry as unknown as { data: { runs: SubagentRunRecord[] } }).data;
    assert.equal(runs.length, 1);
    const [run] = runs;
    assert.ok(run);
    assert.equal(run.task, "answer.ts 的第 1 行写的是什么");
    assert.equal(run.status, "done");
    assert.equal(run.steps, 2);
    assert.deepEqual(run.calls.map((call) => call.name), ["grep", "read"]);
    assert.match(run.calls[0]!.error ?? "", /outside|超出|not in|会话根|repository/i);
    assert.match(run.conclusion, /answer\.ts:1/);

    // 回收之后从记录重建,这一条照样在:transcript 文件随子进程的临时目录没了,卡片靠它。
    await disposeAgentSessions();
    const rebuilt = await records(h, cookie, sessionId);
    assert.deepEqual(
      rebuilt.map((one) => (one.entry as { customType?: string }).customType ?? one.type),
      landed.map((one) => (one.entry as { customType?: string }).customType ?? one.type),
    );
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

/** 一轮题的工具参数。标题两头带空白、第一题掺一个空选项,用来压服务端归一化。 */
const ROUND_ARGS: Json = {
  questions: [
    {
      title: "  汇率取哪一天的  ",
      body: "两处代码都取提交当天,财务那边的口径我读不出来",
      options: [
        { text: " 提交当天 ", recommended: true },
        { text: "月末统一", recommended: false },
        { text: "   ", recommended: false },
      ],
      multiple: false,
    },
    {
      title: "撤回之后谁收到通知",
      body: "现在只有审批人一条路",
      options: [
        { text: "审批人", recommended: true },
        { text: "抄送人", recommended: false },
      ],
      multiple: true,
    },
  ],
};

/** 面板把整轮答案合成的那一条用户消息(`web/src/lib/session-question-round.ts` 的格式)。 */
const ROUND_ANSWER = [
  "提问轮次的回答:",
  "",
  "1. 汇率取哪一天的",
  "- 月末统一",
  "",
  "2. 撤回之后谁收到通知",
  "- 审批人",
  "- 抄送人",
].join("\n");

/** 等到这个会话落了这么多条提问轮次条目。等的是库里的行,不猜子进程的时序。 */
async function roundsAtLeast(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
  count: number,
): Promise<Record[]> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const rows = (await records(h, cookie, sessionId)).filter(
      (row) =>
        row.type === "custom" &&
        (row.entry as { customType?: unknown }).customType ===
          AGENT_SESSION_QUESTION_ROUND_CUSTOM_TYPE,
    );
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  assert.fail(`等了 30 秒,会话 ${sessionId} 还没落到 ${count} 条提问轮次`);
}

test("提问轮次:一轮题落成新种类条目、回合就地收尾转空闲,整轮答案回来是一条用户消息", async () => {
  const turns: StubTurn[] = [
    {
      toolCall: { name: ASK_QUESTION_ROUND_TOOL, args: ROUND_ARGS },
      usage: { input: 90, output: 18 },
    },
    { text: "按月末统一算,通知审批人与抄送人", usage: { input: 60, output: 12 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    const rounds = await roundsAtLeast(h, cookie, sessionId, 1);
    await idle(h, cookie, sessionId);

    // 工具面里有它(需求拆分这个用途);产品梳理那一条用例验的是另一个用途。
    assert.ok(
      requests[0]!.tools.includes(ASK_QUESTION_ROUND_TOOL),
      `工具面里没有提问轮次:${requests[0]!.tools.join(",")}`,
    );
    // 落的是新种类条目,内容归一化过:标题两头空白去掉,空文字的选项丢掉。
    assert.equal(rounds.length, 1);
    assert.deepEqual((rounds[0]!.entry as { data?: unknown }).data, {
      questions: [
        {
          title: "汇率取哪一天的",
          body: "两处代码都取提交当天,财务那边的口径我读不出来",
          options: [
            { text: "提交当天", recommended: true },
            { text: "月末统一", recommended: false },
          ],
          multiple: false,
        },
        {
          title: "撤回之后谁收到通知",
          body: "现在只有审批人一条路",
          options: [
            { text: "审批人", recommended: true },
            { text: "抄送人", recommended: false },
          ],
          multiple: true,
        },
      ],
    });
    // 回合就地收尾:题抛出去之后没有第二次模型请求,会话已经空闲等人答题。
    assert.equal(requests.length, 1);
    // 这一下中止不是人点的停止,记录里因此没有那条系统消息。
    const rows = await records(h, cookie, sessionId);
    assert.equal(
      rows.filter(
        (row) => (row.entry as { customType?: unknown }).customType === SYSTEM_MESSAGE_ENTRY,
      ).length,
      0,
    );
    // 条目接在这次工具调用后面:主进程直接落库会让它成旁支,重建时被算成「不在上下文」。
    const store = openStore(h.db.path);
    try {
      assert.equal(agentSessionContextGap(await store.agentSessionEntryLinks(sessionId)), 0);
    } finally {
      await store.close();
    }

    // 整轮答案作一条用户消息回来,会话接着跑。
    assert.equal((await send(h, cookie, sessionId, "c2", ROUND_ANSWER)).status, 202);
    await requestsAtLeast(requests, 2);
    await idle(h, cookie, sessionId);
    const answers = requests[1]!.messages.filter(
      (message) => message.role === "user" && message.content.includes("提问轮次的回答"),
    );
    assert.equal(answers.length, 1);
    assert.match(answers[0]!.content, /1\. 汇率取哪一天的\n- 月末统一/);
    assert.match(answers[0]!.content, /2\. 撤回之后谁收到通知\n- 审批人\n- 抄送人/);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("不合规的一轮走正常返回打回:不落条目,回合照旧跑下去", async () => {
  /** 把一轮好题改坏:改哪一处由 `patch` 决定。 */
  const broken = (patch: (questions: Json[]) => void): Json => {
    const args = JSON.parse(JSON.stringify(ROUND_ARGS)) as Json;
    patch(args["questions"] as Json[]);
    return args;
  };
  const turns: StubTurn[] = [
    {
      // 一题都没有。
      toolCall: { name: ASK_QUESTION_ROUND_TOOL, args: { questions: [] } },
      usage: { input: 10, output: 2 },
    },
    {
      // 只剩一个选项。
      toolCall: {
        name: ASK_QUESTION_ROUND_TOOL,
        args: broken((questions) => {
          questions[0]!["options"] = [{ text: "提交当天", recommended: true }];
        }),
      },
      usage: { input: 10, output: 2 },
    },
    {
      // 没有推荐项。
      toolCall: {
        name: ASK_QUESTION_ROUND_TOOL,
        args: broken((questions) => {
          questions[1]!["options"] = [
            { text: "审批人", recommended: false },
            { text: "抄送人", recommended: false },
          ];
        }),
      },
      usage: { input: 10, output: 2 },
    },
    { text: "三次都被打回了,我重排一轮再问", usage: { input: 10, output: 2 } },
  ];
  const { h, cookie, sessionId, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    // 一个回合 = 用户消息 + 3 ×(助手消息 + 工具结果)+ 收尾的助手消息。
    await messagesAtLeast(h.db.path, sessionId, 8);
    await idle(h, cookie, sessionId);

    const rows = await records(h, cookie, sessionId);
    // 一条提问轮次都没落:打回的那几次不是一轮题,回合也没有被就地收尾。
    assert.equal(
      rows.filter(
        (row) =>
          (row.entry as { customType?: unknown }).customType ===
          AGENT_SESSION_QUESTION_ROUND_CUSTOM_TYPE,
      ).length,
      0,
    );
    const results = rows
      .filter((row) => row.entry.message?.role === "toolResult")
      .map((row) => JSON.stringify(row.entry));
    assert.equal(results.length, 3);
    assert.match(results[0]!, /this round has no questions/);
    assert.match(results[1]!, /question 1 has 1 options/);
    assert.match(results[2]!, /question 2 has 0 recommended options/);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

/**
 * 这一轮以提问卡收尾时,执行中排队的那条消息留在队列里没投出去(`endTurnAfterRound` 中止当前
 * 这一步,Pi 的 agent loop 不再排空队列)。人紧接着交答案时它要是先投出去,这张卡片就被自己
 * 的旧消息顶成过期,而答案随后照样送达——卡片上的话与事实相反(issue #406)。
 */
test("提问轮次的答案排在留存的排队消息前面:卡片不被自己的旧消息顶成过期", async () => {
  // 第一次回应等排队那一条进去之后才放行:窗口由测试放行,不靠延迟跑赢机器负载(issue #397)。
  const { promise: queuedIn, resolve: go } = Promise.withResolvers<void>();
  const turns: StubTurn[] = [
    {
      toolCall: { name: ASK_QUESTION_ROUND_TOOL, args: ROUND_ARGS },
      usage: { input: 90, output: 18 },
      release: queuedIn,
    },
    { text: "按答案接着办", usage: { input: 60, output: 12 } },
    { text: "排队那一条也回了", usage: { input: 50, output: 10 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await requestsAtLeast(requests, 1);
    assert.equal((await send(h, cookie, sessionId, "c2", "再补一句", "followUp")).status, 202);
    go();

    const rounds = await roundsAtLeast(h, cookie, sessionId, 1);
    await idle(h, cookie, sessionId);
    // 回合以提问卡收尾,排队的那一条还排着:它是这一票要跨过去的那条消息。
    assert.deepEqual(await queueOf(h, cookie, sessionId), [
      { mode: "followUp", text: "再补一句" },
    ]);

    const roundSeq = rounds[0]!.seq;
    assert.equal(
      (await send(h, cookie, sessionId, "c3", ROUND_ANSWER, "followUp", undefined, roundSeq))
        .status,
      202,
    );
    await requestsAtLeast(requests, 3);
    await idle(h, cookie, sessionId);
    assert.equal(requests.length, 3);
    // 答案先投,留存的那一条跟在后面。
    assert.ok(bodyOf(requests[1]!).includes("提问轮次的回答"), "答案没先投出去");
    assert.ok(!bodyOf(requests[1]!).includes("再补一句"), "留存的排队消息插到答案前面了");
    assert.ok(bodyOf(requests[2]!).includes("再补一句"), "留存的排队消息没投递");
    assert.deepEqual(await queueOf(h, cookie, sessionId), []);

    // 卡片因此是「已回答」:面板按这张卡后面第一条用户消息定三态,那一条得是这一轮的答案。
    const after = (await records(h, cookie, sessionId)).filter(
      (row) =>
        row.seq > roundSeq &&
        row.type === "message" &&
        (row.entry.message as { role?: string } | undefined)?.role === "user",
    );
    assert.match(JSON.stringify(after[0]!.entry.message?.content), /提问轮次的回答/);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("答的不是待答的那一轮:按普通消息处理,留存的排队消息仍先投", async () => {
  const { promise: queuedIn, resolve: go } = Promise.withResolvers<void>();
  const turns: StubTurn[] = [
    {
      toolCall: { name: ASK_QUESTION_ROUND_TOOL, args: ROUND_ARGS },
      usage: { input: 90, output: 18 },
      release: queuedIn,
    },
    { text: "先回排队那一条", usage: { input: 60, output: 12 } },
    { text: "再回后来这一条", usage: { input: 50, output: 10 } },
  ];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await requestsAtLeast(requests, 1);
    assert.equal((await send(h, cookie, sessionId, "c2", "再补一句", "followUp")).status, 202);
    go();
    await roundsAtLeast(h, cookie, sessionId, 1);
    await idle(h, cookie, sessionId);

    // 标记指的那一格上落的不是一轮提问(seq 1 是人发的第一条消息):按普通消息处理。
    assert.equal(
      (await send(h, cookie, sessionId, "c3", ROUND_ANSWER, "followUp", undefined, 1)).status,
      202,
    );
    await requestsAtLeast(requests, 3);
    await idle(h, cookie, sessionId);
    assert.equal(requests.length, 3);
    assert.ok(bodyOf(requests[1]!).includes("再补一句"), "留存的排队消息没先投");
    assert.ok(bodyOf(requests[2]!).includes("提问轮次的回答"));
  } finally {
    await disposeAgentSessions();
    await close();
  }
});
