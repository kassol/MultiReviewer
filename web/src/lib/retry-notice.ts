/**
 * Pi 自动重试那一行的文案(会话页的流式区)。形状与服务端瞬时帧里的 `retry` 一格相同;
 * 错误原文不进这句话,由调用方放进 `title`。
 */
export type LiveRetry = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
};

/** 「模型服务暂时出错，第 2/10 次重试，约 4 秒后再试」。等待不足一秒按一秒说。 */
export function retryNotice(retry: Pick<LiveRetry, "attempt" | "maxAttempts" | "delayMs">): string {
  const seconds = Math.max(1, Math.ceil(retry.delayMs / 1000));
  return `模型服务暂时出错，第 ${retry.attempt}/${retry.maxAttempts} 次重试，约 ${seconds} 秒后再试`;
}

/**
 * 从瞬时帧的 payload 读重试那一格:`undefined` 即这一帧没说重试,`null` 即重试已落定,
 * 对象即一轮重试正排着。形状不对的按没说处理——后端改了字段不该让面板白屏。
 */
export function readRetry(payload: unknown): LiveRetry | null | undefined {
  if (typeof payload !== "object" || payload === null || !("retry" in payload)) return undefined;
  const retry = (payload as { retry: unknown }).retry;
  if (retry === null) return null;
  if (typeof retry !== "object") return undefined;
  const { attempt, maxAttempts, delayMs, errorMessage } = retry as Record<string, unknown>;
  if (
    typeof attempt !== "number" ||
    typeof maxAttempts !== "number" ||
    typeof delayMs !== "number" ||
    typeof errorMessage !== "string"
  ) {
    return undefined;
  }
  return { attempt, maxAttempts, delayMs, errorMessage };
}
