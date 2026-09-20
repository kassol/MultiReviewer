import type { ReactNode } from "react";

/**
 * 页头。页名由顶栏面包屑常驻显示,这里的标题默认只留给读屏(`sr-only` 的 h1),
 * 屏幕上只画这一页当下需要的那一行:说明在左,动作(注册按钮、时间窗、总处置率)在右。
 * 两样都没有时整行不画。
 *
 * `visibleTitle` 只给标题本身是内容的页面用——阶段详情的阶段名不在面包屑里。那时
 * 标题走 Display 字体栈:25px 往上 SF Pro Display 的字腔比 Text 舒展。
 *
 * 它随内容一起滚,不粘顶。
 */
export function PageHeader({
  title,
  description,
  actions,
  visibleTitle = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  visibleTitle?: boolean;
}) {
  // 绝对定位的 sr-only 不参与父级 flex 的 gap,空页头因此不占一格间距。
  if (!visibleTitle && description === undefined && actions === undefined) {
    return <h1 className="sr-only">{title}</h1>;
  }
  return (
    <header
      className={`flex flex-wrap justify-between gap-x-5 gap-y-2 ${visibleTitle ? "items-end" : "items-center"}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <h1
          className={
            visibleTitle
              ? "font-display text-5xl font-extrabold tracking-[-0.022em] text-balance"
              : "sr-only"
          }
        >
          {title}
        </h1>
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
