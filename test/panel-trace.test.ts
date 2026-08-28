/**
 * 审查轨迹的两个面板端点(issue #171):`/trace` 的列表与权限,`/trace/stream` 的回放、
 * 实时推送、断线续传与结束信号。打在真实 HTTP 缝上(先例 `panel-runs`、`panel-permissions`)。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { hashPassword } from "../src/panel/password.ts";
import type {
  HistoryFinding,
  ReviewIntent,
  ReviewRange,
  ReviewRule,
  Reviewer,
  ReviewerEvent,
} from "../src/review/finding.ts";
import { openStore } from "../src/review/store.ts";
import type { TraceEvent, TraceKind } from "../src/review/trace.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  PANEL_PREFIX,
  seedHistoricalRepo,
  startPanelHarness,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { confirmEmptyRuleSet } from "./support/git-fixture.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

/** 一条 SSE 帧,按空行切开之后的三行。 */
type Frame = { id?: string; event: string; data: string };

function parseFrame(chunk: string): Frame {
  const frame: { id?: string; event: string; data: string } = { event: "message", data: "" };
  for (const line of chunk.split("\n")) {
    if (line.startsWith("id: ")) frame.id = line.slice(4);
    else if (line.startsWith("event: ")) frame.event = line.slice(7);
    else if (line.startsWith("data: ")) frame.data = line.slice(6);
  }
  return frame;
}

/**
 * 从 SSE 响应体里逐帧读。测试要能在流还开着的时候就看到已经到达的帧,不能等整个
 * 响应结束——「实时推送」这件事只有增量读得出来。
 */
function frameReader(response: Response): {
  next(): Promise<Frame>;
  cancel(): Promise<void>;
} {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pending: Frame[] = [];
  return {
    async next(): Promise<Frame> {
      for (;;) {
        const index = buffer.indexOf("\n\n");
        if (index !== -1) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          // 以冒号开头的是心跳注释帧,浏览器不当事件,这里也跳过。
          if (chunk.startsWith(":")) continue;
          return parseFrame(chunk);
        }
        if (pending.length > 0) return pending.shift()!;
        const { value, done } = await reader.read();
        assert.equal(done, false, "流已经关了,还差一帧没读到");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

function sse(
  harness: PanelHarness,
  runId: number,
  options: { headers?: Record<string, string>; query?: string } = {},
): Promise<Response> {
  const query = options.query === undefined ? "" : `?${options.query}`;
  return fetch(`${harness.serverUrl}/${PANEL_PREFIX}/api/runs/${runId}/trace/stream${query}`, {
    headers: { cookie: harness.cookie, ...options.headers },
  });
}

/** 一条跑完的历史轮次,带几条轨迹事件。 */
function seedFinishedRun(
  dbPath: string,
  events: readonly { kind: TraceKind; text: string }[],
): number {
  const store = openStore(dbPath);
  try {
    const runId = store.startRun({
      owner: HARNESS_PR.owner,
      repo: HARNESS_PR.repo,
      pullNumber: HARNESS_PR.number,
      headSha: "seeded-sha",
      startedAt: "2026-08-25T00:00:00.000Z",
      changedFiles: 1,
      changedLines: 1,
      batchCount: 1,
      reviewerPins: [],
    });
    for (const event of events) {
      store.appendTrace(runId, {
        scope: "reviewer",
        reviewer: "test:global-model",
        kind: event.kind,
        payload: { text: event.text },
      });
    }
    store.finishRun(runId, {
      finishedAt: "2026-08-25T00:01:00.000Z",
      durationMs: 60_000,
      failed: false,
      outcomes: [],
      findings: [],
      verdicts: [],
    });
    return runId;
  } finally {
    store.close();
  }
}

test("已结束的轮次:`/trace` 按 seq 升序回全部事件", async () => {
  const h = await startPanelHarness(cleanups);
  const runId = seedFinishedRun(h.db.path, [
    { kind: "assistant_message", text: "第一句" },
    { kind: "assistant_message", text: "第二句" },
  ]);

  const response = await h.api("GET", `/runs/${runId}/trace`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { events: TraceEvent[] };
  assert.deepEqual(
    body.events.map((event) => event.seq),
    [1, 2],
  );
  assert.deepEqual(body.events[0], {
    seq: 1,
    runId,
    at: body.events[0]!.at,
    scope: "reviewer",
    reviewer: "test:global-model",
    kind: "assistant_message",
    payload: { text: "第一句" },
  });
});

test("升级前跑过的轮次:`/trace` 回空列表而不是报错", async () => {
  const h = await startPanelHarness(cleanups);
  const runId = seedFinishedRun(h.db.path, []);

  const body = (await (await h.api("GET", `/runs/${runId}/trace`)).json()) as {
    events: TraceEvent[];
  };
  assert.deepEqual(body.events, []);
});

test("不存在的轮次:`/trace` 与 `/trace/stream` 都回 404", async () => {
  const h = await startPanelHarness(cleanups);
  assert.equal((await h.api("GET", "/runs/4242/trace")).status, 404);
  const stream = await sse(h, 4242);
  assert.equal(stream.status, 404);
  await stream.text();
});

test("轨迹的可见范围与轮次详情一致:一格权限都没有的人,分到仓库就读得到两个端点", async () => {
  const h = await startPanelHarness(cleanups);
  const runId = seedFinishedRun(h.db.path, [{ kind: "assistant_message", text: "第一句" }]);
  seedHistoricalRepo(h);

  const password = "trace-permission-password";
  const store = openStore(h.db.path);
  store.createPanelUser({
    username: "no-permission",
    displayName: null,
    passwordHash: await hashPassword(password),
    mustChangePassword: false,
    createdAt: "2026-08-25T00:00:00.000Z",
    isSystemAdmin: false,
    roleId: null,
  });
  store.setPanelUserAssignment("no-permission", [GITEA_REPO.id]);
  store.close();

  const login = await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "no-permission", password }),
  });
  const cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;

  for (const path of [`/runs/${runId}/trace`, `/runs/${runId}/trace/stream`]) {
    const response = await fetch(`${h.serverUrl}/${PANEL_PREFIX}/api${path}`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200, `${path} 登录即可读`);
    await response.text();
  }
});

test("已结束的轮次:stream 回放完直接发 end 并关闭", async () => {
  const h = await startPanelHarness(cleanups);
  const runId = seedFinishedRun(h.db.path, [
    { kind: "assistant_message", text: "第一句" },
    { kind: "assistant_message", text: "第二句" },
  ]);

  const response = await sse(h, runId);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const frames = response.body === null ? "" : await response.text();
  const chunks = frames.split("\n\n").filter((chunk) => chunk !== "");
  assert.deepEqual(chunks.map(parseFrame).map((frame) => frame.event), [
    "trace",
    "trace",
    "end",
  ]);
  const first = parseFrame(chunks[0]!);
  assert.equal(first.id, "1", "id 就是 seq,断线之后浏览器拿它续传");
  assert.deepEqual((JSON.parse(first.data) as TraceEvent).payload, { text: "第一句" });
});

test("带 Last-Event-ID:只收到它之后的事件", async () => {
  const h = await startPanelHarness(cleanups);
  const runId = seedFinishedRun(h.db.path, [
    { kind: "assistant_message", text: "第一句" },
    { kind: "assistant_message", text: "第二句" },
    { kind: "assistant_message", text: "第三句" },
  ]);

  const response = await sse(h, runId, { headers: { "last-event-id": "2" } });
  const chunks = (await response.text()).split("\n\n").filter((chunk) => chunk !== "");
  const frames = chunks.map(parseFrame);
  assert.deepEqual(frames.map((frame) => frame.event), ["trace", "end"]);
  assert.equal(frames[0]!.id, "3");
  assert.deepEqual((JSON.parse(frames[0]!.data) as TraceEvent).payload, { text: "第三句" });
});

test("带 ?after=:与 Last-Event-ID 同义,两者都在时取大的那个", async () => {
  const h = await startPanelHarness(cleanups);
  const runId = seedFinishedRun(h.db.path, [
    { kind: "assistant_message", text: "第一句" },
    { kind: "assistant_message", text: "第二句" },
    { kind: "assistant_message", text: "第三句" },
  ]);

  // 原生 EventSource 设不了首个请求的请求头,面板打开时只能把已经补齐的 seq 放查询串。
  const byQuery = await sse(h, runId, { query: "after=2" });
  const first = (await byQuery.text()).split("\n\n").filter((chunk) => chunk !== "");
  assert.deepEqual(first.map(parseFrame).map((frame) => frame.event), ["trace", "end"]);
  assert.equal(parseFrame(first[0]!).id, "3");

  // 两条来源说的是同一件事,取小的会把已经收到的再发一遍。
  const both = await sse(h, runId, { query: "after=1", headers: { "last-event-id": "2" } });
  const frames = (await both.text())
    .split("\n\n")
    .filter((chunk) => chunk !== "")
    .map(parseFrame);
  assert.deepEqual(frames.map((frame) => frame.event), ["trace", "end"]);
  assert.equal(frames[0]!.id, "3");

  // 认不出来的值按「从头给」处理,不能因此少发。
  const garbage = await sse(h, runId, { query: "after=zzz" });
  const all = (await garbage.text()).split("\n\n").filter((chunk) => chunk !== "");
  assert.equal(all.length, 4, "三条事件加一条 end");
});

/** 卡在原地不返回的 Reviewer:用来在轮次进行中时观察实时推送。 */
function pausedReviewer(model: string): Reviewer & {
  started: Promise<void>;
  emit(event: ReviewerEvent): void;
  release(): void;
} {
  let emit: (event: ReviewerEvent) => void = () => {};
  let release = (): void => {};
  let markStarted = (): void => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    model,
    started,
    emit: (event) => emit(event),
    release: () => release(),
    review: async (
      _range: ReviewRange,
      _worktreePath: string,
      _history: readonly HistoryFinding[],
      _intent?: ReviewIntent,
      _rules?: readonly ReviewRule[],
      onEvent?: (event: ReviewerEvent) => void,
    ) => {
      emit = onEvent ?? (() => {});
      markStarted();
      await done;
      return {
        model,
        findings: [],
        anomalies: [],
        rejectedToolCalls: 0,
        anchorRejections: 0,
      };
    },
  };
}

test("进行中的轮次:先回放已有事件,再收到新写入的那条,结束时收到 end", async () => {
  const paused = pausedReviewer("test:global-model");
  const h = await startReadyPanelHarness(cleanups, {
    buildReviewers: () => [paused],
  });
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );
  confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);
  assert.equal((await h.deliverViaHook(h.repo.headSha)).status, 200);
  await paused.started;

  const runId = openStoreRunId(h.db.path);
  const response = await sse(h, runId);
  const reader = frameReader(response);

  // 回放:开跑到现在的编排事件已经在库里。
  const first = await reader.next();
  assert.equal(first.event, "trace");
  assert.equal((JSON.parse(first.data) as TraceEvent).kind, "worktree_ready");
  const second = await reader.next();
  assert.equal((JSON.parse(second.data) as TraceEvent).kind, "batch_started");

  // 实时:订阅之后写进去的那条要推过来。
  paused.emit({ kind: "assistant_message", text: "正在读 src/answer.ts" });
  const live = await reader.next();
  const liveEvent = JSON.parse(live.data) as TraceEvent;
  assert.equal(liveEvent.kind, "assistant_message");
  assert.equal(liveEvent.reviewer, "test:global-model");
  assert.deepEqual(liveEvent.payload, { text: "正在读 src/answer.ts" });

  // 结束:轮次跑完,订阅者收到明确的结束信号。
  paused.release();
  await h.settledAtLeast(1);
  let frame = await reader.next();
  while (frame.event === "trace") frame = await reader.next();
  assert.equal(frame.event, "end");
});

test("进行中的轮次:没有可回放的事件时响应头也立刻发出,静默期间有心跳注释帧", async () => {
  const paused = pausedReviewer("test:global-model");
  const h = await startReadyPanelHarness(cleanups, {
    buildReviewers: () => [paused],
    traceHeartbeatMs: 30,
  });
  assert.equal(
    (await h.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo })).status,
    201,
  );
  confirmEmptyRuleSet(h.db.path, GITEA_REPO.id);
  assert.equal((await h.deliverViaHook(h.repo.headSha)).status, 200);
  await paused.started;
  const runId = openStoreRunId(h.db.path);

  // 面板打开时先取 `/trace` 补全,再拿最后那个 seq 接流——此时没有一帧可回放。
  const known = (await (await h.api("GET", `/runs/${runId}/trace`)).json()) as {
    events: TraceEvent[];
  };
  const lastSeq = known.events.at(-1)!.seq;

  // 头不 flush 的话 fetch 在这里一直等到反代或测试超时;`EventSource` 会把它当永久失败。
  const response = await withTimeout(sse(h, runId, { query: `after=${lastSeq}` }), 2000, "响应头没有立刻发出");
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");

  const reader = response.body!.getReader();
  const { value } = await withTimeout(reader.read(), 2000, "静默期间没有心跳");
  assert.match(new TextDecoder().decode(value), /^: keep-alive\n\n/);

  await reader.cancel();
  paused.release();
  await h.settledAtLeast(1);
});

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 这个库里唯一那一轮的 id。 */
function openStoreRunId(dbPath: string): number {
  const store = openStore(dbPath);
  try {
    const runs = store.listRuns({ limit: 1 });
    assert.equal(runs.length, 1, "库里应当正好有一轮 Review Run");
    return runs[0]!.id;
  } finally {
    store.close();
  }
}
