import { Box, Flex, Text } from "@radix-ui/themes";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type EmptyStateProps = {
  title: ReactNode;
  titleAs?: "h1" | "h2" | "h3" | "p";
  description?: ReactNode;
  action?: ReactNode;
  /** `start` 是窄容器里的一行式反馈;整块高容器(如选择器的结果区)用 `center`。 */
  align?: "start" | "center";
  className?: string;
};

/** 资源为空、筛选无结果与零权限状态的紧凑文字反馈。 */
export function EmptyState({
  title,
  titleAs: Title = "p",
  description,
  action,
  align = "start",
  className,
}: EmptyStateProps) {
  return (
    <Flex
      direction="column"
      align={align}
      gap="1"
      role="status"
      className={cn("py-4", align === "center" && "text-center", className)}
    >
      <Text asChild size="3" weight="medium">
        <Title>{title}</Title>
      </Text>
      {description === undefined ? null : (
        <Text as="div" size="2" color="gray">
          {description}
        </Text>
      )}
      {action === undefined ? null : <Box pt="1">{action}</Box>}
    </Flex>
  );
}
