/**
 * `submit_requirement_breakdown`、需求拆分那一段系统提示与真实模型之间的契约,桩测不到:
 * 真模型会不会读完代码再给落点、会不会把整份拆分放进一次调用、总述三段与条目六格填不填齐,
 * 都要真模型跑一遍才知道立不立得住(issue #338)。
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

import { piBuiltinProviderTargets } from "../src/reviewer/catalog.ts";
import { MODEL_API_KEY_ENV, reviewerEnv } from "../src/reviewer/env.ts";
import { resolveBuiltinModelTarget, type RuntimeModel } from "../src/reviewer/model-service-runtime.ts";
import type {
  SessionCommand,
  SessionOutput,
  SessionWorkerMessage,
} from "../src/reviewer/session-protocol.ts";

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
const REPO_NAME = `${REPO.owner}/${REPO.repo}`;

/** 一段中文需求,落点只可能在夹具那三个文件里:订单接口、分页与那一份数据访问。 */
const REQUIREMENT = [
  "订单列表要支持按状态筛选:前端传一个状态参数,后端按它过滤,不传就还是返回全部。",
  "同时分页要有每页条数上限,超过上限按上限截断,页码小于 1 的请求直接拒掉。",
  "这个需求已经说清楚了,直接拆。",
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

/** 这一次会话交上来的全部产出,以及回合结束时可见的失败原因。 */
type SessionRun = { outputs: SessionOutput[]; failure?: string };

/**
 * 起一个真会话子进程,发一条消息,等这一个回合跑完,回它交上来的产出。
 *
 * 历史 Finding 查询在这里回一条固定结果:本用例没有库,而工具调用在等那条回应——少回一次
 * 它就永远等下去。
 */
async function runSession(text: string): Promise<SessionRun> {
  const sessionRoot = mkdtempSync(join(tmpdir(), "multireviewer-session-smoke-"));
  cpSync(FIXTURE, join(sessionRoot, REPO.owner, REPO.repo), { recursive: true });

  const child: ChildProcess = fork(WORKER_PATH, {
    cwd: sessionRoot,
    env: reviewerEnv(process.env, { [MODEL_API_KEY_ENV]: secret! }),
    execArgv: [],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  const outputs: SessionOutput[] = [];
  const run = new Promise<SessionRun>((resolve, reject) => {
    let opened = false;
    child.on("message", (message: SessionWorkerMessage) => {
      switch (message.kind) {
        case "ready":
          opened = true;
          child.send({ kind: "prompt", text } satisfies SessionCommand);
          return;
        case "output":
          outputs.push(message.output);
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
            outputs,
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
      purpose: "requirement-breakdown",
      repos: [
        {
          ...REPO,
          rules: [{ id: 1, scope: "src", statement: "每个导出函数都要有 JSDoc 注释" }],
          facts: [{ id: 2, scope: "src", statement: "这个仓库的数据访问都走 src/db.js" }],
        },
      ],
      runtimeModel: await smokeRuntimeModel(),
    },
  } satisfies SessionCommand);

  try {
    return await run;
  } finally {
    child.kill("SIGKILL");
  }
}

test("真实模型经 submit_requirement_breakdown 交出一份齐全的需求拆分", { skip }, async () => {
  const { outputs, failure } = await runSession(REQUIREMENT);
  assert.equal(failure, undefined, `这一回合失败: ${failure}`);

  // 一份拆分一次调用:交了几版就有几条产出,至少有一版。
  assert.ok(outputs.length > 0, "一版拆分都没交");
  for (const output of outputs) assert.equal(output.kind, "requirement-breakdown");

  const breakdown = outputs.at(-1)!.payload as {
    summary: string;
    assumptions: string[];
    openQuestions: string[];
    items: {
      title: string;
      description: string;
      repo: string;
      locations: string[];
      dependsOn: number[];
      acceptance: string[];
    }[];
  };

  // 总述:概要必须有话,假设与未决问题两格在(「直接拆」之后它们可以是空的)。
  assert.ok(breakdown.summary.trim().length > 0, "总述没有需求概要");
  assert.ok(Array.isArray(breakdown.assumptions));
  assert.ok(Array.isArray(breakdown.openQuestions));

  // 条目:六格齐全,所属仓库落在夹具仓库内,依赖序号指得到本次列表里的另一条。
  assert.ok(breakdown.items.length > 0, "一条拆分条目都没有");
  for (const [index, item] of breakdown.items.entries()) {
    const at = `第 ${index + 1} 条`;
    assert.ok(item.title.trim().length > 0, `${at}没有标题`);
    assert.ok(item.description.trim().length > 0, `${at}没有描述`);
    assert.equal(item.repo, REPO_NAME, `${at}的所属仓库不是夹具仓库`);
    assert.ok(item.locations.length > 0, `${at}没有落点`);
    for (const location of item.locations) {
      assert.equal(location.startsWith("/"), false, `${at}的落点不是仓库相对路径: ${location}`);
      assert.equal(location.includes(".."), false, `${at}的落点爬出了仓库: ${location}`);
    }
    assert.ok(item.acceptance.length > 0, `${at}没有验收要点`);
    for (const dependency of item.dependsOn) {
      assert.notEqual(dependency, index + 1, `${at}依赖自己`);
      assert.ok(
        dependency >= 1 && dependency <= breakdown.items.length,
        `${at}的依赖序号 ${dependency} 越界`,
      );
    }
  }
  // 不估算工作量:条目里不该出现工时、人天或故事点。
  assert.doesNotMatch(
    JSON.stringify(breakdown),
    /(人天|工时|story point|故事点|\d+\s*(小时|天))/,
    "拆分里出现了工作量估算",
  );
});

/**
 * 带一张图再交一次(spec #330 的真实模型契约那一半)。
 *
 * 此刻交不了:图片附件是 issue #336,会话的 IPC 上还没有图片通道——`prompt` 这一档只带
 * 文本,Pi 的 `prompt(text, { images })` 那个形状过不到子进程里。#336 落地后把这一条打开:
 * 发一条带图的消息,断言产出的文本提到图里的内容。
 */
test("真实模型对带图的需求交出提到图里内容的拆分", { skip: "图片通道随 issue #336 落地" }, () => {
  assert.fail("未实现");
});
