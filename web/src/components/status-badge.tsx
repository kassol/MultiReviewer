import {
  CheckCircledIcon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
  InfoCircledIcon,
  StopwatchIcon,
} from "@radix-ui/react-icons";
import { Badge, type BadgeProps } from "@radix-ui/themes";
import type { ComponentType, ReactNode } from "react";

export type StatusTone = "neutral" | "running" | "success" | "warning" | "error";

type StatusBadgeProps = Omit<BadgeProps, "className" | "color" | "highContrast" | "variant" | "radius"> & {
  tone: StatusTone;
  icon?: ComponentType<{ "aria-hidden"?: boolean }>;
  children: ReactNode;
};

const STATUS_COLOR = {
  neutral: "gray",
  // 进行中走主色:它不是好也不是坏,是「还没有结论」,与三档语义色分开。
  running: "blue",
  success: "green",
  warning: "amber",
  error: "red",
} as const satisfies Record<StatusTone, NonNullable<BadgeProps["color"]>>;

const STATUS_ICON = {
  neutral: InfoCircledIcon,
  running: StopwatchIcon,
  success: CheckCircledIcon,
  warning: ExclamationTriangleIcon,
  error: CrossCircledIcon,
} as const satisfies Record<StatusTone, ComponentType<{ "aria-hidden"?: boolean }>>;

/**
 * 跨页面状态的唯一视觉出口。领域组件继续决定状态含义,这里只统一颜色、图标和形状。
 *
 * 固定 `soft` 加 full 圆角,不开 `highContrast`:三族语义色的目标值就落在各自的 11 档
 * 上(`--green-11` / `--amber-11` / `--red-11`),而 highContrast 会把文字推到 12 档
 * ——那是 Radix 的默认深色,不是这套设计定的色。选中行现在是浅色 tint,也不再需要
 * solid 变体去压深色底。
 */
export function StatusBadge({ tone, icon, children, ...props }: StatusBadgeProps) {
  const Icon = icon ?? STATUS_ICON[tone];
  return (
    <Badge {...props} radius="full" color={STATUS_COLOR[tone]} variant="soft">
      <Icon aria-hidden />
      {children}
    </Badge>
  );
}
