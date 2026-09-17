import { CalendarIcon, ChevronDownIcon } from "@radix-ui/react-icons";
import { Popover } from "@radix-ui/themes";
import { useState, useSyncExternalStore } from "react";

import { Button } from "@/components/theme-button";
import { Calendar } from "@/components/ui/calendar";
import { localDay } from "@/lib/time";

export type DateRangeValue = Readonly<{
  from: string;
  to: string;
}>;

type DateRangePickerProps = {
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
};

/**
 * `sm` 以下的取反写法(Tailwind 的 `sm:` 是 `min-width: 640px`),与 Calendar 里
 * `sm:[--cell-size:…]` 同一个断点:窄屏日期格是 44px 触控尺寸,两个月竖着叠起来
 * 有 732px 高,比 390×844 的可用高度还大。
 */
const NARROW_SCREEN = "(max-width: 639.98px)";

function subscribeNarrowScreen(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW_SCREEN);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

/** 日历日期与 `YYYY-MM-DD` 互转时只读本地字段，避免 UTC 偏移所选日期。 */
function dayDate(day: string): Date | undefined {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (parts === null) return undefined;
  return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
}

export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const narrow = useSyncExternalStore(
    subscribeNarrowScreen,
    () => window.matchMedia(NARROW_SCREEN).matches,
    () => false,
  );
  const fromDate = dayDate(value.from);
  const fromLabel = value.from === "" ? "起始不限" : value.from;
  const toLabel = value.to === "" ? "至今" : value.to;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <Button
          variant="outline"
          color="gray"
          size="3"
          // v8 描边型控件(§7.14):白底 + 输入框描边 + 控件阴影,不是 Radix outline 默认的灰底块。
          className="min-w-0 max-w-full gap-[7px] rounded-md border border-input bg-surface px-[15px] py-[7px] text-md font-medium text-text shadow-control"
          aria-label={`选择日期范围，当前为${fromLabel}至${toLabel}`}
        >
          <CalendarIcon aria-hidden className="text-text-secondary" />
          <span className={value.from === "" ? "text-text-muted" : "font-mono"}>{fromLabel}</span>
          <span className="text-text-muted">至</span>
          <span className={value.to === "" ? "text-text-muted" : "font-mono"}>{toLabel}</span>
          <ChevronDownIcon aria-hidden className="text-text-muted" />
        </Button>
      </Popover.Trigger>
      {/*
        高度上限必须来自 Radix 自己算出的可用高度。原来写的 `100vh - space-4` 在 844px
        高的屏上是 828px,比 732px 的双月日历还大,所以 max-height 从不生效,浮层也就
        没有可滚动的溢出(`scrollHeight === clientHeight`),Popper 只能把装不下的部分
        推出视口。`--radix-popper-available-height` 由 Popper 的 size 中间件按翻转后
        的那一侧写在包裹层上,已经扣掉 collisionPadding;`.rt-PopoverContent` 自带
        `overflow: auto`,超出部分自然可滚。
        窄屏底部留出 Tab 栏的高度(44px 触控行 + 安全区),否则日历最后一行压在导航下面。
      */}
      <Popover.Content
        align="end"
        size="1"
        maxWidth="calc(100vw - var(--space-4))"
        maxHeight="var(--radix-popper-available-height)"
        collisionPadding={{ top: 10, right: 10, bottom: narrow ? 80 : 10, left: 10 }}
      >
        <Calendar
          mode="range"
          numberOfMonths={narrow ? 1 : 2}
          {...(fromDate === undefined ? {} : { defaultMonth: fromDate })}
          selected={{ from: fromDate, to: dayDate(value.to) }}
          onSelect={(range) => {
            onChange({
              from: range?.from === undefined ? "" : localDay(range.from),
              to: range?.to === undefined ? "" : localDay(range.to),
            });
          }}
        />
      </Popover.Content>
    </Popover.Root>
  );
}
