import { useCallback, useSyncExternalStore } from "react";

/**
 * 订阅一条 CSS 媒体查询。输入方式与视口都会在运行中变(平板接上鼠标、笔记本合盖翻成
 * 平板、桌面拖窄窗口),所以订阅而不是只读一次。
 *
 * `matchMedia` 惰性取:模块顶层调用会在导入时就碰 `window`,这份代码因此只能在浏览器
 * 里被导入。服务端快照返回 `false`——没有视口就没有命中,由客户端补一次渲染。
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => {
        list.removeEventListener("change", onChange);
      };
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
