/**
 * 原型切换条 —— 只在原型分支上存在,不进主干。
 *
 * 固定在屏幕底部中间,左右箭头循环切变体,`←` / `→` 也切(焦点在输入框里时不拦)。
 * 变体写进 URL 的 `?variant=`,刷新与分享都稳。生产构建里整个不渲染。
 */
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

export type VariantEntry = { key: string; name: string };

export function PrototypeSwitcher({
  variants,
  current,
}: {
  variants: VariantEntry[];
  current: string;
}) {
  const navigate = useNavigate();
  const index = Math.max(
    0,
    variants.findIndex((entry) => entry.key === current),
  );

  const go = (delta: number): void => {
    const next = variants[(index + delta + variants.length) % variants.length];
    if (next === undefined) return;
    void navigate({ to: "/settings", search: { variant: next.key } });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "ArrowLeft") go(-1);
      if (event.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (import.meta.env.PROD) return null;

  const entry = variants[index];

  return (
    <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-foreground px-1.5 py-1.5 text-background shadow-lg">
      <button
        type="button"
        aria-label="上一个变体"
        className="rounded-full px-2.5 py-1 hover:bg-white/15"
        onClick={() => go(-1)}
      >
        ←
      </button>
      <span className="px-2 text-sm">
        <span className="font-mono">{entry?.key}</span> — {entry?.name}
      </span>
      <button
        type="button"
        aria-label="下一个变体"
        className="rounded-full px-2.5 py-1 hover:bg-white/15"
        onClick={() => go(1)}
      >
        →
      </button>
    </div>
  );
}
