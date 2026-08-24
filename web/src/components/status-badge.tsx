import {
  CheckCircledIcon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
  InfoCircledIcon,
} from "@radix-ui/react-icons";
import { Badge, type BadgeProps } from "@radix-ui/themes";
import type { ComponentType, ForwardRefExoticComponent, ReactNode, RefAttributes } from "react";

export type StatusTone = "neutral" | "success" | "warning" | "error";

type StatusBadgeProps = Omit<BadgeProps, "className" | "color" | "highContrast" | "variant"> & {
  tone: StatusTone;
  icon?: ComponentType<{ "aria-hidden"?: boolean }>;
  onSolid?: boolean;
  children: ReactNode;
};

const STATUS_COLOR = {
  neutral: "gray",
  success: "green",
  warning: "amber",
  error: "red",
} as const satisfies Record<StatusTone, NonNullable<BadgeProps["color"]>>;

const STATUS_ICON = {
  neutral: InfoCircledIcon,
  success: CheckCircledIcon,
  warning: ExclamationTriangleIcon,
  error: CrossCircledIcon,
} as const satisfies Record<StatusTone, ComponentType<{ "aria-hidden"?: boolean }>>;

// Themes 3.3.0 在 exactOptionalPropertyTypes 下把 highContrast 推成 never；运行时仍是官方 Badge。
const StatusBadgeRoot = Badge as ForwardRefExoticComponent<
  Omit<BadgeProps, "highContrast"> & { highContrast?: boolean } & RefAttributes<HTMLSpanElement>
>;

/**
 * 跨页面状态的唯一视觉出口。领域组件继续决定状态含义，这里只统一颜色、图标和表面适配。
 */
export function StatusBadge({ tone, icon, onSolid = false, children, ...props }: StatusBadgeProps) {
  const Icon = icon ?? STATUS_ICON[tone];
  return (
    <StatusBadgeRoot
      {...props}
      color={STATUS_COLOR[tone]}
      variant={onSolid ? "solid" : "soft"}
      highContrast={!onSolid}
    >
      <Icon aria-hidden />
      {children}
    </StatusBadgeRoot>
  );
}
