import { CalendarIcon, ChevronDownIcon } from "@radix-ui/react-icons";
import { Popover } from "@radix-ui/themes";
import { useState } from "react";

import { Button } from "@/components/theme-button";
import { Calendar } from "@/components/ui/calendar";

export type DateRangeValue = Readonly<{
  from: string;
  to: string;
}>;

type DateRangePickerProps = {
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
};

/** 日历日期与 `YYYY-MM-DD` 互转时只读本地字段，避免 UTC 偏移所选日期。 */
function dayString(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function dayDate(day: string): Date | undefined {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (parts === null) return undefined;
  return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
}

export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
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
      <Popover.Content
        align="end"
        size="1"
        maxWidth="calc(100vw - var(--space-4))"
        maxHeight="calc(100vh - var(--space-4))"
        className="overflow-auto"
      >
        <Calendar
          mode="range"
          numberOfMonths={2}
          {...(fromDate === undefined ? {} : { defaultMonth: fromDate })}
          selected={{ from: fromDate, to: dayDate(value.to) }}
          onSelect={(range) => {
            onChange({
              from: range?.from === undefined ? "" : dayString(range.from),
              to: range?.to === undefined ? "" : dayString(range.to),
            });
          }}
        />
      </Popover.Content>
    </Popover.Root>
  );
}
