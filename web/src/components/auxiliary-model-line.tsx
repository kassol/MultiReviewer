/**
 * 「将使用：<模型标识> · <档位>（来源：…）」那一行(issue #303、#304)。基点探索、知识整理、
 * 修订意图与仓库配置弹窗共用:四处说的是同一个仓库生效的那一处辅助模型,读的也是同一个
 * 只读投影(`GET /repos/{id}/auxiliary-model`),各写一份就会在其中一处说出另一个结论。
 */
import { Text } from "@radix-ui/themes";

import {
  AUXILIARY_MODEL_SOURCE_LABEL,
  type AuxiliaryModelView,
} from "../auxiliary-model.ts";
import { THINKING_LEVEL_LABEL } from "../model-services.ts";

export function AuxiliaryModelLine({ view }: { view: AuxiliaryModelView | undefined }) {
  if (view === undefined) {
    return <Text size="2" color="gray">正在确认将使用哪个模型…</Text>;
  }
  if (view.identity === null || view.source === null || !view.available) {
    return (
      <Text size="2" color="red" role="alert">
        {view.unavailableReason ?? "这个仓库生效的辅助模型跑不了。"}
      </Text>
    );
  }
  return (
    <Text size="2" color="gray">
      将使用：<span className="font-mono">{view.identity}</span>
      {view.thinkingLevel === null
        ? null
        : ` · 思考 ${THINKING_LEVEL_LABEL[view.thinkingLevel]}`}
      （来源：{AUXILIARY_MODEL_SOURCE_LABEL[view.source]}）
    </Text>
  );
}
