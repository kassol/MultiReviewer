import { useCallback, useRef } from "react";

type TriggerEvent = { currentTarget: HTMLElement };
type BubblingTriggerEvent = { target: EventTarget | null };
type CloseAutoFocusEvent = { preventDefault: () => void };

function canReceiveFocus(element: HTMLElement | null): element is HTMLElement {
  if (element === null || !element.isConnected || element.getAttribute("aria-disabled") === "true") {
    return false;
  }
  return !(element instanceof HTMLButtonElement && element.disabled);
}

/** 受控浮层在触发事件发生时记录焦点来源，并在关闭后显式恢复。 */
export function useDialogReturnFocus(fallback?: () => HTMLElement | null) {
  const triggerRef = useRef<HTMLElement | null>(null);

  const captureTrigger = useCallback((event: TriggerEvent): void => {
    triggerRef.current = event.currentTarget;
  }, []);

  const captureBubblingLink = useCallback((event: BubblingTriggerEvent): void => {
    if (!(event.target instanceof Element)) return;
    triggerRef.current = event.target.closest<HTMLElement>("a[href]");
  }, []);

  const restoreFocus = useCallback((): void => {
    const trigger = triggerRef.current;
    triggerRef.current = null;
    requestAnimationFrame(() => {
      const target = canReceiveFocus(trigger) ? trigger : fallback?.() ?? null;
      if (canReceiveFocus(target)) target.focus({ preventScroll: true });
    });
  }, [fallback]);

  const onCloseAutoFocus = useCallback((event: CloseAutoFocusEvent): void => {
    event.preventDefault();
    restoreFocus();
  }, [restoreFocus]);

  return { captureTrigger, captureBubblingLink, onCloseAutoFocus, restoreFocus };
}

/**
 * 当前可见的导航激活项,作为弹窗关闭时的后备焦点入口。
 *
 * 桌面顶栏导航与移动端底部 Tab 栏同时在 DOM 里,只靠 CSS 断点显隐,所以
 * `[aria-current='page']` 会命中两个,而 `focus()` 对 `display: none` 的那个静默无效
 * ——焦点会直接丢在 body 上。这里挑真正占位的那一个。
 */
export function visibleNavCurrentItem(): HTMLElement | null {
  const items = document.querySelectorAll<HTMLElement>(
    "nav[aria-label='面板导航'] [aria-current='page']",
  );
  for (const item of items) {
    if (item.getClientRects().length > 0) return item;
  }
  return null;
}
