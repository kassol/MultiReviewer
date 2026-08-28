import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Cross2Icon, CrossCircledIcon } from "@radix-ui/react-icons";
import { Callout, Dialog, IconButton, Skeleton, Text, TextField, Tooltip } from "@radix-ui/themes";

import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/theme-button";

import { api, errorText, fetchJson } from "./api.ts";

/** `GET /repos/{id}/rules` 的一条评审规则(CONTEXT.md)。`scope` 空串即全仓库。 */
type ReviewRule = {
  id: number;
  scope: string;
  statement: string;
  layer: string;
  origin: string;
};

/**
 * 这个仓库当前生效的规则集与它的规则集版本。`version` 为 null 即还没确认过;`retired`
 * 是废止过的规则,不再生效但仍要查得到(issue #203)。
 */
type RuleSet = {
  version: number | null;
  rules: ReviewRule[];
  retired: ReviewRule[];
};

/** 编辑中的那条规则:`id` 为 null 即新增,有值即改这一条。 */
type RuleDraft = { id: number | null; scope: string; statement: string; layer: string };

const BLANK_DRAFT: RuleDraft = { id: null, scope: "", statement: "", layer: "" };

/**
 * 规则集入口(issue #202):首页右栏头部选中一个仓库时的一个按钮加它的弹窗。
 *
 * 读侧不挂权限格(ADR 0019),登录加仓库分配即可读,因此这个按钮与「发起范围审查」
 * 「重跑」并排却不跟着写权限出现;手工增删改那三个入口按 `rule:write` 出现
 * (issue #203)。规则怎么来(基点探索)与提案裁决是后续票的事。
 */
export function RepoRules({
  repo,
  canWrite,
}: {
  repo: { repoId: number; owner: string; repo: string };
  canWrite: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button variant="soft" color="gray" size={{ initial: "3", sm: "2" }}>
          规则集
        </Button>
      </Dialog.Trigger>
      {open ? <RuleSetDialogContent repo={repo} canWrite={canWrite} /> : null}
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
  canWrite,
}: {
  repo: { repoId: number; owner: string; repo: string };
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const ruleSet = useQuery({
    queryKey: ["repo-rules", repo.repoId],
    queryFn: () => fetchJson<RuleSet>(`/repos/${repo.repoId}/rules`),
  });

  // 三个写动作走同一次改动:每一次都推进一个规则集版本,回来重读这一份规则集。
  const change = useMutation({
    mutationFn: async (action: RuleDraft | { retire: number }): Promise<void> => {
      const rules = `/repos/${repo.repoId}/rules`;
      const response = "retire" in action
        ? await api(`${rules}/${action.retire}`, { method: "DELETE" })
        : await api(action.id === null ? rules : `${rules}/${action.id}`, {
            method: action.id === null ? "POST" : "PUT",
            body: JSON.stringify({
              scope: action.scope.trim(),
              statement: action.statement.trim(),
              layer: action.layer.trim(),
            }),
          });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: () => {
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: ["repo-rules", repo.repoId] });
    },
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

      {ruleSet.isError || change.isError ? (
        <Callout.Root role="alert" color="red" size="1" mb="3">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>
            {((ruleSet.error ?? change.error) as Error).message}
          </Callout.Text>
        </Callout.Root>
      ) : null}

      {canWrite && ruleSet.data !== undefined ? (
        draft === null ? (
          <div className="mb-3">
            <Button
              variant="soft"
              size={{ initial: "3", sm: "2" }}
              onClick={() => setDraft(BLANK_DRAFT)}
            >
              新增规则
            </Button>
          </div>
        ) : (
          <RuleForm
            draft={draft}
            busy={change.isPending}
            onChange={setDraft}
            onCancel={() => setDraft(null)}
            onSubmit={() => change.mutate(draft)}
          />
        )
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
                    <div className="flex items-start justify-between gap-2">
                      <Text as="p" size="2">{rule.statement}</Text>
                      {canWrite ? (
                        <div className="flex shrink-0 gap-1">
                          <Button
                            variant="ghost"
                            color="gray"
                            size={{ initial: "3", sm: "1" }}
                            onClick={() => setDraft({ ...rule, id: rule.id })}
                          >
                            修改
                          </Button>
                          <Button
                            variant="ghost"
                            color="gray"
                            size={{ initial: "3", sm: "1" }}
                            disabled={change.isPending}
                            onClick={() => change.mutate({ retire: rule.id })}
                          >
                            废止
                          </Button>
                        </div>
                      ) : null}
                    </div>
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

      {ruleSet.data === undefined || ruleSet.data.retired.length === 0 ? null : (
        <section className="mt-3.5 flex flex-col gap-2">
          <h3 className="text-lg font-bold tracking-[-0.015em]">已废止</h3>
          <ul className="overflow-hidden rounded-lg border border-card-line">
            {ruleSet.data.retired.map((rule) => (
              <li key={rule.id} className="border-t border-line px-4 py-3 first:border-t-0">
                <Text as="p" size="2" color="gray" className="line-through">
                  {rule.statement}
                </Text>
                <span className="mt-1.5 inline-block">
                  <StatusBadge tone="neutral">{rule.layer}</StatusBadge>
                </span>
              </li>
            ))}
          </ul>
        </section>
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

/**
 * 新增与修改共用的一张表(issue #203)。规范陈述与层标签是两个必填面——空陈述不构成
 * 规范,空层标签在这个弹窗里分不了组;作用范围留空即全仓库,与服务端同一判据。
 */
function RuleForm({
  draft,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: RuleDraft;
  busy: boolean;
  onChange: (draft: RuleDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const ready = draft.statement.trim() !== "" && draft.layer.trim() !== "";
  return (
    <form
      className="mb-3 flex flex-col gap-2 rounded-lg border border-card-line p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) onSubmit();
      }}
    >
      <label className="flex flex-col gap-1">
        <Text size="1" color="gray">规范陈述</Text>
        <TextField.Root
          size={{ initial: "3", sm: "2" }}
          className="max-sm:min-h-11"
          value={draft.statement}
          onChange={(event) => onChange({ ...draft, statement: event.target.value })}
          autoFocus
        />
      </label>
      <label className="flex flex-col gap-1">
        <Text size="1" color="gray">层标签</Text>
        <TextField.Root
          size={{ initial: "3", sm: "2" }}
          className="max-sm:min-h-11"
          value={draft.layer}
          onChange={(event) => onChange({ ...draft, layer: event.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1">
        <Text size="1" color="gray">作用范围(glob,留空即全仓库)</Text>
        <TextField.Root
          size={{ initial: "3", sm: "2" }}
          className="max-sm:min-h-11"
          value={draft.scope}
          onChange={(event) => onChange({ ...draft, scope: event.target.value })}
        />
      </label>
      <div className="flex gap-2">
        <Button type="submit" size={{ initial: "3", sm: "2" }} disabled={!ready || busy}>
          {draft.id === null ? "新增" : "保存"}
        </Button>
        <Button
          type="button"
          variant="soft"
          color="gray"
          size={{ initial: "3", sm: "2" }}
          onClick={onCancel}
        >
          取消
        </Button>
      </div>
    </form>
  );
}
