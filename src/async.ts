/**
 * 异步化过渡期的两件小工具(issue #459,spec #445 的扩张那一步)。
 *
 * 持久化分两步搬:先把 Store 的签名与事务接口扩成异步(SQL 不动、底下仍是
 * `node:sqlite`),再换 Drizzle 与 PostgreSQL。这期间同一段代码既要接得住同步回调
 * (今天的调用点)也要接得住异步回调(迁完的调用点),判一次再决定要不要等。
 *
 * 收缩那一步(#449)之后同步那一路没有了,这个文件跟着删。
 */

/** 这个值要不要等。`await` 认的就是这个判据。 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null | undefined)?.then === "function";
}

/**
 * 跑一段同步或异步的活:拿到值交给 `done`,出错交给 `onError`。同步那一路当场跑完并
 * 返回结果,异步那一路返回一个跟着它的 Promise——调用方据此把后续动作排在它后面,
 * 顺序不乱。
 *
 * `done` 自己抛的错同样走 `onError`:两段是一件事的两半(落库加广播),原先写成一个
 * try 包住两句,那个口径在这里保留,同步与异步两路也因此一致。
 */
export function relay<T, R>(
  run: () => T | PromiseLike<T>,
  done: (value: T) => R,
  onError: (error: unknown) => R,
): R | Promise<R> {
  try {
    const result = run();
    return isThenable(result)
      ? Promise.resolve(result as PromiseLike<T>).then(done).catch(onError)
      : done(result as T);
  } catch (error) {
    return onError(error);
  }
}
