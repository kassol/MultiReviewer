import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";

import { Cross2Icon, CrossCircledIcon } from "@radix-ui/react-icons";
import { Badge, Callout, Checkbox, Dialog, IconButton, Select, Skeleton, Text, TextArea, TextField, Tooltip } from "@radix-ui/themes";

import { CommitChip } from "@/components/commit-chip";
import { EmptyState } from "@/components/empty-state";
import { HelpTooltip } from "@/components/help-tooltip";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/theme-button";

import { api, errorText, fetchJson } from "./api.ts";
import { CommitPicker, type CommitSelection } from "./commit-picker.tsx";
import { RuleTraceButton, SOURCE_LABEL, TYPE_LABEL, type KnowledgeType } from "./rule-trace.tsx";
import { THINKING_LEVEL_LABEL, type ThinkingLevel } from "./model-services.ts";

/** 事实型陈述的字数上限,与服务端同一个数:超了服务端 400,表单先拦一道。 */
const FACT_STATEMENT_LIMIT = 500;

/** `GET /repos/{id}/rules` 的一条知识条目(CONTEXT.md)。`scope` 空串即全仓库。 */
type ReviewRule = {
  id: number;
  type: KnowledgeType;
  scope: string;
  statement: string;
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
  /** 这一次探索的知识轨迹(CONTEXT.md,issue #214)。升级前跑过的那些没有,为 null。 */
  traceTaskId: number | null;
};

/**
 * 一条修订提案(CONTEXT.md,issue #207)。`change` 是变更类型,`targetRuleId` 是修改与
 * 废止指向的现有规则,`source` 是出处二元,`sourceNote` 是反哺时触发它的处置备注。
 */
type RuleProposal = {
  id: number;
  type: KnowledgeType;
  change: "add" | "modify" | "retire";
  targetRuleId: number | null;
  scope: string;
  statement: string;
  source: "baseline-exploration" | "disposition-feedback";
  sourceNote: string | null;
  /** 提出它的那一次知识轨迹(issue #214)。人据此回溯这条提案是怎么推出来的。 */
  traceTaskId: number | null;
  state: "pending" | "accepted" | "rejected";
  decidedAt: string | null;
};

/**
 * 这个仓库当前生效的知识集与它的知识集版本。`version` 为 null 即还没确认过;`retired`
 * 是废止过的规则,不再生效但仍要查得到(issue #203)。`exploration`、`draft` 与
 * `proposals` 是等人确认或裁决的那一半(issue #205、#207),与知识集同一份读取。
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
type RuleModel = {
  identity: string;
  provider: string;
  model: string;
  /** 这个模型支持的思考档位。表单只列这几档,服务端发起时也只收这几档。 */
  thinkingLevels: ThinkingLevel[];
};

/**
 * 表单里编辑中的那条规则:`id` 为 null 即新增,有值即改这一条。生效规则、知识草案与修订
 * 提案三张表单共用它。它与 CONTEXT.md 的「知识草案」(`ruleSet.draft`)不是一回事,因此
 * 不叫 `RuleDraft`。
 */
type RuleFormState = {
  id: number | null;
  type: KnowledgeType;
  scope: string;
  statement: string;
};

const BLANK_DRAFT: RuleFormState = { id: null, type: "rule", scope: "", statement: "" };

/** 一条知识条目的请求 body。三处写侧(生效条目、知识草案、提案的改后内容)同一个形状。 */
function ruleFieldsBody(form: RuleFormState): string {
  return JSON.stringify({
    type: form.type,
    scope: form.scope.trim(),
    statement: form.statement.trim(),
  });
}

/**
 * 一组规则表单的增删改。生效规则与知识草案各有一组端点,写法却是同一套:`id` 为 null 即
 * POST 新增、有值即 PUT 改这一条,`{ retire }` 与 `{ deleteDraft }` 即 DELETE 那一条。
 * 两者的差别只有端点前缀与成功后清空哪一份表单,由入参给。
 *
 * 删那一档分成两个名字:生效规则的那一次是**废止**(CONTEXT.md 的两态之一,那条规则
 * 仍要查得到),知识草案的那一次是**删除**(还没确认,删了就不剩什么)。请求形状相同,
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
 * 一组条目的勾选态(issue #223)。草案与修订提案两处共用:上百条时逐条点击点不完,
 * 勾选之后一次裁决完。
 *
 * `all` 为真即当前这一组全部勾上——它是**推出来的**,不另存一份状态,否则列表变化时
 * 两份状态会各说各话。全选那一颗按 `some && !all` 显示 indeterminate(`web/AGENTS.md`
 * 的批量规范)。
 */
function useSelection(ids: readonly number[], defaultAll: boolean) {
  const key = ids.join(",");
  const [picked, setPicked] = useState<Set<number>>(() => new Set(defaultAll ? ids : []));
  // 列表换了就按默认重来:上一次勾的那些标识可能已经不在队列里了。
  useEffect(() => {
    setPicked(new Set(defaultAll ? key.split(",").filter(Boolean).map(Number) : []));
  }, [key, defaultAll]);

  const toggle = (id: number, on: boolean): void => {
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const all = ids.length > 0 && ids.every((id) => picked.has(id));
  const some = ids.some((id) => picked.has(id));
  return {
    picked,
    /** 按列表顺序给出勾选的那些:请求里的次序因此与人看到的一致。 */
    selected: ids.filter((id) => picked.has(id)),
    toggle,
    /** 全选那一颗的状态:全勾 / 部分勾 / 一条不勾。 */
    headState: all ? true : some ? ("indeterminate" as const) : false,
    toggleAll: (on: boolean): void => setPicked(new Set(on ? ids : [])),
  };
}

/**
 * 知识集入口(issue #202):首页右栏头部选中一个仓库时的一个按钮加它的弹窗。
 *
 * 读侧不挂权限格(ADR 0019),登录加仓库分配即可读,因此这个按钮与「发起范围审查」
 * 「重跑」并排却不跟着写权限出现;手工增删改那三个入口按 `knowledge:write` 出现
 * (issue #203)。规则怎么来是同一个弹窗里的基点探索与知识确认(issue #205,见
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
          知识集
        </Button>
      </Dialog.Trigger>
      {open ? <RuleSetDialogContent repo={repo} canWrite={canWrite} /> : null}
    </Dialog.Root>
  );
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

  // 三个写动作走同一次改动:每一次都推进一个知识集版本,回来重读这一份知识集。
  const change = useRuleEdits(`/repos/${repo.repoId}/rules`, () => {
    setDraft(null);
    reload();
  });

  // 草案的增删改与生效规则各走各的端点:草案还没确认,改它不推进知识集版本。
  const changeDraft = useRuleEdits(`/repos/${repo.repoId}/rule-draft`, () => {
    setDraftEdit(null);
    reload();
  });

  /**
   * 裁决一条修订提案(CONTEXT.md,issue #207)。采纳可以带改后的内容,不带即按队列里
   * 那份原样采纳;采纳推进一个知识集版本,驳回只改状态。
   */
  const decide = useMutation({
    mutationFn: async (
      action:
        | { id: number; accept: boolean; edit?: RuleFormState }
        | { ids: readonly number[]; accept: boolean },
    ): Promise<void> => {
      const base = `/repos/${repo.repoId}/rule-proposals`;
      // 批量裁决走另一对端点(issue #223):采纳一整组只推进一个知识集版本,而逐条采纳
      // 还带「改后采纳」的改后内容,两者要的 body 不是一回事。
      const response =
        "ids" in action
          ? await api(`${base}/${action.accept ? "accept" : "reject"}`, {
              method: "POST",
              body: JSON.stringify({ ids: action.ids }),
            })
          : await api(`${base}/${action.id}/${action.accept ? "accept" : "reject"}`, {
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

  /**
   * 知识确认(CONTEXT.md):勾选的那些生效,生成这个仓库的下一个知识集版本。
   * `itemIds` 为空即整组确认(草案本来就是空的那一档),与升级前逐字一致。
   */
  const confirm = useMutation({
    mutationFn: async (itemIds: readonly number[]): Promise<void> => {
      const response = await api(`/repos/${repo.repoId}/rule-draft/confirm`, {
        method: "POST",
        ...(itemIds.length === 0 ? {} : { body: JSON.stringify({ itemIds }) }),
      });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: reload,
  });

  return (
    // 标题钉住,正文自己滚:提案与规则多起来(AI-API 一轮 29 条)会把弹窗撑出视口,
    // 标题和关闭全被推走(修复自部署实例的走查)。
    <Dialog.Content
      aria-describedby={undefined}
      maxWidth="680px"
      maxHeight="min(780px, calc(100dvh - 4.5rem))"
      size={{ initial: "2", sm: "3" }}
      className="flex flex-col overflow-hidden"
    >
      <Dialog.Title size="4" mb="1" className="shrink-0 pr-9 break-all">
        {repo.owner}/{repo.repo} 的知识集
      </Dialog.Title>
      {ruleSet.data === undefined ? null : typeof ruleSet.data.version === "number" ? (
        <Text as="p" size="1" color="gray" mb="3">
          知识集版本 {ruleSet.data.version}
        </Text>
      ) : (
        /* 门禁分代(issue #206):没有知识集版本即还没确认,这个仓库暂不执行 Review Run。
           下面就是基点探索与知识确认那一段,引导到位。 */
        <Text as="p" size="1" color="orange" mb="3">
          知识集未确认:完成知识确认前,这个仓库的投递只记录不审,面板也发起不了审查。
        </Text>
      )}

      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">

      {ruleSet.isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-live="polite">
          <span className="sr-only">正在读取知识集</span>
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
          onConfirm={(itemIds) => confirm.mutate(itemIds)}
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
          onDecideAll={(ids, accept) => decide.mutate({ ids, accept })}
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
              新增知识条目
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
          title="这个仓库还没有知识条目"
          titleAs="h3"
          description="空知识集是合法状态:评审照常执行,只是没有知识注入。"
        />
      ) : null}

      {ruleSet.data === undefined ? null : (
        <div className="flex flex-col gap-3.5">
          {/* 生效条目只按两型分段(ADR 0020),与修订提案区同一套语法。 */}
          {ruleSet.data.rules.some((entry) => entry.type === "rule") ? (
            <section className="flex flex-col gap-2">
              <div className="flex items-center gap-1">
                <h3 className="text-xs font-semibold text-text-muted">
                  {TYPE_LABEL.rule}
                  <span className="ml-1.5 font-normal">
                    {ruleSet.data.rules.filter((entry) => entry.type === "rule").length}
                  </span>
                </h3>
                <HelpTooltip content="评审规则说的是代码应当怎样,违反它即是一条 Finding。" />
              </div>
              <ul className="overflow-hidden rounded-lg border border-card-line">
                {ruleSet.data.rules
                  .filter((entry) => entry.type === "rule")
                  .map((rule) => (
                    <li key={rule.id} className="border-t border-line px-4 py-3 first:border-t-0">
                      <div className="flex items-start justify-between gap-2">
                        <Text as="p" size="2">{rule.statement}</Text>
                        {canWrite ? (
                          <div className="flex shrink-0 gap-1">
                            <Button
                              variant="soft"
                              color="gray"
                              size={{ initial: "3", sm: "1" }}
                              onClick={() => setDraft({ ...rule, id: rule.id })}
                            >
                              修改
                            </Button>
                            <Button
                              variant="soft"
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
          ) : null}

          {ruleSet.data.rules.every((entry) => entry.type === "rule") ? null : (
            <section className="flex flex-col gap-2">
              <div className="flex items-center gap-1">
                <h3 className="text-xs font-semibold text-text-muted">
                  {TYPE_LABEL.fact}
                  <span className="ml-1.5 font-normal">
                    {ruleSet.data.rules.filter((entry) => entry.type === "fact").length}
                  </span>
                </h3>
                <HelpTooltip content="项目事实是 Reviewer 的判断依据,本身不产 Finding;与代码矛盾时以代码为准。" />
              </div>
              <ul className="overflow-hidden rounded-lg border border-card-line">
                {ruleSet.data.rules
                  .filter((entry) => entry.type === "fact")
                  .map((fact) => (
                    <li key={fact.id} className="border-t border-line px-4 py-3 first:border-t-0">
                      <div className="flex items-start justify-between gap-2">
                        <Text as="p" size="2">{fact.statement}</Text>
                        {canWrite ? (
                          <div className="flex shrink-0 gap-1">
                            <Button
                              variant="soft"
                              color="gray"
                              size={{ initial: "3", sm: "1" }}
                              onClick={() => setDraft({ ...fact, id: fact.id })}
                            >
                              修改
                            </Button>
                            <Button
                              variant="soft"
                              color="gray"
                              size={{ initial: "3", sm: "1" }}
                              disabled={change.isPending}
                              onClick={() => change.mutate({ retire: fact.id })}
                            >
                              废止
                            </Button>
                          </div>
                        ) : null}
                      </div>
                      <span className="mt-1.5 inline-block">
                        <Badge color="gray" variant="soft">
                          {fact.scope === "" ? "全仓库" : fact.scope}
                        </Badge>
                      </span>
                    </li>
                  ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {ruleSet.data === undefined || ruleSet.data.retired.length === 0 ? null : (
        <section className="mt-3.5 flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-text-muted">
            已废止
            <span className="ml-1.5 font-normal">{ruleSet.data.retired.length}</span>
          </h3>
          <ul className="overflow-hidden rounded-lg border border-card-line">
            {ruleSet.data.retired.map((rule) => (
              <li key={rule.id} className="border-t border-line px-4 py-3 first:border-t-0">
                <Text as="p" size="2" color="gray" className="line-through">
                  {rule.statement}
                </Text>
                <span className="mt-1.5 inline-block">
                  {/* 废止的那一条也要说得出它是哪一型。 */}
                  <Badge color="gray" variant="soft">{TYPE_LABEL[rule.type]}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      </div>

      <div className="absolute top-3 right-3">
        <Tooltip content="关闭知识集">
          <Dialog.Close>
            <IconButton
              variant="ghost"
              color="gray"
              size={{ initial: "3", sm: "1" }}
              className="max-sm:min-h-11 max-sm:min-w-11"
              aria-label="关闭知识集"
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
 * 新增与修改共用的一张表(issue #203、#221)。两型同一张表(ADR 0020),第一格就是选
 * 哪一型,陈述那一格跟着换:
 *
 * - **评审规则**要那一句规范陈述(空陈述不构成规范);
 * - **项目事实**要那一句可核查的陈述,另有字数上限,事实是一句话不是一段说明。
 *
 * 作用范围两型都可以留空,空即全仓库。这里的必填判据与服务端逐条对应。
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
  // 表单在生效条目、草案与提案三处各挂一份,可能同时渲染;写死的 id 会在 DOM 里
  // 重复,标签指到别的表单上,所以按实例生成。
  const typeSelectId = useId();
  const statement = draft.statement.trim();
  const isRule = draft.type === "rule";
  const overLimit = !isRule && statement.length > FACT_STATEMENT_LIMIT;
  const ready = statement !== "" && !overLimit;
  return (
    <form
      className="mb-3 flex flex-col gap-2 rounded-lg border border-card-line p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) onSubmit();
      }}
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <Text as="label" htmlFor={typeSelectId} size="1" color="gray">类型</Text>
          <HelpTooltip content="评审规则说的是代码应当怎样,违反它即是一条 Finding;项目事实说的是这个仓库实际怎样,只作模型的判断依据,本身不产 Finding。" />
        </div>
        <Select.Root
          value={draft.type}
          onValueChange={(next) => onChange({ ...draft, type: next as KnowledgeType })}
          size={{ initial: "3", sm: "2" }}
        >
          <Select.Trigger id={typeSelectId} />
          <Select.Content position="popper">
            <Select.Item value="rule">{TYPE_LABEL.rule}</Select.Item>
            <Select.Item value="fact">{TYPE_LABEL.fact}</Select.Item>
          </Select.Content>
        </Select.Root>
      </div>
      <label className="flex flex-col gap-1">
        <Text size="1" color={overLimit ? "red" : "gray"}>
          {isRule
            ? "规范陈述"
            : `项目事实陈述(至多 ${FACT_STATEMENT_LIMIT} 字,已写 ${statement.length})`}
        </Text>
        {/* 多行输入:陈述常常一句写不下,单行框在长句上没法回看。换行在注入侧压成
            单行(worker-tools 的 oneLine),prompt 的列表结构不受影响。 */}
        <TextArea
          size={{ initial: "3", sm: "2" }}
          rows={3}
          resize="vertical"
          value={draft.statement}
          onChange={(event) => onChange({ ...draft, statement: event.target.value })}
          autoFocus
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

/** 一段列表头上的全选(issue #223)。可见标签与 Checkbox 关联,窄屏保留触控尺寸。 */
function SelectAll({
  id,
  state,
  label,
  onChange,
}: {
  id: string;
  state: boolean | "indeterminate";
  label: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <Text as="label" size="1" color="gray" className="flex items-center gap-1.5">
      <Checkbox
        id={id}
        checked={state}
        onCheckedChange={(next) => onChange(next === true)}
        size={{ initial: "2", sm: "1" }}
      />
      {label}
    </Text>
  );
}

const CHANGE_LABEL = { add: "新增", modify: "修改", retire: "废止" } as const;

/**
 * 一条已裁决提案的结论说法。裁决的对象是提案而不是条目:光写「已驳回」会被读成「这条
 * 规则被驳回」,而被驳回的其实是「废止它的提案」——条目还在。因此按裁决 × 变更类型合成
 * 一句话,把两件事一次说清。
 */
const DECISION_LABEL = {
  accepted: {
    add: "采纳了新增提案",
    modify: "采纳了修改提案",
    retire: "采纳了废止提案,条目已废止",
  },
  rejected: {
    add: "驳回了新增提案",
    modify: "驳回了修改提案,条目保持原样",
    retire: "驳回了废止提案,条目保留",
  },
} as const satisfies Record<"accepted" | "rejected", Record<RuleProposal["change"], string>>;

/**
 * 修订提案队列与裁决那一段(issue #207)。待裁决的排在前面,已裁决的留在后面供查。
 *
 * 队列本身对所有读得到知识集的人可见——「还有什么在等人裁决」与「现在按什么标准评审」
 * 是同一个问题的两半;采纳与驳回按 `knowledge:write` 出现。
 */
function ProposalSection({
  repoId,
  ruleSet,
  canWrite,
  edit,
  busy,
  onEdit,
  onDecide,
  onDecideAll,
  onSubmitEdit,
}: {
  repoId: number;
  ruleSet: RuleSet;
  canWrite: boolean;
  edit: RuleFormState | null;
  busy: boolean;
  onEdit: (draft: RuleFormState | null) => void;
  onDecide: (id: number, accept: boolean) => void;
  onDecideAll: (ids: readonly number[], accept: boolean) => void;
  onSubmitEdit: () => void;
}) {
  const pending = ruleSet.proposals.filter((row) => row.state === "pending");
  const decided = ruleSet.proposals.filter((row) => row.state !== "pending");
  // 提案默认一条不勾:采纳是改变知识集的动作,该由人一条条挑,不该默认全中。
  const pick = useSelection(pending.map((row) => row.id), false);
  /** 修改与废止指向的那条现有规则。已经不在生效规则里时只显示标识。 */
  const target = (proposal: RuleProposal): string | null => {
    if (proposal.targetRuleId === null) return null;
    const rule = ruleSet.rules.find((entry) => entry.id === proposal.targetRuleId);
    return rule === undefined
      ? `知识条目 ${proposal.targetRuleId}(已不生效)`
      : rule.statement;
  };

  return (
    <section className="mb-3.5 flex flex-col gap-2 rounded-lg border border-card-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <h3 className="text-2xl font-bold tracking-[-0.015em]">修订提案</h3>
          <HelpTooltip content="知识集的每次变更都要你裁决:采纳生成新的知识集版本,驳回只留下记录。批量采纳一次只生成一个版本。" />
        </div>
        {canWrite && pending.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <SelectAll
              id="rule-proposals-all"
              state={pick.headState}
              label={`全选(${pick.selected.length}/${pending.length})`}
              onChange={pick.toggleAll}
            />
            <Button
              variant="soft"
              size={{ initial: "3", sm: "1" }}
              disabled={busy || pick.selected.length === 0}
              onClick={() => onDecideAll(pick.selected, true)}
            >
              采纳勾选的 {pick.selected.length} 条
            </Button>
            <Button
              variant="soft"
              color="gray"
              size={{ initial: "3", sm: "1" }}
              disabled={busy || pick.selected.length === 0}
              onClick={() => onDecideAll(pick.selected, false)}
            >
              驳回
            </Button>
          </div>
        ) : null}
      </div>

      {pending.length === 0 ? null : (
        <ul className="overflow-hidden rounded-lg border border-card-line">
          {pending.map((proposal) => (
            <li key={proposal.id} className="border-t border-line px-4 py-3 first:border-t-0">
              <div className="flex items-start justify-between gap-2">
                {canWrite ? (
                  <Text as="label" size="2" className="flex min-w-0 items-start gap-2">
                    <Checkbox
                      checked={pick.picked.has(proposal.id)}
                      onCheckedChange={(next) => pick.toggle(proposal.id, next === true)}
                      size={{ initial: "2", sm: "1" }}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 break-words">{proposal.statement}</span>
                  </Text>
                ) : (
                  <Text as="p" size="2">{proposal.statement}</Text>
                )}
                {canWrite && edit?.id !== proposal.id ? (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="soft"
                      color="gray"
                      size={{ initial: "3", sm: "1" }}
                      onClick={() =>
                        onEdit({
                          id: proposal.id,
                          type: proposal.type,
                          scope: proposal.scope,
                          statement: proposal.statement,
                        })
                      }
                    >
                      修改
                    </Button>
                    <Button
                      variant="soft"
                      color="gray"
                      size={{ initial: "3", sm: "1" }}
                      disabled={busy}
                      onClick={() => onDecide(proposal.id, true)}
                    >
                      采纳
                    </Button>
                    <Button
                      variant="soft"
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
                {/* 采纳的后果两型不同(issue #222):规则违反即 Finding,事实只作判断依据。 */}
                <Badge color="gray" variant="soft">{TYPE_LABEL[proposal.type]}</Badge>
                <Badge color="gray" variant="soft">{CHANGE_LABEL[proposal.change]}</Badge>
                <Badge color="gray" variant="soft">{SOURCE_LABEL[proposal.source]}</Badge>
                <Badge color="gray" variant="soft">
                  {proposal.scope === "" ? "全仓库" : proposal.scope}
                </Badge>
                {/* 出处回溯(issue #214):这条提案是哪一次探索或反哺推出来的。 */}
                {proposal.traceTaskId === null ? null : (
                  <RuleTraceButton
                    repoId={repoId}
                    taskId={proposal.traceTaskId}
                    context={`来自提案:${proposal.statement}`}
                  />
                )}
              </span>
              {target(proposal) === null ? null : (
                <Text as="p" size="1" color="gray" className="mt-1.5">
                  目标知识条目:{target(proposal)}
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
                  {/* 短语已经带上变更类型,同行不再挂 CHANGE_LABEL 徽章:那枚徽章与
                      短语说的是同一件事,并排只会把人读回「条目被驳回」那个误解。 */}
                  <StatusBadge tone={proposal.state === "accepted" ? "success" : "neutral"}>
                    {proposal.state === "accepted"
                      ? DECISION_LABEL.accepted[proposal.change]
                      : DECISION_LABEL.rejected[proposal.change]}
                  </StatusBadge>
                  <Badge color="gray" variant="soft">{TYPE_LABEL[proposal.type]}</Badge>
                  <Badge color="gray" variant="soft">{SOURCE_LABEL[proposal.source]}</Badge>
                  {proposal.traceTaskId === null ? null : (
                    <RuleTraceButton
                      repoId={repoId}
                      taskId={proposal.traceTaskId}
                      context={`来自提案:${proposal.statement}`}
                    />
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
 * 基点探索、知识草案与知识确认那一段(issue #205)。只在有 `knowledge:write` 时出现。
 *
 * 已确认的仓库照样发起得了探索(issue #207):**有没有知识集版本是草案与提案的分界**,
 * 已确认时那一次的产出排进上面的修订提案队列,草案与知识确认那两样因此不再显示。空知识
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
  onConfirm: (itemIds: readonly number[]) => void;
}) {
  const exploration = ruleSet.exploration;
  const running = exploration?.state === "running";
  // 分界按有没有知识集版本取,不按规则为不为空:已确认的空知识集重探索也走提案队列。
  const confirmed = ruleSet.version !== null;
  // 草案默认全勾:确认这一整组是常规动作,取消勾选是例外(issue #223)。
  const pick = useSelection(ruleSet.draft.map((row) => row.id), true);

  return (
    <section className="mb-3.5 flex flex-col gap-2 rounded-lg border border-card-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <h3 className="text-2xl font-bold tracking-[-0.015em]">
            {confirmed ? "基点探索" : "知识草案"}
          </h3>
          <HelpTooltip
            content={
              confirmed
                ? "知识集已经确认,再次探索的产出排进上面的修订提案队列,由你逐条裁决。"
                : "基点探索让 agent 从一个 commit 上的代码推导评审规则与项目事实的初稿,由你勾选后整组确认。"
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
            <RuleTraceButton repoId={repo.repoId} taskId={exploration.traceTaskId} />
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
          <Button
            size={{ initial: "3", sm: "2" }}
            disabled={busy || (ruleSet.draft.length > 0 && pick.selected.length === 0)}
            onClick={() => onConfirm(pick.selected)}
          >
            {ruleSet.draft.length === 0
              ? "确认空知识集"
              : `确认勾选的 ${pick.selected.length} 条`}
          </Button>
          {ruleSet.draft.length === 0 ? (
            <HelpTooltip content="确认空知识集即宣布这个仓库没有规则:审查随之放行,评审不注入任何规则。之后再探索,产出排进修订提案队列。" />
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
        <>
        <SelectAll
          id="rule-draft-all"
          state={pick.headState}
          label={`全选(${pick.selected.length}/${ruleSet.draft.length})`}
          onChange={pick.toggleAll}
        />
        <ul className="overflow-hidden rounded-lg border border-card-line">
          {ruleSet.draft.map((rule) => (
            <li key={rule.id} className="border-t border-line px-4 py-3 first:border-t-0">
              <div className="flex items-start justify-between gap-2">
                <Text as="label" size="2" className="flex min-w-0 items-start gap-2">
                  {/* 没勾的那些不进知识集,随草案一并丢弃(issue #223)。 */}
                  <Checkbox
                    checked={pick.picked.has(rule.id)}
                    onCheckedChange={(next) => pick.toggle(rule.id, next === true)}
                    size={{ initial: "2", sm: "1" }}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 break-words">{rule.statement}</span>
                </Text>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="soft"
                    color="gray"
                    size={{ initial: "3", sm: "1" }}
                    onClick={() => onEdit({ ...rule, id: rule.id })}
                  >
                    修改
                  </Button>
                  <Button
                    variant="soft"
                    color="gray"
                    size={{ initial: "3", sm: "1" }}
                    disabled={busy}
                    onClick={() => onDeleteDraft(rule.id)}
                  >
                    删除
                  </Button>
                </div>
              </div>
              <span className="mt-1.5 inline-flex flex-wrap gap-1.5">
                {/* 草案里两型并列(ADR 0020),确认时一起进知识集,徽章要分得出哪条是哪型。 */}
                <Badge color="gray" variant="soft">{TYPE_LABEL[rule.type]}</Badge>
                <Badge color="gray" variant="soft">
                  {rule.scope === "" ? "全仓库" : rule.scope}
                </Badge>
              </span>
            </li>
          ))}
        </ul>
        </>
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

  // 档位只在所选模型支持的那几档里取:换了模型而旧档位它不支持时落回它自己的第一档,
  // 免得发起时被服务端拒。选中的那一档不另存一份状态,由这里推出来。
  const levels = available.find((entry) => entry.identity === model)?.thinkingLevels ?? [];
  const level = levels.includes(thinkingLevel) ? thinkingLevel : levels[0] ?? "off";
  // 只有「关闭」一档即这个模型不支持思考档位。
  const picking = levels.length > 1;

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
          // 「关闭」不带这一项:缺席即关闭,与从没选过等价。
          ...(level === "off" ? {} : { thinkingLevel: level }),
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
            <HelpTooltip
              className="ml-1 align-middle"
              content="产出知识草案(评审规则与项目事实两型),条数不设上限,由你勾选后整组确认。"
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
              <Text
                as="label"
                {...(picking ? { htmlFor: "rule-exploration-thinking" } : {})}
                size="2"
                weight="medium"
              >
                思考档位
              </Text>
              <HelpTooltip content="档位越高,agent 推导规则前想得越久,这一次探索也越慢越贵。" />
            </div>
            {picking ? (
              // 只列这个模型支持的档位:列出它不支持的那些,运行侧会 clamp 成相邻可用档,
              // 跑的就不是人选的那一档。
              <div className="flex items-center gap-1">
                <Select.Root
                  value={level}
                  onValueChange={(next) => setThinkingLevel(next as ThinkingLevel)}
                  size={{ initial: "3", sm: "2" }}
                >
                  <Select.Trigger id="rule-exploration-thinking" />
                  <Select.Content position="popper">
                    {levels.map((entry) => (
                      <Select.Item key={entry} value={entry}>
                        {THINKING_LEVEL_LABEL[entry]}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
                {levels.includes("off") ? null : (
                  <HelpTooltip
                    label="这个模型始终思考"
                    content="这个模型关不掉思考,只能选它投入多少。"
                  />
                )}
              </div>
            ) : model === "" ? (
              <Text size="2" color="gray">先选模型</Text>
            ) : (
              <div>
                <Badge color="gray" variant="outline">不支持思考档位</Badge>
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
