import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useState, type ReactNode } from "react";

import { Cross2Icon, CrossCircledIcon } from "@radix-ui/react-icons";
import { Badge, Callout, Checkbox, Dialog, IconButton, Select, Skeleton, Tabs, Text, TextArea, TextField, Tooltip } from "@radix-ui/themes";

import { CommitChip } from "@/components/commit-chip";
import { EmptyState } from "@/components/empty-state";
import { HelpTooltip } from "@/components/help-tooltip";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
import { TAB_TRIGGER } from "@/components/tab-trigger";

import { api, errorText, fetchJson } from "./api.ts";
import { CommitPicker, type CommitSelection } from "./commit-picker.tsx";
import { OUTLINED_ACTION, RuleTraceButton, SOURCE_LABEL, TYPE_LABEL, type KnowledgeType } from "./rule-trace.tsx";
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
 * 这个仓库最近一次知识整理(CONTEXT.md 知识整理,issue #284)。从没整理过为 null;
 * `merged` / `retargeted` / `proposed` 是完成后的摘要(issue #285),没跑完即 null。
 */
type RuleConsolidation = {
  state: "running" | "failed" | "completed";
  model: string;
  thinkingLevel: ThinkingLevel | null;
  traceTaskId: number | null;
  failure: string | null;
  merged: number | null;
  retargeted: number | null;
  proposed: number | null;
};

/**
 * 一条出处附注(CONTEXT.md,issue #281)。`origin` 是这一次的来源,`note` 是备注原文
 * (只有处置反哺有),`evidence` 是 agent 为这一条给出的理由与代码证据(issue #287),
 * `findingId` 是引发它的那条 Finding(只有处置反哺有),`traceTaskId` 是提出它的那一次
 * 知识轨迹。`findingStageId` 是那条 Finding 所在的审查阶段,面板据此开侧滑。
 */
type RuleProposalSource = {
  id: number;
  origin: "baseline-exploration" | "disposition-feedback" | "knowledge-consolidation";
  note: string | null;
  evidence: string | null;
  findingId: number | null;
  findingStageId: string | null;
  traceTaskId: number | null;
  createdAt: string;
};

/**
 * 一条修订提案(CONTEXT.md,issue #207)。`change` 是变更类型,`targetRuleIds` 是这条
 * 变更指向的现有条目(新增没有目标,修改与废止一条,合并一条以上,issue #282、#289),
 * `sources` 是它的出处附注列表(issue #281)。
 */
type RuleProposal = {
  id: number;
  type: KnowledgeType;
  change: "add" | "modify" | "retire" | "merge";
  targetRuleIds: number[];
  scope: string;
  statement: string;
  sources: RuleProposalSource[];
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
  /** 最近一次知识整理(issue #284)。与探索同一份读取。 */
  consolidation: RuleConsolidation | null;
  draft: ReviewRule[];
  proposals: RuleProposal[];
  /** 运行中、失败,以及刚完成不久的修订意图(issue #294)。与知识集同一份读取。 */
  intents: RevisionIntent[];
  /** 意图将使用的模型标识。为 null 即一个模型都选不出来,意图框置灰。 */
  intentModel: string | null;
};

/**
 * 一条修订意图(CONTEXT.md 修订意图,ADR 0028,issue #294)。`produced` 是它产出的提案
 * 与草案条目标识,`summary` 是 agent 的一句收尾——两者都要跑完才有。
 */
type RevisionIntent = {
  id: number;
  text: string;
  submittedBy: string;
  targetKind: "none" | "rule" | "proposal" | "draft" | "finding";
  targetId: number | null;
  /** 目标 Finding 所在的阶段标识(issue #296)。有它才开得了 `?finding=` 侧滑。 */
  targetStageId: string | null;
  state: "running" | "failed" | "completed";
  failure: string | null;
  summary: string | null;
  model: string | null;
  thinkingLevel: ThinkingLevel | null;
  traceTaskId: number | null;
  produced: { proposalIds: number[]; draftItemIds: number[] };
  startedAt: string;
  finishedAt: string | null;
};

/** `GET /rule-models` 的一项:发起基点探索与知识整理时可选的模型。 */
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

/** 弹窗的三个 tab:生效条目、修订提案队列、基点探索(未确认时叫知识草案)。 */
type DialogTab = "entries" | "proposals" | "exploration";

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
  /** 人点过的 tab。null 即还没点过,按数据推默认落点。 */
  const [pickedTab, setPickedTab] = useState<DialogTab | null>(null);
  /** 从意图行点过来要看的那条提案(issue #295)。null 即没有要高亮的。 */
  const [highlightProposal, setHighlightProposal] = useState<number | null>(null);
  const ruleSet = useQuery({
    queryKey: ["repo-rules", repo.repoId],
    queryFn: () => fetchJson<RuleSet>(`/repos/${repo.repoId}/rules`),
    // 探索、整理与修订意图都在服务端后台跑,结束时没人推给面板,弹窗开着就每 5 秒问
    // 一次,跑完即停。
    refetchInterval: (query) =>
      query.state.data?.exploration?.state === "running" ||
      query.state.data?.consolidation?.state === "running" ||
      (query.state.data?.intents ?? []).some((intent) => intent.state === "running")
        ? 5000
        : false,
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

  const data = ruleSet.data;
  const pendingCount = data?.proposals.filter((row) => row.state === "pending").length ?? 0;
  // 队列 tab 的可见性:有过提案就一直在(已裁决的留在里面供查),**现集非空时它同样出现**。
  // 知识整理的入口挂在这颗 tab 上,而整理在「现集非空、队列为空」时照样跑得动(服务端只在
  // 两样都空时短路,issue #285):跟着队列一起藏掉的话,那种局面下人根本发起不了整理。空队
  // 列那一档只对有 `knowledge:write` 的人开——只读的人在空队列上无事可做。
  const showProposals =
    data !== undefined && (data.proposals.length > 0 || (canWrite && data.rules.length > 0));
  // 未确认时完成知识确认是当前唯一要紧的事(issue #206 的门禁),默认落在草案 tab;
  // 其余默认落生效条目——弹窗叫「知识集」,先回答「现在按什么标准评审」。
  const fallbackTab = data !== undefined && data.version === null && canWrite
    ? "exploration"
    : "entries";
  const wanted = pickedTab ?? fallbackTab;
  const tab = (wanted === "proposals" && !showProposals) || (wanted === "exploration" && !canWrite)
    ? "entries"
    : wanted;

  return (
    // 标题与 tab 栏钉住,正文自己滚:提案与规则多起来(AI-API 一轮 29 条)会把弹窗撑出
    // 视口,标题和关闭全被推走(修复自部署实例的走查)。
    <Dialog.Content
      aria-describedby={undefined}
      maxWidth="880px"
      size={{ initial: "2", sm: "3" }}
      // 高度定死而不是随内容:三个 tab 的内容量差得远,跟着内容缩放的话每次切 tab
      // 整个弹窗都在跳。
      className="flex h-[min(820px,calc(100dvh-4.5rem))] flex-col overflow-hidden"
    >
      <Dialog.Title size="4" mb="1" className="shrink-0 pr-9 break-all">
        {repo.owner}/{repo.repo} 的知识集
      </Dialog.Title>
      {data === undefined ? null : typeof data.version === "number" ? (
        <Text as="p" size="1" color="gray" mb="2">
          知识集版本 {data.version}
        </Text>
      ) : (
        /* 门禁分代(issue #206):没有知识集版本即还没确认,这个仓库暂不执行 Review Run。
           默认 tab 就落在知识草案上,引导到位。 */
        <Text as="p" size="1" color="orange" mb="2">
          知识集未确认:完成知识确认前,这个仓库的投递只记录不审,面板也发起不了审查。
        </Text>
      )}

      {/* 意图框与意图列表在弹窗顶部,三个 tab 之上(ADR 0028):写下一段话是这个弹窗
          现在唯一的写入口,它不属于其中任何一个 tab。 */}
      {data === undefined ? null : (
        <IntentSection
          repo={repo}
          canWrite={canWrite}
          ruleSet={data}
          onChanged={reload}
          onShowProposal={(proposalId) => {
            setPickedTab("proposals");
            setHighlightProposal(proposalId);
          }}
        />
      )}

      {ruleSet.isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-live="polite">
          <span className="sr-only">正在读取知识集</span>
          {[0, 1].map((slot) => <Skeleton key={slot} className="h-14" />)}
        </div>
      ) : null}

      {ruleSet.isError || change.isError || changeDraft.isError || confirm.isError
        || decide.isError ? (
        <Callout.Root role="alert" color="red" size="1" mb="3" className="shrink-0">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>
            {((ruleSet.error ?? change.error ?? changeDraft.error ?? confirm.error ?? decide.error) as Error).message}
          </Callout.Text>
        </Callout.Root>
      ) : null}

      {data === undefined ? null : (
        <Tabs.Root
          value={tab}
          onValueChange={(next) => setPickedTab(next as DialogTab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          {/* 与模型服务详情同一套 tab 语法:3px 圆头指示条,底线通栏。 */}
          <Tabs.List size="2" className="shrink-0 shadow-[inset_0_-1px_0_0_var(--v8-border-chrome)]">
            <Tabs.Trigger value="entries" className={TAB_TRIGGER}>
              知识条目
              {data.rules.length > 0 ? (
                <Badge
                  color={tab === "entries" ? "blue" : "gray"}
                  variant="soft"
                  radius="full"
                  size="1"
                  className="ml-1.5 tabular-nums"
                >
                  {data.rules.length}
                </Badge>
              ) : null}
            </Tabs.Trigger>
            {showProposals ? (
              <Tabs.Trigger value="proposals" className={TAB_TRIGGER}>
                修订提案
                {/* 待裁决数是这颗 tab 的注意力信号,无论停在哪个 tab 都亮着。 */}
                {pendingCount > 0 ? (
                  <Badge color="amber" variant="soft" radius="full" size="1" className="ml-1.5 tabular-nums">
                    {pendingCount}
                  </Badge>
                ) : null}
              </Tabs.Trigger>
            ) : null}
            {canWrite ? (
              <Tabs.Trigger value="exploration" className={TAB_TRIGGER}>
                {data.version === null ? "知识草案" : "基点探索"}
                {data.exploration?.state === "running" ? (
                  <Badge color="blue" variant="soft" radius="full" size="1" className="ml-1.5">
                    进行中
                  </Badge>
                ) : data.version === null && data.draft.length > 0 ? (
                  <Badge color="amber" variant="soft" radius="full" size="1" className="ml-1.5 tabular-nums">
                    {data.draft.length}
                  </Badge>
                ) : null}
              </Tabs.Trigger>
            ) : null}
          </Tabs.List>

          <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pt-3">
            <Tabs.Content value="entries">
              {canWrite && data.draft.length === 0 ? (
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

              {data.rules.length === 0 ? (
                <EmptyState
                  title="这个仓库还没有知识条目"
                  titleAs="h3"
                  description="空知识集是合法状态:评审照常执行,只是没有知识注入。"
                />
              ) : null}

              <div className="flex flex-col gap-3.5">
                {/* 生效条目只按两型分段(ADR 0020),与修订提案区同一套语法。 */}
                {data.rules.some((entry) => entry.type === "rule") ? (
            <section className="flex flex-col gap-2">
              <div className="flex items-center gap-1">
                <h3 className="text-xs font-semibold text-text-muted">
                  {TYPE_LABEL.rule}
                  <span className="ml-1.5 font-normal">
                    {data.rules.filter((entry) => entry.type === "rule").length}
                  </span>
                </h3>
                <HelpTooltip content="评审规则说的是代码应当怎样,违反它即是一条 Finding。" />
              </div>
              <ul className="overflow-hidden rounded-lg border border-card-line">
                {data.rules
                  .filter((entry) => entry.type === "rule")
                  .map((rule) => (
                    <li key={rule.id} className="border-t border-line px-4 py-3 first:border-t-0">
                      {/* 陈述独占整行:长句不再被按钮挤着折行。元数据与操作合成底部
                          一条收尾线,操作靠右,行与行之间有稳定的对齐锚。 */}
                      <Text as="p" size="2" className="wrap-anywhere">{rule.statement}</Text>
                      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                        <Badge color="gray" variant="soft" className="min-w-0 shrink break-all whitespace-normal">
                          {rule.scope === "" ? "全仓库" : rule.scope}
                        </Badge>
                        {canWrite ? (
                          <div className="flex shrink-0 gap-1">
                            <Button
                              variant="outline"
                              color="gray"
                              highContrast
                              size={{ initial: "3", sm: "1" }}
                              className={OUTLINED_ACTION}
                              onClick={() => setDraft({ ...rule, id: rule.id })}
                            >
                              修改
                            </Button>
                            <Button
                              variant="outline"
                              color="gray"
                              highContrast
                              size={{ initial: "3", sm: "1" }}
                              className={OUTLINED_ACTION}
                              disabled={change.isPending}
                              onClick={() => change.mutate({ retire: rule.id })}
                            >
                              废止
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
              </ul>
            </section>
          ) : null}

                {data.rules.some((entry) => entry.type === "fact") ? (
            <section className="flex flex-col gap-2">
              <div className="flex items-center gap-1">
                <h3 className="text-xs font-semibold text-text-muted">
                  {TYPE_LABEL.fact}
                  <span className="ml-1.5 font-normal">
                    {data.rules.filter((entry) => entry.type === "fact").length}
                  </span>
                </h3>
                <HelpTooltip content="项目事实是 Reviewer 的判断依据,本身不产 Finding;与代码矛盾时以代码为准。" />
              </div>
              <ul className="overflow-hidden rounded-lg border border-card-line">
                {data.rules
                  .filter((entry) => entry.type === "fact")
                  .map((fact) => (
                    <li key={fact.id} className="border-t border-line px-4 py-3 first:border-t-0">
                      <Text as="p" size="2" className="wrap-anywhere">{fact.statement}</Text>
                      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                        <Badge color="gray" variant="soft" className="min-w-0 shrink break-all whitespace-normal">
                          {fact.scope === "" ? "全仓库" : fact.scope}
                        </Badge>
                        {canWrite ? (
                          <div className="flex shrink-0 gap-1">
                            <Button
                              variant="outline"
                              color="gray"
                              highContrast
                              size={{ initial: "3", sm: "1" }}
                              className={OUTLINED_ACTION}
                              onClick={() => setDraft({ ...fact, id: fact.id })}
                            >
                              修改
                            </Button>
                            <Button
                              variant="outline"
                              color="gray"
                              highContrast
                              size={{ initial: "3", sm: "1" }}
                              className={OUTLINED_ACTION}
                              disabled={change.isPending}
                              onClick={() => change.mutate({ retire: fact.id })}
                            >
                              废止
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
              </ul>
            </section>
                ) : null}

                {/* 废止的不再生效但仍要查得到(issue #203):收进折叠,与已裁决同一语法。 */}
                {data.retired.length === 0 ? null : (
                  <details>
                    <summary className="cursor-pointer text-sm text-text-secondary">
                      已废止 {data.retired.length} 条
                    </summary>
                    <ul className="mt-2 overflow-hidden rounded-lg border border-card-line">
                      {data.retired.map((rule) => (
                        <li key={rule.id} className="border-t border-line px-4 py-3 first:border-t-0">
                          <Text as="p" size="2" color="gray" className="line-through wrap-anywhere">
                            {rule.statement}
                          </Text>
                          <span className="mt-1.5 inline-block">
                            {/* 废止的那一条也要说得出它是哪一型。 */}
                            <Badge color="gray" variant="soft">{TYPE_LABEL[rule.type]}</Badge>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            </Tabs.Content>

            {showProposals ? (
              <Tabs.Content value="proposals">
                <ProposalSection
                  repo={repo}
                  ruleSet={data}
                  canWrite={canWrite}
                  edit={proposalEdit}
                  busy={decide.isPending}
                  highlight={highlightProposal}
                  onEdit={setProposalEdit}
                  onChanged={reload}
                  onDecide={(id, accept) => decide.mutate({ id, accept })}
                  onDecideAll={(ids, accept) => decide.mutate({ ids, accept })}
                  onSubmitEdit={() =>
                    decide.mutate({ id: proposalEdit!.id!, accept: true, edit: proposalEdit! })
                  }
                />
              </Tabs.Content>
            ) : null}

            {canWrite ? (
              <Tabs.Content value="exploration">
                <ExplorationSection
                  repo={repo}
                  ruleSet={data}
                  draft={draftEdit}
                  busy={changeDraft.isPending || confirm.isPending}
                  onLaunched={reload}
                  onEdit={setDraftEdit}
                  onSubmitEdit={() => changeDraft.mutate(draftEdit!)}
                  onDeleteDraft={(id) => changeDraft.mutate({ deleteDraft: id })}
                  onConfirm={(itemIds) => confirm.mutate(itemIds)}
                />
              </Tabs.Content>
            ) : null}
          </div>
        </Tabs.Root>
      )}

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

const CHANGE_LABEL = { add: "新增", modify: "修改", retire: "废止", merge: "合并" } as const;

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
    merge: "采纳了合并提案,目标已换成合成的那一条",
  },
  rejected: {
    add: "驳回了新增提案",
    modify: "驳回了修改提案,条目保持原样",
    retire: "驳回了废止提案,条目保留",
    merge: "驳回了合并提案,目标条目保持原样",
  },
} as const satisfies Record<"accepted" | "rejected", Record<RuleProposal["change"], string>>;

/**
 * 一条提案的出处一行汇总(issue #281):同一个来源出现多次即带次数。人先看见「它被
 * 哪几件事提过」,要逐条读再展开。
 */
function sourceSummary(sources: readonly RuleProposalSource[]): string {
  const counts = new Map<string, number>();
  for (const entry of sources) counts.set(entry.origin, (counts.get(entry.origin) ?? 0) + 1);
  return [...counts]
    .map(([origin, count]) => `${SOURCE_LABEL[origin] ?? origin}${count > 1 ? ` ×${count}` : ""}`)
    .join(" · ");
}

/**
 * 提案卡片上的出处那一段(CONTEXT.md 出处附注,issue #281)。收起时是一行汇总,展开
 * 逐条:来源、备注原文、那条 Finding 与提出它的那一次知识轨迹。
 *
 * Finding 走既有的 `?finding=` 侧滑:点进去就是那条 Finding 的 diff,人看得出这条提案
 * 是从哪条 Finding 的处置备注来的。
 */
function ProposalSources({ repoId, proposal }: { repoId: number; proposal: RuleProposal }) {
  if (proposal.sources.length === 0) return null;
  return (
    <details className="mt-1.5">
      <summary className="cursor-pointer text-xs text-text-secondary">
        出处:{sourceSummary(proposal.sources)}
      </summary>
      <ul className="mt-1.5 flex flex-col gap-2 border-l border-line pl-3">
        {proposal.sources.map((entry) => (
          <li key={entry.id} className="flex min-w-0 flex-col gap-1">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Badge color="gray" variant="soft">
                {SOURCE_LABEL[entry.origin] ?? entry.origin}
              </Badge>
              {entry.findingId === null || entry.findingStageId === null ? null : (
                <Link
                  to="/stages/$stageId"
                  params={{ stageId: entry.findingStageId }}
                  search={{ finding: entry.findingId }}
                  className={`${OUTLINED_ACTION} px-2 py-1 text-sm text-text-secondary hover:bg-sunken`}
                >
                  查看 Finding
                </Link>
              )}
              {entry.traceTaskId === null ? null : (
                <RuleTraceButton
                  repoId={repoId}
                  taskId={entry.traceTaskId}
                  context={`来自提案:${proposal.statement}`}
                  highlight={proposal.statement}
                />
              )}
            </span>
            {entry.note === null ? null : (
              <Text as="p" size="1" color="gray" className="wrap-anywhere">
                备注:{entry.note}
              </Text>
            )}
            {/* 依据(issue #287):陈述只留那一句结论,凭什么成立在这里。为空即不显示。 */}
            {entry.evidence === null ? null : (
              <Text as="p" size="1" color="gray" className="wrap-anywhere">
                依据:{entry.evidence}
              </Text>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * 修订提案队列与裁决那一段(issue #207)。待裁决的排在前面,已裁决的留在后面供查。
 *
 * 队列本身对所有读得到知识集的人可见——「还有什么在等人裁决」与「现在按什么标准评审」
 * 是同一个问题的两半;采纳与驳回按 `knowledge:write` 出现。
 */
/** 一条修订意图的原文上限,与服务端同一个数:超了服务端 400,表单先拦一道。 */
const INTENT_TEXT_LIMIT = 500;

const INTENT_STATE_LABEL = {
  running: "运行中",
  failed: "失败",
  completed: "已完成",
} as const;

/**
 * 意图框(CONTEXT.md 修订意图,ADR 0028,issue #294、#295)。弹窗顶部那一个与待裁决提案
 * 卡片上「改写」展开的那一个是同一个组件,**目标由调用方给**:目标决定的只有提交时带不
 * 带 `target` 与框里那句提示语,字数、置灰与提交那几道判据两处必须一样。
 */
function IntentForm({
  repoId,
  intentModel,
  placeholder,
  target,
  onSubmitted,
  onCancel,
}: {
  repoId: number;
  intentModel: string | null;
  placeholder: string;
  /** 这条意图指向什么。缺席即无目标(产新增)。 */
  target?: { kind: "proposal"; id: number };
  onSubmitted: () => void;
  /** 就地展开的那一个给一颗取消;顶部那一个常驻,不给。 */
  onCancel?: () => void;
}) {
  const [text, setText] = useState("");
  const fieldId = useId();
  const noModel = intentModel === null;

  const submit = useMutation({
    mutationFn: async (): Promise<void> => {
      const response = await api(`/repos/${repoId}/revision-intents`, {
        method: "POST",
        body: JSON.stringify({
          text: text.trim(),
          ...(target === undefined ? {} : { target }),
        }),
      });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: () => {
      setText("");
      onSubmitted();
    },
  });

  const trimmed = text.trim();
  const tooLong = trimmed.length > INTENT_TEXT_LIMIT;

  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed !== "" && !tooLong && !noModel && !submit.isPending) submit.mutate();
        }}
      >
        <TextArea
          id={fieldId}
          value={text}
          disabled={noModel}
          onChange={(event) => setText(event.target.value)}
          placeholder={placeholder}
          rows={2}
          size="2"
        />
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
          <Text as="span" size="1" color={tooLong ? "red" : "gray"} className="tabular-nums">
            {noModel
              ? "还没有可用的模型：先配一个模型凭据，或为这个仓库跑一次基点探索。"
              : `${trimmed.length} / ${INTENT_TEXT_LIMIT} 字`}
          </Text>
          <div className="flex flex-wrap items-center gap-2">
            {onCancel === undefined ? null : (
              <Button
                type="button"
                variant="outline"
                color="gray"
                highContrast
                size={{ initial: "3", sm: "1" }}
                className={OUTLINED_ACTION}
                onClick={onCancel}
              >
                取消
              </Button>
            )}
            <Button
              type="submit"
              size={{ initial: "3", sm: "1" }}
              disabled={trimmed === "" || tooLong || noModel || submit.isPending}
            >
              {submit.isPending ? "提交中…" : "提交意图"}
            </Button>
          </div>
        </div>
      </form>

      {submit.isError ? (
        <Callout.Root role="alert" color="red" size="1" mt="2">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{(submit.error as Error).message}</Callout.Text>
        </Callout.Root>
      ) : null}
    </>
  );
}

/**
 * 修订意图那一块(CONTEXT.md 修订意图,ADR 0028,issue #294):一个意图框加一列意图行。
 *
 * 框只对有 `knowledge:write` 的人出现——没有这一格的人提不了意图。列表所有人都看得到:
 * 知识集怎么变的对能看这个仓库的人都透明。
 */
function IntentSection({
  repo,
  canWrite,
  ruleSet,
  onChanged,
  onShowProposal,
}: {
  repo: { repoId: number; owner: string; repo: string };
  canWrite: boolean;
  ruleSet: RuleSet;
  onChanged: () => void;
  /** 点意图行上的目标引用:切到队列 tab 并高亮那张卡片(issue #295)。 */
  onShowProposal: (proposalId: number) => void;
}) {
  const remove = useMutation({
    mutationFn: async (intentId: number): Promise<void> => {
      const response = await api(`/repos/${repo.repoId}/revision-intents/${intentId}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: onChanged,
  });

  if (!canWrite && ruleSet.intents.length === 0) return null;

  return (
    <div className="mb-3 shrink-0 flex flex-col gap-2">
      {canWrite ? (
        <IntentForm
          repoId={repo.repoId}
          intentModel={ruleSet.intentModel}
          placeholder="写下要新增或改成什么样，agent 会读代码并按陈述形状提出一条修订提案"
          onSubmitted={onChanged}
        />
      ) : null}

      {remove.isError ? (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{(remove.error as Error).message}</Callout.Text>
        </Callout.Root>
      ) : null}

      {ruleSet.intents.length === 0 ? null : (
        <ul className="overflow-hidden rounded-lg border border-card-line">
          {ruleSet.intents.map((intent) => (
            <li
              key={intent.id}
              className="flex flex-col gap-1 border-t border-line px-3 py-2 first:border-t-0"
            >
              <Text as="p" size="2" className="wrap-anywhere">{intent.text}</Text>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {/* 来源徽章(issue #296):处置备注那一行与人在弹窗里写的那一行同形,人要
                    一眼分得出这段话是谁在哪写下的。 */}
                <Badge color="gray" variant="soft" radius="full" size="1">
                  {intent.targetKind === "finding" ? SOURCE_LABEL["disposition-feedback"] : SOURCE_LABEL["manual-proposal"]}
                </Badge>
                <Badge
                  color={
                    intent.state === "running" ? "blue" : intent.state === "failed" ? "red" : "gray"
                  }
                  variant="soft"
                  radius="full"
                  size="1"
                >
                  {INTENT_STATE_LABEL[intent.state]}
                </Badge>
                <Text as="span" size="1" color="gray">
                  {intent.submittedBy}
                  {intent.model === null ? null : ` · 模型 ${intent.model}`}
                  {intent.thinkingLevel === null
                    ? null
                    : ` · 思考 ${THINKING_LEVEL_LABEL[intent.thinkingLevel]}`}
                </Text>
                {/* 目标引用(issue #295):点它切到队列 tab 并滚到那张卡片,不另开一页
                    ——改写与被改写的那一条本来就在同一个弹窗里。 */}
                {intent.targetKind === "proposal" && intent.targetId !== null ? (
                  <Button
                    variant="outline"
                    color="gray"
                    highContrast
                    size={{ initial: "3", sm: "1" }}
                    className={OUTLINED_ACTION}
                    onClick={() => onShowProposal(intent.targetId!)}
                  >
                    改写提案 #{intent.targetId}
                  </Button>
                ) : null}
                {/* 反哺那一行的 Finding 引用(issue #296):走提案出处上那个既有的
                    `?finding=` 侧滑,人点进去就是那条 Finding 的 diff。 */}
                {intent.targetKind === "finding" &&
                intent.targetId !== null &&
                intent.targetStageId !== null ? (
                  <Link
                    to="/stages/$stageId"
                    params={{ stageId: intent.targetStageId }}
                    search={{ finding: intent.targetId }}
                    className={`${OUTLINED_ACTION} px-2 py-1 text-sm text-text-secondary hover:bg-sunken`}
                  >
                    查看 Finding
                  </Link>
                ) : null}
                {intent.traceTaskId === null ? null : (
                  <RuleTraceButton
                    repoId={repo.repoId}
                    taskId={intent.traceTaskId}
                    context={intent.text}
                  />
                )}
                {canWrite && intent.state !== "running" ? (
                  <Button
                    variant="outline"
                    color="gray"
                    highContrast
                    size={{ initial: "3", sm: "1" }}
                    className={OUTLINED_ACTION}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(intent.id)}
                  >
                    删除
                  </Button>
                ) : null}
              </div>
              {intent.state === "completed" && intent.summary !== null ? (
                <Text as="p" size="1" color="gray" className="wrap-anywhere">
                  {intent.summary}
                  {intent.produced.proposalIds.length > 0
                    ? ` · 产出 ${intent.produced.proposalIds.length} 条修订提案`
                    : intent.produced.draftItemIds.length > 0
                      ? ` · 产出 ${intent.produced.draftItemIds.length} 条草案条目`
                      : ""}
                </Text>
              ) : null}
              {intent.state === "failed" && intent.failure !== null ? (
                <Callout.Root role="alert" color="red" size="1">
                  <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
                  <Callout.Text>{intent.failure}</Callout.Text>
                </Callout.Root>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProposalSection({
  repo,
  ruleSet,
  canWrite,
  edit,
  busy,
  highlight,
  onEdit,
  onDecide,
  onDecideAll,
  onSubmitEdit,
  onChanged,
}: {
  repo: { repoId: number; owner: string; repo: string };
  ruleSet: RuleSet;
  canWrite: boolean;
  edit: RuleFormState | null;
  busy: boolean;
  /** 从意图行点过来的那条提案(issue #295):滚到它并高亮。 */
  highlight: number | null;
  onEdit: (draft: RuleFormState | null) => void;
  onDecide: (id: number, accept: boolean) => void;
  onDecideAll: (ids: readonly number[], accept: boolean) => void;
  onSubmitEdit: () => void;
  onChanged: () => void;
}) {
  // 就地展开意图框的那条提案(issue #295)。一次只展开一条:两张框同时开着人分不清写的
  // 是哪一条。
  const [rewriting, setRewriting] = useState<number | null>(null);
  // 从意图行点过来时滚到那张卡片。切 tab 那一下这一段才挂上,因此按 `highlight` 变化滚,
  // 不按渲染滚——渲染每五秒一次(队列在轮询),每次都滚会把人拽走。
  useEffect(() => {
    if (highlight === null) return;
    document.getElementById(`rule-proposal-card-${highlight}`)?.scrollIntoView({ block: "center" });
  }, [highlight]);
  const pending = ruleSet.proposals.filter((row) => row.state === "pending");
  const decided = ruleSet.proposals.filter((row) => row.state !== "pending");
  // 提案默认一条不勾:采纳是改变知识集的动作,该由人一条条挑,不该默认全中。
  const pick = useSelection(pending.map((row) => row.id), false);
  // 刚完成的意图产出的提案(issue #294)。判据取意图行自己的产出列表:附注的来源说得出
  // 「这条曾由人工提议提过」,说不出「是刚才那一次」,而人回到队列要找的是刚才那几条。
  const fromIntent = new Set(
    ruleSet.intents.flatMap((intent) =>
      intent.state === "completed" ? intent.produced.proposalIds : [],
    ),
  );
  /**
   * 这条提案指向的现有条目那一段:新增没有,修改与废止一条,合并几条(issue #282)。
   * 合并逐条给陈述与作用范围——人要看清被合掉的是哪几条。已经不在生效条目里的只显示
   * 标识,采纳那时它落不下去,人要先看得出是哪一条没了。
   */
  const targets = (proposal: RuleProposal): ReactNode => {
    const rows = proposal.targetRuleIds.map((id) => {
      const rule = ruleSet.rules.find((entry) => entry.id === id);
      return rule === undefined
        ? { id, label: `知识条目 ${id}(已不生效)`, scope: "", type: null }
        : { id, label: rule.statement, scope: rule.scope === "" ? "全仓库" : rule.scope, type: rule.type };
    });
    if (rows.length === 0) return null;
    // 合并的型由新陈述定(CONTEXT.md 修订提案,issue #289):有一条目标的型与提案不同就
    // 多一句说清换的是哪一型——「合并」这个词本身看不出这一次改的是型。单目标的合并即
    // 改型,多目标的合并(两条事实合成一条规则)同样改型,验收时正是后一种被漏掉。目标
    // 两型混杂时说不出「从哪一型」,只写合成后是哪一型。
    const fromTypes = [...new Set(rows.flatMap((row) => (row.type === null ? [] : [row.type])))];
    const retyped =
      proposal.change === "merge" && fromTypes.some((type) => type !== proposal.type)
        ? fromTypes.length === 1
          ? `改型:${TYPE_LABEL[fromTypes[0]!]} → ${TYPE_LABEL[proposal.type]}`
          : `改型:合成后为${TYPE_LABEL[proposal.type]}`
        : null;
    const retypedLine =
      retyped === null ? null : (
        <Text as="p" size="1" color="gray">
          {retyped}
        </Text>
      );
    if (rows.length === 1) {
      return (
        <>
          <Text as="p" size="1" color="gray" className="mt-1.5 wrap-anywhere">
            目标知识条目:{rows[0]!.label}
          </Text>
          {retypedLine}
        </>
      );
    }
    return (
      <div className="mt-1.5">
        <Text as="p" size="1" color="gray">
          目标知识条目({rows.length} 条):
        </Text>
        <ul className="mt-0.5 list-disc pl-4">
          {rows.map((row) => (
            <li key={row.id}>
              <Text as="span" size="1" color="gray" className="wrap-anywhere">
                {row.label}
                {row.scope === "" ? null : `(${row.scope})`}
              </Text>
            </li>
          ))}
        </ul>
        {retypedLine}
      </div>
    );
  };

  return (
    // tab 本身已经叫「修订提案」,这里不再立一层大标题,头行直接是队列状态与批量动作。
    <section className="flex flex-col gap-2" aria-label="修订提案">
      {/* 知识整理改的就是这份队列(issue #284),入口因此挨着它,不另开一个 tab。 */}
      {canWrite ? <ConsolidationRow repo={repo} consolidation={ruleSet.consolidation} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <h3 className="text-xs font-semibold text-text-muted">
            待裁决
            <span className="ml-1.5 font-normal">{pending.length}</span>
          </h3>
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
              variant="solid"
              size={{ initial: "3", sm: "1" }}
              disabled={busy || pick.selected.length === 0}
              onClick={() => onDecideAll(pick.selected, true)}
            >
              采纳勾选的 {pick.selected.length} 条
            </Button>
            <Button
              variant="outline"
              color="gray"
              highContrast
              size={{ initial: "3", sm: "1" }}
              className={OUTLINED_ACTION}
              disabled={busy || pick.selected.length === 0}
              onClick={() => onDecideAll(pick.selected, false)}
            >
              驳回
            </Button>
          </div>
        ) : null}
      </div>

      {pending.length === 0 ? (
        <Text as="p" size="2" color="gray">没有待裁决的提案。</Text>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-card-line">
          {pending.map((proposal) => (
            <li
              key={proposal.id}
              id={`rule-proposal-card-${proposal.id}`}
              className={`flex items-start gap-2 border-t border-line px-4 py-3 first:border-t-0 ${
                highlight === proposal.id ? "bg-accent-tint" : ""
              }`}
            >
              {/* 勾选框独立成列,陈述、目标条目、备注与收尾线共用一条左边缘;陈述
                  独占整行宽度,不再与按钮簇抢同一行。htmlFor 保住整句可点勾选。 */}
              {canWrite ? (
                <Checkbox
                  id={`rule-proposal-${proposal.id}`}
                  checked={pick.picked.has(proposal.id)}
                  onCheckedChange={(next) => pick.toggle(proposal.id, next === true)}
                  size={{ initial: "2", sm: "1" }}
                  className="mt-0.5"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                {canWrite ? (
                  <Text
                    as="label"
                    htmlFor={`rule-proposal-${proposal.id}`}
                    size="2"
                    className="block wrap-anywhere"
                  >
                    {proposal.statement}
                  </Text>
                ) : (
                  <Text as="p" size="2" className="wrap-anywhere">{proposal.statement}</Text>
                )}
                {targets(proposal)}
                <ProposalSources repoId={repo.repoId} proposal={proposal} />
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
                    {/* 采纳的后果两型不同(issue #222):规则违反即 Finding,事实只作判断依据。 */}
                    <Badge color="gray" variant="soft">{TYPE_LABEL[proposal.type]}</Badge>
                    <Badge color="gray" variant="soft">{CHANGE_LABEL[proposal.change]}</Badge>
                    <Badge color="gray" variant="soft" className="min-w-0 shrink break-all whitespace-normal">
                      {proposal.scope === "" ? "全仓库" : proposal.scope}
                    </Badge>
                    {/* 刚完成的意图产出的那几条(issue #294):人写完意图回到队列,要一眼
                        认出该去裁决哪一条。十分钟窗口过后意图不再列出,徽章跟着消失。 */}
                    {fromIntent.has(proposal.id) ? (
                      <Badge color="amber" variant="soft">刚由意图产出</Badge>
                    ) : null}
                  </span>
                  {canWrite && edit?.id !== proposal.id ? (
                    <div className="flex shrink-0 gap-1">
                      {/* 「改写」就地展开与顶部同一个意图框(ADR 0028,issue #295):人写
                          一句话,agent 换陈述与作用范围并追加一条附注。废止型没有这一颗
                          ——它说的就是废止哪一条,改不出别的内容。 */}
                      {proposal.change === "retire" ? null : (
                        <Button
                          variant="outline"
                          color="gray"
                          highContrast
                          size={{ initial: "3", sm: "1" }}
                          className={OUTLINED_ACTION}
                          onClick={() =>
                            setRewriting((open) => (open === proposal.id ? null : proposal.id))
                          }
                        >
                          改写
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        color="gray"
                        highContrast
                        size={{ initial: "3", sm: "1" }}
                        className={OUTLINED_ACTION}
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
                        variant="outline"
                        color="gray"
                        highContrast
                        className={OUTLINED_ACTION}
                        size={{ initial: "3", sm: "1" }}
                        disabled={busy}
                        onClick={() => onDecide(proposal.id, true)}
                      >
                        采纳
                      </Button>
                      <Button
                        variant="outline"
                        color="gray"
                        highContrast
                        size={{ initial: "3", sm: "1" }}
                        className={OUTLINED_ACTION}
                        disabled={busy}
                        onClick={() => onDecide(proposal.id, false)}
                      >
                        驳回
                      </Button>
                    </div>
                  ) : null}
                </div>
                {rewriting === proposal.id ? (
                  <div className="mt-2">
                    <IntentForm
                      repoId={repo.repoId}
                      intentModel={ruleSet.intentModel}
                      placeholder="写下这一条要改成什么样，agent 会读代码并原地改写它，追加一条出处附注"
                      target={{ kind: "proposal", id: proposal.id }}
                      onSubmitted={() => {
                        setRewriting(null);
                        onChanged();
                      }}
                      onCancel={() => setRewriting(null)}
                    />
                  </div>
                ) : null}
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
              </div>
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
                <Text as="p" size="2" color="gray" className="wrap-anywhere">{proposal.statement}</Text>
                <span className="mt-1.5 inline-flex flex-wrap items-center gap-1.5">
                  {/* 短语已经带上变更类型,同行不再挂 CHANGE_LABEL 徽章:那枚徽章与
                      短语说的是同一件事,并排只会把人读回「条目被驳回」那个误解。 */}
                  <StatusBadge tone={proposal.state === "accepted" ? "success" : "neutral"}>
                    {proposal.state === "accepted"
                      ? DECISION_LABEL.accepted[proposal.change]
                      : DECISION_LABEL.rejected[proposal.change]}
                  </StatusBadge>
                  <Badge color="gray" variant="soft">{TYPE_LABEL[proposal.type]}</Badge>
                </span>
                {/* 裁决过的那些同样看得到出处:队列历史要说得出它当初被哪几件事提过。 */}
                <ProposalSources repoId={repo.repoId} proposal={proposal} />
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
    // tab 本身已经命名这一段,头行直接是探索状态与发起按钮,不再立一层大标题。
    <section className="flex flex-col gap-2" aria-label={confirmed ? "基点探索" : "知识草案"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {exploration === null ? (
            <Text as="span" size="1" color="gray">还没探索过这个仓库</Text>
          ) : (
            <>
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
            </>
          )}
          <HelpTooltip
            content={
              confirmed
                ? "知识集已经确认,再次探索的产出排进「修订提案」,由你逐条裁决。"
                : "基点探索让 agent 从一个 commit 上的代码推导评审规则与项目事实的初稿,由你勾选后整组确认。"
            }
          />
        </div>
        <ExplorationLaunch repo={repo} busy={running} onLaunched={onLaunched} />
      </div>

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
            <li key={rule.id} className="flex items-start gap-2 border-t border-line px-4 py-3 first:border-t-0">
              {/* 没勾的那些不进知识集,随草案一并丢弃(issue #223)。行结构与修订提案
                  同一套:勾选框独立成列,陈述整行,元数据与操作合成底部收尾线。 */}
              <Checkbox
                id={`rule-draft-${rule.id}`}
                checked={pick.picked.has(rule.id)}
                onCheckedChange={(next) => pick.toggle(rule.id, next === true)}
                size={{ initial: "2", sm: "1" }}
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1">
                <Text
                  as="label"
                  htmlFor={`rule-draft-${rule.id}`}
                  size="2"
                  className="block wrap-anywhere"
                >
                  {rule.statement}
                </Text>
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    {/* 草案里两型并列(ADR 0020),确认时一起进知识集,徽章要分得出哪条是哪型。 */}
                    <Badge color="gray" variant="soft">{TYPE_LABEL[rule.type]}</Badge>
                    <Badge color="gray" variant="soft" className="min-w-0 shrink break-all whitespace-normal">
                      {rule.scope === "" ? "全仓库" : rule.scope}
                    </Badge>
                  </span>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="outline"
                      color="gray"
                      highContrast
                      size={{ initial: "3", sm: "1" }}
                      className={OUTLINED_ACTION}
                      onClick={() => onEdit({ ...rule, id: rule.id })}
                    >
                      修改
                    </Button>
                    <Button
                      variant="outline"
                      color="gray"
                      highContrast
                      size={{ initial: "3", sm: "1" }}
                      className={OUTLINED_ACTION}
                      disabled={busy}
                      onClick={() => onDeleteDraft(rule.id)}
                    >
                      删除
                    </Button>
                  </div>
                </div>
              </div>
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

/**
 * 发起表单里的模型与思考档位那两格(issue #284)。基点探索与知识整理共用:两者选的是同
 * 一份可用模型,档位判据也只有一套——各写一份就会在其中一处漏掉「只列这个模型支持的档位」。
 */
function useRuleModelChoice(): {
  available: RuleModel[];
  model: string;
  setModel: (next: string) => void;
  setThinkingLevel: (next: ThinkingLevel) => void;
  levels: ThinkingLevel[];
  /** 实际会发出去的那一档:所选模型不支持人选的那一档时落回它自己的第一档。 */
  level: ThinkingLevel;
  /** 只有「关闭」一档即这个模型不支持思考档位。 */
  picking: boolean;
} {
  const [model, setModel] = useState<string>("");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("off");
  const models = useQuery({
    queryKey: ["rule-models"],
    queryFn: () => fetchJson<{ models: RuleModel[] }>("/rule-models"),
  });
  const available = models.data?.models ?? [];
  useEffect(() => {
    if (model !== "" || available.length === 0) return;
    setModel(available[0]!.identity);
  }, [available, model]);
  // 档位只在所选模型支持的那几档里取:换了模型而旧档位它不支持时落回它自己的第一档,
  // 免得发起时被服务端拒。选中的那一档不另存一份状态,由这里推出来。
  const levels = available.find((entry) => entry.identity === model)?.thinkingLevels ?? [];
  const level = levels.includes(thinkingLevel) ? thinkingLevel : levels[0] ?? "off";
  return { available, model, setModel, setThinkingLevel, levels, level, picking: levels.length > 1 };
}

/** 上面那份选择的两格控件。`id` 是这份表单的前缀,同一页开两个弹窗时标签各指各的。 */
function RuleModelFields({
  id,
  choice,
  hint,
}: {
  id: string;
  choice: ReturnType<typeof useRuleModelChoice>;
  /** 思考档位那一格的说明,两条链路各说各的那一句。 */
  hint: string;
}) {
  const { available, model, setModel, setThinkingLevel, levels, level, picking } = choice;
  return (
    <div className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
      <Text as="label" htmlFor={`${id}-model`} size="2" weight="medium">模型</Text>
      <Select.Root value={model} onValueChange={setModel} size={{ initial: "3", sm: "2" }}>
        <Select.Trigger id={`${id}-model`} placeholder="选择一个可用模型" />
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
          {...(picking ? { htmlFor: `${id}-thinking` } : {})}
          size="2"
          weight="medium"
        >
          思考档位
        </Text>
        <HelpTooltip content={hint} />
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
            <Select.Trigger id={`${id}-thinking`} />
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
  const [error, setError] = useState<string | null>(null);
  const choice = useRuleModelChoice();
  const { available, model, level } = choice;
  const query = `owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.repo)}`;

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
          <RuleModelFields
            id="rule-exploration"
            choice={choice}
            hint="档位越高,agent 推导规则前想得越久,这一次探索也越慢越贵。"
          />
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

/**
 * 知识整理的状态行与发起入口(CONTEXT.md 知识整理,issue #284)。三态、失败原因、轨迹
 * 入口与摘要都与基点探索同形;摘要那一句说的是这一次把队列改成了什么样。
 *
 * 它挂在修订提案队列的头上而不是探索那一段:整理改的就是这份队列。
 */
function ConsolidationRow({
  repo,
  consolidation,
}: {
  repo: { repoId: number; owner: string; repo: string };
  consolidation: RuleConsolidation | null;
}) {
  const running = consolidation?.state === "running";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {consolidation === null ? (
            <Text as="span" size="1" color="gray">还没整理过这个队列</Text>
          ) : (
            <>
              <Text as="span" size="1" color="gray">
                {running
                  ? "正在整理"
                  : consolidation.state === "failed"
                    ? "上次整理失败"
                    : // 两半分开说:前两个数是对队列的直改,后一个是对现集提出的提案——提案自己
                      // 也可以是合并型,与「并掉几条提案」不是一回事,并排写成三个数会读串。
                      `已完成整理 · 队列:并掉 ${consolidation.merged ?? 0} 条提案、改写 ${consolidation.retargeted ?? 0} 条为修改型 · 现集:提出 ${consolidation.proposed ?? 0} 条提案`}
                {" · "}模型 {consolidation.model}
                {consolidation.thinkingLevel === null
                  ? null
                  : ` · 思考 ${THINKING_LEVEL_LABEL[consolidation.thinkingLevel]}`}
              </Text>
              {consolidation.traceTaskId === null ? null : (
                <RuleTraceButton repoId={repo.repoId} taskId={consolidation.traceTaskId} />
              )}
            </>
          )}
          <HelpTooltip content="知识整理让 agent 读这份队列与当前生效的知识集:说同一件事的提案合成一条,现集已经有的新增改成指向那条的修改。它不替你裁决。" />
        </div>
        <ConsolidationLaunch repo={repo} busy={running} />
      </div>

      {consolidation?.state === "failed" && consolidation.failure !== null ? (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{consolidation.failure}</Callout.Text>
        </Callout.Root>
      ) : null}
    </div>
  );
}

/** 发起知识整理:只选模型——整理读的是队列与现集,没有基点可选。 */
function ConsolidationLaunch({
  repo,
  busy,
}: {
  repo: { repoId: number; owner: string; repo: string };
  busy: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button variant="soft" size={{ initial: "3", sm: "2" }} disabled={busy}>
          {busy ? "正在整理…" : "知识整理"}
        </Button>
      </Dialog.Trigger>
      {open ? (
        <ConsolidationLaunchContent
          key={`${repo.owner}/${repo.repo}`}
          repo={repo}
          onLaunched={() => {
            void queryClient.invalidateQueries({ queryKey: ["repo-rules", repo.repoId] });
            setOpen(false);
          }}
        />
      ) : null}
    </Dialog.Root>
  );
}

function ConsolidationLaunchContent({
  repo,
  onLaunched,
}: {
  repo: { repoId: number; owner: string; repo: string };
  onLaunched: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const choice = useRuleModelChoice();
  const { available, model, level } = choice;

  const start = useMutation({
    mutationFn: async (): Promise<void> => {
      const picked = available.find((entry) => entry.identity === model);
      if (picked === undefined) throw new Error("先选一个可用模型");
      const response = await api(`/repos/${repo.repoId}/rule-consolidation`, {
        method: "POST",
        body: JSON.stringify({
          provider: picked.provider,
          model: picked.model,
          // 「关闭」不带这一项:缺席即关闭,与发起探索同一条口径。
          ...(level === "off" ? {} : { thinkingLevel: level }),
        }),
      });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: onLaunched,
    onError: (failure: Error) => setError(failure.message),
  });

  return (
    <Dialog.Content aria-describedby={undefined} maxWidth="520px" size={{ initial: "2", sm: "3" }}>
      <form
        aria-busy={start.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          if (model !== "" && !start.isPending) start.mutate();
        }}
      >
        <Dialog.Title size="4" mb="0" className="pr-10">
          发起知识整理
          <span className="ml-2 break-all text-md font-normal text-text-secondary">
            {repo.owner}/{repo.repo}
          </span>
        </Dialog.Title>
        <RuleModelFields
          id="rule-consolidation"
          choice={choice}
          hint="档位越高,agent 判断两条提案是不是同一件事时想得越久,这一次整理也越慢越贵。"
        />
        {error === null ? null : (
          <p role="alert" className="mt-3 break-words text-sm text-danger">{error}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Dialog.Close>
            <Button type="button" variant="soft" color="gray" size={{ initial: "3", sm: "2" }}>
              取消
            </Button>
          </Dialog.Close>
          <Button
            type="submit"
            size={{ initial: "3", sm: "2" }}
            disabled={model === "" || start.isPending}
          >
            {start.isPending ? "发起中…" : "开始整理"}
          </Button>
        </div>
      </form>
      <div className="absolute top-2.5 right-2.5 sm:top-3.5 sm:right-3.5">
        <Dialog.Close>
          <IconButton
            variant="ghost"
            color="gray"
            size="3"
            className="max-sm:min-h-11 max-sm:min-w-11"
            aria-label="关闭发起知识整理"
          >
            <Cross2Icon aria-hidden />
          </IconButton>
        </Dialog.Close>
      </div>
    </Dialog.Content>
  );
}
