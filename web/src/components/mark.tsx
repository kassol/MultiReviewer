/**
 * 产品标记:三条错位的短线,三个模型各看同一段改动。与 index.html 里内联的
 * favicon 是同一份图形——标签页与顶栏认得出是同一个东西。
 *
 * 只出线条,线条用 `currentColor`。顶栏、登录页与改密页把标记放进自己的渐变方块里,
 * 再带一层外框就是方块套方块——外框和线条同色时整枚标记会消失。
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden focusable="false">
      <g fill="currentColor">
        <rect x="7" y="9" width="18" height="3" rx="1" />
        <rect x="7" y="14.5" width="12" height="3" rx="1" />
        <rect x="7" y="20" width="15" height="3" rx="1" />
      </g>
    </svg>
  );
}
