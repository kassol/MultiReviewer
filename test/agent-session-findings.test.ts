/**
 * 历史 Finding 查询工具与需求拆分用途那一段系统提示(issue #338),走真实链路:
 * `POST /messages → 常驻子进程 → Pi 会话 → 假模型服务 → 工具调用 → IPC 查库 → 工具结果`。
 * 模型由本机的假服务(`support/model-stub.ts`)按脚本扮演,全程不碰收费模型。先例是
 * `agent-session-subprocess.test.ts`。
 *
 * 钉的是桩测不到的几件事:工具真的按三个条件过滤、上限真的在 50 条、会话根外的仓库问不到,
 * 以及用途那一段提示确实进了模型请求。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { openStore } from "../src/review/store.ts";
import { disposeAgentSessions } from "../src/webhook/agent-session.ts";
import {
  GITEA_REPO,
  HARNESS_SPEC,
  scopedUser,
  seedAvailableModelService,
  startPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { startModelStub, type StubTurn } from "./support/model-stub.ts";

const PASSWORD = "agent-session-findings-password";
const AT = "2026-09-12T00:00:00.000Z";
const REPO = `${GITEA_REPO.owner}/${GITEA_REPO.repo}`;

/** 发给 agent 的那句话。 */
const MESSAGE = "把「订单可以按状态筛选」拆成可实现的条目";

type Record = {
  seq: number;
  type: string;
  entry: { type: string; message?: { role: string; content: unknown } };
};

/** 播种用的一条 Finding:位置、处置状态与正文三段。 */
type SeedFinding = {
  file: string;
  line: number;
  title: string;
  severity: "P0" | "P1" | "P2";
  description: string;
  impact: string;
  suggestion: string;
  disposition: "unknown" | "unresolved" | "resolved" | "fixed";
};

/**
 * 把这几条 Finding 落进一个仓库名下。走 `startRun` / `finishRun` 这条生产写链:查询按
 * Finding Identity 折叠,自己拼 INSERT 会把指纹这一格写成另一个口径。
 *
 * `review_run` 的 owner / repo 是两列文本,不引用仓库注册表——会话根外那个仓库因此播得进去。
 */
function seedFindings(
  dbPath: string,
  ref: { owner: string; repo: string },
  findings: readonly SeedFinding[],
): void {
  const store = openStore(dbPath);
  try {
    const runId = store.startRun({
      owner: ref.owner,
      repo: ref.repo,
      pullNumber: 11,
      headSha: "seeded-head",
      startedAt: AT,
      changedFiles: findings.length,
      changedLines: findings.length,
      batchCount: 1,
      reviewerPins: [],
    });
    store.finishRun(runId, {
      finishedAt: AT,
      durationMs: 1,
      failed: false,
      outcomes: [],
      findings: findings.map((finding, index) => ({
        file: finding.file,
        line: finding.line,
        title: finding.title,
        severity: finding.severity,
        category: "bug" as const,
        description: finding.description,
        impact: finding.impact,
        suggestion: finding.suggestion,
        attributions: [
          {
            model: HARNESS_SPEC.model,
            severity: finding.severity,
            category: "bug" as const,
            description: finding.description,
            impact: finding.impact,
            suggestion: finding.suggestion,
          },
        ],
        groupIndex: 0,
        disposition: finding.disposition,
        placement: "inline" as const,
        fingerprint: `seeded-${ref.repo}-${index}`,
      })),
      verdicts: [],
    });
  } finally {
    store.close();
  }
}

/**
 * 起一套指向假模型服务的 harness,建好产品与一个需求拆分会话,回会话 id 与创建者的 cookie。
 * 与 `agent-session-subprocess.test.ts` 那一份同形;两份各自留在自己的用例文件里。
 */
async function startSessionHarness(turns: readonly StubTurn[]): Promise<{
  h: PanelHarness;
  cookie: string;
  sessionId: number;
  requests: Awaited<ReturnType<typeof startModelStub>>["requests"];
  close: () => Promise<void>;
}> {
  const stub = await startModelStub(turns);
  const h = await startPanelHarness();
  seedAvailableModelService(h, HARNESS_SPEC.provider, [HARNESS_SPEC.model], {}, stub.baseUrl);
  assert.equal(
    (await h.api("POST", "/repos", { owner: GITEA_REPO.owner, repo: GITEA_REPO.repo })).status,
    201,
  );
  const created = await h.api("POST", "/products", { name: "订单系统" });
  assert.equal(created.status, 201);
  const { product } = (await created.json()) as { product: { id: number } };
  assert.equal((await h.api("PUT", `/products/${product.id}/repos/${GITEA_REPO.id}`)).status, 204);
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [GITEA_REPO.id], ["agent:chat"]);
  const response = await fetch(`${h.serverUrl}/api/products/${product.id}/sessions`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ purpose: "requirement-breakdown" }),
  });
  assert.equal(response.status, 201);
  const { session } = (await response.json()) as { session: { id: number } };
  return { h, cookie, sessionId: session.id, requests: stub.requests, close: stub.close };
}

function send(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
  clientMessageId: string,
  text: string,
): Promise<Response> {
  return fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ clientMessageId, text }),
  });
}

/** 等到这个会话回到空闲(一个回合跑完)。 */
async function idle(h: PanelHarness, cookie: string, sessionId: number): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const response = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}`, {
      headers: { cookie },
    });
    const { session } = (await response.json()) as { session: { status: string } };
    if (session.status === "idle") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`等了 60 秒,会话 ${sessionId} 还在执行`);
}

/** 这个会话记录表里每一次工具结果的正文,按时间顺序。 */
async function toolResults(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
): Promise<string[]> {
  const response = await fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/records`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const { records } = (await response.json()) as { records: Record[] };
  return records
    .filter((row) => row.entry.message?.role === "toolResult")
    .map((row) => JSON.stringify(row.entry.message?.content));
}

/** 一次查询的脚本响应。 */
function query(args: Record_ = {}): StubTurn {
  return { toolCall: { name: "query_findings", args }, usage: { input: 10, output: 2 } };
}

type Record_ = globalThis.Record<string, unknown>;

const SEEDED: SeedFinding[] = [
  {
    file: "src/finance/rate.ts",
    line: 12,
    title: "汇率换算没判空",
    severity: "P1",
    description: "rate 为 null 时折算结果是 NaN。",
    impact: "报销单金额会落成 NaN。",
    suggestion: "取不到汇率就拒绝提交。",
    disposition: "unresolved",
  },
  {
    file: "src/finance/sheet.ts",
    line: 20,
    title: "月结表没有唯一约束",
    severity: "P2",
    description: "同一年月同一币种可以存两条。",
    impact: "折算取到哪一条不确定。",
    suggestion: "加唯一索引。",
    disposition: "resolved",
  },
  {
    file: "src/answer.ts",
    line: 3,
    title: "返回值没有类型",
    severity: "P2",
    description: "导出函数的返回值是 any。",
    impact: "调用方拿不到提示。",
    suggestion: "补上返回类型。",
    disposition: "unknown",
  },
  {
    file: "src/orders/list.ts",
    line: 8,
    title: "分页下界没校验",
    severity: "P1",
    description: "page 小于 1 时偏移量是负数。",
    impact: "查询报错。",
    suggestion: "下界取 1。",
    disposition: "fixed",
  },
];

test("历史 Finding 工具按仓库、路径 glob 与处置状态过滤,会话根外的仓库问不到", async () => {
  const turns: StubTurn[] = [
    query({ repo: REPO }),
    query({ repo: REPO, pathGlob: "src/finance/**" }),
    query({ repo: REPO, disposition: "resolved" }),
    query({ repo: REPO, pathGlob: "src/finance/**", disposition: "unresolved" }),
    query({ repo: "acme/elsewhere" }),
    query({ repo: REPO, disposition: "已处置" }),
    { text: "查完了,我按这些提醒写验收要点", usage: { input: 10, output: 2 } },
  ];
  const { h, cookie, sessionId, close } = await startSessionHarness(turns);
  try {
    seedFindings(h.db.path, GITEA_REPO, SEEDED);
    // 会话根外的那个仓库也有历史,它一条都不该回来。
    seedFindings(h.db.path, { owner: "acme", repo: "elsewhere" }, [SEEDED[0]!]);

    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await idle(h, cookie, sessionId);

    const results = await toolResults(h, cookie, sessionId);
    assert.equal(results.length, 6, `工具结果条数不对:${results.join("\n")}`);

    // 只按仓库查:四条都回来,标题、严重度、文件行与综合说明三段都在。
    assert.match(results[0]!, /4 past finding\(s\) in acme\/widgets, newest first\./);
    assert.match(results[0]!, /src\/finance\/rate\.ts:12 \(P1, unresolved\)/);
    assert.match(results[0]!, /title: 汇率换算没判空/);
    assert.match(results[0]!, /description: rate 为 null 时折算结果是 NaN。/);
    assert.match(results[0]!, /impact: 报销单金额会落成 NaN。/);
    assert.match(results[0]!, /suggestion: 取不到汇率就拒绝提交。/);
    // 按时间倒序:最后落库的那条排在最前。
    assert.ok(
      results[0]!.indexOf("src/orders/list.ts") < results[0]!.indexOf("src/finance/rate.ts"),
      "结果没有按时间倒序",
    );

    // 路径 glob:只回 src/finance 下那两条。
    assert.match(results[1]!, /2 past finding\(s\)/);
    assert.match(results[1]!, /src\/finance\/sheet\.ts:20/);
    assert.equal(results[1]!.includes("src/answer.ts"), false);

    // 处置状态:只回已处置(人工)那一条。
    assert.match(results[2]!, /1 past finding\(s\)/);
    assert.match(results[2]!, /src\/finance\/sheet\.ts:20 \(P2, resolved\)/);

    // 三个条件一起:src/finance 下未处置的那一条。
    assert.match(results[3]!, /1 past finding\(s\)/);
    assert.match(results[3]!, /src\/finance\/rate\.ts:12 \(P1, unresolved\)/);

    // 会话根外的仓库走正常返回一句打回理由,一条 Finding 都不带。
    assert.match(
      results[4]!,
      /acme\/elsewhere is not a repository of this session; look in one of: acme\/widgets/,
    );
    assert.equal(results[4]!.includes("汇率换算没判空"), false);

    // 不是那四个取值之一的处置状态同样打回。
    assert.match(
      results[5]!,
      /not a disposition state; use one of exactly: unknown, unresolved, resolved, fixed/,
    );
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("历史 Finding 工具一次最多回 50 条,并说还有更多", async () => {
  const many: SeedFinding[] = Array.from({ length: 60 }, (_, index) => ({
    file: `src/bulk/f${index}.ts`,
    line: index + 1,
    title: `第 ${index} 条`,
    severity: "P2" as const,
    description: `第 ${index} 条的问题说明。`,
    impact: "",
    suggestion: "",
    disposition: "unresolved" as const,
  }));
  const turns: StubTurn[] = [
    query({ repo: REPO }),
    { text: "条数太多,我缩小范围再查", usage: { input: 10, output: 2 } },
  ];
  const { h, cookie, sessionId, close } = await startSessionHarness(turns);
  try {
    seedFindings(h.db.path, GITEA_REPO, many);

    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await idle(h, cookie, sessionId);

    const results = await toolResults(h, cookie, sessionId);
    assert.equal(results.length, 1);
    assert.match(results[0]!, /50 past finding\(s\) in acme\/widgets, newest first\./);
    assert.match(results[0]!, /Only the 50 newest are listed/);
    // 倒序截断:最后播种的那条在,最先播种的那条不在。
    assert.match(results[0]!, /src\/bulk\/f59\.ts/);
    assert.equal(results[0]!.includes("src/bulk/f0.ts"), false);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});

test("需求拆分会话的系统提示里有粒度、落点、不估算与「恰好一次」", async () => {
  const turns: StubTurn[] = [{ text: "先问两句再拆", usage: { input: 10, output: 2 } }];
  const { h, cookie, sessionId, requests, close } = await startSessionHarness(turns);
  try {
    assert.equal((await send(h, cookie, sessionId, "c1", MESSAGE)).status, 202);
    await idle(h, cookie, sessionId);

    assert.equal(requests.length, 1);
    const system = requests[0]!.messages.filter((message) => message.role === "system");
    assert.equal(system.length, 1);
    const prompt = system[0]!.content;
    // 粒度:单一仓库内一个可独立提 PR 的变更,跨仓库拆多条并用依赖串。
    assert.match(
      prompt,
      /one change inside a single repository that can go out as its own pull request/,
    );
    assert.match(prompt, /spans repositories is therefore several items/);
    assert.match(prompt, /tied together by dependsOn/);
    // 落点只能来自读过的代码。
    assert.match(
      prompt,
      /a directory or a file you have seen yourself with read, grep, find or ls/,
    );
    // 追问与「直接拆」。
    assert.match(prompt, /ask before you break it down/);
    assert.match(prompt, /直接拆/);
    // 知识集是边界,历史 Finding 给验收要点加提醒。
    assert.match(prompt, /review rules and project facts above are the boundary/);
    assert.match(prompt, /query_findings/);
    // 不估算工作量。
    assert.match(prompt, /Do not estimate effort/);
    // 每次交拆分恰好一次,正文里散列的不算产出。
    assert.match(prompt, /submit_requirement_breakdown exactly once/);
    assert.match(prompt, /Items written out in your reply are not handed in/);
  } finally {
    await disposeAgentSessions();
    await close();
  }
});
