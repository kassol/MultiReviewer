/**
 * 原型专用:浮在底部的变体切换条。issue #104 的原型,不进主干。
 *
 * 视觉上刻意与面板不同(深色药丸),免得被当成被评估的设计的一部分。
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect } from "react";

export type VariantKey = string;

export function PrototypeSwitcher({
  variants,
  current,
  onChange,
  scenarios,
  scenario,
  onScenario,
}: {
  variants: readonly { key: VariantKey; name: string }[];
  current: VariantKey;
  onChange: (key: VariantKey) => void;
  scenarios: readonly { key: string; name: string }[];
  scenario: string;
  onScenario: (key: string) => void;
}) {
  const index = Math.max(
    0,
    variants.findIndex((item) => item.key === current),
  );

  function step(delta: number): void {
    const next = variants[(index + delta + variants.length) % variants.length];
    if (next !== undefined) onChange(next.key);
  }

  // 左右方向键也切;输入框聚焦时不抢。
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable === true) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-3 z-50 flex justify-center px-3">
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-1 rounded-full bg-[#1f2328] px-1.5 py-1.5 text-white shadow-lg">
        <button
          type="button"
          onClick={() => step(-1)}
          aria-label="上一个变体"
          className="flex size-7 items-center justify-center rounded-full hover:bg-white/15"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="px-1.5 text-xs font-medium whitespace-nowrap tabular-nums">
          {current} — {variants[index]?.name}
        </span>
        <button
          type="button"
          onClick={() => step(1)}
          aria-label="下一个变体"
          className="flex size-7 items-center justify-center rounded-full hover:bg-white/15"
        >
          <ChevronRight className="size-4" />
        </button>
        <span className="mx-1 h-5 w-px bg-white/25" />
        {scenarios.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => onScenario(item.key)}
            aria-pressed={item.key === scenario}
            className={
              item.key === scenario
                ? "rounded-full bg-white px-2.5 py-1 text-xs font-medium text-[#1f2328]"
                : "rounded-full px-2.5 py-1 text-xs text-white/70 hover:bg-white/15 hover:text-white"
            }
          >
            {item.name}
          </button>
        ))}
      </div>
    </div>
  );
}
