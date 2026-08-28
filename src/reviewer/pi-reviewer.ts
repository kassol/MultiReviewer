import { fileURLToPath } from "node:url";

import type {
  Finding,
  FindingVerdict,
  RawFinding,
  Reviewer,
  ReviewerInput,
  ReviewerOutcome,
  ReviewerUsage,
} from "../review/finding.ts";
import { modelIdentity } from "../config.ts";
import { normalizeFinding, normalizeVerdict } from "./normalize.ts";
import type { ReviewerRequest, WorkerMessage } from "./protocol.ts";
import type { RuntimeModel } from "./model-service-runtime.ts";
import { runWorkerChild } from "./subprocess.ts";

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));

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
    review: (input) => runInChild(WORKER_PATH, config, input),
  };
}

/**
 * 子进程回传消息的收集与归一化。进程本身的生命周期在 `subprocess.ts`,与规则 agent
 * 共用一份;`workerPath` 是参数而非常量,使失败路径能用受控的 worker 脚本驱动测试。
 */
export async function runInChild(
  workerPath: string,
  config: PiReviewerConfig,
  input: ReviewerInput,
): Promise<ReviewerOutcome> {
  const {
    range,
    worktreePath,
    history,
    intent,
    // 空规则集与不传等价。
    rules = [],
    // 子进程转发上来的过程事件的去处(issue #171)。不关心过程的调用方不传。
    onEvent = () => {},
  } = input;
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

  const request: ReviewerRequest = {
    runtimeModel: config.runtimeModel,
    range,
    worktreePath,
    history,
    ...(intent === undefined ? {} : { intent }),
    // 空规则集不带这一项:子进程据此不渲染规则段,prompt 与没有规则集时逐字一致。
    ...(rules.length === 0 ? {} : { rules }),
  };

  const { failure, exitCode } = await runWorkerChild<WorkerMessage>({
    workerPath,
    worktreePath,
    apiKey: config.apiKey,
    timeoutSubject: "Reviewer",
    payload: request,
    onMessage: (message) => {
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
    },
  });

  return {
    model: identity,
    findings,
    verdicts,
    anomalies,
    rejectedToolCalls,
    anchorRejections,
    ...(failure === undefined ? {} : { failure }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(usage === undefined ? {} : { usage }),
  };
}
