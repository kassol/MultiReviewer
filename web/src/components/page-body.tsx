import { cn } from "@/lib/utils";

/**
 * 内容区宽度。列表与看板页用 wide,表单与矩阵页用 form——设计稿里两类页面的正文
 * 列宽本来就不同,窄一档能让长表单的标签和输入不至于横跨整屏。
 */
const WIDTH = {
  wide: "max-w-[1240px]",
  form: "max-w-[1080px]",
} as const;

export function PageBody({
  width = "wide",
  className,
  ...props
}: React.ComponentProps<"div"> & { width?: keyof typeof WIDTH }) {
  return (
    <div
      className={cn(
        // 底部留白比顶部厚:滚到底时最后一张卡不该贴着窗沿。
        "mx-auto flex w-full min-w-0 flex-col gap-4 px-[18px] pt-6 pb-20 sm:px-7",
        WIDTH[width],
        className,
      )}
      {...props}
    />
  );
}
