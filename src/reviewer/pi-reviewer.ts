import { fileURLToPath } from "node:url";

import type {
  Finding,
  FindingVerdict,
  RawFinding,
  Reviewer,
  ReviewerInput,
  ReviewerOutcome,
  ReviewerUsage,
  SessionKnowledgeEntries,
  SessionKnowledgeQuery,
} from "../review/finding.ts";
import { DEFAULT_MIN_REPORT_SEVERITY } from "../review/finding.ts";
import { modelIdentity, type ThinkingLevel } from "../config.ts";
import { normalizeFinding, normalizeVerdict } from "./normalize.ts";
import type { ReviewerCommand, ReviewerRequest, WorkerMessage } from "./protocol.ts";
import type { RuntimeModel } from "./model-service-runtime.ts";
import { runWorkerChild } from "./subprocess.ts";

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));

export type PiReviewerConfig = {
  /** 本轮固定的完整运行模型，不再从共享的当前目录解析。 */
  runtimeModel: RuntimeModel;
  /** 该 Reviewer 绑定厂商的模型凭据。子进程的环境里只会有这一份。 */
  apiKey: string;
  /** 本轮这一处模型引用的思考档位(CONTEXT.md)。缺席即 `off`。 */
  thinkingLevel?: ThinkingLevel;
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
 * 回一次产品知识查询(issue #362)。库在这一侧,子进程只拿得到回音,因此**恒回一条**
 * ——查不动时带上原因,不然子进程那边的工具调用永远等下去。
 *
 * 查询回调缺席时也回一条:那时子进程本不该注册这件工具,回一句比让它挂着强。
 *
 * 回调是异步的(issue #447、#449):查完再回音,失败的那一档同形。
 */
async function answerKnowledgeQuery(
  requestId: string,
  query: SessionKnowledgeQuery,
  read: ((query: SessionKnowledgeQuery) => Promise<SessionKnowledgeEntries>) | undefined,
  reply: (command: ReviewerCommand) => void,
): Promise<void> {
  const failed = (failure: string): void => {
    reply({
      kind: "knowledge-query-result",
      requestId,
      entries: { product: [], repo: [] },
      failure,
    });
  };
  if (read === undefined) {
    failed("this repository is not in a product, so nothing is written down to read");
    return;
  }
  try {
    reply({ kind: "knowledge-query-result", requestId, entries: await read(query) });
  } catch (error) {
    failed(error instanceof Error ? error.message : String(error));
  }
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
    commentable,
    history,
    intent,
    directive,
    mode,
    maxEvidenceCallsPerBatch,
    minReportSeverity,
    batched,
    // 仓库属于某个产品、且那个产品写下过东西时才有(issue #362)。目录进 prompt,
    // 查询回调留在这一侧:库在编排进程里。
    productKnowledge,
    queryKnowledge,
    // 空知识集与不传等价。两型各判各的:只有事实没有规则的知识集同样成立。
    rules = [],
    facts = [],
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
  let stopReason: string | undefined;
  let turns: number | undefined;

  const request: ReviewerRequest = {
    runtimeModel: config.runtimeModel,
    ...(config.thinkingLevel === undefined ? {} : { thinkingLevel: config.thinkingLevel }),
    range,
    worktreePath,
    commentable,
    history,
    ...(intent === undefined ? {} : { intent }),
    // 没有本轮指令时不带这一项:子进程据此不渲染指令段(issue #225)。
    ...(directive === undefined || directive === "" ? {} : { directive }),
    // 完整审查不带这一项(issue #242):子进程的工具面与这一票之前逐字一致。
    ...(mode === undefined || mode === "full" ? {} : { mode }),
    // 取证上限不给即不带(issue #258):子进程落回系统默认,任务形状与这一票之前逐字一致。
    ...(maxEvidenceCallsPerBatch === undefined ? {} : { maxEvidenceCallsPerBatch }),
    // 全报那一档不带这一项(issue #271):子进程据此不渲染阈值段,prompt 逐字不变。
    ...(minReportSeverity === undefined || minReportSeverity === DEFAULT_MIN_REPORT_SEVERITY
      ? {}
      : { minReportSeverity }),
    // 分批那一档才带这一项(issue #306):子进程据此在文件清单后多一句「只报这些文件」,
    // 单批时 prompt 逐字不变。
    ...(batched === undefined ? {} : { batched }),
    // 空知识集不带这一项:子进程据此不渲染规则段,prompt 与没有知识集时逐字一致。
    ...(rules.length === 0 ? {} : { rules }),
    // 事实段同律(issue #221):一条事实都没有时不带,prompt 与升级前逐字一致。
    ...(facts.length === 0 ? {} : { facts }),
    // 仓库不属于任何产品时不带(issue #362):子进程据此不渲染产品段、也不注册
    // `query_knowledge`,prompt 与这一票之前逐字一致。
    ...(productKnowledge === undefined ? {} : { productKnowledge }),
  };

  const { failure, exitCode } = await runWorkerChild<WorkerMessage>({
    workerPath,
    worktreePath,
    apiKey: config.apiKey,
    timeoutSubject: "Reviewer",
    payload: request,
    onMessage: (message, reply) => {
      if (message.kind === "knowledge-query") {
        void answerKnowledgeQuery(message.requestId, message.query, queryKnowledge, reply);
        return;
      }
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
      // 心跳只为重置静默闸(`subprocess.ts` 已在收到消息时重置),这里不读它。
      if (message.kind === "heartbeat") return;
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
      stopReason = message.stopReason;
      turns = message.turns;
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
    // 子进程没回报收尾消息就退出时两格都取不到(issue #408),如实缺失。
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(turns === undefined ? {} : { turns }),
  };
}
