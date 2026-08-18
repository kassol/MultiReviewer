import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type {
  Finding,
  RawFinding,
  ReviewRange,
  Reviewer,
  ReviewerOutcome,
  ReviewerUsage,
} from "../review/finding.ts";
import { modelIdentity } from "../config.ts";
import { MODEL_API_KEY_ENV, reviewerEnv } from "./env.ts";
import { CACHE_DIR_ENV, cacheRoot } from "./model-runtime.ts";
import { normalizeFinding } from "./normalize.ts";
import type { ReviewerRequest, WorkerMessage } from "./protocol.ts";

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));

/**
 * 一个卡住的 Reviewer 不是失败,是永远不返回。没有这道闸,整次 Review Run 会被它
 * 拖住不结束。取值宽到足以容纳最慢的模型跑完一个大 Review Range。
 */
const TIMEOUT_MS = 20 * 60 * 1000;

/** 回报结果之后留给子进程收尾的时间。超过就当它退不掉,强杀并按已收到的结果结束。 */
const EXIT_GRACE_MS = 5000;

export type PiReviewerConfig = {
  /** Pi 的 provider 标识,如 `anthropic`、`openrouter`。 */
  provider: string;
  /** Pi 的 model 标识。喂给 Pi 的是它,对外的模型标识是 `provider:model`。 */
  model: string;
  /** 该 Reviewer 绑定厂商的模型凭据。子进程的环境里只会有这一份。 */
  apiKey: string;
};

/**
 * 基于 Pi SDK 的 Reviewer。每次审查 fork 一个子进程,进程的环境只含自家厂商凭据。
 */
export function createPiReviewer(config: PiReviewerConfig): Reviewer {
  return {
    model: modelIdentity(config),
    review: (range, worktreePath) =>
      runInChild(WORKER_PATH, config, range, worktreePath),
  };
}

/**
 * 子进程的生命周期管理与消息收集。`workerPath` 是参数而非常量,使失败路径
 * (未回报即退出、被信号终止)能用受控的 worker 脚本驱动测试。
 */
export function runInChild(
  workerPath: string,
  config: PiReviewerConfig,
  range: ReviewRange,
  worktreePath: string,
): Promise<ReviewerOutcome> {
  return new Promise((resolve) => {
    // 对外一律用模型标识;`config.model` 只喂给 Pi。
    const identity = modelIdentity(config);
    const findings: Finding[] = [];
    const anomalies: { raw: RawFinding; reason: string }[] = [];
    let rejectedToolCalls = 0;
    let anchorRejections = 0;
    let usage: ReviewerUsage | undefined;
    let done: { rejectedToolCalls: number; failure?: string } | undefined;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    let child: ChildProcess;
    try {
      child = fork(workerPath, {
        // 进程级 cwd 也落在工作副本里。只设 Pi 的 cwd 不够:模型会拼出相对于
        // 编排进程目录的路径,报出来的 file 因此指不到仓库里的文件。
        cwd: worktreePath,
        env: reviewerEnv(process.env, {
          [MODEL_API_KEY_ENV]: config.apiKey,
          // 缓存根在父进程里定死成绝对路径再传下去。默认值是相对路径,而子进程的 cwd 是
          // 工作副本:同一个相对值两侧解析出两个不同的目录,共用的模型目录当场落空
          // (`model-runtime.ts` 的 `cacheRoot`)。
          [CACHE_DIR_ENV]: cacheRoot(),
        }),
        // 不继承父进程的 execArgv。worker 是普通脚本,继承会把父进程的运行模式带过来
        // ——在 `node --test` 下跑时,worker 会被当成测试文件启动并挂住不退出。
        execArgv: [],
        // 子进程的 stdout/stderr 归入服务日志,不参与协议。
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
    } catch (error) {
      // 工作副本目录不存在时 fork 同步抛。这是一次 Reviewer 失败,
      // 不该把整次 Review Run 一起掀掉。
      resolve({
        model: identity,
        findings: [],
        anomalies: [],
        rejectedToolCalls: 0,
        anchorRejections: 0,
        failure: `子进程无法启动: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    const finish = (failure: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      child.removeAllListeners();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve({
        model: identity,
        findings,
        anomalies,
        rejectedToolCalls,
        anchorRejections,
        ...(failure === undefined ? {} : { failure }),
        ...(usage === undefined ? {} : { usage }),
      });
    };

    const timer = setTimeout(
      () => finish(`Reviewer 超时,超过 ${TIMEOUT_MS / 60_000} 分钟未结束`),
      TIMEOUT_MS,
    );

    child.on("message", (message: WorkerMessage) => {
      if (message.kind === "finding") {
        const result = normalizeFinding(message.raw, identity);
        if (result.ok) findings.push(result.finding);
        else anomalies.push({ raw: result.raw, reason: result.reason });
        return;
      }
      rejectedToolCalls = message.rejectedToolCalls;
      anchorRejections = message.anchorRejections;
      usage = message.usage;
      done = message;
      // 结果已经拿到,不该再为一个赖着不退出的子进程等满超时。
      clearTimeout(timer);
      graceTimer = setTimeout(() => finish(message.failure), EXIT_GRACE_MS);
    });

    child.on("error", (error) => finish(`子进程无法启动: ${error.message}`));

    child.on("exit", (code, signal) => {
      // 退出码优先于会话状态:子进程异常终止时 `done` 根本没发出来,会话内的三处
      // 失败信号都读不到,退出码是唯一的信号。
      if (done === undefined) {
        finish(
          signal === null
            ? `子进程未回报结果即退出,退出码 ${code}`
            : `子进程被信号 ${signal} 终止`,
        );
        return;
      }
      if (code !== 0) {
        finish(done.failure ?? `子进程退出码 ${code}`);
        return;
      }
      finish(done.failure);
    });

    const request: ReviewerRequest = {
      provider: config.provider,
      model: config.model,
      range,
      worktreePath,
    };
    // 必须带 callback:子进程起不来时(例如工作副本目录不存在)投递会失败,
    // 没有 callback 时 Node 把 EPIPE 异步抛出去,try/catch 拦不住,
    // 一个 Reviewer 的失败会掀掉整次 Review Run。
    child.send(request, (error) => {
      if (error !== null) finish(`无法向子进程投递任务: ${error.message}`);
    });
  });
}
