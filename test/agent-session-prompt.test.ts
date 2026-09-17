/**
 * 会话系统提示里的产品名、仓库职责(CONTEXT.md 仓库职责,issue #341)、每个仓库停在哪个
 * commit 的短 sha(issue #351)与知识目录(issue #344、#362)。
 *
 * 桩测这一份字符串:agent 选哪个仓库读、什么时候去查知识全凭这几行,职责没渲染上去它只能一个个
 * README 读过去,而整条真实链路(提示进模型请求)已经由 `agent-session-subprocess.test.ts` 钉住。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  OpenSessionRequest,
  SessionProductKnowledge,
} from "../src/reviewer/session-protocol.ts";
import { sessionSystemPrompt } from "../src/reviewer/session-worker.ts";

/** 一条产品知识的桩。三种条目共用一份默认,各自只覆盖用得上的那几格。 */
function entry(one: Partial<SessionProductKnowledge> & { id: number }): SessionProductKnowledge {
  return {
    kind: "term",
    name: "",
    body: "",
    topic: null,
    avoided: [],
    options: null,
    consequences: null,
    supersededBy: null,
    ...one,
  };
}

/**
 * 目录那三行要盖到的四种条目:分组是「定位」的术语、普通术语、生效决策、被取代的决策。
 * 仓库关系没有名字,目录里因此没有它那一行。
 */
const KNOWLEDGE: readonly SessionProductKnowledge[] = [
  entry({ id: 1, name: "报销系统", topic: "定位", body: "员工提交票据、财务审批并打款的内部系统。" }),
  entry({ id: 2, name: "报销单", topic: "单据", body: "一次报销申请的载体。" }),
  entry({ id: 3, kind: "relationship", body: "web 的提交走 api 的报销单接口。" }),
  entry({ id: 4, kind: "decision", name: "金额用整数分表示", body: "浮点会攒出误差。" }),
  entry({ id: 5, kind: "decision", name: "金额用浮点表示", body: "旧的那一条。", supersededBy: 4 }),
];

/** 两棵工作树各停在哪个 commit(issue #351)。短 sha 是前 7 位。 */
const API_HEAD_SHA = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const WEB_HEAD_SHA = "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c";

const REQUEST: OpenSessionRequest = {
  sessionRoot: "/tmp/session-root",
  productName: "报销系统",
  purpose: "requirement-breakdown",
  repos: [
    {
      owner: "acme",
      repo: "api",
      role: "后端 API(Node)",
      headSha: API_HEAD_SHA,
      ruleCount: 4,
      factCount: 1,
    },
    { owner: "acme", repo: "web", role: null, headSha: WEB_HEAD_SHA, ruleCount: 0, factCount: 0 },
  ],
  productKnowledge: KNOWLEDGE,
  // 提示这一份不读模型,这一格只为凑齐形状。
  runtimeModel: {
    provider: "stub",
    id: "stub-model",
    name: "Stub Model",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    input: ["text"],
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_000,
    sources: {
      name: "trusted",
      api: "service-target",
      baseUrl: "service-target",
      input: "trusted",
      reasoning: "trusted",
      contextWindow: "trusted",
      maxTokens: "trusted",
    },
  },
};

test("系统提示写出产品名,有职责的仓库带破折号那一段,没有的只有仓库名", () => {
  const prompt = sessionSystemPrompt(REQUEST);

  assert.match(prompt, /^The product: 报销系统\.$/m);
  assert.match(prompt, /^- acme\/api 1a2b3c4 — 后端 API\(Node\)$/m);
  assert.match(prompt, /^- acme\/web 9f8e7d6$/m);
  assert.match(
    prompt,
    /^The note after the dash says what that repository is for in this product; start from it to decide which repository to read\.$/m,
  );
});

test("没有一个仓库写过职责时,不写那句说破折号的话", () => {
  const prompt = sessionSystemPrompt({
    ...REQUEST,
    repos: REQUEST.repos.map((repo) => ({ ...repo, role: null })),
  });

  assert.match(prompt, /^- acme\/api 1a2b3c4$/m);
  assert.doesNotMatch(prompt, /The note after the dash/);
});

test("知识目录是定位一句加两串名字,一条规则或事实的正文都不在提示里", () => {
  const prompt = sessionSystemPrompt(REQUEST);

  // 产品层三行目录(issue #362):定位那一条给正文,术语与生效决策只给名字。
  assert.match(prompt, /^- Positioning: 员工提交票据、财务审批并打款的内部系统。$/m);
  assert.match(prompt, /^- Glossary terms: 报销单$/m);
  assert.match(prompt, /^- Decision records: 金额用整数分表示$/m);
  // 定位那一条不在术语名里重复一遍,被取代的决策不进目录,仓库关系没有名字也不进。
  assert.doesNotMatch(prompt, /报销系统、|、报销系统/);
  assert.doesNotMatch(prompt, /金额用浮点表示/);
  assert.doesNotMatch(prompt, /web 的提交走 api 的报销单接口/);
  // 目录之外一条正文都没有:术语与决策的定义都要花一次 query_knowledge 取。
  assert.doesNotMatch(prompt, /一次报销申请的载体/);
  assert.doesNotMatch(prompt, /浮点会攒出误差/);
  // 仓库层仍只给条数,每个仓库一行。
  assert.match(prompt, /^- acme\/api — 4 review rules, 1 project fact$/m);
  assert.match(prompt, /^- acme\/web — 0 review rules, 0 project facts$/m);
  // 什么时候去查,一句话。
  assert.match(
    prompt,
    /^When the task spans repositories or its scope is unclear, read the product layer first; otherwise query the repository and the paths the task touches\.$/m,
  );
  assert.match(prompt, /query_knowledge/);
  // 写这一层的两件工具同样只在提示里点名(issue #360)。
  assert.match(prompt, /write_knowledge writes or rewrites one entry and withdraw_knowledge/);
  // 升级前按仓库分段注入的那几段不在了:提示里没有一条陈述,也没有那两段的标题。
  assert.doesNotMatch(prompt, /has agreed on/);
  assert.doesNotMatch(prompt, /^- \[\d+\] \(/m);
});

test("只有一条规则、一条事实时,计数那一行用单数", () => {
  const prompt = sessionSystemPrompt({
    ...REQUEST,
    repos: [
      { owner: "acme", repo: "api", role: null, headSha: API_HEAD_SHA, ruleCount: 1, factCount: 1 },
    ],
  });

  assert.match(prompt, /^- acme\/api — 1 review rule, 1 project fact$/m);
});

test("产品一条都没写下时,目录那一段说清楚是空的", () => {
  const prompt = sessionSystemPrompt({ ...REQUEST, productKnowledge: [] });

  assert.match(prompt, /^- nothing written down yet$/m);
  assert.doesNotMatch(prompt, /^- Positioning:/m);
  assert.doesNotMatch(prompt, /^- Glossary terms:/m);
});

test("产品没写过定位时,定位那一行不渲染,术语名照旧列全", () => {
  const prompt = sessionSystemPrompt({
    ...REQUEST,
    productKnowledge: KNOWLEDGE.filter((one) => one.id !== 1),
  });

  assert.doesNotMatch(prompt, /^- Positioning:/m);
  assert.match(prompt, /^- Glossary terms: 报销单$/m);
});

test("需求拆分与开放对话拿到同一份目录:目录在底座那一段,不随用途变", () => {
  // 目录三行加它们之间的空行:底座那一段里这一截,两个用途逐字一样(issue #362)。
  const block = (purpose: string): string =>
    sessionSystemPrompt({ ...REQUEST, purpose }).split("\n\n").find((one) => one.startsWith("- Positioning:"))!;

  const breakdown = block("requirement-breakdown");
  assert.match(breakdown, /^- Positioning: /);
  assert.equal(block("open-conversation"), breakdown, "开放对话的目录与需求拆分那一份不一致");
});

test("产品梳理拿到的是整份条目,不是目录:它改写的正是这些条目(issue #365)", () => {
  const prompt = sessionSystemPrompt({ ...REQUEST, purpose: "product-survey" });

  // 目录那三行一行都不在:每条都带着 id 与正文列出来。
  assert.doesNotMatch(prompt, /^- Positioning:/m);
  assert.doesNotMatch(prompt, /^- Glossary terms:/m);
  assert.doesNotMatch(prompt, /^- Decision records:/m);
  assert.match(prompt, /^- \[2\] glossary term 报销单 \(topic 单据\): 一次报销申请的载体。$/m);
  // 目录里没有的两种也在:仓库关系整句,被取代的决策带着取代它的那一条的 id。
  assert.match(prompt, /^- \[3\] repository relationship: web 的提交走 api 的报销单接口。$/m);
  assert.match(prompt, /^- \[4\] decision 金额用整数分表示 \(in force\): 浮点会攒出误差。$/m);
  assert.match(prompt, /^- \[5\] decision 金额用浮点表示 \(superseded by entry 4\): /m);
  // 用途那一段接在后面。
  assert.match(prompt, /^## This session: interviewing the person about this product$/m);
});

test("产品梳理的底座里没有 tracker 那一段:它的工具面上没有那九件(评审复核)", () => {
  // 需求拆分与开放对话写 spec 与票,那一段告诉它 tracker 是它的;产品梳理写的是产品知识,
  // 手上一件 tracker 工具都没有,提示里写着「yours to read and write」只会让它去调空气。
  for (const purpose of ["requirement-breakdown", "open-conversation"]) {
    assert.match(
      sessionSystemPrompt({ ...REQUEST, purpose }),
      /This product also has a tracker/,
      `${purpose} 的提示里少了 tracker 那一段`,
    );
  }
  assert.doesNotMatch(
    sessionSystemPrompt({ ...REQUEST, purpose: "product-survey" }),
    /This product also has a tracker/,
  );
});
