import { Box, Flex, Text } from "@radix-ui/themes";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type EmptyStateProps = {
  title: ReactNode;
  titleAs?: "h1" | "h2" | "h3" | "p";
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
};

/** 资源为空、筛选无结果与零权限状态的紧凑文字反馈。 */
export function EmptyState({
  title,
  titleAs: Title = "p",
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <Flex
      direction="column"
      align="start"
      gap="1"
      role="status"
      className={cn("py-4", className)}
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
