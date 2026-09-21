/**
 * 面板读请求的重试判据(issue #440)。404 / 403 / 409 这类 4xx 是服务端给出的结论,
 * 重试多少次结果都一样,只会让人先对着骨架等上几秒(三次指数退避约 7 秒)才看到错误态;
 * 5xx 与网络错误才可能下一次就好,保留 React Query 默认的三次。
 *
 * `failureCount` 是 React Query 传进来的「此前已失败的次数」,第一次失败时是 0,
 * 因此 `< 3` 与默认的 `retry: 3` 是同一个上限。状态码由 `fetchJson` 挂在 Error 上;
 * 拿不到状态码的(网络错误、别处抛的)按可重试处理。
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) return false;
  return failureCount < 3;
}
