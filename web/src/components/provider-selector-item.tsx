import { Slot } from "radix-ui";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactElement, ReactNode } from "react";

import { cn } from "@/lib/utils";

type ProviderSelectorItemCommonProps = {
  selected: boolean;
  className?: string;
  children: ReactNode;
};

type ProviderSelectorItemLinkProps = ProviderSelectorItemCommonProps & {
  /** Link 自己持有路由与点击行为，产品组件只合并表面和 aria-current。 */
  asChild: true;
};

type ProviderSelectorItemButtonProps = ProviderSelectorItemCommonProps &
  Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "aria-current" | "aria-pressed" | "children" | "className"
  > & {
    asChild?: false;
  };

type ProviderSelectorItemTextProps = HTMLAttributes<HTMLElement> & {
  asChild?: boolean;
  tone?: "muted" | "danger";
  children: ReactNode;
};

/**
 * Provider 单选的唯一交互表面。路由项使用 asChild + Link，页内选择直接使用 button。
 */
function providerSelectorItemClassName(
  selected: boolean,
  className: string | undefined,
  disabled = false,
): string {
  return cn(
    "relative w-full text-left transition-colors focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--provider-selector-focus)]",
    selected
      ? "bg-[var(--selection-solid)] text-[var(--selection-solid-text)] [--provider-selector-danger:var(--selection-solid-danger-text)] [--provider-selector-focus:var(--selection-solid-text)] [--provider-selector-muted:var(--selection-solid-muted-text)] hover:bg-[var(--selection-solid-hover)]"
      : "text-[var(--text-primary)] [--provider-selector-danger:var(--red-11)] [--provider-selector-focus:var(--selection-solid)] [--provider-selector-muted:var(--text-secondary)] hover:bg-[var(--gray-3)]",
    disabled && "cursor-not-allowed opacity-60",
    className,
  );
}

export function ProviderSelectorItem(props: ProviderSelectorItemLinkProps): ReactElement;
export function ProviderSelectorItem(props: ProviderSelectorItemButtonProps): ReactElement;
export function ProviderSelectorItem(
  props: ProviderSelectorItemLinkProps | ProviderSelectorItemButtonProps,
): ReactElement {
  if (props.asChild) {
    const { selected, className, children } = props;
    return <Slot.Root
      aria-current={selected ? "page" : undefined}
      data-selected={selected ? "true" : "false"}
      data-slot="provider-selector-item"
      className={providerSelectorItemClassName(selected, className)}
    >
      {children}
    </Slot.Root>;
  }

  const { selected, className, children, disabled, type = "button", ...buttonProps } = props;

  return (
    <button
      {...buttonProps}
      type={type}
      disabled={disabled}
      aria-pressed={selected}
      data-selected={selected ? "true" : "false"}
      data-slot="provider-selector-item"
      className={providerSelectorItemClassName(selected, className, disabled)}
    >
      {children}
    </button>
  );
}

/** Provider 项内随深浅表面切换对比度的辅助文字或异常文字。 */
export function ProviderSelectorItemText({
  asChild = false,
  tone = "muted",
  className,
  children,
  ...props
}: ProviderSelectorItemTextProps) {
  const Component = asChild ? Slot.Root : "span";
  return (
    <Component
      {...props}
      data-slot="provider-selector-item-text"
      className={cn(
        tone === "danger"
          ? "text-[var(--provider-selector-danger)]"
          : "text-[var(--provider-selector-muted)]",
        className,
      )}
    >
      {children}
    </Component>
  );
}
