/**
 * 产品标记:三条错位的短线,三个模型各看同一段改动。与 index.html 里内联的
 * favicon 是同一份图形——标签页与侧栏认得出是同一个东西。
 *
 * 外框用 `currentColor` 上色,内部线条沿用主操作前景色。
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden focusable="false">
      <rect width="32" height="32" rx="6" fill="currentColor" />
      <g fill="var(--primary-foreground)">
        <rect x="7" y="9" width="18" height="3" rx="1" />
        <rect x="7" y="14.5" width="12" height="3" rx="1" />
        <rect x="7" y="20" width="15" height="3" rx="1" />
      </g>
    </svg>
  );
}
