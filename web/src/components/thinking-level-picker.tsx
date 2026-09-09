/**
 * 一处模型引用的思考档位控件(CONTEXT.md 思考档位,issue #213、#303)。模型组合编辑器与
 * 辅助模型控件共用这一份:只列这个模型支持的那几档、只有「关闭」一档时换成 Badge、这个
 * 模型关不掉思考时挂一句说明。各写一份就会在其中一处列出它不支持的档位,运行侧会 clamp
 * 成相邻可用档,跑的就不是人选的那一档。
 */
import { Badge, Select } from "@radix-ui/themes";

import { HelpTooltip } from "@/components/help-tooltip";

import { THINKING_LEVEL_LABEL, type ThinkingLevel } from "../model-services.ts";

export type ThinkingLevelPickerProps = {
  /** 这个模型支持的那几档。只有一档(只剩「关闭」)即不给选,改成 Badge。 */
  levels: readonly ThinkingLevel[];
  value: ThinkingLevel;
  onChange: (next: ThinkingLevel) => void;
  /** 「始终思考」那句说明指名的是哪一处模型。 */
  identity: string;
  size: NonNullable<React.ComponentProps<typeof Select.Root>["size"]>;
  /** 调用页自己那个标签的 `htmlFor` 指向它;不给就靠 `ariaLabel` 认。 */
  triggerId?: string | undefined;
  ariaLabel?: string | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
};

export function ThinkingLevelPicker({
  levels,
  value,
  onChange,
  identity,
  size,
  triggerId,
  ariaLabel,
  placeholder,
  disabled,
}: ThinkingLevelPickerProps) {
  if (levels.length <= 1) {
    return (
      <div>
        <Badge color="gray" variant="outline">不支持思考档位</Badge>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <Select.Root
        value={value}
        disabled={disabled === true}
        size={size}
        onValueChange={(next) => onChange(next as ThinkingLevel)}
      >
        <Select.Trigger
          {...(triggerId === undefined ? {} : { id: triggerId })}
          {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
          {...(placeholder === undefined ? {} : { placeholder })}
          className="max-sm:min-h-11"
        />
        <Select.Content position="popper">
          {levels.map((level) => (
            <Select.Item key={level} value={level}>
              思考 {THINKING_LEVEL_LABEL[level]}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
      {levels.includes("off") ? null : (
        <HelpTooltip
          label={`${identity} 始终思考`}
          content="这个模型关不掉思考,只能选它投入多少。"
        />
      )}
    </div>
  );
}
