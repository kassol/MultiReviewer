import * as React from "react";
import { QuestionMarkCircledIcon } from "@radix-ui/react-icons";
import { IconButton, Popover, Text, Tooltip } from "@radix-ui/themes";

import { cn } from "@/lib/utils";

type HelpTooltipProps = {
  content: React.ReactNode;
  label?: string;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
};

const coarsePointerQuery = window.matchMedia("(pointer: coarse)");

function subscribeCoarsePointer(onChange: () => void) {
  coarsePointerQuery.addEventListener("change", onChange);
  return () => coarsePointerQuery.removeEventListener("change", onChange);
}

/**
 * 输入方式会变(平板接上鼠标、笔记本合盖翻成平板),所以订阅这条查询而不是只读一次。
 */
function useCoarsePointer() {
  return React.useSyncExternalStore(subscribeCoarsePointer, () => coarsePointerQuery.matches);
}

export function HelpTooltip({
  content,
  label = "查看说明",
  side = "top",
  className,
}: HelpTooltipProps) {
  const coarsePointer = useCoarsePointer();
  const trigger = (
    <IconButton
      type="button"
      aria-label={label}
      size="1"
      variant="ghost"
      color="gray"
      radius="full"
      className={cn("shrink-0 max-sm:min-h-11 max-sm:min-w-11", className)}
    >
      <QuestionMarkCircledIcon aria-hidden="true" />
    </IconButton>
  );

  /*
   * Tooltip 只认 hover 与键盘焦点,触屏上点一下什么都不出,帮助文字因此在手机上读不到
   * (issue #374)。粗指针改成点按打开的 Popover,细指针保持原来的悬停提示。
   */
  if (coarsePointer) {
    return (
      <Popover.Root>
        <Popover.Trigger>{trigger}</Popover.Trigger>
        <Popover.Content side={side} size="1" maxWidth="min(18rem, calc(100vw - 16px))">
          <Text as="p" size="2">
            {content}
          </Text>
        </Popover.Content>
      </Popover.Root>
    );
  }

  return (
    <Tooltip content={content} side={side} delayDuration={300} maxWidth="18rem">
      {trigger}
    </Tooltip>
  );
}
