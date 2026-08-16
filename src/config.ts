import type { Reviewer } from "./review/finding.ts";
import { createPiReviewer } from "./reviewer/pi-reviewer.ts";

/** 模型组合的一项。凭据按 provider 查库得到(ADR 0008),这里不带凭据。 */
export type ReviewerSpec = {
  /** Pi 的 provider 标识。 */
  provider: string;
  /** Pi 的 model 标识。模型标识另取 `modelIdentity`。 */
  model: string;
};

/**
 * 模型标识:`provider:model`。Finding 与 Reviewer 的统计都按它归属来源。
 *
 * 带 provider 段是因为 Pi 目录里有 216 个 model id 跨 provider 重复;分隔用冒号而非
 * 斜杠,是因为部分 model id 本身带斜杠,首次出现的冒号即边界。
 */
export function modelIdentity(spec: { provider: string; model: string }): string {
  return `${spec.provider}:${spec.model}`;
}

/**
 * 校验一组 ReviewerSpec 并返回。全局模型组合与每仓库模型覆盖共用这套判据,
 * `context` 写进报错里指认来源(全局还是哪个仓库)。
 *
 * 空组合只在全局这一层受支持(`allowEmpty`):空库刚部署时它本来就是空的,而空的全局
 * 组合有确定行为——投递照常受理,留下一条写明「还没配模型组合」的失败 Run(issue #66)。
 * 每仓库覆盖不同:覆盖的语义是「这个仓库不跟全局,用这几个模型」,空覆盖表达不了任何
 * 意图,要停掉就把覆盖清成 null 回到跟随全局(issue #69)。
 */
export function assertReviewerSpecs(
  value: unknown,
  context: string,
  options: { allowEmpty?: boolean } = {},
): ReviewerSpec[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context}要是一个列表。`);
  }
  if (value.length === 0 && options.allowEmpty !== true) {
    throw new Error(`${context}至少要选一个模型。`);
  }

  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    for (const field of ["provider", "model"] as const) {
      const fieldValue = (entry as Record<string, unknown>)[field];
      if (typeof fieldValue !== "string" || fieldValue === "") {
        throw new Error(`${context}的第 ${index + 1} 项没有 ${field}。`);
      }
    }
    const identity = modelIdentity(entry as ReviewerSpec);
    if (seen.has(identity)) {
      // Finding 以模型标识归属来源,标识重复就分不清是哪一个 Reviewer 提的。
      // 键是完整标识:同一个 model id 在两家 provider 下是两个 Reviewer,可共存。
      throw new Error(`${context}里 ${identity} 选了两次,去掉一个。`);
    }
    seen.add(identity);
  }
  return value as ReviewerSpec[];
}

/** 全局模型组合在库里的存法与每仓库覆盖同构:ReviewerSpec 的 JSON 数组,null 即还没配。 */
export const GLOBAL_REVIEWERS_CONTEXT = "全局模型组合";

/** 读库里的全局模型组合。没配与显式配空都是空数组——空库刚起来时就是这样。 */
export function parseGlobalReviewers(reviewersJson: string | null): ReviewerSpec[] {
  if (reviewersJson === null) return [];
  return assertReviewerSpecs(JSON.parse(reviewersJson), GLOBAL_REVIEWERS_CONTEXT, {
    allowEmpty: true,
  });
}

/**
 * 一次 Review Run 开始时取到的模型凭据:provider → 明文 key。快照在编排进程里解密
 * 得到,整轮不重读(ADR 0008)——轮转对进行中的 Run 无影响,下一次投递自然用新的。
 */
export type CredentialSnapshot = ReadonlyMap<string, string>;

/**
 * 缺凭据的 provider 照样建出一个 Reviewer,它一跑就报失败并写明缺哪一家。
 *
 * 这里不抛:抛出去的话这次投递在时间线上一点痕迹都不留,人看到的是「投了没反应」。
 * 报成 Reviewer 失败则这次 Review Run 留下一条失败记录,原因跟着落库。
 */
function missingCredentialReviewer(spec: ReviewerSpec): Reviewer {
  const identity = modelIdentity(spec);
  return {
    model: identity,
    review: () =>
      Promise.resolve({
        model: identity,
        findings: [],
        anomalies: [],
        rejectedToolCalls: 0,
        anchorRejections: 0,
        failure: `没有配置 ${spec.provider} 的模型凭据,${identity} 这次没跑。去面板的凭据页配好再重跑。`,
      }),
  };
}

/**
 * 一个模型都没配时顶上的 Reviewer,理由同上:零 Reviewer 的 Review Run 既不失败也不
 * 报错,人看到的是「投了没反应」。有它在,这次投递留下一条失败记录说明差什么。
 */
function emptyModelSetReviewer(): Reviewer {
  const identity = "none";
  return {
    model: identity,
    review: () =>
      Promise.resolve({
        model: identity,
        findings: [],
        anomalies: [],
        rejectedToolCalls: 0,
        anchorRejections: 0,
        failure: "还没有配置模型组合,这次没跑。去面板的设置页配好再重跑。",
      }),
  };
}

/**
 * 按模型组合建出全部 Reviewer,每个只拿到自己那一家的凭据。
 *
 * 凭据来自 Review Run 开始时的快照,缺失不拦启动也不拦投递:服务照常起,那一家的
 * Reviewer 报失败(issue #65)。组合为空同理,由 `emptyModelSetReviewer` 报失败。
 */
export function buildReviewers(
  specs: readonly ReviewerSpec[],
  credentials: CredentialSnapshot,
): Reviewer[] {
  if (specs.length === 0) return [emptyModelSetReviewer()];
  return specs.map((spec) => {
    const apiKey = credentials.get(spec.provider);
    if (apiKey === undefined || apiKey === "") return missingCredentialReviewer(spec);
    return createPiReviewer({
      provider: spec.provider,
      model: spec.model,
      apiKey,
    });
  });
}
