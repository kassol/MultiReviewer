import * as React from "react";
import { QuestionMarkCircledIcon } from "@radix-ui/react-icons";
import { IconButton, Tooltip } from "@radix-ui/themes";

import { cn } from "@/lib/utils";

type HelpTooltipProps = {
  content: React.ReactNode;
  label?: string;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
};

export function HelpTooltip({
  content,
  label = "查看说明",
  side = "top",
  className,
}: HelpTooltipProps) {
  return (
    <Tooltip content={content} side={side} delayDuration={300} maxWidth="18rem">
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
    </Tooltip>
  );
}
