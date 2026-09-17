/**
 * Agent 会话的产出工具(issue #337)。
 *
 * 底座这一侧只有一条机制:**用途 → 产出工具定义列表**(`sessionOutputTools`)。需求拆分那一件
 * 随 issue #366 退役(它现在把结果写进产品 tracker),产品梳理改成访谈之后交的只有「谈完了」
 * 这一格(issue #365),所以它只是一处按用途分发;写代码类用途接入时在那里多一档。
 *
 * 工具的做法与 Reviewer 的 `report_finding` 逐条对齐(`worker.ts`):枚举与格式要求写在字段
 * 自己的 `description` 里、形状宽松、服务端归一化(trim、去空项),打回走**正常返回**一句
 * 理由而不是抛工具错误——出根与白名单那种「这个会话做不到的事」才抛错,打回是「换个参数
 * 再试」的摩擦,模型看见理由就改得动。通过则经 IPC 单条回主进程,工具回 `recorded`。
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { SessionWorkerMessage } from "./session-protocol.ts";

/**
 * 产品梳理的完成工具(CONTEXT.md 产品梳理,issue #365)。
 *
 * 访谈这一版没有「交卷」:每一个答案当场经 `write_knowledge` 落成条目,写下即生效。剩下要
 * 表达的只有一件事——**问不出新东西了**。收尾句判定不了这件事(一段话既可能是宣告共识,
 * 也可能是这一轮的小结),因此给它一件工具:调到即记下完成时刻,同一个产品的下一场梳理
 * 才开得起来。
 *
 * 没有参数、不打回:这一格是布尔的,判什么都没有意义。会话本身照旧读得到、续得了。
 */
export const COMPLETE_SURVEY_TOOL = "complete_survey";

function completeSurveyTool(options: {
  send: (message: SessionWorkerMessage) => void;
}): ToolDefinition<never, never> {
  return defineTool({
    name: COMPLETE_SURVEY_TOOL,
    label: "Complete Survey",
    description:
      "Mark this survey complete. Call it when the frontier is empty: everything you and the person settled is already written into product knowledge, and there is no question left whose answer would change an entry. Until you call it, this product cannot start another survey. The session stays readable and the person can keep talking to you after it.",
    parameters: Type.Object({}),
    execute: async () => {
      options.send({ kind: "survey-complete" });
      return {
        content: [
          {
            type: "text",
            text: "recorded. Say in one or two sentences what this product now has written down, and stop there.",
          },
        ],
        details: {},
      };
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
    send: (message: SessionWorkerMessage) => void;
  },
): ToolDefinition<never, never>[] {
  return purpose === "product-survey" ? [completeSurveyTool(options)] : [];
}
