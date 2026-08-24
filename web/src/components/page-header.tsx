import type { ReactNode } from "react";

/**
 * 页头。左边是这一页叫什么、干什么,右边是这一页当下需要的那一个东西(注册按钮、
 * 时间窗、总处置率)。
 *
 * 它随内容一起滚,不粘顶:顶栏已经常驻显示当前页名,再粘一条页头就是两层重复的
 * 页名压掉本来就紧张的垂直空间。主动作跟着滚走是这个取舍的代价——长列表页把主
 * 动作再放一份在工具行里。
 *
 * 标题走 Display 字体栈:25px 往上 SF Pro Display 的字腔比 Text 舒展,这是设计稿
 * 里唯一区分两套字体栈的尺寸线。
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-5 gap-y-2">
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <h1 className="font-display text-5xl font-extrabold tracking-[-0.022em] text-balance">{title}</h1>
        {description === undefined ? null : (
          // 说明文字压在 68ch 以内:再宽读者的眼睛要横跨整屏才回到行首。
          <p className="max-w-[68ch] text-base text-text-muted text-pretty">{description}</p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2.5 max-sm:w-full">
          {actions}
        </div>
      )}
    </header>
  );
}
