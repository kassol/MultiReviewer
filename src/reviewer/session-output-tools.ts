/**
 * Agent 会话的产出工具(issue #337)。
 *
 * 底座这一侧只有一条机制:**用途 → 产出工具定义列表**(`sessionOutputTools`)。这一版只有
 * 需求拆分一个用途、一件工具,所以它只是一处按用途分发;写代码类用途接入时在那里多一档。
 *
 * 工具的做法与 Reviewer 的 `report_finding` 逐条对齐(`worker.ts`):枚举与格式要求写在字段
 * 自己的 `description` 里、形状宽松、服务端归一化(trim、去空项),打回走**正常返回**一句
 * 理由而不是抛工具错误——出根与白名单那种「这个会话做不到的事」才抛错,打回是「换个参数
 * 再试」的摩擦,模型看见理由就改得动。通过则经 IPC 单条回主进程,工具回 `recorded`。
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { SessionWorkerMessage } from "./session-protocol.ts";

export const SUBMIT_REQUIREMENT_BREAKDOWN_TOOL = "submit_requirement_breakdown";

/** 一条拆分条目(CONTEXT.md 拆分条目)。不带工作量估算。 */
export type RequirementBreakdownItem = {
  title: string;
  description: string;
  /** 所属仓库,`<owner>/<repo>`。必须是这个会话根里的一个仓库。 */
  repo: string;
  /** 落点:仓库相对的目录或文件路径。 */
  locations: string[];
  /** 依赖的条目,按条目在本次列表里的序号(从 1 起)。 */
  dependsOn: number[];
  acceptance: string[];
};

/** 一份需求拆分(CONTEXT.md 需求拆分):总述三段加一组拆分条目。 */
export type RequirementBreakdown = {
  summary: string;
  assumptions: string[];
  openQuestions: string[];
  items: RequirementBreakdownItem[];
};

const breakdownSchema = Type.Object({
  summary: Type.String({
    description: "The requirement in your own words, written in Chinese: what is being asked for",
  }),
  assumptions: Type.Array(Type.String(), {
    description:
      "Everything you assumed because the requirement did not say, written in Chinese. Empty array when you assumed nothing.",
  }),
  openQuestions: Type.Array(Type.String(), {
    description:
      "The questions still open, written in Chinese: what the person has to decide before this can be built. Empty array when nothing is open.",
  }),
  items: Type.Array(
    Type.Object({
      title: Type.String({
        description: "A short Chinese title naming the change, about 20 characters",
      }),
      description: Type.String({
        description: "What has to change and why, written in Chinese",
      }),
      repo: Type.String({
        description:
          "The repository this item changes, exactly as <owner>/<repo>, copied from the list of this session's repositories. One item changes one repository.",
      }),
      locations: Type.Array(Type.String(), {
        description:
          "Where the change lands: paths relative to the root of that repository, without the <owner>/<repo> prefix, without a leading / and without .. — a directory like src/finance/ or a file like src/finance/rate.ts. Only paths you have read or listed.",
      }),
      dependsOn: Type.Array(Type.Integer(), {
        description:
          "The items this one has to wait for, by their 1-based position in this items array. An item cannot depend on itself, and every number has to be the position of another item in this same array. Empty array when it depends on nothing.",
      }),
      acceptance: Type.Array(Type.String(), {
        description:
          "What has to hold for this item to be done, written in Chinese: one line per check, concrete enough to verify",
      }),
    }),
    {
      description:
        "The breakdown itself. One item is one change inside a single repository that can go out as its own pull request; a feature that spans repositories becomes several items tied together by dependsOn.",
    },
  ),
});

/** 去掉首尾空白,丢掉空项。模型给的列表里常有空串占位。 */
function cleanList(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value !== "");
}

/** 服务端归一化:字符串 trim,列表去空项。与 `report_finding` 同一做法。 */
export function normalizeRequirementBreakdown(raw: RequirementBreakdown): RequirementBreakdown {
  return {
    summary: raw.summary.trim(),
    assumptions: cleanList(raw.assumptions),
    openQuestions: cleanList(raw.openQuestions),
    items: raw.items.map((item) => ({
      title: item.title.trim(),
      description: item.description.trim(),
      repo: item.repo.trim(),
      locations: cleanList(item.locations),
      dependsOn: [...item.dependsOn],
      acceptance: cleanList(item.acceptance),
    })),
  };
}

/** 这个落点是不是仓库相对路径。只核对形状,不核对文件存不存在(spec #330)。 */
function malformedLocation(location: string): boolean {
  return location.startsWith("/") || location.split("/").includes("..");
}

/**
 * 这份拆分要不要打回,要就回一句理由(spec #330 的三种情形)。
 *
 * 只回第一处:一次说一件事,模型改完再交一版,比收到一张清单挑着改可靠。
 */
export function requirementBreakdownRejection(
  breakdown: RequirementBreakdown,
  repos: readonly string[],
): string | undefined {
  for (const [index, item] of breakdown.items.entries()) {
    const at = `item ${index + 1}`;
    if (!repos.includes(item.repo)) {
      return `${at} is on ${item.repo}, which is not a repository of this session; put it on one of: ${repos.join(", ")}`;
    }
    const malformed = item.locations.find(malformedLocation);
    if (malformed !== undefined) {
      return `${at} has the location ${malformed}; every location is a path relative to the root of ${item.repo}, without a leading / and without ..`;
    }
    for (const dependency of item.dependsOn) {
      if (dependency === index + 1) return `${at} depends on itself`;
      if (dependency < 1 || dependency > breakdown.items.length) {
        return `${at} depends on item ${dependency}, but this breakdown has ${breakdown.items.length} items; depend on another item by its position in the items array`;
      }
    }
  }
  return undefined;
}

/** 需求拆分的产出工具。`repos` 是会话根里的 `<owner>/<repo>` 清单,打回按它判。 */
function submitRequirementBreakdownTool(options: {
  repos: readonly string[];
  send: (message: SessionWorkerMessage) => void;
}): ToolDefinition<never, never> {
  return defineTool({
    name: SUBMIT_REQUIREMENT_BREAKDOWN_TOOL,
    label: "Submit Requirement Breakdown",
    description:
      "Hand in the whole requirement breakdown in one call: the overview (your summary, your assumptions, the open questions) and every item. One item is one change inside a single repository that can go out as its own pull request. Call it once per breakdown — items written in prose are not handed in. Calling it again replaces nothing: it hands in a new version, and the earlier ones stay.",
    parameters: breakdownSchema,
    execute: async (id, params) => {
      const breakdown = normalizeRequirementBreakdown(params as RequirementBreakdown);
      const rejection = requirementBreakdownRejection(breakdown, options.repos);
      if (rejection !== undefined) {
        return { content: [{ type: "text", text: rejection }], details: {} };
      }
      options.send({
        kind: "output",
        output: { kind: "requirement-breakdown", toolCallId: id, payload: breakdown },
      });
      return { content: [{ type: "text", text: "recorded" }], details: {} };
    },
  }) as unknown as ToolDefinition<never, never>;
}

/**
 * 这个用途注册的产出工具(issue #337)。用途是会话建时定的那一格,决定工具面与产出类型
 * (CONTEXT.md 会话用途);认不出的用途回空数组,会话照常开得起来,只是交不出产出。
 */
export function sessionOutputTools(
  purpose: string,
  options: { repos: readonly string[]; send: (message: SessionWorkerMessage) => void },
): ToolDefinition<never, never>[] {
  return purpose === "requirement-breakdown" ? [submitRequirementBreakdownTool(options)] : [];
}
