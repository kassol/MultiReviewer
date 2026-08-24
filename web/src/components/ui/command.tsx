import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { MagnifyingGlassIcon } from "@radix-ui/react-icons"

import { cn } from "@/lib/utils"

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-[var(--radius-2)] bg-[var(--color-panel-solid)] text-[var(--gray-12)]",
        className
      )}
      {...props}
    />
  )
}

function CommandInput({
  className,
  "aria-label": ariaLabel = "搜索选项",
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-9 items-center gap-2 border-b border-[var(--gray-6)] px-3"
    >
      <MagnifyingGlassIcon className="size-4 shrink-0 text-[var(--gray-10)]" aria-hidden />
      <CommandPrimitive.Input
        data-slot="command-input"
        aria-label={ariaLabel}
        className={cn(
          // 不画焦点框:这个输入框所在的弹层一打开焦点就落在它身上,它也是层里唯一能
          // 输入的地方。再套一圈 2px 实线,那圈线会贴着文字边缘,把搜索框framed成一个
          // 报错似的高亮块。
          "flex h-9 w-full bg-transparent outline-none placeholder:text-text-disabled disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    </div>
  )
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto",
        className
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-[var(--gray-11)]"
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-[var(--gray-12)] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[var(--gray-11)]",
        className
      )}
      {...props}
    />
  )
}

function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-[var(--radius-2)] px-2 py-1.5 outline-none select-none max-sm:min-h-11 data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-fill data-[selected=true]:text-text [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
}
