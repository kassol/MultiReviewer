import { cn } from "@/lib/utils";

/**
 * 内容轨。全部页面共用一条:不设宽度上限,只留左右边距,任何屏宽都铺满。
 * 要读的长文自己限行宽(说明文字 68ch、文章 120ch),轨道不替它们收。
 */
export function PageBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        // 底部留白比顶部厚:滚到底时最后一张卡不该贴着窗沿。
        "flex w-full min-w-0 flex-col gap-4 px-[18px] pt-6 pb-20 sm:px-7",
        className,
      )}
      {...props}
    />
  );
}
