/**
 * 产品标记:三条错位的短线,三个模型各看同一段改动。与 index.html 里内联的
 * favicon 是同一份图形——标签页与顶栏认得出是同一个东西。
 *
 * 两种用法:
 * - `framed`(默认):自带 `currentColor` 圆角外框,线条用主操作前景色。favicon 与
 *   任何需要一枚完整标记的地方用它。
 * - `framed={false}`:只出线条,线条改用 `currentColor`。顶栏与登录页把标记放进自己
 *   的渐变方块里,再带一层外框就是方块套方块——外框和线条同色时整枚标记会消失。
 */
export function Mark({ className, framed = true }: { className?: string; framed?: boolean }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden focusable="false">
      {framed ? <rect width="32" height="32" rx="6" fill="currentColor" /> : null}
      <g fill={framed ? "var(--primary-foreground)" : "currentColor"}>
        <rect x="7" y="9" width="18" height="3" rx="1" />
        <rect x="7" y="14.5" width="12" height="3" rx="1" />
        <rect x="7" y="20" width="15" height="3" rx="1" />
      </g>
    </svg>
  );
}
