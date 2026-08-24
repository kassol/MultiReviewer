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
 *
 * 选中态是「蓝 tint 底 + 3px 蓝左条 + 字重提到 650」。左条走 `before` 伪元素而不是
 * `border-left`：伪元素不进盒模型，选中行与未选中行的内容仍然左对齐，调用方不必在
 * 每一处补 3px 的 padding——设计稿里正是这个补偿漏了一页，行内容跟着右移了 3px。
 *
 * 选中优先于 hover：选中项的 hover 不改底色。鼠标扫过一列时，只有当前项保持蓝底，
 * 指到哪一项就变哪一项的话，"我选中的是哪个" 这个信息在扫读过程中就丢了。
 */
function masterListItemClassName(
  selected: boolean,
  className: string | undefined,
  disabled = false,
): string {
  return cn(
    "relative w-full text-left transition-colors focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--master-list-focus)]",
    "text-text [--master-list-danger:var(--v8-danger)] [--master-list-muted:var(--v8-text-muted)]",
    selected
      ? "bg-accent-tint font-bold [--master-list-focus:var(--v8-accent)] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary before:content-['']"
      : "[--master-list-focus:var(--v8-accent)] hover:bg-sunken",
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
      // 用 "true" 而不是 "page":这是列表里的当前项,不是导航里的当前页面。写 "page"
      // 会让模型服务这类页面同时出现三个 aria-current="page"(顶栏导航项、列表选中项、
      // 详情 Tab),读屏软件报出三个"当前页面"。
      aria-current={selected ? "true" : undefined}
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
