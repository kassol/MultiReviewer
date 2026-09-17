/**
 * 产品 tracker 那几件工具、需求拆分那一段系统提示与真实模型之间的契约,桩测不到:真模型
 * 会不会读完代码再动手、会不会把谈定的需求收成一条 spec 再拆成几张票、票之间的先后会不会
 * 落成阻塞边而不是写在正文里,都要真模型跑一遍才知道立不立得住(issue #338、#366)。
 *
 * 默认跳过。它会真实调用模型,产生费用。先例是 `reviewer-smoke.test.ts`。
 *
 *   MULTIREVIEWER_SMOKE_PROVIDER=anthropic \
 *   MULTIREVIEWER_SMOKE_MODEL=claude-haiku-4-5 \
 *   MULTIREVIEWER_SMOKE_ENV=ANTHROPIC_API_KEY \
 *   node --test test/agent-session-smoke.test.ts
 *
 * 起的是真子进程:会话根是一个临时目录,`acme/widgets` 那一棵工作树是 reviewer 烟测的
 * 夹具拷过来的,没有库连接——历史 Finding 查询由本用例在 IPC 上回一条固定结果,过滤本身
 * 由假模型用例(`agent-session-findings.test.ts`)把关。
 */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { PRODUCT_TICKET_LABELS } from "../src/review/store.ts";
import { piBuiltinProviderTargets } from "../src/reviewer/catalog.ts";
import { MODEL_API_KEY_ENV, reviewerEnv } from "../src/reviewer/env.ts";
import { resolveBuiltinModelTarget, type RuntimeModel } from "../src/reviewer/model-service-runtime.ts";
import {
  agentSessionImageRef,
  storeAgentSessionImage,
  type AgentSessionImageRef,
} from "../src/reviewer/session-images.ts";
import type {
  SessionCommand,
  SessionWorkerMessage,
  TrackerRequest,
} from "../src/reviewer/session-protocol.ts";
import { pngBytes } from "./support/png.ts";

const provider = process.env["MULTIREVIEWER_SMOKE_PROVIDER"];
const model = process.env["MULTIREVIEWER_SMOKE_MODEL"];
const envVar = process.env["MULTIREVIEWER_SMOKE_ENV"];
const secret = envVar === undefined ? undefined : process.env[envVar];

const skip =
  provider === undefined || model === undefined || envVar === undefined || secret === undefined
    ? "设置 MULTIREVIEWER_SMOKE_PROVIDER / _MODEL / _ENV 后运行"
    : false;

const WORKER_PATH = fileURLToPath(new URL("../src/reviewer/session-worker.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixture/reviewer-smoke", import.meta.url));

const REPO = { owner: "acme", repo: "widgets" };
/** 这棵树停在哪个 commit(issue #351)。冒烟夹具不建真仓库,提示里那一行认这一串。 */
const SMOKE_HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

/** 一段中文需求,要动的只可能是夹具那三个文件:订单接口、分页与那一份数据访问。 */
const REQUIREMENT = [
  "订单列表要支持按状态筛选:前端传一个状态参数,后端按它过滤,不传就还是返回全部。",
  "同时分页要有每页条数上限,超过上限按上限截断,页码小于 1 的请求直接拒掉。",
  "这个需求已经说清楚了,不必再问,直接收成一条 spec 再拆成票。",
].join("\n");

/** 烟测模型的调用目标(ADR 0027):Pi 内置表里它自己那一行,否则整家唯一的目标。 */
async function smokeRuntimeModel(): Promise<RuntimeModel> {
  const targets = await piBuiltinProviderTargets(provider!);
  assert.ok(targets, `Pi 内置 provider 不存在: ${provider}`);
  const resolved = resolveBuiltinModelTarget(provider!, model!, targets.get(model!), [
    ...targets.values(),
  ]);
  assert.ok(resolved.ok, `Pi 内置 provider 没有运行目标: ${provider}:${model}`);
  return {
    provider: provider!,
    id: model!,
    name: model!,
    api: resolved.target.api,
    baseUrl: resolved.target.baseUrl,
    input: ["text"],
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_000,
    sources: {
      name: "model-id",
      api: "service-target",
      baseUrl: "service-target",
      input: "runtime-baseline",
      reasoning: "runtime-baseline",
      contextWindow: "runtime-baseline",
      maxTokens: "runtime-baseline",
    },
  };
}

/** 这一次会话对产品 tracker 做的那几次读写,以及回合结束时可见的失败原因。 */
type SessionRun = { tracker: TrackerRequest[]; failure?: string };

/**
 * 起一个真会话子进程,发一条消息,等这一个回合跑完,回它对产品 tracker 做的那几次读写。
 *
 * 历史 Finding 查询与 tracker 的每一次读写都在这里回一条固定结果:本用例没有库,而工具调用
 * 在等那条回应——少回一次它就永远等下去。tracker 那一侧因此只记下模型要做什么,不真落库;
 * 落库由假模型用例(`agent-session-subprocess.test.ts`)把关。
 */
async function runSession(
  text: string,
  images: readonly AgentSessionImageRef[] = [],
): Promise<SessionRun> {
  const sessionRoot = mkdtempSync(join(tmpdir(), "multireviewer-session-smoke-"));
  cpSync(FIXTURE, join(sessionRoot, REPO.owner, REPO.repo), { recursive: true });

  const child: ChildProcess = fork(WORKER_PATH, {
    cwd: sessionRoot,
    env: reviewerEnv(process.env, { [MODEL_API_KEY_ENV]: secret! }),
    execArgv: [],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  const tracker: TrackerRequest[] = [];
  /** 下一条 spec 与票的号。恒回成功,模型因此接得下去。 */
  let nextId = 0;
  const run = new Promise<SessionRun>((resolve, reject) => {
    let opened = false;
    child.on("message", (message: SessionWorkerMessage) => {
      switch (message.kind) {
        case "ready":
          opened = true;
          child.send({
            kind: "prompt",
            text,
            mode: "followUp",
            ...(images.length === 0 ? {} : { images }),
            seq: 1,
          } satisfies SessionCommand);
          return;
        case "tracker-request":
          tracker.push(message.request);
          nextId += 1;
          child.send({
            kind: "tracker-result",
            requestId: message.requestId,
            text:
              message.request.kind === "create-spec"
                ? `spec ${nextId} created`
                : message.request.kind === "create-ticket"
                  ? `ticket ${nextId} created under spec ${message.request.specId}`
                  : "done",
          } satisfies SessionCommand);
          return;
        case "finding-query":
          child.send({
            kind: "finding-query-result",
            requestId: message.requestId,
            findings: [
              {
                file: "src/pagination.js",
                line: 3,
                title: "页码下界没有校验",
                severity: "P1",
                disposition: "unresolved",
                description: "page 小于 1 时偏移量算成负数。",
                impact: "查询直接报错。",
                suggestion: "下界取 1。",
              },
            ],
          } satisfies SessionCommand);
          return;
        case "turn-end":
          resolve({
            tracker,
            ...(message.failure === undefined ? {} : { failure: message.failure }),
          });
          return;
        case "failed":
          reject(new Error(`会话建不起来: ${message.failure}`));
          return;
        default:
          return;
      }
    });
    child.on("exit", (code) => {
      if (!opened) reject(new Error(`子进程未建会话即退出,退出码 ${code}`));
    });
  });

  child.send({
    kind: "open",
    request: {
      sessionRoot,
      productName: "冒烟产品",
      purpose: "requirement-breakdown",
      // 知识不进提示,只进一份目录(issue #344、#362):这个子进程没有库连接,
      // `query_knowledge` 在这一侧没有主进程接它,提示里因此只有仓库那两个计数。
      repos: [{ ...REPO, role: "唯一的仓库", headSha: SMOKE_HEAD_SHA, ruleCount: 1, factCount: 1 }],
      productKnowledge: [],
      runtimeModel: await smokeRuntimeModel(),
    },
  } satisfies SessionCommand);

  try {
    return await run;
  } finally {
    child.kill("SIGKILL");
  }
}

test("真实模型把需求收成一条 spec、拆成几张票并连上阻塞边", { skip }, async () => {
  const { tracker, failure } = await runSession(REQUIREMENT);
  assert.equal(failure, undefined, `这一回合失败: ${failure}`);

  // 一条 spec:谈定的需求先落成它,票挂在它下面。
  const specs = tracker.filter((one) => one.kind === "create-spec");
  assert.equal(specs.length, 1, `写了 ${specs.length} 条 spec`);
  const spec = specs[0]!;
  assert.ok(spec.title.trim().length > 0, "这条 spec 没有标题");
  assert.ok(spec.body.trim().length > 0, "这条 spec 没有正文");

  // 票:至少两张,各自有标题与正文,标签落在固定的五个里,都挂在刚写的那条 spec 上。
  const tickets = tracker.filter((one) => one.kind === "create-ticket");
  assert.ok(tickets.length >= 2, `只拆出 ${tickets.length} 张票`);
  for (const [index, ticket] of tickets.entries()) {
    const at = `第 ${index + 1} 张票`;
    assert.ok(ticket.title.trim().length > 0, `${at}没有标题`);
    assert.ok(ticket.body.trim().length > 0, `${at}没有正文`);
    assert.ok(PRODUCT_TICKET_LABELS.includes(ticket.label as never), `${at}的标签是 ${ticket.label}`);
    assert.equal(ticket.specId, 1, `${at}没挂在刚写的那条 spec 上`);
  }

  // 先后关系走阻塞边,不写在正文里:这个需求的分页上限与状态筛选各自独立,但页码下界要在
  // 分页那一条之后,模型至少该连出一条边。
  assert.ok(
    tracker.some((one) => one.kind === "block"),
    "一条阻塞边都没连",
  );

  // 不估算工作量:spec 与票的正文里不该出现工时、人天或故事点。
  assert.doesNotMatch(
    JSON.stringify(tracker),
    /(人天|工时|story point|故事点|\d+\s*(小时|天))/,
    "spec 或票里出现了工作量估算",
  );
});

/**
 * 带一张图再走一遍(spec #330 的真实模型契约那一半,图片通道是 issue #336)。
 *
 * 图的内容要模型说得出口,因此画的是「左半边纯红、右半边纯白」——没有字库就画不出文字,
 * 而一块颜色是一张手写编码器画得出、模型又一定认得的内容。需求文本点名让它把这个颜色写进
 * 对应那张票的正文,断言写下来的东西里出现「红」或 red:模型没看图就写不出这个词。
 *
 * 图走与面板同一条落盘路径(`storeAgentSessionImage`):缩放、扩展名与文件引用都按线上那一份
 * 来,临时库文件只用来定图片目录的位置,不开库连接。
 */
const SWATCH_REQUIREMENT = [
  "订单列表要加一个状态筛选器。附图里左边那一块是筛选器选中时的高亮色。",
  "把这个颜色的名字写进对应那张票的正文里,再按需求直接收成 spec 与票。",
].join("\n");

test("真实模型对带图的需求写出提到图里内容的票", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-session-smoke-image-"));
  const stored = await storeAgentSessionImage(
    join(dir, "panel.db"),
    1,
    pngBytes(240, 120, (x) => (x < 120 ? [220, 30, 30] : [255, 255, 255])),
    "image/png",
  );
  assert.ok(stored, "那张图落不了盘");

  const { tracker, failure } = await runSession(SWATCH_REQUIREMENT, [agentSessionImageRef(stored)]);
  assert.equal(failure, undefined, `这一回合失败: ${failure}`);
  assert.ok(
    tracker.some((one) => one.kind === "create-ticket"),
    "一张票都没写",
  );
  assert.match(JSON.stringify(tracker), /红|red/i, "写下来的东西里没提到图里那块颜色");
});
