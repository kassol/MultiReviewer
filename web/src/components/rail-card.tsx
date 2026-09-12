import type { ReactNode } from "react";

import { CardShell } from "@/components/card-shell";

/**
 * 左栏的一张卡:一行小标题(可带计数与一个动作)加下面的内容。产品页与会话详情页的左栏
 * 共用它(原型 A 的三段式左栏,issue #332)。
 */
export function RailCard({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <CardShell className="overflow-hidden">
      <div className="flex min-h-9 items-center justify-between gap-2 px-4 pt-2.5 pb-2">
        <h2 className="flex min-w-0 items-baseline gap-2 text-base font-bold text-text-muted">
          <span className="truncate">{title}</span>
          {count === undefined ? null : (
            <span className="font-mono text-xs font-normal tabular-nums">{count}</span>
          )}
        </h2>
        {action}
      </div>
      {children}
    </CardShell>
  );
}
