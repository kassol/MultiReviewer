/**
 * 产品标记:三条错位的短线,三个模型各看同一段改动。与 index.html 里内联的
 * favicon 是同一份图形——标签页与侧栏认得出是同一个东西。
 *
 * 用 `currentColor` 上色,所以放在哪一层底色上都跟着那层的文字色走。
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden fill="currentColor">
      <rect x="1" y="1" width="30" height="30" rx="2" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <rect x="8" y="9.5" width="16" height="3" rx="1.5" />
      <rect x="8" y="14.5" width="10" height="3" rx="1.5" />
      <rect x="8" y="19.5" width="13" height="3" rx="1.5" />
    </svg>
  );
}
