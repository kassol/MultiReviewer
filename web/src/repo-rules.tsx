import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Cross2Icon, CrossCircledIcon } from "@radix-ui/react-icons";
import { Badge, Callout, Dialog, IconButton, Select, Skeleton, Text, TextField, Tooltip } from "@radix-ui/themes";

import { CommitChip } from "@/components/commit-chip";
import { EmptyState } from "@/components/empty-state";
import { HelpTooltip } from "@/components/help-tooltip";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/theme-button";

import { api, errorText, fetchJson } from "./api.ts";
import { CommitPicker, type CommitSelection } from "./commit-picker.tsx";
import { RuleTraceButton } from "./rule-trace.tsx";
import {
  THINKING_LEVEL_LABEL,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "./model-services.ts";

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
  thinkingLevel: ThinkingLevel | null;
  failure: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** 这一次探索的规则轨迹(CONTEXT.md,issue #214)。升级前跑过的那些没有,为 null。 */
  traceTaskId: number | null;
};

/**
 * 一条修订提案(CONTEXT.md,issue #207)。`change` 是变更类型,`targetRuleId` 是修改与
 * 废止指向的现有规则,`source` 是出处二元,`sourceNote` 是反哺时触发它的处置备注。
 */
type RuleProposal = {
  id: number;
  change: "add" | "modify" | "retire";
  targetRuleId: number | null;
  scope: string;
  statement: string;
  layer: string;
  source: "baseline-exploration" | "disposition-feedback";
  sourceNote: string | null;
  /** 提出它的那一次规则轨迹(issue #214)。人据此回溯这条提案是怎么推出来的。 */
  traceTaskId: number | null;
  state: "pending" | "accepted" | "rejected";
  decidedAt: string | null;
};

/**
 * 这个仓库当前生效的规则集与它的规则集版本。`version` 为 null 即还没确认过;`retired`
 * 是废止过的规则,不再生效但仍要查得到(issue #203)。`exploration`、`draft` 与
 * `proposals` 是等人确认或裁决的那一半(issue #205、#207),与规则集同一份读取。
 */
type RuleSet = {
  version: number | null;
  rules: ReviewRule[];
  retired: ReviewRule[];
  exploration: RuleExploration | null;
  draft: ReviewRule[];
  proposals: RuleProposal[];
};

/** `GET /rule-models` 的一项:发起基点探索时可选的模型。 */
type RuleModel = { identity: string; provider: string; model: string; reasoning: boolean };

/**
 * 表单里编辑中的那条规则:`id` 为 null 即新增,有值即改这一条。生效规则、规则草案与修订
 * 提案三张表单共用它。它与 CONTEXT.md 的「规则草案」(`ruleSet.draft`)不是一回事,因此
 * 不叫 `RuleDraft`。
 */
type RuleFormState = { id: number | null; scope: string; statement: string; layer: string };

const BLANK_DRAFT: RuleFormState = { id: null, scope: "", statement: "", layer: "" };

/** 规则三样的请求 body。三处写侧(生效规则、规则草案、提案的改后内容)同一个形状。 */
function ruleFieldsBody(form: RuleFormState): string {
  return JSON.stringify({
    scope: form.scope.trim(),
    statement: form.statement.trim(),
    layer: form.layer.trim(),
  });
}

/**
 * 一组规则表单的增删改。生效规则与规则草案各有一组端点,写法却是同一套:`id` 为 null 即
 * POST 新增、有值即 PUT 改这一条,`{ retire }` 与 `{ deleteDraft }` 即 DELETE 那一条。
 * 两者的差别只有端点前缀与成功后清空哪一份表单,由入参给。
 *
 * 删那一档分成两个名字:生效规则的那一次是**废止**(CONTEXT.md 的两态之一,那条规则
 * 仍要查得到),规则草案的那一次是**删除**(还没确认,删了就不剩什么)。请求形状相同,
 * 说的却是两件事,同名会让读代码的人以为它们是一回事。
 */
function useRuleEdits(basePath: string, onSuccess: () => void) {
  return useMutation({
    mutationFn: async (
      action: RuleFormState | { retire: number } | { deleteDraft: number },
    ): Promise<void> => {
      const response = "retire" in action
        ? await api(`${basePath}/${action.retire}`, { method: "DELETE" })
        : "deleteDraft" in action
        ? await api(`${basePath}/${action.deleteDraft}`, { method: "DELETE" })
        : await api(action.id === null ? basePath : `${basePath}/${action.id}`, {
            method: action.id === null ? "POST" : "PUT",
            body: ruleFieldsBody(action),
          });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess,
  });
}

/**
 * 规则集入口(issue #202):首页右栏头部选中一个仓库时的一个按钮加它的弹窗。
 *
 * 读侧不挂权限格(ADR 0019),登录加仓库分配即可读,因此这个按钮与「发起范围审查」
 * 「重跑」并排却不跟着写权限出现;手工增删改那三个入口按 `rule:write` 出现
 * (issue #203)。规则怎么来是同一个弹窗里的基点探索与规则确认(issue #205,见
 * `ExplorationSection`),之后怎么改是修订提案队列与逐条裁决(issue #207,见
 * `ProposalSection`)。
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
  const [draft, setDraft] = useState<RuleFormState | null>(null);
  const [draftEdit, setDraftEdit] = useState<RuleFormState | null>(null);
  const [proposalEdit, setProposalEdit] = useState<RuleFormState | null>(null);
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
  const change = useRuleEdits(`/repos/${repo.repoId}/rules`, () => {
    setDraft(null);
    reload();
  });

  // 草案的增删改与生效规则各走各的端点:草案还没确认,改它不推进规则集版本。
  const changeDraft = useRuleEdits(`/repos/${repo.repoId}/rule-draft`, () => {
    setDraftEdit(null);
    reload();
  });

  /**
   * 裁决一条修订提案(CONTEXT.md,issue #207)。采纳可以带改后的内容,不带即按队列里
   * 那份原样采纳;采纳推进一个规则集版本,驳回只改状态。
   */
  const decide = useMutation({
    mutationFn: async (
      action: { id: number; accept: boolean; edit?: RuleFormState },
    ): Promise<void> => {
      const path = `/repos/${repo.repoId}/rule-proposals/${action.id}`;
      const response = await api(`${path}/${action.accept ? "accept" : "reject"}`, {
        method: "POST",
        ...(action.edit === undefined ? {} : { body: ruleFieldsBody(action.edit) }),
      });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: () => {
      setProposalEdit(null);
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
      {ruleSet.data === undefined ? null : typeof ruleSet.data.version === "number" ? (
        <Text as="p" size="1" color="gray" mb="3">
          规则集版本 {ruleSet.data.version}
        </Text>
      ) : (
        /* 门禁分代(issue #206):没有规则集版本即还没确认,这个仓库暂不执行 Review Run。
           下面就是基点探索与规则确认那一段,引导到位。 */
        <Text as="p" size="1" color="orange" mb="3">
          规则集未确认:完成规则确认前,这个仓库的投递只记录不审,面板也发起不了审查。
        </Text>
      )}

      {ruleSet.isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-live="polite">
          <span className="sr-only">正在读取规则集</span>
          {[0, 1].map((slot) => <Skeleton key={slot} className="h-14" />)}
        </div>
      ) : null}

      {ruleSet.isError || change.isError || changeDraft.isError || confirm.isError
        || decide.isError ? (
        <Callout.Root role="alert" color="red" size="1" mb="3">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>
            {((ruleSet.error ?? change.error ?? changeDraft.error ?? confirm.error ?? decide.error) as Error).message}
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
          onDeleteDraft={(id) => changeDraft.mutate({ deleteDraft: id })}
          onConfirm={() => confirm.mutate()}
        />
      ) : null}

      {ruleSet.data === undefined || ruleSet.data.proposals.length === 0 ? null : (
        <ProposalSection
          repoId={repo.repoId}
          ruleSet={ruleSet.data}
          canWrite={canWrite}
          edit={proposalEdit}
          busy={decide.isPending}
          onEdit={setProposalEdit}
          onDecide={(id, accept) => decide.mutate({ id, accept })}
          onSubmitEdit={() =>
            decide.mutate({ id: proposalEdit!.id!, accept: true, edit: proposalEdit! })
          }
        />
      )}

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
              <h3 className="text-2xl font-bold tracking-[-0.015em]">{layer}</h3>
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
                      <Badge color="gray" variant="soft">
                        {rule.scope === "" ? "全仓库" : rule.scope}
                      </Badge>
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
          <h3 className="text-2xl font-bold tracking-[-0.015em]">已废止</h3>
          <ul className="overflow-hidden rounded-lg border border-card-line">
            {ruleSet.data.retired.map((rule) => (
              <li key={rule.id} className="border-t border-line px-4 py-3 first:border-t-0">
                <Text as="p" size="2" color="gray" className="line-through">
                  {rule.statement}
                </Text>
                <span className="mt-1.5 inline-block">
                  <Badge color="gray" variant="soft">{rule.layer}</Badge>
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
  submitLabel,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: RuleFormState;
  busy: boolean;
  /** 提交那一颗的字。省略即按新增 / 保存,裁决那一段给「改后采纳」。 */
  submitLabel?: string;
  onChange: (draft: RuleFormState) => void;
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
          {submitLabel ?? (draft.id === null ? "新增" : "保存")}
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

const CHANGE_LABEL = { add: "新增", modify: "修改", retire: "废止" } as const;
const SOURCE_LABEL = {
  "baseline-exploration": "基点探索",
  "disposition-feedback": "处置反哺",
} as const;

/**
 * 修订提案队列与裁决那一段(issue #207)。待裁决的排在前面,已裁决的留在后面供查。
 *
 * 队列本身对所有读得到规则集的人可见——「还有什么在等人裁决」与「现在按什么标准评审」
 * 是同一个问题的两半;采纳与驳回按 `rule:write` 出现。
 */
function ProposalSection({
  repoId,
  ruleSet,
  canWrite,
  edit,
  busy,
  onEdit,
  onDecide,
  onSubmitEdit,
}: {
  repoId: number;
  ruleSet: RuleSet;
  canWrite: boolean;
  edit: RuleFormState | null;
  busy: boolean;
  onEdit: (draft: RuleFormState | null) => void;
  onDecide: (id: number, accept: boolean) => void;
  onSubmitEdit: () => void;
}) {
  const pending = ruleSet.proposals.filter((row) => row.state === "pending");
  const decided = ruleSet.proposals.filter((row) => row.state !== "pending");
  /** 修改与废止指向的那条现有规则。已经不在生效规则里时只显示标识。 */
  const target = (proposal: RuleProposal): string | null => {
    if (proposal.targetRuleId === null) return null;
    const rule = ruleSet.rules.find((entry) => entry.id === proposal.targetRuleId);
    return rule === undefined ? `规则 ${proposal.targetRuleId}(已不生效)` : rule.statement;
  };

  return (
    <section className="mb-3.5 flex flex-col gap-2 rounded-lg border border-card-line p-3">
      <div className="flex items-center gap-1">
        <h3 className="text-2xl font-bold tracking-[-0.015em]">修订提案</h3>
        <HelpTooltip content="规则集的每次变更都要你裁决:采纳生成新的规则集版本,驳回只留下记录。" />
      </div>

      {pending.length === 0 ? null : (
        <ul className="overflow-hidden rounded-lg border border-card-line">
          {pending.map((proposal) => (
            <li key={proposal.id} className="border-t border-line px-4 py-3 first:border-t-0">
              <div className="flex items-start justify-between gap-2">
                <Text as="p" size="2">{proposal.statement}</Text>
                {canWrite && edit?.id !== proposal.id ? (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      color="gray"
                      size={{ initial: "3", sm: "1" }}
                      onClick={() =>
                        onEdit({
                          id: proposal.id,
                          scope: proposal.scope,
                          statement: proposal.statement,
                          layer: proposal.layer,
                        })
                      }
                    >
                      修改
                    </Button>
                    <Button
                      variant="ghost"
                      color="gray"
                      size={{ initial: "3", sm: "1" }}
                      disabled={busy}
                      onClick={() => onDecide(proposal.id, true)}
                    >
                      采纳
                    </Button>
                    <Button
                      variant="ghost"
                      color="gray"
                      size={{ initial: "3", sm: "1" }}
                      disabled={busy}
                      onClick={() => onDecide(proposal.id, false)}
                    >
                      驳回
                    </Button>
                  </div>
                ) : null}
              </div>
              <span className="mt-1.5 inline-flex flex-wrap items-center gap-1.5">
                <Badge color="gray" variant="soft">{CHANGE_LABEL[proposal.change]}</Badge>
                <Badge color="gray" variant="soft">{SOURCE_LABEL[proposal.source]}</Badge>
                <Badge color="gray" variant="soft">
                  {proposal.scope === "" ? "全仓库" : proposal.scope}
                </Badge>
                {/* 出处回溯(issue #214):这条提案是哪一次探索或反哺推出来的。 */}
                {proposal.traceTaskId === null ? null : (
                  <RuleTraceButton repoId={repoId} taskId={proposal.traceTaskId} />
                )}
              </span>
              {target(proposal) === null ? null : (
                <Text as="p" size="1" color="gray" className="mt-1.5">
                  目标规则:{target(proposal)}
                </Text>
              )}
              {proposal.sourceNote === null ? null : (
                <Text as="p" size="1" color="gray" className="mt-1.5">
                  处置备注:{proposal.sourceNote}
                </Text>
              )}
              {edit?.id === proposal.id ? (
                <div className="mt-2">
                  <RuleForm
                    draft={edit}
                    busy={busy}
                    submitLabel="改后采纳"
                    onChange={onEdit}
                    onCancel={() => onEdit(null)}
                    onSubmit={onSubmitEdit}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {decided.length === 0 ? null : (
        <details>
          <summary className="cursor-pointer text-sm text-text-secondary">
            已裁决 {decided.length} 条
          </summary>
          <ul className="mt-2 overflow-hidden rounded-lg border border-card-line">
            {decided.map((proposal) => (
              <li key={proposal.id} className="border-t border-line px-4 py-3 first:border-t-0">
                <Text as="p" size="2" color="gray">{proposal.statement}</Text>
                <span className="mt-1.5 inline-flex flex-wrap items-center gap-1.5">
                  <StatusBadge tone={proposal.state === "accepted" ? "success" : "neutral"}>
                    {proposal.state === "accepted" ? "已采纳" : "已驳回"}
                  </StatusBadge>
                  <Badge color="gray" variant="soft">{CHANGE_LABEL[proposal.change]}</Badge>
                  <Badge color="gray" variant="soft">{SOURCE_LABEL[proposal.source]}</Badge>
                  {proposal.traceTaskId === null ? null : (
                    <RuleTraceButton repoId={repoId} taskId={proposal.traceTaskId} />
                  )}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/**
 * 基点探索、规则草案与规则确认那一段(issue #205)。只在有 `rule:write` 时出现。
 *
 * 已确认的仓库照样发起得了探索(issue #207):**有没有规则集版本是草案与提案的分界**,
 * 已确认时那一次的产出排进上面的修订提案队列,草案与规则确认那两样因此不再显示。空规则
 * 集是合法状态(issue #200),因此未确认时草案为空也确认得了。
 */
function ExplorationSection({
  repo,
  ruleSet,
  draft,
  busy,
  onLaunched,
  onEdit,
  onSubmitEdit,
  onDeleteDraft,
  onConfirm,
}: {
  repo: { repoId: number; owner: string; repo: string };
  ruleSet: RuleSet;
  draft: RuleFormState | null;
  busy: boolean;
  onLaunched: () => void;
  onEdit: (draft: RuleFormState | null) => void;
  onSubmitEdit: () => void;
  onDeleteDraft: (id: number) => void;
  onConfirm: () => void;
}) {
  const exploration = ruleSet.exploration;
  const running = exploration?.state === "running";
  // 分界按有没有规则集版本取,不按规则为不为空:已确认的空规则集重探索也走提案队列。
  const confirmed = ruleSet.version !== null;

  return (
    <section className="mb-3.5 flex flex-col gap-2 rounded-lg border border-card-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <h3 className="text-2xl font-bold tracking-[-0.015em]">
            {confirmed ? "基点探索" : "规则草案"}
          </h3>
          <HelpTooltip
            content={
              confirmed
                ? "规则集已经确认,再次探索的产出排进上面的修订提案队列,由你逐条裁决。"
                : "基点探索让 agent 从一个 commit 上的代码推导规则初稿,至多 30 条,由你逐条改定后整组确认。"
            }
          />
        </div>
        <ExplorationLaunch repo={repo} busy={running} onLaunched={onLaunched} />
      </div>
      {exploration === null ? null : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Text as="span" size="1" color="gray">
            {running ? "正在探索" : exploration.state === "failed" ? "上次探索失败" : "已完成探索"}
            {" · "}基点 <CommitChip sha={exploration.baselineSha} /> · 模型 {exploration.model}
            {exploration.thinkingLevel === null
              ? null
              : ` · 思考 ${THINKING_LEVEL_LABEL[exploration.thinkingLevel]}`}
          </Text>
          {/* 运行中实时看,结束后回看(issue #214)。轨迹在弹窗里开,不新建顶级导航。 */}
          {exploration.traceTaskId === null ? null : (
            <RuleTraceButton
              repoId={repo.repoId}
              taskId={exploration.traceTaskId}
              label={running ? "看它在做什么" : "查看轨迹"}
            />
          )}
        </div>
      )}

      {exploration?.state === "failed" && exploration.failure !== null ? (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{exploration.failure}</Callout.Text>
        </Callout.Root>
      ) : null}

      {confirmed ? null : draft === null ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="soft"
            color="gray"
            size={{ initial: "3", sm: "2" }}
            onClick={() => onEdit(BLANK_DRAFT)}
          >
            向草案新增
          </Button>
          <Button size={{ initial: "3", sm: "2" }} disabled={busy} onClick={onConfirm}>
            {ruleSet.draft.length === 0 ? "确认空规则集" : "确认这组规则"}
          </Button>
          {ruleSet.draft.length === 0 ? (
            <HelpTooltip content="确认空规则集即宣布这个仓库没有规则:审查随之放行,评审不注入任何规则。之后再探索,产出排进修订提案队列。" />
          ) : null}
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
                    onClick={() => onDeleteDraft(rule.id)}
                  >
                    删除
                  </Button>
                </div>
              </div>
              <span className="mt-1.5 inline-flex gap-1.5">
                <Badge color="gray" variant="soft">{rule.layer}</Badge>
                <Badge color="gray" variant="soft">
                  {rule.scope === "" ? "全仓库" : rule.scope}
                </Badge>
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
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("off");
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
          // 模型不声明推理能力时不带档位:那一档运行侧本来就会落回关闭。
          ...(picked.reasoning && thinkingLevel !== "off" ? { thinkingLevel } : {}),
        }),
      });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: onLaunched,
    onError: (failure: Error) => setError(failure.message),
  });

  const ready = baseline !== null && model !== "";
  const reasoning = available.find((entry) => entry.identity === model)?.reasoning === true;

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
            <HelpTooltip
              className="ml-1 align-middle"
              content="产出至多 30 条规则草案,由你逐条改定后整组确认。"
            />
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
            <div className="flex items-center gap-1">
              <Text size="2" weight="medium">思考档位</Text>
              <HelpTooltip content="档位越高,agent 推导规则前想得越久,这一次探索也越慢越贵。" />
            </div>
            {reasoning ? (
              <Select.Root
                value={thinkingLevel}
                onValueChange={(next) => setThinkingLevel(next as ThinkingLevel)}
                size={{ initial: "3", sm: "2" }}
              >
                <Select.Trigger aria-label="思考档位" />
                <Select.Content position="popper">
                  {THINKING_LEVELS.map((level) => (
                    <Select.Item key={level} value={level}>
                      {THINKING_LEVEL_LABEL[level]}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            ) : (
              <div>
                <Badge color="gray" variant="outline">
                  {model === "" ? "先选模型" : "不支持思考档位"}
                </Badge>
              </div>
            )}
          </div>
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
