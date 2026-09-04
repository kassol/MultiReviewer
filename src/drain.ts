/**
 * 排空状态(issue #249)。
 *
 * 进程收到 SIGTERM / SIGINT 后不再接新活:投递与重跑当场回绝,已开跑的轮次跑完当前
 * 批次、落库,再停在没有结束时间的状态——批次是恢复粒度(ADR 0024),停在批次边界的
 * 那些由下一次启动续跑(issue #248)。
 *
 * 状态是可注入的对象而不是模块级单例:信号只在 `main.ts` 那一处接线,测试因此不必给
 * 自己发信号,把「开始排空」当普通调用即可。
 */
export type Drain = {
  /** 已经开始排空。投递、重跑与批次取号线都据此止步。 */
  draining(): boolean;
  /** 进入排空。重复调用没有额外作用。 */
  begin(): void;
  /** 登记一轮在跑,返回它到达可退出点时调用的句柄。重复调用同一个句柄只算一次。 */
  enter(label: string): () => void;
  /**
   * 等到没有在跑的轮次,或等到上限。返回到上限时仍没停下的那些轮次标签——它们就是这次
   * 退出放弃的轮次,交给下一次启动续跑或改判。没有在跑的轮次时立即返回空数组。
   */
  settle(timeoutMs: number): Promise<readonly string[]>;
};

export function createDrain(): Drain {
  let draining = false;
  let nextId = 0;
  const active = new Map<number, string>();
  const waiters = new Set<() => void>();
  return {
    draining: () => draining,
    begin: () => {
      draining = true;
    },
    enter(label) {
      const id = nextId++;
      active.set(id, label);
      return () => {
        if (!active.delete(id)) return;
        if (active.size > 0) return;
        for (const wake of [...waiters]) wake();
      };
    },
    async settle(timeoutMs) {
      if (active.size > 0) {
        await new Promise<void>((resolve) => {
          const wake = (): void => {
            clearTimeout(timer);
            waiters.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, timeoutMs);
          waiters.add(wake);
        });
      }
      return [...active.values()];
    },
  };
}
