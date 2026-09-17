/**
 * Agent 会话的产出工具(issue #337)。
 *
 * 底座这一侧只有一条机制:**用途 → 产出工具定义列表**(`sessionOutputTools`)。需求拆分那一件
 * 随 issue #366 退役(它现在把结果写进产品 tracker),眼下只剩产品梳理一件。
 *
 * 工具的做法与 Reviewer 的 `report_finding` 逐条对齐(`worker.ts`):枚举与格式要求写在字段
 * 自己的 `description` 里、形状宽松、服务端归一化(trim、去空项),打回走**正常返回**一句
 * 理由而不是抛工具错误——出根与白名单那种「这个会话做不到的事」才抛错,打回是「换个参数
 * 再试」的摩擦,模型看见理由就改得动。通过则经 IPC 单条回主进程,工具回 `recorded`。
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { AGENT_STATEMENT_LIMIT } from "./rule-agent.ts";

import type {
  ProductSurveyProposals,
  SessionProductKnowledge,
  SessionWorkerMessage,
} from "./session-protocol.ts";

/** 产品梳理的产出工具(CONTEXT.md 产品梳理,issue #345)。 */
export const SUBMIT_PRODUCT_SURVEY_TOOL = "submit_product_survey";

/** 去掉首尾空白,丢掉空项。模型给的列表里常有空串占位。 */
function cleanList(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value !== "");
}

const surveySchema = Type.Object({
  statements: Type.Array(
    Type.Object({
      statement: Type.String({
        description:
          "One relationship, cross-cutting convention or routing fact, written in Chinese as one sentence of about 100 characters, concrete enough to check against the code",
      }),
      repos: Type.Array(Type.String(), {
        description:
          "The repositories this statement speaks about, each exactly as <owner>/<repo>, copied from the list of this product's repositories. At least two: a fact about one repository alone belongs to that repository's own knowledge set.",
      }),
    }),
    {
      description:
        "The new product knowledge you found. Empty array when you found nothing that is not already listed in your prompt.",
    },
  ),
  retirements: Type.Array(
    Type.Object({
      id: Type.Integer({
        description:
          "The id in brackets of the product knowledge entry that no longer holds, copied from the list in your prompt",
      }),
      reason: Type.String({
        description: "Why it no longer holds, written in Chinese: what you read instead",
      }),
    }),
    {
      description:
        "The entries that no longer hold. Empty array when every entry in your prompt still holds.",
    },
  ),
});

/** 服务端归一化:陈述与理由 trim,仓库集合去空项。与 `report_finding` 同一做法。 */
export function normalizeProductSurvey(raw: ProductSurveyProposals): ProductSurveyProposals {
  return {
    statements: raw.statements.map((one) => ({
      statement: one.statement.trim(),
      repos: cleanList(one.repos),
    })),
    retirements: raw.retirements.map((one) => ({ id: one.id, reason: one.reason.trim() })),
  };
}

/**
 * 这一批提案要不要打回,要就回一句理由(spec #342 的 US 19、US 20)。
 *
 * 只回第一处,一次说一件事。`repos` 是这个产品的仓库清单,
 * `knowledge` 是提示里列过的产品知识——退役只能指向其中的一条仓库关系。
 */
export function productSurveyRejection(
  proposals: ProductSurveyProposals,
  repos: readonly string[],
  knowledge: readonly SessionProductKnowledge[],
): string | undefined {
  for (const [index, one] of proposals.statements.entries()) {
    const at = `statement ${index + 1}`;
    if (one.statement === "") return `${at} is empty; write the statement itself, in Chinese`;
    // 与知识条目的陈述同一个数(`AGENT_STATEMENT_LIMIT`):落下来就是一条仓库关系,
    // 一句说得完的事不该写成一段。
    if (one.statement.length > AGENT_STATEMENT_LIMIT) {
      return `${at} is ${one.statement.length} characters; a statement is at most ${AGENT_STATEMENT_LIMIT} characters — tighten it to one sentence`;
    }
    const outside = one.repos.find((repo) => !repos.includes(repo));
    if (outside !== undefined) {
      return `${at} names ${outside}, which is not a repository of this product; name only: ${repos.join(", ")}`;
    }
    if (new Set(one.repos).size < 2) {
      return `${at} names fewer than two repositories of this product; a product knowledge statement speaks about at least two of: ${repos.join(", ")}. A fact about one repository alone belongs to that repository's own knowledge set, not here.`;
    }
  }
  // 退役只指得动已经写下的仓库关系:梳理交的那一句就是一条仓库关系(issue #360)。
  const active = knowledge.filter((entry) => entry.kind === "relationship").map((entry) => entry.id);
  for (const [index, one] of proposals.retirements.entries()) {
    const at = `retirement ${index + 1}`;
    if (!active.includes(one.id)) {
      return active.length === 0
        ? `${at} retires entry ${one.id}, but this product has no product knowledge in force; retire nothing`
        : `${at} retires entry ${one.id}, which is not one of the entries in force; retire one of: ${active.join(", ")}`;
    }
    if (one.reason === "") return `${at} has no reason; say what you read instead, in Chinese`;
  }
  return undefined;
}

/**
 * 产品梳理的产出工具。一次调用交全:新陈述与退役各一批(spec #342 的 US 19);新陈述落成
 * 仓库关系条目,写下即生效(issue #360)。
 * `repos` 是这个产品的仓库清单(产品梳理的会话根就是产品的全部仓库),`knowledge` 是此刻
 * 生效的那些条目。
 */
function submitProductSurveyTool(options: {
  repos: readonly string[];
  knowledge: readonly SessionProductKnowledge[];
  send: (message: SessionWorkerMessage) => void;
}): ToolDefinition<never, never> {
  return defineTool({
    name: SUBMIT_PRODUCT_SURVEY_TOOL,
    label: "Submit Product Survey",
    description:
      "Hand in the whole survey in one call: every new product knowledge statement with the repositories it speaks about, and every entry that no longer holds. Each new statement speaks about at least two repositories of this product. Call it once per survey — statements written in prose are not handed in.",
    parameters: surveySchema,
    execute: async (_id, params) => {
      const proposals = normalizeProductSurvey(params as ProductSurveyProposals);
      const rejection = productSurveyRejection(proposals, options.repos, options.knowledge);
      if (rejection !== undefined) {
        return { content: [{ type: "text", text: rejection }], details: {} };
      }
      options.send({ kind: "survey", proposals });
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
  options: {
    repos: readonly string[];
    /** 此刻的产品知识(issue #345)。产品梳理的退役目标按其中的仓库关系判,别的用途用不上。 */
    knowledge: readonly SessionProductKnowledge[];
    send: (message: SessionWorkerMessage) => void;
  },
): ToolDefinition<never, never>[] {
  return purpose === "product-survey" ? [submitProductSurveyTool(options)] : [];
}
