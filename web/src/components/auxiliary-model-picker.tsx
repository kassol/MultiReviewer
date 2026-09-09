/**
 * 辅助模型那一处引用的编辑控件(CONTEXT.md 辅助模型,issue #303)。审查策略页与仓库配置
 * 弹窗共用这一份:两处读的是 `GET /model-services` 同一份候选投影、同一套档位规则,各写
 * 一份就会在其中一处漏掉「只列这个模型支持的档位」。
 *
 * **它只负责选择**,与模型组合编辑器同律:模型服务、凭据与模型目录一律回模型服务页,
 * 这里不发任何写请求。
 */
import { Badge, Select, Text } from "@radix-ui/themes";

import { HelpTooltip } from "@/components/help-tooltip";

import {
  THINKING_LEVEL_LABEL,
  useModelServices,
  type ModelRef,
  type ThinkingLevel,
} from "../model-services.ts";

/** 「不设」那一项的值。Radix `Select` 收不了空字符串。 */
const UNSET = "__unset";

export type AuxiliaryModelPickerProps = {
  /** 这份表单的前缀,同一页开两处时标签各指各的。 */
  id: string;
  value: ModelRef | null;
  onChange: (next: ModelRef | null) => void;
  /**
   * 给了就多一项「不设」,文案是它——审查策略页用它说清空着意味着什么。仓库配置弹窗不给:
   * 那一侧的「跟随全局」由段控件表达,自定义态必须选出一处。
   */
  emptyLabel?: string | undefined;
  disabled?: boolean | undefined;
};

export function AuxiliaryModelPicker({
  id,
  value,
  onChange,
  emptyLabel,
  disabled,
}: AuxiliaryModelPickerProps) {
  const query = useModelServices();
  const candidates = query.data?.candidates ?? [];
  // 已经存下、此刻却不可用的那一处照样列出来:人要看得见它才换得掉。候选还没到时也先把
  // 它列上——`Select` 的触发器只认列表里有的那一项,不列就先空着一格,读起来像没设。
  const visible = candidates.filter(
    (candidate) => candidate.available || candidate.identity === value?.identity,
  );
  const options =
    value === null || visible.some((candidate) => candidate.identity === value.identity)
      ? visible.map((candidate) => candidate.identity)
      : [value.identity, ...visible.map((candidate) => candidate.identity)];
  const picked = candidates.find((candidate) => candidate.identity === value?.identity);
  const levels = picked?.runtime.thinkingLevels ?? [];
  const reason =
    value === null || picked?.available !== false
      ? null
      : picked.unavailableReasonText ?? "模型不可用";

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
      <Text as="label" htmlFor={`${id}-model`} size="2" weight="medium">模型</Text>
      <Select.Root
        value={value?.identity ?? UNSET}
        disabled={disabled === true}
        size={{ initial: "3", sm: "2" }}
        onValueChange={(next) => {
          if (next === UNSET) return onChange(null);
          // 新选进来的模型带它自己的第一档:adaptive 模型不支持「关闭」,不带就等于选了
          // 一档它不支持的,保存时会被服务端拒。
          const first =
            candidates.find((candidate) => candidate.identity === next)?.runtime
              .thinkingLevels[0] ?? "off";
          return onChange({ identity: next, ...(first === "off" ? {} : { thinkingLevel: first }) });
        }}
      >
        <Select.Trigger id={`${id}-model`} placeholder="选择一个可用模型" className="max-sm:min-h-11" />
        <Select.Content position="popper">
          {emptyLabel === undefined ? null : (
            <Select.Item value={UNSET}>{emptyLabel}</Select.Item>
          )}
          {options.map((identity) => (
            <Select.Item key={identity} value={identity}>{identity}</Select.Item>
          ))}
        </Select.Content>
      </Select.Root>

      <div className="flex items-center gap-1">
        <Text
          as="label"
          {...(levels.length > 1 ? { htmlFor: `${id}-thinking` } : {})}
          size="2"
          weight="medium"
        >
          思考档位
        </Text>
        <HelpTooltip content="档位越高,这些 agent 想得越久,合并与知识任务也越慢越贵。" />
      </div>
      {value === null ? (
        <Text size="2" color="gray">先选模型</Text>
      ) : levels.length > 1 ? (
        // 只列这个模型支持的档位:列出它不支持的那些,运行侧会 clamp 成相邻可用档,跑的
        // 就不是人选的那一档。
        <div className="flex items-center gap-1">
          <Select.Root
            value={value.thinkingLevel ?? "off"}
            disabled={disabled === true}
            size={{ initial: "3", sm: "2" }}
            onValueChange={(next) =>
              onChange({
                identity: value.identity,
                ...(next === "off" ? {} : { thinkingLevel: next as ThinkingLevel }),
              })}
          >
            <Select.Trigger id={`${id}-thinking`} className="max-sm:min-h-11" />
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
              label={`${value.identity} 始终思考`}
              content="这个模型关不掉思考,只能选它投入多少。"
            />
          )}
        </div>
      ) : (
        <div>
          <Badge color="gray" variant="outline">不支持思考档位</Badge>
        </div>
      )}

      {reason === null ? null : (
        <p className="col-span-2 text-xs text-danger">
          {value?.identity}：{reason}。到模型服务页恢复它,或在这里换一处。
        </p>
      )}
    </div>
  );
}
