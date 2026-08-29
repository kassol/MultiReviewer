import type { Reviewer } from "./review/finding.ts";
import { createPiReviewer } from "./reviewer/pi-reviewer.ts";
import type { RuntimeModel } from "./reviewer/model-service-runtime.ts";

/**
 * 思考档位的取值(CONTEXT.md)。与 Pi 的 `ThinkingLevel` 逐字一致:档位最终原样交给
 * 会话,自己另起一套名字只会在某一天对不上。
 */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** 模型组合的一项。凭据按 provider 查库得到(ADR 0008),这里不带凭据。 */
export type ReviewerSpec = {
  /** Pi 的 provider 标识。 */
  provider: string;
  /** Pi 的 model 标识。模型标识另取 `modelIdentity`。 */
  model: string;
  /**
   * 这一处模型引用的思考档位(CONTEXT.md)。缺席即 `off`,与档位可配之前逐字一致;
   * 模型不声明推理能力时运行侧静默落回 `off`,不在这里拦。
   */
  thinkingLevel?: ThinkingLevel;
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
 * 这个模型支持的思考档位(CONTEXT.md 思考档位)。判据与 pi-ai 的
 * `getSupportedThinkingLevels` 逐字一致:不声明推理能力时只有 `off`;声明了则按
 * `thinkingLevelMap` 筛——映射成 null 的那一档端点不认(adaptive 模型的 `off` 就是
 * 这样压掉的),`xhigh` 与 `max` 是模型自己 opt-in 的两档,映射里没写就没有。
 *
 * 判据只有这一份:面板列哪几档、保存组合与发起探索时拒哪几档都读它。选了模型不支持的
 * 那一档 Pi 会 clamp 到相邻可用档——人以为选了「关闭」而模型仍在思考,静默地不是人选的。
 */
export function supportedThinkingLevels(
  model: Pick<RuntimeModel, "reasoning" | "thinkingLevelMap">,
): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
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
    const level = (entry as Record<string, unknown>)["thinkingLevel"];
    if (level !== undefined && !THINKING_LEVELS.includes(level as ThinkingLevel)) {
      throw new Error(
        `${context}的第 ${index + 1} 项的思考档位不认得:${String(level)},只收 ${THINKING_LEVELS.join(" / ")}。`,
      );
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

/** Review Run 启动时固定下来的模型服务调用目标。 */
export type ModelServiceTarget = Readonly<{ baseUrl: string; api: string }>;

/**
 * 一个 Reviewer 在本轮实际使用的完整运行计划。凭据只活在内存里；持久化必须经
 * `reviewerPin` 显式投影，不能直接展开这个对象。
 */
export type ReviewerRuntimePlan = Readonly<{
  spec: ReviewerSpec;
  modelServiceVersion: number | null;
  target: ModelServiceTarget | null;
  runtimeModel: RuntimeModel | null;
  credential: string | null;
  failure: string | null;
}>;

/** Review Run 的非秘密审计快照。 */
export type ReviewRunReviewerPin = Readonly<{
  identity: string;
  provider: string;
  model: string;
  /** 这一轮这处模型引用用的思考档位,null 即没选(等同 off)。 */
  thinkingLevel: ThinkingLevel | null;
  modelServiceVersion: number | null;
  target: ModelServiceTarget | null;
  runtimeModel: RuntimeModel | null;
  failure: string | null;
}>;

/**
 * 安全边界：逐字段复制可持久化字段，凭据既不在返回类型里，也不会因以后给运行计划加字段而
 * 被对象展开顺带落库。
 */
export function reviewerPin(plan: ReviewerRuntimePlan): ReviewRunReviewerPin {
  return {
    identity: modelIdentity(plan.spec),
    provider: plan.spec.provider,
    model: plan.spec.model,
    thinkingLevel: plan.spec.thinkingLevel ?? null,
    modelServiceVersion: plan.modelServiceVersion,
    target: plan.target,
    runtimeModel: plan.runtimeModel,
    failure: plan.failure,
  };
}

/** 运行计划无法执行时仍建出 Reviewer，让这一项留下明确失败记录而不是从 Run 消失。 */
function failedReviewer(spec: ReviewerSpec, failure: string): Reviewer {
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
        failure,
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
 * 从本轮已经物化好的不可变计划建 Reviewer。这里不再读当前模型配置，也不再按 provider
 * 另查凭据；每个 Reviewer 只收到自己计划里的那一份。
 */
export function buildReviewers(plans: readonly ReviewerRuntimePlan[]): Reviewer[] {
  if (plans.length === 0) return [emptyModelSetReviewer()];
  return plans.map((plan) => {
    if (plan.failure !== null) return failedReviewer(plan.spec, plan.failure);
    if (plan.credential === null || plan.runtimeModel === null) {
      return failedReviewer(
        plan.spec,
        `${modelIdentity(plan.spec)} 的不可变运行计划不完整,这次没跑。`,
      );
    }
    return createPiReviewer({
      runtimeModel: plan.runtimeModel,
      apiKey: plan.credential,
      // 档位挂在模型引用处:本轮用的是计划冻结下来的那一份,开跑后改设置不影响本轮。
      ...(plan.spec.thinkingLevel === undefined ? {} : { thinkingLevel: plan.spec.thinkingLevel }),
    });
  });
}
