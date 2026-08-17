import type { ReactNode } from "react";

/**
 * 页头。五个页面共用同一条:左边是这一页叫什么、干什么,右边是这一页当下需要的
 * 那一个东西(注册按钮、时间窗、总处置率)。
 *
 * 它替掉了原来常驻顶部的那条汇总数字带。那条带子在每一页都摆同一串百分比,而人在
 * 「配凭据」这类页面上并不需要它;真正每页都要的是「我在哪一页、这一页能干什么」。
 *
 * 粘在滚动容器顶上:长列表往下滚时页名与主动作不该消失。
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
    <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-chrome px-5 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {description === undefined ? null : (
          // 说明文字压在 68ch 以内:再宽读者的眼睛要横跨整屏才回到行首。
          <p className="max-w-[68ch] text-muted-foreground">{description}</p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
