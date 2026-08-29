import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * 卡壳。Themes 的 Card 把圆角画在伪元素上,而这套设计的卡片圆角随视口在 14 / 12 之间
 * 换档,只改根元素的话边框与底色的圆角会错开;列表卡还要求零内边距加逐行分隔。所以
 * 壳走 utility + 令牌,壳里的通用件(徽章、输入、按钮、骨架)仍是 Themes 组件。
 */
export function CardShell({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col rounded-xl border border-card-line bg-surface shadow-card sm:rounded-lg",
        className,
      )}
      {...props}
    />
  );
}
