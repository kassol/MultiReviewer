import * as React from "react"
import {
  DayPicker,
  getDefaultClassNames,
  type DayButton,
  type Locale,
} from "react-day-picker"
import { IconButton } from "@radix-ui/themes"

import { Button } from "@/components/theme-button"
import { cn } from "@/lib/utils"
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "@radix-ui/react-icons"

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = "label",
  buttonVariant = "ghost",
  locale,
  formatters,
  labels,
  components,
  ...props
}: React.ComponentProps<typeof DayPicker> & {
  buttonVariant?: React.ComponentProps<typeof IconButton>["variant"]
}) {
  const defaultClassNames = getDefaultClassNames()

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn(
        "group/calendar bg-background p-2 [--cell-radius:var(--radius-sm)] [--cell-size:--spacing(11)] sm:[--cell-size:--spacing(7)] in-data-[slot=card-content]:bg-transparent in-data-[slot=popover-content]:bg-transparent",
        String.raw`rtl:**:[.rdp-button\_next>svg]:rotate-180`,
        String.raw`rtl:**:[.rdp-button\_previous>svg]:rotate-180`,
        className
      )}
      captionLayout={captionLayout}
      locale={locale}
      // react-day-picker 不带中文,不给格式化就是一整块英文月份和 Su Mo Tu 星期头
      // 压在全中文的面板里。这里只改显示,不引入 date-fns 语言包换整套 locale。
      formatters={{
        formatCaption: (date) => `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`,
        formatWeekdayName: (date) => "日一二三四五六".charAt(date.getDay()),
        formatMonthDropdown: (date) => `${date.getMonth() + 1} 月`,
        ...formatters,
      }}
      labels={{
        labelPrevious: () => "上个月",
        labelNext: () => "下个月",
        ...labels,
      }}
      classNames={{
        root: cn("w-fit", defaultClassNames.root),
        months: cn(
          "relative flex flex-col gap-4 md:flex-row",
          defaultClassNames.months
        ),
        // 根是 w-fit,月份再写 w-full 就成了「父宽取决于子宽、子宽取决于父宽」,浏览器
        // 只能塌到最小内容宽度——日期格被压到装不下两位数,range 高亮跟着挤成横杠。
        // 给每个月一个由格子尺寸推出的下限,宽度就有了确定来源。
        month: cn(
          "flex w-full min-w-[calc(var(--cell-size)*7)] flex-col gap-4",
          defaultClassNames.month,
        ),
        nav: cn(
          "absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1",
          defaultClassNames.nav
        ),
        month_caption: cn(
          "flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)",
          defaultClassNames.month_caption
        ),
        dropdowns: cn(
          "flex h-(--cell-size) w-full items-center justify-center gap-1.5 text-sm font-medium",
          defaultClassNames.dropdowns
        ),
        dropdown_root: cn(
          "relative rounded-(--cell-radius)",
          defaultClassNames.dropdown_root
        ),
        dropdown: cn(
          "absolute inset-0 bg-popover opacity-0",
          defaultClassNames.dropdown
        ),
        caption_label: cn(
          "font-medium select-none",
          captionLayout === "label"
            ? "text-sm"
            : "flex items-center gap-1 rounded-(--cell-radius) text-sm [&>svg]:size-3.5 [&>svg]:text-muted-foreground",
          defaultClassNames.caption_label
        ),
        month_grid: cn("w-full border-collapse", defaultClassNames.month_grid),
        weekdays: cn("flex", defaultClassNames.weekdays),
        weekday: cn(
          "flex-1 rounded-(--cell-radius) text-base font-normal text-text-muted select-none",
          defaultClassNames.weekday
        ),
        week: cn("mt-2 flex w-full", defaultClassNames.week),
        week_number_header: cn(
          "w-(--cell-size) select-none",
          defaultClassNames.week_number_header
        ),
        week_number: cn(
          "text-base text-text-muted select-none",
          defaultClassNames.week_number
        ),
        day: cn(
          "group/day relative aspect-square h-full w-full rounded-(--cell-radius) p-0 text-center select-none [&:last-child[data-selected=true]_button]:rounded-r-(--cell-radius)",
          props.showWeekNumber
            ? "[&:nth-child(2)[data-selected=true]_button]:rounded-l-(--cell-radius)"
            : "[&:first-child[data-selected=true]_button]:rounded-l-(--cell-radius)",
          defaultClassNames.day
        ),
        range_start: cn(
          "relative isolate z-0 rounded-l-(--cell-radius) bg-accent-tint after:absolute after:inset-y-0 after:right-0 after:w-4 after:bg-accent-tint",
          defaultClassNames.range_start
        ),
        range_middle: cn("rounded-none", defaultClassNames.range_middle),
        range_end: cn(
          "relative isolate z-0 rounded-r-(--cell-radius) bg-accent-tint after:absolute after:inset-y-0 after:left-0 after:w-4 after:bg-accent-tint",
          defaultClassNames.range_end
        ),
        today: cn("rounded-(--cell-radius)", defaultClassNames.today),
        outside: cn(
          "text-muted-foreground aria-selected:text-muted-foreground",
          defaultClassNames.outside
        ),
        disabled: cn(
          "text-muted-foreground opacity-50",
          defaultClassNames.disabled
        ),
        hidden: cn("invisible", defaultClassNames.hidden),
        ...classNames,
      }}
      components={{
        Root: ({ className, rootRef, ...props }) => {
          return (
            <div
              data-slot="calendar"
              ref={rootRef}
              className={cn(className)}
              {...props}
            />
          )
        },
        Chevron: ({ className, orientation, ...props }) => {
          if (orientation === "left") {
            return (
              <ChevronLeftIcon className={cn("size-4", className)} {...props} />
            )
          }

          if (orientation === "right") {
            return (
              <ChevronRightIcon className={cn("size-4", className)} {...props} />
            )
          }

          return (
            <ChevronDownIcon className={cn("size-4", className)} {...props} />
          )
        },
        // locale 是可选的,exactOptionalPropertyTypes 下不能把 undefined 显式传进去。
        DayButton: ({ ...props }) => (
          <CalendarDayButton {...(locale === undefined ? {} : { locale })} {...props} />
        ),
        PreviousMonthButton: ({ className, children, ...buttonProps }) => (
          <IconButton
            {...buttonProps}
            variant={buttonVariant}
            color="gray"
            size="1"
            className={cn("size-(--cell-size) select-none aria-disabled:opacity-50", className)}
          >
            {children}
          </IconButton>
        ),
        NextMonthButton: ({ className, children, ...buttonProps }) => (
          <IconButton
            {...buttonProps}
            variant={buttonVariant}
            color="gray"
            size="1"
            className={cn("size-(--cell-size) select-none aria-disabled:opacity-50", className)}
          >
            {children}
          </IconButton>
        ),
        WeekNumber: ({ children, ...props }) => {
          return (
            <td {...props}>
              <div className="flex size-(--cell-size) items-center justify-center text-center">
                {children}
              </div>
            </td>
          )
        },
        ...components,
      }}
      {...props}
    />
  )
}

function CalendarDayButton({
  className,
  day,
  modifiers,
  locale,
  ...props
}: React.ComponentProps<typeof DayButton> & { locale?: Partial<Locale> }) {
  const defaultClassNames = getDefaultClassNames()

  const ref = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus()
  }, [modifiers.focused])

  return (
    <Button
      {...props}
      ref={ref}
      variant="ghost"
      color="gray"
      size="1"
      data-day={day.date.toLocaleDateString(locale?.code)}
      data-selected-single={
        modifiers.selected &&
        !modifiers.range_start &&
        !modifiers.range_end &&
        !modifiers.range_middle
      }
      data-today={modifiers.today === true && modifiers.selected !== true}
      data-range-start={modifiers.range_start}
      data-range-end={modifiers.range_end}
      data-range-middle={modifiers.range_middle}
      className={cn(
        "relative isolate z-10 flex aspect-square size-auto w-full min-w-(--cell-size) flex-col gap-1 rounded-(--cell-radius) border-0 p-0 leading-none font-normal data-[today=true]:font-semibold data-[today=true]:text-primary data-[today=true]:ring-1 data-[today=true]:ring-inset data-[today=true]:ring-accent-track group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 data-[range-end=true]:rounded-(--cell-radius) data-[range-end=true]:rounded-r-(--cell-radius) data-[range-end=true]:bg-primary data-[range-end=true]:text-white data-[range-middle=true]:rounded-none data-[range-middle=true]:bg-accent-tint data-[range-middle=true]:text-text data-[range-start=true]:rounded-(--cell-radius) data-[range-start=true]:rounded-l-(--cell-radius) data-[range-start=true]:bg-primary data-[range-start=true]:text-white data-[selected-single=true]:bg-primary data-[selected-single=true]:text-white [&>span]:text-xs [&>span]:opacity-70",
        defaultClassNames.day,
        className
      )}
    />
  )
}

export { Calendar }
