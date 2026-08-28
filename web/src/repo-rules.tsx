import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Cross2Icon, CrossCircledIcon } from "@radix-ui/react-icons";
import { Callout, Dialog, IconButton, Skeleton, Text, Tooltip } from "@radix-ui/themes";

import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/theme-button";

import { fetchJson } from "./api.ts";

/** `GET /repos/{id}/rules` 的一条评审规则(CONTEXT.md)。`scope` 空串即全仓库。 */
type ReviewRule = {
  id: number;
  scope: string;
  statement: string;
  layer: string;
  origin: string;
};

/** 这个仓库当前生效的规则集与它的规则集版本。`version` 为 null 即还没确认过。 */
type RuleSet = {
  version: number | null;
  rules: ReviewRule[];
};

/**
 * 规则集入口(issue #202):首页右栏头部选中一个仓库时的一个按钮加它的只读弹窗。
 *
 * 读侧不挂权限格(ADR 0019),登录加仓库分配即可读,因此它与「发起范围审查」「重跑」
 * 并排却不跟着写权限出现。这一票只读:规则怎么来、怎么改是后续票的事。
 */
export function RepoRules({ repo }: { repo: { repoId: number; owner: string; repo: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button variant="soft" color="gray" size={{ initial: "3", sm: "2" }}>
          规则集
        </Button>
      </Dialog.Trigger>
      {open ? <RuleSetDialogContent repo={repo} /> : null}
    </Dialog.Root>
  );
}

/** 按层标签把规则分组,层内保持服务端给的顺序,层之间按首次出现的先后。 */
function byLayer(rules: readonly ReviewRule[]): [string, ReviewRule[]][] {
  const groups = new Map<string, ReviewRule[]>();
  for (const rule of rules) {
    const group = groups.get(rule.layer);
    if (group === undefined) groups.set(rule.layer, [rule]);
    else group.push(rule);
  }
  return [...groups];
}

function RuleSetDialogContent({
  repo,
}: {
  repo: { repoId: number; owner: string; repo: string };
}) {
  const ruleSet = useQuery({
    queryKey: ["repo-rules", repo.repoId],
    queryFn: () => fetchJson<RuleSet>(`/repos/${repo.repoId}/rules`),
  });

  return (
    <Dialog.Content
      aria-describedby={undefined}
      maxWidth="680px"
      maxHeight="calc(100dvh - 2rem)"
      size={{ initial: "2", sm: "3" }}
    >
      <Dialog.Title size="4" mb="1" className="pr-9 break-all">
        {repo.owner}/{repo.repo} 的规则集
      </Dialog.Title>
      {typeof ruleSet.data?.version === "number" ? (
        <Text as="p" size="1" color="gray" mb="3">
          规则集版本 {ruleSet.data.version}
        </Text>
      ) : null}

      {ruleSet.isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-live="polite">
          <span className="sr-only">正在读取规则集</span>
          {[0, 1].map((slot) => <Skeleton key={slot} className="h-14" />)}
        </div>
      ) : null}

      {ruleSet.isError ? (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{(ruleSet.error as Error).message}</Callout.Text>
        </Callout.Root>
      ) : null}

      {ruleSet.data !== undefined && ruleSet.data.rules.length === 0 ? (
        <EmptyState
          title="这个仓库还没有评审规则"
          titleAs="h3"
          description="空规则集是合法状态:评审照常执行,只是没有规则注入。"
        />
      ) : null}

      {ruleSet.data === undefined ? null : (
        <div className="flex flex-col gap-3.5">
          {byLayer(ruleSet.data.rules).map(([layer, rules]) => (
            <section key={layer} className="flex flex-col gap-2">
              <h3 className="text-lg font-bold tracking-[-0.015em]">{layer}</h3>
              <ul className="overflow-hidden rounded-lg border border-card-line">
                {rules.map((rule) => (
                  <li key={rule.id} className="border-t border-line px-4 py-3 first:border-t-0">
                    <Text as="p" size="2">{rule.statement}</Text>
                    <span className="mt-1.5 inline-block">
                      <StatusBadge tone="neutral">
                        {rule.scope === "" ? "全仓库" : rule.scope}
                      </StatusBadge>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <div className="absolute top-3 right-3">
        <Tooltip content="关闭规则集">
          <Dialog.Close>
            <IconButton
              variant="ghost"
              color="gray"
              size={{ initial: "3", sm: "1" }}
              className="max-sm:min-h-11 max-sm:min-w-11"
              aria-label="关闭规则集"
            >
              <Cross2Icon aria-hidden />
            </IconButton>
          </Dialog.Close>
        </Tooltip>
      </div>
    </Dialog.Content>
  );
}
