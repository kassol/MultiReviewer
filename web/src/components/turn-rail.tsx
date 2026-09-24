import { useState } from "react";

import type { TurnOutline } from "@/lib/turn-outline";
import { cn } from "@/lib/utils";

/** 刻度长度按离焦点(悬停的那一根,没有就是当前轮)的距离收短,焦点附近像放大镜一样鼓起来。 */
const TICK_WIDTHS = [28, 20, 15, 12] as const;
const TICK_REST = 10;

/**
 * 对话流左侧的轮次导航(仿 Codex):一轮一根刻度,正在读的那一轮最长、最深。指到或键盘聚焦
 * 一根刻度,右侧浮出这一轮的问题与回复开头;点它滚到那一轮。
 *
 * 只在对话列两侧留得出空白时出现(外层 `@container` 宽 ≥ 1048px,即 920px 的对话列加两侧
 * 64px):窄了它会压在正文上。卡片 `pointer-events-none`,它只是预览,不挡对话流的点击。
 */
export function TurnRail({
  turns,
  active,
  onJump,
}: {
  turns: readonly TurnOutline[];
  active: number;
  onJump: (seq: number) => void;
}) {
  const [focus, setFocus] = useState<number | null>(null);
  const [cardTop, setCardTop] = useState(0);
  const anchor = focus ?? active;
  const aim = (index: number, button: HTMLElement): void => {
    setFocus(index);
    setCardTop(button.offsetTop + button.offsetHeight / 2);
  };
  const shown = focus === null ? undefined : turns[focus];

  return (
    <nav
      aria-label="轮次导航"
      className="absolute top-1/2 left-4 z-10 hidden max-h-[calc(100%-2rem)] -translate-y-1/2 flex-col @min-[1048px]:flex"
      onMouseLeave={() => setFocus(null)}
    >
      {turns.map((turn, index) => (
        <button
          key={turn.seq}
          type="button"
          aria-label={`第 ${index + 1} 轮:${turn.question}`}
          aria-current={index === active ? "location" : undefined}
          className="group flex h-5 min-h-1 w-10 shrink items-center focus-visible:outline-none"
          onMouseEnter={(event) => aim(index, event.currentTarget)}
          onFocus={(event) => aim(index, event.currentTarget)}
          onBlur={() => setFocus(null)}
          onClick={() => onJump(turn.seq)}
        >
          <span
            aria-hidden
            style={{ width: TICK_WIDTHS[Math.abs(index - anchor)] ?? TICK_REST }}
            className={cn(
              "h-0.5 rounded-full transition-[width,background-color] duration-150 ease-out motion-reduce:transition-none group-focus-visible:bg-accent",
              index === active ? "bg-text" : index === focus ? "bg-text-secondary" : "bg-text-faint",
            )}
          />
        </button>
      ))}
      {shown === undefined ? null : (
        <div
          aria-hidden
          style={{ top: cardTop }}
          className="pointer-events-none absolute left-full ml-1 w-80 -translate-y-1/2 rounded-2xl border border-card-line bg-surface px-4 py-3 shadow-overlay"
        >
          <p className="truncate text-md font-semibold text-text">{shown.question}</p>
          <p className="mt-1 line-clamp-3 text-base text-text-muted">
            {shown.summary ?? "这一轮还没有回复"}
          </p>
        </div>
      )}
    </nav>
  );
}
