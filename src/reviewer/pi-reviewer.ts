import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type {
  Finding,
  FindingVerdict,
  HistoryFinding,
  RawFinding,
  ReviewIntent,
  ReviewRange,
  ReviewRule,
  Reviewer,
  ReviewerEvent,
  ReviewerOutcome,
  ReviewerUsage,
} from "../review/finding.ts";
import { modelIdentity } from "../config.ts";
import { MODEL_API_KEY_ENV, reviewerEnv } from "./env.ts";
import { normalizeFinding, normalizeVerdict } from "./normalize.ts";
import type { ReviewerRequest, WorkerMessage } from "./protocol.ts";
import type { RuntimeModel } from "./model-service-runtime.ts";

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));

/**
 * 一个卡住的 Reviewer 不是失败,是永远不返回。没有这道闸,整次 Review Run 会被它
 * 拖住不结束。取值宽到足以容纳最慢的模型跑完一个大 Review Range。
 */
const TIMEOUT_MS = 20 * 60 * 1000;

/** 回报结果之后留给子进程收尾的时间。超过就当它退不掉,强杀并按已收到的结果结束。 */
const EXIT_GRACE_MS = 5000;

export type PiReviewerConfig = {
  /** 本轮固定的完整运行模型，不再从共享的当前目录解析。 */
  runtimeModel: RuntimeModel;
  /** 该 Reviewer 绑定厂商的模型凭据。子进程的环境里只会有这一份。 */
  apiKey: string;
};

/**
 * 基于 Pi SDK 的 Reviewer。每次审查 fork 一个子进程,进程的环境只含自家厂商凭据。
 */
export function createPiReviewer(config: PiReviewerConfig): Reviewer {
  return {
    model: modelIdentity({ provider: config.runtimeModel.provider, model: config.runtimeModel.id }),
    review: (range, worktreePath, history, intent, rules, onEvent) =>
      runInChild(WORKER_PATH, config, range, worktreePath, history, intent, rules, onEvent),
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
  /** 本审查阶段的历史 Finding(ADR 0016)。首轮没有历史,默认空。 */
  history: readonly HistoryFinding[] = [],
  /** 这一轮声称要做的事(issue #201)。取不到意图上下文的调用方不传。 */
  intent?: ReviewIntent,
  /** 本批要按的评审规则(issue #204)。空规则集与不传等价。 */
  rules: readonly ReviewRule[] = [],
  /** 子进程转发上来的过程事件的去处(issue #171)。不关心过程的调用方不传。 */
  onEvent: (event: ReviewerEvent) => void = () => {},
): Promise<ReviewerOutcome> {
  return new Promise((resolve) => {
    // 对外一律用完整模型标识；运行字段来自这轮固定的模型服务版本。
    const identity = modelIdentity({
      provider: config.runtimeModel.provider,
      model: config.runtimeModel.id,
    });
    const ruleIds = new Set(rules.map((rule) => rule.id));
    const findings: Finding[] = [];
    const verdicts: FindingVerdict[] = [];
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

    const finish = (failure: string | undefined, exitCode?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      child.removeAllListeners();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve({
        model: identity,
        findings,
        verdicts,
        anomalies,
        rejectedToolCalls,
        anchorRejections,
        ...(failure === undefined ? {} : { failure }),
        // 退出码只在失败时有意义,进轨迹的失败事件带上它(issue #171)。
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(usage === undefined ? {} : { usage }),
      });
    };

    const timer = setTimeout(
      () => finish(`Reviewer 超时,超过 ${TIMEOUT_MS / 60_000} 分钟未结束`),
      TIMEOUT_MS,
    );

    child.on("message", (message: WorkerMessage) => {
      if (message.kind === "finding") {
        // 模型自报的规则标识在这里校验:注入的这一批规则是它唯一的合法取值(issue #204)。
        const result = normalizeFinding(message.raw, identity, ruleIds);
        if (result.ok) findings.push(result.finding);
        else anomalies.push({ raw: result.raw, reason: result.reason });
        return;
      }
      if (message.kind === "event") {
        onEvent(message.event);
        return;
      }
      if (message.kind === "verdict") {
        // 同一条历史被复核两次时后一条作数:模型改口时最后那句才是它的结论。
        const verdict = normalizeVerdict(message.raw);
        if (verdict !== undefined) {
          const index = verdicts.findIndex((v) => v.findingId === verdict.findingId);
          if (index === -1) verdicts.push(verdict);
          else verdicts[index] = verdict;
        }
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
          code ?? undefined,
        );
        return;
      }
      if (code !== 0) {
        finish(done.failure ?? `子进程退出码 ${code}`, code ?? undefined);
        return;
      }
      finish(done.failure);
    });

    const request: ReviewerRequest = {
      runtimeModel: config.runtimeModel,
      range,
      worktreePath,
      history,
      ...(intent === undefined ? {} : { intent }),
      // 空规则集不带这一项:子进程据此不渲染规则段,prompt 与没有规则集时逐字一致。
      ...(rules.length === 0 ? {} : { rules }),
    };
    // 必须带 callback:子进程起不来时(例如工作副本目录不存在)投递会失败,
    // 没有 callback 时 Node 把 EPIPE 异步抛出去,try/catch 拦不住,
    // 一个 Reviewer 的失败会掀掉整次 Review Run。
    child.send(request, (error) => {
      if (error !== null) finish(`无法向子进程投递任务: ${error.message}`);
    });
  });
}
