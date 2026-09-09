import { AlertDialog, Flex } from "@radix-ui/themes";
import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/theme-button";

type ConfirmButtonSpec = {
  label: ReactNode;
  color?: "red" | "gray";
  highContrast?: boolean;
  disabled?: boolean;
  onClick: () => void;
  /** AlertDialog.Action 点击后立即关闭弹窗；不给就是普通按钮，关闭时机由调用方自己决定。 */
  closesDialog?: boolean;
};

/**
 * 受控 AlertDialog 确认块的唯一实现。各处的标题、说明、正文与按钮外观差异很大，因此
 * 每个视觉细节都是显式 prop；未传的一律不出现在传给 Radix 组件的属性里(`exactOptionalPropertyTypes`
 * 下,显式传 `undefined` 与不传对类型检查而言是两回事),不替调用方猜一个默认值。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  trigger,
  title,
  titleSize,
  titleMb,
  titleClassName,
  description,
  descriptionClassName,
  children,
  maxWidth,
  maxHeight,
  contentClassName,
  onCloseAutoFocus,
  direction,
  footerClassName,
  cancelLabel,
  cancelVariant,
  cancelDisabled,
  confirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: ReactNode;
  title: ReactNode;
  titleSize: "4" | "6";
  titleMb?: ComponentProps<typeof AlertDialog.Title>["mb"];
  titleClassName?: string;
  description: ReactNode;
  descriptionClassName?: string;
  children?: ReactNode;
  maxWidth?: ComponentProps<typeof AlertDialog.Content>["maxWidth"];
  maxHeight?: ComponentProps<typeof AlertDialog.Content>["maxHeight"];
  contentClassName?: string;
  onCloseAutoFocus?: (event: Event) => void;
  direction?: ComponentProps<typeof Flex>["direction"];
  footerClassName?: string;
  cancelLabel: ReactNode;
  cancelVariant: "soft" | "outline";
  cancelDisabled?: boolean;
  /** null 隐藏确认按钮——弹窗此刻只能取消(用于操作进行中不许关闭那一档)。 */
  confirm: ConfirmButtonSpec | null;
}) {
  const contentProps: ComponentProps<typeof AlertDialog.Content> = {
    size: { initial: "2", sm: "3" },
    ...(maxWidth === undefined ? {} : { maxWidth }),
    ...(maxHeight === undefined ? {} : { maxHeight }),
    ...(contentClassName === undefined ? {} : { className: contentClassName }),
    ...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus }),
  };
  const titleProps: ComponentProps<typeof AlertDialog.Title> = {
    size: titleSize,
    ...(titleMb === undefined ? {} : { mb: titleMb }),
    ...(titleClassName === undefined ? {} : { className: titleClassName }),
  };
  const descriptionProps: ComponentProps<typeof AlertDialog.Description> = {
    size: "2",
    color: "gray",
    ...(descriptionClassName === undefined ? {} : { className: descriptionClassName }),
  };
  const footerProps: ComponentProps<typeof Flex> = {
    gap: "3",
    mt: "4",
    justify: "end",
    ...(direction === undefined ? {} : { direction }),
    ...(footerClassName === undefined ? {} : { className: footerClassName }),
  };
  const cancelButtonProps: ComponentProps<typeof Button> = {
    type: "button",
    variant: cancelVariant,
    color: "gray",
    size: { initial: "4", sm: "2" },
    ...(cancelDisabled === undefined ? {} : { disabled: cancelDisabled }),
  };

  const confirmButton = confirm === null ? null : (
    <Button
      type="button"
      variant="solid"
      size={{ initial: "4", sm: "2" }}
      onClick={confirm.onClick}
      {...(confirm.color === undefined ? {} : { color: confirm.color })}
      {...(confirm.highContrast === undefined ? {} : { highContrast: confirm.highContrast })}
      {...(confirm.disabled === undefined ? {} : { disabled: confirm.disabled })}
    >
      {confirm.label}
    </Button>
  );

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger === undefined ? null : <AlertDialog.Trigger>{trigger}</AlertDialog.Trigger>}
      <AlertDialog.Content {...contentProps}>
        <AlertDialog.Title {...titleProps}>{title}</AlertDialog.Title>
        <AlertDialog.Description {...descriptionProps}>{description}</AlertDialog.Description>
        {children}
        <Flex {...footerProps}>
          <AlertDialog.Cancel>
            <Button {...cancelButtonProps}>{cancelLabel}</Button>
          </AlertDialog.Cancel>
          {confirm?.closesDialog ? <AlertDialog.Action>{confirmButton}</AlertDialog.Action> : confirmButton}
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
