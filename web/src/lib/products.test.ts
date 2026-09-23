/*
 * 产品页那几个纯函数的单测(issue #331、#360、#363)。归属候选判反了的后果是一列只会回 409
 * 的候选,或者一个归不进任何产品的新仓库;术语分组漏一组的后果是那几条术语在产品页上不见
 * 了;可开工判错的后果是有人去做一张还被挡着、或者已经有人认领的票;陈述拆段判错的后果是
 * 半句话被当成代码渲染;关掉前那句确认报错对象的后果是人照着它点头,关掉的却是另一条。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  currentProduct,
  filterKnowledge,
  groupedTerms,
  openTicketIds,
  NO_TRACKER_FILTER,
  pickableTickets,
  statementParts,
  ticketStatuses,
  trackerListGroups,
  ticketNotes,
  trackerCloseConfirm,
  unassignedRepos,
  type ProductKnowledge,
  type TrackerSpec,
  type TrackerTicket,
} from "./products.ts";

test("候选只留没归入任何产品的仓库,哪个产品占着都算占着", () => {
  const repos = [{ repoId: 1 }, { repoId: 2 }, { repoId: 3 }];
  const products = [{ repos: [{ repoId: 2 }] }, { repos: [] }, { repos: [{ repoId: 3 }] }];

  assert.deepEqual(unassignedRepos(repos, products), [{ repoId: 1 }]);
  // 一个产品都没有时全是候选。
  assert.deepEqual(unassignedRepos(repos, []), repos);
});

test("当前产品取地址上那个,取不到就落到列表第一个", () => {
  const products = [{ id: 7 }, { id: 9 }];

  assert.deepEqual(currentProduct(products, 9), { id: 9 });
  // 地址没带产品(`/products`)。
  assert.deepEqual(currentProduct(products, undefined), { id: 7 });
  // 地址带的产品这个账号看不到,仍要有当前项,否则右栏整块空着。
  assert.deepEqual(currentProduct(products, 404), { id: 7 });
  assert.equal(currentProduct([], 7), undefined);
});

test("术语表按主题分组:主题按首次出现排,没分组的排在最后一组", () => {
  const term = (id: number, name: string, topic: string | null): ProductKnowledge => ({
    id,
    kind: "term",
    name,
    body: `${name}是什么`,
    topic,
    avoided: [],
    options: null,
    consequences: null,
    supersededBy: null,
    annotations: [],
    writtenAt: "2026-09-17T00:00:00.000Z",
  });
  const relationship: ProductKnowledge = { ...term(9, "", null), kind: "relationship" };

  assert.deepEqual(
    groupedTerms([
      term(1, "订单", "交易"),
      term(2, "口令", null),
      term(3, "退款", "交易"),
      relationship,
      term(4, "工单", "运营"),
    ]).map((group) => [group.topic, group.terms.map((row) => row.name)]),
    [
      ["交易", ["订单", "退款"]],
      ["运营", ["工单"]],
      [null, ["口令"]],
    ],
  );
  // 一条术语都没有时没有分组:关系与决策不进这一份。
  assert.deepEqual(groupedTerms([relationship]), []);
});

test("筛产品知识:名字、正文、不说、备选与后果都匹配,不分大小写", () => {
  const entry = (id: number, over: Partial<ProductKnowledge> = {}): ProductKnowledge => ({
    id,
    kind: "term",
    name: "",
    body: "",
    topic: null,
    avoided: [],
    options: null,
    consequences: null,
    supersededBy: null,
    annotations: [{ location: "src/order.ts:12", reason: "退款走的是这里" }],
    writtenAt: "2026-09-20T00:00:00.000Z",
    ...over,
  });
  const knowledge = [
    entry(1, { name: "订单" }),
    entry(2, { body: "退款只走这一条路" }),
    entry(3, { avoided: ["撤单"] }),
    entry(4, { kind: "decision", options: "用 Kafka" }),
    entry(5, { kind: "decision", consequences: "库要重建" }),
    entry(6, { name: "口令" }),
  ];
  const ids = (query: string): number[] =>
    filterKnowledge(knowledge, query).map((row) => row.id);

  assert.deepEqual(ids("订单"), [1]);
  assert.deepEqual(ids("退款"), [2]);
  assert.deepEqual(ids("撤单"), [3]);
  assert.deepEqual(ids("kafka"), [4]);
  assert.deepEqual(ids("重建"), [5]);
  // 空串与只有空白都不筛:人清空输入框之后看到的是全部。
  assert.deepEqual(ids(""), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ids("   "), [1, 2, 3, 4, 5, 6]);
  // 首尾空白不参与匹配。
  assert.deepEqual(ids("  订单 "), [1]);
  // 出处附注不进匹配:按文件路径搜出来的条目与人要找的那句话无关。
  assert.deepEqual(ids("src/order.ts"), []);
  assert.deepEqual(ids("没有这句话"), []);
});

test("可开工的票:开着、无未关阻塞、无人认领", () => {
  const ticket = (id: number, over: Partial<TrackerTicket> = {}): TrackerTicket => ({
    id,
    title: `票 ${id}`,
    label: "needs-triage",
    state: "open",
    claimedBy: null,
    blockedBy: [],
    ...over,
  });
  const spec = (id: number, tickets: TrackerTicket[]): TrackerSpec => ({
    id,
    title: `spec ${id}`,
    state: "open",
    tickets,
  });

  const picked = pickableTickets([
    spec(1, [
      ticket(1),
      ticket(2, { state: "closed" }),
      ticket(3, { claimedBy: "wang" }),
      // 挡着它的那张还开着。
      ticket(4, { blockedBy: [1] }),
      // 挡着它的那张已经关了。
      ticket(5, { blockedBy: [2] }),
      // 两张挡着,只关了一张。
      ticket(6, { blockedBy: [1, 2] }),
    ]),
    // 挡着它的那张挂在另一条 spec 下:判定跨整份 tracker 做,不在单条 spec 里算。
    spec(2, [ticket(7, { blockedBy: [1] }), ticket(8, { blockedBy: [2] })]),
  ]);

  assert.deepEqual(
    [...picked].sort((a, b) => a - b),
    [1, 5, 8],
  );
  // 认不出的票号不挡着:一份还没读全的数据不该让整张票从可开工里消失。
  assert.deepEqual([...pickableTickets([spec(1, [ticket(1, { blockedBy: [99] })])])], [1]);
  assert.deepEqual([...pickableTickets([])], []);
});

test("票行只列还开着的阻塞", () => {
  const ticket = (over: Partial<TrackerTicket>): TrackerTicket => ({
    id: 3,
    title: "票 3",
    label: "needs-triage",
    state: "open",
    claimedBy: null,
    blockedBy: [],
    ...over,
  });
  assert.equal(ticketNotes(ticket({ blockedBy: [1, 2] }), new Set([2])), "等 #2");
  assert.equal(ticketNotes(ticket({ blockedBy: [1, 2] }), new Set()), "");
  assert.equal(
    ticketNotes(ticket({ state: "closed", claimedBy: "admin", blockedBy: [1] }), new Set([1])),
    "已关 · admin 认领 · 等 #1",
  );
  assert.deepEqual(
    [...openTicketIds([{ id: 1, title: "s", state: "open", tickets: [ticket({ id: 1 }), ticket({ id: 2, state: "closed" })] }])],
    [1],
  );
});

test("陈述按成对的反引号拆段,没配对的整句当正文", () => {
  assert.deepEqual(statementParts("金额用 `amount` 这一格存"), [
    { code: false, text: "金额用 " },
    { code: true, text: "amount" },
    { code: false, text: " 这一格存" },
  ]);
  // 一句话里两对:两段代码各自成段。
  assert.deepEqual(
    statementParts("`a` 与 `b`").map((part) => [part.code, part.text]),
    [
      [false, ""],
      [true, "a"],
      [false, " 与 "],
      [true, "b"],
      [false, ""],
    ],
  );
  // 奇数个反引号:哪半是代码猜不出来,整句当正文——猜错会把后半句整段渲染成代码。
  assert.deepEqual(statementParts("成本降到 `50%"), [{ code: false, text: "成本降到 `50%" }]);
  // 一个反引号都没有,以及空串。
  assert.deepEqual(statementParts("一句普通的话"), [{ code: false, text: "一句普通的话" }]);
  assert.deepEqual(statementParts(""), [{ code: false, text: "" }]);
});

test("关掉前那句确认报清楚关的是哪一条", () => {
  assert.deepEqual(trackerCloseConfirm({ kind: "spec", id: 7, title: "结算重构" }), {
    title: "关掉 spec「结算重构」?",
    description: "它下面那几张票的开关不动。关错了再点一次「重新打开这条 spec」。",
  });
  // 票报票号:一条 spec 下的票标题常常只差几个字,只报标题认不出是哪一张。
  assert.deepEqual(trackerCloseConfirm({ kind: "ticket", id: 12, title: "补对账口径" }), {
    title: "关掉票 #12「补对账口径」?",
    description: "它不再算可开工的票,被它挡着的票跟着放开。关错了再点一次「重新打开」。",
  });
});

test("看板四列:已关压过一切,有人认领压过阻塞,其余看阻塞", () => {
  const ticket = (id: number, over: Partial<TrackerTicket> = {}): TrackerTicket => ({
    id,
    title: `票 ${id}`,
    label: "needs-triage",
    state: "open",
    claimedBy: null,
    blockedBy: [],
    ...over,
  });
  const statuses = ticketStatuses([
    {
      id: 1,
      title: "spec 1",
      state: "open",
      tickets: [
        ticket(1),
        ticket(2, { state: "closed", claimedBy: "wang", blockedBy: [1] }),
        // 被挡着但有人认领:归认领人,不落「被阻塞」。
        ticket(3, { claimedBy: "wang", blockedBy: [1] }),
        ticket(4, { blockedBy: [1] }),
        ticket(5, { blockedBy: [2] }),
      ],
    },
  ]);
  assert.deepEqual(Object.fromEntries(statuses), {
    1: "ready",
    2: "closed",
    3: "claimed",
    4: "blocked",
    5: "ready",
  });
});

test("列表分组:按所选状态与筛选取票,空组只在不筛时为同状态的 spec 留着", () => {
  const ticket = (id: number, over: Partial<TrackerTicket> = {}): TrackerTicket => ({
    id,
    title: `票 ${id}`,
    label: "needs-triage",
    state: "open",
    claimedBy: null,
    blockedBy: [],
    ...over,
  });
  const specs: TrackerSpec[] = [
    { id: 1, title: "a", state: "open", tickets: [ticket(1), ticket(2, { state: "closed" })] },
    // 还没拆票的开着的 spec。
    { id: 2, title: "b", state: "open", tickets: [] },
    // 已关的 spec,票全关了。
    { id: 3, title: "c", state: "closed", tickets: [ticket(3, { state: "closed", label: "wontfix" })] },
  ];
  const shape = (groups: ReturnType<typeof trackerListGroups>) =>
    groups.map((group) => [group.spec.id, group.tickets.map((one) => one.id)]);

  assert.deepEqual(shape(trackerListGroups(specs, "open", NO_TRACKER_FILTER)), [
    [1, [1]],
    [2, []],
  ]);
  assert.deepEqual(shape(trackerListGroups(specs, "closed", NO_TRACKER_FILTER)), [
    [1, [2]],
    [3, [3]],
  ]);
  // 筛着标签时空组不画。
  assert.deepEqual(
    shape(trackerListGroups(specs, "closed", { label: "wontfix", claimer: undefined })),
    [[3, [3]]],
  );
  // claimer 为 null 即只看没人认领的。
  specs[0]!.tickets[0]!.claimedBy = "wang";
  assert.deepEqual(shape(trackerListGroups(specs, "open", { label: null, claimer: null })), []);
  assert.deepEqual(shape(trackerListGroups(specs, "open", { label: null, claimer: "wang" })), [
    [1, [1]],
  ]);
});
