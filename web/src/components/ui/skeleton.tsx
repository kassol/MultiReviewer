import { cn } from "@/lib/utils";

/**
 * 读取中的占位块。这一档不用「读取中…」那行字:占位块保住了它替代的那块内容的
 * 尺寸与位置,数据到了不跳版;一行字会让整页在到达那一刻整体位移。
 *
 * `data-slot` 供 styles.css 里降低动效偏好的那一段关掉呼吸动画。
 */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn("animate-pulse rounded-sm bg-muted", className)}
      {...props}
    />
  );
}
