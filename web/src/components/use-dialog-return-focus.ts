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
  const triggerHrefRef = useRef<string | null>(null);

  const captureTrigger = useCallback((event: TriggerEvent): void => {
    triggerRef.current = event.currentTarget;
    triggerHrefRef.current = event.currentTarget instanceof HTMLAnchorElement
      ? event.currentTarget.getAttribute("href")
      : null;
  }, []);

  const captureBubblingLink = useCallback((event: BubblingTriggerEvent): void => {
    if (!(event.target instanceof Element)) return;
    const trigger = event.target.closest<HTMLAnchorElement>("a[href]");
    triggerRef.current = trigger;
    triggerHrefRef.current = trigger?.getAttribute("href") ?? null;
  }, []);

  const restoreFocus = useCallback((): void => {
    const trigger = triggerRef.current;
    const triggerHref = triggerHrefRef.current;
    triggerRef.current = null;
    triggerHrefRef.current = null;
    requestAnimationFrame(() => {
      const replacement = triggerHref === null
        ? null
        : [...document.querySelectorAll<HTMLElement>("a[href]")]
            .find((candidate) => candidate.getAttribute("href") === triggerHref) ?? null;
      const target = canReceiveFocus(trigger)
        ? trigger
        : canReceiveFocus(replacement)
          ? replacement
          : fallback?.() ?? null;
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
