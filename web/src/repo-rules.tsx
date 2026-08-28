import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Cross2Icon, CrossCircledIcon } from "@radix-ui/react-icons";
import { Callout, Dialog, IconButton, Select, Skeleton, Text, TextField, Tooltip } from "@radix-ui/themes";

import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/theme-button";

import { api, errorText, fetchJson } from "./api.ts";
import { CommitPicker, type CommitSelection } from "./commit-picker.tsx";

/** `GET /repos/{id}/rules` 的一条评审规则(CONTEXT.md)。`scope` 空串即全仓库。 */
type ReviewRule = {
  id: number;
  scope: string;
  statement: string;
  layer: string;
  origin: string;
};

/** 这个仓库最近一次基点探索(CONTEXT.md,issue #205)。从没探索过为 null。 */
type RuleExploration = {
  state: "running" | "failed" | "completed";
  baselineSha: string;
  model: string;
  failure: string | null;
  startedAt: string;
  finishedAt: string | null;
};

/**
 * 这个仓库当前生效的规则集与它的规则集版本。`version` 为 null 即还没确认过;`retired`
 * 是废止过的规则,不再生效但仍要查得到(issue #203)。`exploration` 与 `draft` 是等人
 * 确认的那一半(issue #205),与规则集同一份读取。
 */
type RuleSet = {
  version: number | null;
  rules: ReviewRule[];
  retired: ReviewRule[];
  exploration: RuleExploration | null;
  draft: ReviewRule[];
};

/** `GET /rule-models` 的一项:发起基点探索时可选的模型。 */
type RuleModel = { identity: string; provider: string; model: string };

/** 编辑中的那条规则:`id` 为 null 即新增,有值即改这一条。 */
type RuleDraft = { id: number | null; scope: string; statement: string; layer: string };

const BLANK_DRAFT: RuleDraft = { id: null, scope: "", statement: "", layer: "" };

/**
 * 规则集入口(issue #202):首页右栏头部选中一个仓库时的一个按钮加它的弹窗。
 *
 * 读侧不挂权限格(ADR 0019),登录加仓库分配即可读,因此这个按钮与「发起范围审查」
 * 「重跑」并排却不跟着写权限出现;手工增删改那三个入口按 `rule:write` 出现
 * (issue #203)。规则怎么来是同一个弹窗里的基点探索与规则确认(issue #205,见
 * `ExplorationSection`);提案裁决是后续票的事。
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
  const [draftEdit, setDraftEdit] = useState<RuleDraft | null>(null);
  const ruleSet = useQuery({
    queryKey: ["repo-rules", repo.repoId],
    queryFn: () => fetchJson<RuleSet>(`/repos/${repo.repoId}/rules`),
    // 探索在服务端后台跑,结束时没人推给面板,弹窗开着就每 5 秒问一次,跑完即停。
    refetchInterval: (query) =>
      query.state.data?.exploration?.state === "running" ? 5000 : false,
  });
  const reload = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["repo-rules", repo.repoId] });
  };

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
      reload();
    },
  });

  // 草案的增删改与生效规则各走各的端点:草案还没确认,改它不推进规则集版本。
  const changeDraft = useMutation({
    mutationFn: async (action: RuleDraft | { remove: number }): Promise<void> => {
      const items = `/repos/${repo.repoId}/rule-draft`;
      const response = "remove" in action
        ? await api(`${items}/${action.remove}`, { method: "DELETE" })
        : await api(action.id === null ? items : `${items}/${action.id}`, {
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
      setDraftEdit(null);
      reload();
    },
  });

  /** 规则确认(CONTEXT.md):整组生效,生成这个仓库的下一个规则集版本。 */
  const confirm = useMutation({
    mutationFn: async (): Promise<void> => {
      const response = await api(`/repos/${repo.repoId}/rule-draft/confirm`, { method: "POST" });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: reload,
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

      {ruleSet.isError || change.isError || changeDraft.isError || confirm.isError ? (
        <Callout.Root role="alert" color="red" size="1" mb="3">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>
            {((ruleSet.error ?? change.error ?? changeDraft.error ?? confirm.error) as Error).message}
          </Callout.Text>
        </Callout.Root>
      ) : null}

      {canWrite && ruleSet.data !== undefined ? (
        <ExplorationSection
          repo={repo}
          ruleSet={ruleSet.data}
          draft={draftEdit}
          busy={changeDraft.isPending || confirm.isPending}
          onLaunched={reload}
          onEdit={setDraftEdit}
          onSubmitEdit={() => changeDraft.mutate(draftEdit!)}
          onRemove={(id) => changeDraft.mutate({ remove: id })}
          onConfirm={() => confirm.mutate()}
        />
      ) : null}

      {canWrite && ruleSet.data !== undefined && ruleSet.data.draft.length === 0 ? (
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

      {ruleSet.data !== undefined
        && ruleSet.data.rules.length === 0
        && ruleSet.data.draft.length === 0 ? (
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

/**
 * 基点探索与规则草案那一段(issue #205)。只在有 `rule:write` 时出现。
 *
 * 规则集非空的仓库不显示发起入口:那时重探索的产出要作修订提案逐条裁决(issue #207),
 * 服务端也按同一条分界回 409。
 */
function ExplorationSection({
  repo,
  ruleSet,
  draft,
  busy,
  onLaunched,
  onEdit,
  onSubmitEdit,
  onRemove,
  onConfirm,
}: {
  repo: { repoId: number; owner: string; repo: string };
  ruleSet: RuleSet;
  draft: RuleDraft | null;
  busy: boolean;
  onLaunched: () => void;
  onEdit: (draft: RuleDraft | null) => void;
  onSubmitEdit: () => void;
  onRemove: (id: number) => void;
  onConfirm: () => void;
}) {
  const exploration = ruleSet.exploration;
  const running = exploration?.state === "running";
  const confirmed = ruleSet.rules.length > 0;
  if (confirmed && ruleSet.draft.length === 0) return null;

  return (
    <section className="mb-3.5 flex flex-col gap-2 rounded-lg border border-card-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-bold tracking-[-0.015em]">规则草案</h3>
        {confirmed ? null : (
          <ExplorationLaunch repo={repo} busy={running} onLaunched={onLaunched} />
        )}
      </div>

      {exploration === null ? (
        <Text as="p" size="1" color="gray">
          基点探索让 agent 从一个 commit 上的代码推导规则初稿,至多 30 条,由你逐条改定后整组确认。
        </Text>
      ) : (
        <Text as="p" size="1" color="gray">
          {running ? "正在探索" : exploration.state === "failed" ? "上次探索失败" : "已完成探索"}
          {" · "}基点 {exploration.baselineSha.slice(0, 7)} · 模型 {exploration.model}
        </Text>
      )}

      {exploration?.state === "failed" && exploration.failure !== null ? (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{exploration.failure}</Callout.Text>
        </Callout.Root>
      ) : null}

      {draft === null ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="soft"
            color="gray"
            size={{ initial: "3", sm: "2" }}
            onClick={() => onEdit(BLANK_DRAFT)}
          >
            向草案新增
          </Button>
          <Button
            size={{ initial: "3", sm: "2" }}
            disabled={busy || ruleSet.draft.length === 0}
            onClick={onConfirm}
          >
            确认这组规则
          </Button>
        </div>
      ) : (
        <RuleForm
          draft={draft}
          busy={busy}
          onChange={onEdit}
          onCancel={() => onEdit(null)}
          onSubmit={onSubmitEdit}
        />
      )}

      {ruleSet.draft.length === 0 ? null : (
        <ul className="overflow-hidden rounded-lg border border-card-line">
          {ruleSet.draft.map((rule) => (
            <li key={rule.id} className="border-t border-line px-4 py-3 first:border-t-0">
              <div className="flex items-start justify-between gap-2">
                <Text as="p" size="2">{rule.statement}</Text>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    color="gray"
                    size={{ initial: "3", sm: "1" }}
                    onClick={() => onEdit({ ...rule, id: rule.id })}
                  >
                    修改
                  </Button>
                  <Button
                    variant="ghost"
                    color="gray"
                    size={{ initial: "3", sm: "1" }}
                    disabled={busy}
                    onClick={() => onRemove(rule.id)}
                  >
                    删除
                  </Button>
                </div>
              </div>
              <span className="mt-1.5 inline-flex gap-1.5">
                <StatusBadge tone="neutral">{rule.layer}</StatusBadge>
                <StatusBadge tone="neutral">
                  {rule.scope === "" ? "全仓库" : rule.scope}
                </StatusBadge>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 发起基点探索的表单:基点 commit 走与发起范围审查同一个选择器(issue #178),模型从
 * 当前可用模型里选——可用性判据与全局模型组合读的是同一份投影。
 *
 * 基点默认预填默认分支的 HEAD:探索的常规问法是「按现在的代码,规则应该是什么」。人
 * 自己点过就不再覆盖。
 */
function ExplorationLaunch({
  repo,
  busy,
  onLaunched,
}: {
  repo: { repoId: number; owner: string; repo: string };
  busy: boolean;
  onLaunched: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button variant="soft" size={{ initial: "3", sm: "2" }} disabled={busy}>
          {busy ? "正在探索…" : "发起基点探索"}
        </Button>
      </Dialog.Trigger>
      {open ? (
        <ExplorationLaunchContent
          key={`${repo.owner}/${repo.repo}`}
          repo={repo}
          onLaunched={() => {
            onLaunched();
            setOpen(false);
          }}
        />
      ) : null}
    </Dialog.Root>
  );
}

function ExplorationLaunchContent({
  repo,
  onLaunched,
}: {
  repo: { repoId: number; owner: string; repo: string };
  onLaunched: () => void;
}) {
  const [baseline, setBaseline] = useState<CommitSelection | null>(null);
  const [touched, setTouched] = useState(false);
  const [model, setModel] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const query = `owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.repo)}`;

  const models = useQuery({
    queryKey: ["rule-models"],
    queryFn: () => fetchJson<{ models: RuleModel[] }>("/rule-models"),
  });

  // 默认基点是默认分支的 HEAD:先认出哪条是默认分支,再取它最新的那个 commit。
  const defaultHead = useQuery({
    queryKey: ["rule-exploration-baseline", repo.owner, repo.repo],
    queryFn: async () => {
      const page = await fetchJson<{ branches: { name: string; isDefault: boolean }[] }>(
        `/repo-branches?${query}&refresh=1`,
      );
      const branch = page.branches.find((entry) => entry.isDefault) ?? page.branches[0];
      if (branch === undefined) return null;
      const commits = await fetchJson<{ commits: { sha: string }[] }>(
        `/repo-commits?${query}&branch=${encodeURIComponent(branch.name)}&limit=1`,
      );
      return commits.commits[0]?.sha ?? null;
    },
  });

  const suggested = defaultHead.data ?? null;
  useEffect(() => {
    if (suggested === null || touched) return;
    setBaseline({ sha: suggested });
  }, [suggested, touched]);

  const available = models.data?.models ?? [];
  useEffect(() => {
    if (model !== "" || available.length === 0) return;
    setModel(available[0]!.identity);
  }, [available, model]);

  const start = useMutation({
    mutationFn: async (): Promise<void> => {
      const picked = available.find((entry) => entry.identity === model);
      if (picked === undefined) throw new Error("先选一个可用模型");
      const response = await api(`/repos/${repo.repoId}/rule-exploration`, {
        method: "POST",
        body: JSON.stringify({
          baseline: baseline?.sha ?? "",
          provider: picked.provider,
          model: picked.model,
        }),
      });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: onLaunched,
    onError: (failure: Error) => setError(failure.message),
  });

  const ready = baseline !== null && model !== "";

  return (
    <Dialog.Content
      aria-describedby={undefined}
      maxWidth="800px"
      size={{ initial: "2", sm: "3" }}
      className="h-[min(780px,calc(100dvh-4.5rem))] overflow-hidden p-0"
    >
      <form
        className="flex h-full min-h-0 flex-col"
        aria-busy={start.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !start.isPending) start.mutate();
        }}
      >
        <div className="shrink-0 border-b border-overlay-line px-4 py-3 sm:px-5 sm:py-4">
          <Dialog.Title size="4" mb="0" className="pr-10">
            发起基点探索
            <span className="ml-2 break-all text-md font-normal text-text-secondary">
              {repo.owner}/{repo.repo}
            </span>
          </Dialog.Title>
          <div className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
            <Text as="label" htmlFor="rule-exploration-model" size="2" weight="medium">模型</Text>
            <Select.Root value={model} onValueChange={setModel} size={{ initial: "3", sm: "2" }}>
              <Select.Trigger id="rule-exploration-model" placeholder="选择一个可用模型" />
              <Select.Content position="popper">
                {available.map((entry) => (
                  <Select.Item key={entry.identity} value={entry.identity}>
                    {entry.identity}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </div>
          <Text as="p" size="1" color="gray" className="mt-1 text-right">
            产出至多 30 条规则草案,由你逐条改定后整组确认
          </Text>
        </div>

        <div className="flex min-h-0 flex-1 px-3 py-3 sm:px-5 sm:py-4">
          <CommitPicker
            repo={repo}
            base={baseline}
            comparison={null}
            singleLabel="基点"
            onPick={(_role, selection) => {
              setTouched(true);
              setBaseline(selection);
            }}
          />
        </div>

        <div className="shrink-0 border-t border-overlay-line bg-sunken px-4 py-3 sm:px-5">
          {error === null ? null : (
            <p role="alert" className="mb-2 break-words text-sm text-danger">{error}</p>
          )}
          <div className="flex justify-end gap-2">
            <Dialog.Close>
              <Button type="button" variant="soft" color="gray" size={{ initial: "3", sm: "2" }}>
                取消
              </Button>
            </Dialog.Close>
            <Button
              type="submit"
              size={{ initial: "3", sm: "2" }}
              disabled={!ready || start.isPending}
            >
              {start.isPending ? "发起中…" : "开始探索"}
            </Button>
          </div>
        </div>
      </form>
      <div className="absolute top-2.5 right-2.5 sm:top-3.5 sm:right-3.5">
        <Dialog.Close>
          <IconButton
            variant="ghost"
            color="gray"
            size="3"
            className="max-sm:min-h-11 max-sm:min-w-11"
            aria-label="关闭发起基点探索"
          >
            <Cross2Icon aria-hidden />
          </IconButton>
        </Dialog.Close>
      </div>
    </Dialog.Content>
  );
}
