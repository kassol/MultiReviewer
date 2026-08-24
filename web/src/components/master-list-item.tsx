import { Slot } from "radix-ui";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactElement, ReactNode } from "react";

import { cn } from "@/lib/utils";

type MasterListItemCommonProps = {
  selected: boolean;
  className?: string;
  children: ReactNode;
};

type MasterListItemLinkProps = MasterListItemCommonProps & {
  /** Link 自己持有路由与点击行为，产品组件只合并表面和 aria-current。 */
  asChild: true;
};

type MasterListItemButtonProps = MasterListItemCommonProps &
  Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "aria-current" | "aria-pressed" | "children" | "className"
  > & {
    asChild?: false;
  };

type MasterListItemTextProps = HTMLAttributes<HTMLElement> & {
  asChild?: boolean;
  tone?: "muted" | "danger";
  children: ReactNode;
};

/**
 * 主从列表当前项的唯一交互表面。路由项使用 asChild + Link，页内选择直接使用 button。
 */
function masterListItemClassName(
  selected: boolean,
  className: string | undefined,
  disabled = false,
): string {
  return cn(
    "relative w-full text-left transition-colors focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--master-list-focus)]",
    selected
      ? "bg-[var(--selection-solid)] text-[var(--selection-solid-text)] [--master-list-danger:var(--selection-solid-danger-text)] [--master-list-focus:var(--selection-solid-text)] [--master-list-muted:var(--selection-solid-muted-text)]"
      : "text-[var(--text-primary)] [--master-list-danger:var(--red-11)] [--master-list-focus:var(--selection-solid)] [--master-list-muted:var(--text-secondary)] hover:bg-[var(--gray-3)]",
    disabled && "cursor-not-allowed opacity-60",
    className,
  );
}

export function MasterListItem(props: MasterListItemLinkProps): ReactElement;
export function MasterListItem(props: MasterListItemButtonProps): ReactElement;
export function MasterListItem(
  props: MasterListItemLinkProps | MasterListItemButtonProps,
): ReactElement {
  if (props.asChild) {
    const { selected, className, children } = props;
    return <Slot.Root
      aria-current={selected ? "page" : undefined}
      data-selected={selected ? "true" : "false"}
      data-slot="master-list-item"
      className={masterListItemClassName(selected, className)}
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
      data-slot="master-list-item"
      className={masterListItemClassName(selected, className, disabled)}
    >
      {children}
    </button>
  );
}

/** 主从列表项内随深浅表面切换对比度的辅助文字或异常文字。 */
export function MasterListItemText({
  asChild = false,
  tone = "muted",
  className,
  children,
  ...props
}: MasterListItemTextProps) {
  const Component = asChild ? Slot.Root : "span";
  return (
    <Component
      {...props}
      data-slot="master-list-item-text"
      className={cn(
        tone === "danger"
          ? "text-[var(--master-list-danger)]"
          : "text-[var(--master-list-muted)]",
        className,
      )}
    >
      {children}
    </Component>
  );
}
