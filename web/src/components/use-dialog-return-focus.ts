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
