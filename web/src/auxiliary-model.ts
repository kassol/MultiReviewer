/**
 * 生效辅助模型的只读投影(CONTEXT.md 辅助模型,issue #303)。仓库配置弹窗与知识集弹窗都
 * 读这一份:解析在服务端那一处函数里(仓库覆盖 ?? 全局 ?? 生效模型组合第一个),面板不
 * 自己算一遍,也因此两处显示的一定是同一个结论。
 */
import { useQuery } from "@tanstack/react-query";

import { fetchJson } from "./api.ts";
import type { ThinkingLevel } from "./model-services.ts";

export type AuxiliaryModelSource = "repo" | "global" | "first-reviewer";

export type AuxiliaryModelView = {
  /** 生效的模型标识,三处都给不出即 null。 */
  identity: string | null;
  thinkingLevel: ThinkingLevel | null;
  source: AuxiliaryModelSource | null;
  /** 此刻跑不跑得起来。跑不了时发起按钮禁用。 */
  available: boolean;
  /** 跑不了或选不出的原因,那句话里说得出去哪里改。 */
  unavailableReason: string | null;
};

/** 来源那三档的说法。仓库配置弹窗与发起表单用的是同一套词。 */
export const AUXILIARY_MODEL_SOURCE_LABEL: Record<AuxiliaryModelSource, string> = {
  repo: "仓库覆盖",
  global: "全局",
  "first-reviewer": "模型组合第一个",
};

export function useAuxiliaryModel(repoId: number) {
  return useQuery({
    queryKey: ["repo-auxiliary-model", repoId],
    queryFn: () => fetchJson<AuxiliaryModelView>(`/repos/${repoId}/auxiliary-model`),
  });
}
