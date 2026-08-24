import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeftIcon, CheckCircledIcon, Cross2Icon, CrossCircledIcon, ExclamationTriangleIcon, UpdateIcon } from "@radix-ui/react-icons";
import { AlertDialog, Callout, Dialog, Flex, IconButton, Skeleton, Text, TextField, Tooltip } from "@radix-ui/themes";

import { HelpTooltip } from "@/components/help-tooltip";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
import { useDialogReturnFocus } from "@/components/use-dialog-return-focus";
import {
  MasterListItem,
  MasterListItemText,
} from "@/components/master-list-item";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";
import {
  ModelComposer,
  type ModelComposerValidity,
} from "@/components/model-composer";

import { api, errorText, fetchJson } from "./api.ts";
import { modelIdentity, parseModelIdentity } from "./model-services.ts";
import { rerunRequest, RunDetailPanel, RunPill, type RunItem } from "./runs.tsx";
import { loadPanelSession, pullRequestUrl } from "./session.ts";
import { useSetupStatus } from "./setup-checklist.tsx";

type ReviewerSpec = { provider: string; model: string };

type RepoRow = {
  repoId: number;
  owner: string;
  repo: string;
  reviewers: ReviewerSpec[] | null;
  runCount: number;
  findingCount: number;
  lastActivity: string | null;
};

type HookCheck = {
  expectedGenerations: number[];
  hooks: { id: number; generation: number; active: boolean }[];
  issues: { message: string; action: string }[];
};

function since(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

/** 键值行:详情面板里成对出现的那一行。 */
function Kv({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
      <span className="text-text-muted">{label}</span>
      <span className="ml-auto text-right">{children}</span>
    </div>
  );
}

/**
 * 卡片外壳。内边距不加在壳上而是落到每个区块里,卡头与内容之间那条分隔线才能通栏——
 * 这是 v8 卡片与 Radix Card 唯一对不上的地方,所以这里自己写壳。
 */
function CardShell({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border border-card-line bg-surface shadow-card sm:rounded-lg",
        className,
      )}
      {...props}
    />
  );
}

/** 分段控件的一段。激活段是白底浮块,未激活段保持主文字色——降对比度会让它看着像禁用。 */
function SegmentButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-chip px-3.5 py-1 whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60 max-sm:min-h-11 max-sm:px-4",
        active ? "bg-surface font-semibold shadow-control" : "text-text",
      )}
    >
      {children}
    </button>
  );
}

/** 卡头:左边区块名,右边这张卡自己的控件。 */
function CardTitle({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pt-3.5 pb-[11px] sm:px-5">
      <h3 className="flex items-center gap-1.5 text-2xl font-bold tracking-[-0.015em]">{title}</h3>
      {action}
    </div>
  );
}

export function ReposPage({
  canWrite,
  canReadModels,
  canReadReviews,
  canRerun,
}: {
  canWrite: boolean;
  canReadModels: boolean;
  canReadReviews: boolean;
  canRerun: boolean;
}) {
  const queryClient = useQueryClient();
  const setup = useSetupStatus();
  const repos = useQuery({
    queryKey: ["repos"],
    queryFn: () => fetchJson<RepoRow[]>("/repos"),
  });
  // 审查策略在库里,「跟随全局」跟的就是它的 reviewers。
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => fetchJson<{ reviewers: ReviewerSpec[] }>("/settings"),
    enabled: canReadModels,
  });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [registering, setRegistering] = useState(false);
  /** 刚注册完的仓库名。注册是首次配置的最后一步,这里要说清楚接下来会发生什么。 */
  const [justRegistered, setJustRegistered] = useState<string | null>(null);

  const rows = repos.data ?? [];
  const selected = rows.find((row) => row.repoId === selectedId) ?? rows[0];
  const registrationReady = setup.data?.reviewConfigurationReady === true;

  return (
    <Dialog.Root open={registering} onOpenChange={setRegistering}>
      <PageBody width="wide">
        <PageHeader title="仓库" />
        {justRegistered === null ? null : (
          <Callout.Root role="status" color="green" size="1">
            <Callout.Icon><CheckCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>
              已接入 <span className="font-medium">{justRegistered}</span>。向它推送 pull request 就会自动开始审查。
            </Callout.Text>
          </Callout.Root>
        )}
        {/*
          主从两列。窄屏收成一列,并且是「列表 → 详情」两级:详情有四张卡,把它顺
          排在整张仓库列表下面,选完仓库还要往下滚过整份列表才看得到自己选了什么。
        */}
        <div className="grid items-start gap-4 lg:grid-cols-[264px_minmax(0,1fr)] lg:gap-[18px]">
          <aside
            aria-label="已注册仓库"
            aria-busy={repos.isPending}
            className={cn(
              "flex-col gap-2.5",
              selectedId === null ? "flex" : "hidden lg:flex",
            )}
          >
          {canWrite ? (
            <Dialog.Trigger>
              <Button
                id="register-repo-trigger"
                variant="solid"
                size={{ initial: "4", sm: "2" }}
                disabled={!registrationReady}
                className="w-full shadow-accent"
              >
                注册仓库
              </Button>
            </Dialog.Trigger>
          ) : null}
          <p className="px-1 text-sm font-bold tracking-[0.03em] text-text-muted">
            已注册 {rows.length} 个
          </p>
          <CardShell className="overflow-hidden">
          {repos.isPending ? (
            <div className="flex flex-col gap-2 px-4 py-3" role="status" aria-live="polite">
              <span className="sr-only">正在读取已注册仓库</span>
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </div>
          ) : null}
          {/* 一份列表就是一份列表:屏幕阅读器会念出「共 N 项、第 K 项」。 */}
          <ul>
            {rows.map((row, index) => (
              <li key={row.repoId} className={index === 0 ? undefined : "border-t border-line"}>
                <MasterListItem
                  data-repo-list-item
                  selected={row.repoId === selected?.repoId}
                  className="block px-4 py-3 data-[selected=false]:font-medium"
                  onClick={() => setSelectedId(row.repoId)}
                >
                  <span className="block break-all text-lg">
                    {row.owner}/{row.repo}
                  </span>
                  <MasterListItemText className="mt-px block text-sm font-normal">
                    <span className="tabular-nums">{row.runCount}</span> 轮
                    {row.lastActivity === null
                      ? " · 还没跑过"
                      : ` · 最近 ${since(row.lastActivity)}`}
                  </MasterListItemText>
                </MasterListItem>
              </li>
            ))}
          </ul>
          {rows.length === 0 && !repos.isPending && !repos.isError ? (
            <EmptyState title="暂无已注册仓库" className="px-4 py-2.5" />
          ) : null}
          </CardShell>
          </aside>

          <div
            className={cn(
              "min-w-0 flex-col gap-4",
              selectedId === null ? "hidden lg:flex" : "flex",
            )}
            aria-busy={repos.isPending}
          >
          {selectedId === null ? null : (
            <Button
              type="button"
              variant="ghost"
              color="gray"
              size="3"
              className="w-fit lg:hidden"
              onClick={() => setSelectedId(null)}
            >
              <ArrowLeftIcon aria-hidden />
              返回仓库列表
            </Button>
          )}
          {canWrite && setup.data !== undefined && !setup.data.reviewConfigurationReady ? (
            <Callout.Root color="amber" size="2">
              <Callout.Icon>
                <ExclamationTriangleIcon aria-hidden />
              </Callout.Icon>
              <Callout.Text>审查配置就绪后才能注册仓库。先在审查策略中保存至少一个当前可用模型。</Callout.Text>
              <Button variant="soft" color="gray" size={{ initial: "4", sm: "1" }} className="w-fit" asChild>
                <Link to="/settings">前往审查策略</Link>
              </Button>
            </Callout.Root>
          ) : null}
          {repos.isError ? (
            <Callout.Root role="alert" color="red" size="1">
              <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
              <Callout.Text>{(repos.error as Error).message}</Callout.Text>
            </Callout.Root>
          ) : null}
          {selected !== undefined && settings.isError ? (
            <Callout.Root role="alert" color="red" size="1">
              <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
              <Callout.Text>{(settings.error as Error).message}</Callout.Text>
            </Callout.Root>
          ) : null}
          {repos.isPending ? (
            <>
              <Skeleton className="h-10" />
              <Skeleton className="h-44" />
              <Skeleton className="h-56" />
            </>
          ) : null}
          {selected === undefined && !repos.isPending && !repos.isError ? (
            <EmptyState
              title="暂无已注册仓库"
              titleAs="h2"
              description={canWrite ? "选择左侧“注册仓库”，搜索并选择要接入的代码仓库。" : "当前没有已注册仓库。"}
              className="rounded-lg border border-card-line bg-surface px-5 py-4 shadow-card"
            />
          ) : null}
          {selected === undefined ? null : (
            <RepoDetail
              key={selected.repoId}
              repo={selected}
              globalModels={settings.data?.reviewers.map(modelIdentity)}
              canWrite={canWrite}
              canReadReviews={canReadReviews}
              canRerun={canRerun}
              onRemoved={() => {
                setSelectedId(null);
                void queryClient.invalidateQueries({ queryKey: ["repos"] });
              }}
            />
          )}
          </div>
        </div>

        {/* 两个表单模态都按需挂载:常驻会把上一次的输入与错误留在 state 里,下次打开
            回显的就不是当前值了。 */}
        {canWrite && registrationReady && registering ? (
          <RegisterDialogContent
            onDone={(repoId, name) => {
              setRegistering(false);
              setJustRegistered(name);
              void queryClient.invalidateQueries({ queryKey: ["repos"] }).then(() => {
                setSelectedId(repoId);
              });
            }}
          />
        ) : null}
      </PageBody>
    </Dialog.Root>
  );
}

function RepoDetail({
  repo,
  globalModels,
  canWrite,
  canReadReviews,
  canRerun,
  onRemoved,
}: {
  repo: RepoRow;
  globalModels: string[] | undefined;
  canWrite: boolean;
  canReadReviews: boolean;
  canRerun: boolean;
  onRemoved: () => void;
}) {
  const queryClient = useQueryClient();
  // 打开仓库时拉一次核对。只展示差异与下一步动作，不自动修改 Hook。
  const check = useQuery({
    queryKey: ["repo-hooks", repo.repoId],
    queryFn: () => fetchJson<HookCheck>(`/repos/${repo.repoId}/hooks`),
  });
  const [feedback, setFeedback] = useState<{ text: string; isError: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const removalFocus = useDialogReturnFocus(() =>
    document.querySelector<HTMLElement>("[data-repo-list-item]")
      ?? document.getElementById("register-repo-trigger"),
  );

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["repos"] });
    void queryClient.invalidateQueries({ queryKey: ["repo-hooks", repo.repoId] });
  };

  const rotate = useMutation({
    mutationFn: async () => {
      const response = await api(`/repos/${repo.repoId}/rotate`, { method: "POST" });
      if (!response.ok) throw new Error(await errorText(response));
      return (await response.json()) as { generation: number };
    },
    onSuccess: (data) => {
      setFeedback({ text: `已轮转到代次 ${data.generation}。`, isError: false });
      refresh();
    },
    onError: (error: Error) => setFeedback({ text: error.message, isError: true }),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const response = await api(`/repos/${repo.repoId}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: () => {
      onRemoved();
      removalFocus.restoreFocus();
    },
    // 「移除被阻止」是本页最重要的一类失败,必须以错误的样子出现,不能混进普通提示。
    onError: (error: Error) => setFeedback({ text: error.message, isError: true }),
  });

  // 「跟随全局」是一个动作:直接把覆盖清掉,不再进编辑框走一遍保存。
  const followGlobal = useMutation({
    mutationFn: async () => {
      const response = await api(`/repos/${repo.repoId}/reviewers`, {
        method: "PUT",
        body: JSON.stringify({ reviewers: null }),
      });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: () => {
      setFeedback({ text: "覆盖已清除，仓库将跟随全局组合；下一次审查时生效。", isError: false });
      refresh();
    },
    onError: (error: Error) => setFeedback({ text: error.message, isError: true }),
  });

  const issues = check.data?.issues ?? [];
  const following = repo.reviewers === null;
  // 覆盖存的是 spec,展示要和全局那侧一样是模型标识 `provider:model`。
  const shownModels = repo.reviewers === null ? globalModels : repo.reviewers.map(modelIdentity);

  return (
    <>
      {/* 标题与它的元信息贴在一起,和下面的卡片之间才留得出一档间距。 */}
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* 页标题是「仓库」,这里是选中的那一个:降一级,字号也降一档。 */}
          <h2 className="min-w-0 flex-1 break-all text-3xl font-extrabold tracking-[-0.02em]">
            {repo.owner}/{repo.repo}
          </h2>
          {check.isPending ? (
            <StatusBadge tone="neutral" icon={UpdateIcon}>
              核对中…
            </StatusBadge>
          ) : check.isError ? (
            <StatusBadge tone="error">
              核对失败
            </StatusBadge>
          ) : issues.length === 0 ? (
            <StatusBadge tone="success">
              Hook 配置正常
            </StatusBadge>
          ) : (
            <StatusBadge tone="warning">
              {issues.length} 处差异
            </StatusBadge>
          )}
          {canWrite ? (
            <Button
              variant="ghost"
              color="red"
              size={{ initial: "4", sm: "2" }}
              className="shrink-0 max-sm:w-full"
              disabled={remove.isPending}
              onClick={(event) => {
                removalFocus.captureTrigger(event);
                setConfirmingRemoval(true);
              }}
            >
              移除仓库
            </Button>
          ) : null}
        </div>
        <section
          aria-label="仓库统计"
          className="flex flex-wrap items-center gap-x-4 gap-y-1 text-base text-text-muted"
        >
          <span>
            仓库 ID <b className="font-semibold tabular-nums text-text">{repo.repoId}</b>
          </span>
          <span>
            审查轮次 <b className="font-semibold tabular-nums text-text">{repo.runCount}</b> 轮
          </span>
          <span>
            来源 Finding <b className="font-semibold tabular-nums text-text">{repo.findingCount}</b> 条
          </span>
        </section>
      </div>

      {feedback === null ? null : (
        <Callout.Root
          role={feedback.isError ? "alert" : "status"}
          color={feedback.isError ? "red" : "green"}
          size="1"
        >
          <Callout.Icon>
            {feedback.isError ? <CrossCircledIcon aria-hidden /> : <CheckCircledIcon aria-hidden />}
          </Callout.Icon>
          <Callout.Text>{feedback.text}</Callout.Text>
        </Callout.Root>
      )}
      {check.isError ? (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>{(check.error as Error).message}</Callout.Text>
        </Callout.Root>
      ) : null}

      {issues.length > 0 ? (
        <Callout.Root color="amber" size="2">
          <Callout.Icon>
            <ExclamationTriangleIcon aria-hidden />
          </Callout.Icon>
          <Callout.Text>Hook 配置差异</Callout.Text>
          <div className="flex flex-col items-start gap-3">
            {issues.map((issue) => (
              <Kv key={issue.message} label={issue.message}>
                <span className="text-text-muted">{issue.action}</span>
              </Kv>
            ))}
            {canWrite ? (
              <Button
                variant="solid"
                size={{ initial: "4", sm: "2" }}
                className="self-start shadow-accent"
                disabled={rotate.isPending}
                onClick={() => rotate.mutate()}
              >
                {rotate.isPending ? "修复中…" : "轮转并修复"}
              </Button>
            ) : null}
          </div>
        </Callout.Root>
      ) : null}

      {/* 编辑态并成一栏:两栏面板是 220px 的厂商列加一整栏模型列,半宽的格子装不下。 */}
      <div className={editing ? "grid gap-4" : "grid gap-4 md:grid-cols-2"}>
        <CardShell>
          <CardTitle
            title={
              <>
                准入 Key
                <HelpTooltip label="准入 Key 说明" content="面板会自动维护 Hook 凭据，页面不会显示明文。" />
              </>
            }
          />
          <div className="flex flex-col gap-2.5 border-t border-line px-4 py-3.5 sm:px-5">
            <Kv label="状态">已配置到 Hook（不会显示明文）</Kv>
            <Kv label="代次">
              <span className="font-mono tabular-nums">
                {check.data === undefined ? "…" : check.data.expectedGenerations.join(" / ")}
              </span>
            </Kv>
            {canWrite ? (
              <Button
                variant="soft"
                color="gray"
                size={{ initial: "4", sm: "2" }}
                className="mt-0.5 self-start"
                disabled={rotate.isPending}
                onClick={() => rotate.mutate()}
              >
                {rotate.isPending ? "轮转中…" : "轮转 Key"}
              </Button>
            ) : null}
          </div>
        </CardShell>

        {canWrite && editing ? (
          <ReviewersEditor
            repo={repo}
            globalModels={globalModels ?? []}
            onClose={() => setEditing(false)}
            onDone={() => {
              setEditing(false);
              setFeedback({ text: "模型组合已更新，下一次审查时生效。", isError: false });
              refresh();
            }}
          />
        ) : (
          <CardShell>
            {/* 两态开关(issue #69):要么跟随全局,要么本仓库自定义。「一个都没选」
                这种既不是跟随、也不是有效覆盖的状态在界面上不存在。
                分段控件手写而不用 Radix SegmentedControl:那个组件点已激活项不回调,
                而这里点已激活的「自定义」正是重新打开编辑器的唯一入口。 */}
            <CardTitle
              title="模型组合"
              action={canWrite ? (
                <div className="flex shrink-0 rounded-sm bg-fill p-0.5 text-base" role="group" aria-label="模型组合来源">
                  <SegmentButton
                    active={following}
                    disabled={followGlobal.isPending}
                    onClick={() => {
                      if (!following) followGlobal.mutate();
                    }}
                  >
                    跟随全局
                  </SegmentButton>
                  <SegmentButton
                    active={!following}
                    disabled={followGlobal.isPending}
                    onClick={() => setEditing(true)}
                  >
                    自定义
                  </SegmentButton>
                </div>
              ) : undefined}
            />
            <div className="flex flex-col gap-3 border-t border-line px-4 py-3.5 sm:px-5">
              <Kv label={following ? "跟随全局默认" : "本仓库覆盖"}>
                {shownModels === undefined ? (
                  <span className="text-text-muted">使用全局组合</span>
                ) : (
                  <span><span className="tabular-nums">{shownModels.length}</span> 个</span>
                )}
              </Kv>
              {shownModels === undefined || shownModels.length === 0 ? null : (
                <div className="flex flex-wrap gap-2">
                  {shownModels.map((model) => (
                    <span
                      key={model}
                      className="rounded-full bg-fill px-3 py-[3px] font-mono text-base break-all"
                    >
                      {model}
                    </span>
                  ))}
                </div>
              )}
              <p className="text-base text-text-muted">
                {following && canWrite
                  ? "审查策略更新后，这个仓库会同步使用新组合。"
                  : following
                    ? "这个仓库使用全局模型组合。"
                    : canWrite
                      ? "这组模型仅对这个仓库生效，不随审查策略变化。"
                      : "这组模型仅对这个仓库生效。"}
              </p>
            </div>
          </CardShell>
        )}
      </div>

      {canReadReviews || canRerun ? (
        <RepoRuns
          repo={repo}
          canRead={canReadReviews}
          canRerun={canRerun}
          onFeedback={setFeedback}
        />
      ) : null}

      {canWrite ? <AlertDialog.Root open={confirmingRemoval} onOpenChange={setConfirmingRemoval}>
        <AlertDialog.Content
          maxWidth="440px"
          maxHeight="calc(100dvh - 2rem)"
          size={{ initial: "2", sm: "3" }}
          onCloseAutoFocus={removalFocus.onCloseAutoFocus}
        >
          <AlertDialog.Title size="4" mb="2">
            移除 {repo.owner}/{repo.repo}?
          </AlertDialog.Title>
          <AlertDialog.Description size="2" color="gray">
            将删除 Gitea 中的 Hook；后续审查请求会因仓库未注册而被拒绝。评审记录和历史模型选择会保留。
          </AlertDialog.Description>
          <Flex gap="3" mt="4" justify="end" direction={{ initial: "column-reverse", sm: "row" }}>
            <AlertDialog.Cancel><Button variant="soft" color="gray" size={{ initial: "4", sm: "2" }}>
              取消
            </Button></AlertDialog.Cancel>
            <Button
              variant="solid"
              color="red"
              size={{ initial: "4", sm: "2" }}
              disabled={remove.isPending}
              onClick={() => {
                setConfirmingRemoval(false);
                remove.mutate();
              }}
            >
              移除
            </Button>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root> : null}
    </>
  );
}

/** 搜索结果的一条。不可选的两类照样返回，`reason` 说明缺少的条件。 */
type RepoSearchResult = {
  repoId: number;
  owner: string;
  repo: string;
  registered: boolean;
  admin: boolean;
  reason?: string;
};

type RepoSearch = {
  state: "empty-query" | "no-match" | "ok";
  total: number;
  truncated: boolean;
  results: RepoSearchResult[];
};

/** 输入暂停一段时间后才发搜索请求，避免每次按键都触发 Gitea 查询。 */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * 注册仓库(issue #70):输入关键词搜索当前凭据可访问的仓库并直接选择，不必先去 Gitea 上把
 * owner 与 repo 复制下来。手动输入已删除——当前凭据无法访问的仓库即使输入也无法通过注册时的
 * 权限检查,留个兜底只会把「搜不到」的问题推迟到注册那一刻才暴露。
 *
 * 搜索经本服务代理(`GET <前缀>/api/repos/search`),浏览器不直连 Gitea。已注册与
 * 无 admin 权限两类照样列出、只是置灰:过滤掉会让人明知仓库存在却搜不到。
 */
function RegisterDialogContent({
  onDone,
}: {
  onDone: (repoId: number, name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [picked, setPicked] = useState<RepoSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const search = useQuery({
    queryKey: ["repo-search", debounced],
    queryFn: () => fetchJson<RepoSearch>(`/repos/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.trim() !== "",
  });

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (picked === null) return;
    setBusy(true);
    setError(null);
    try {
      // 入参一字未改:仍是 owner 与 repo,repoId 由服务端在权限检查那一次请求里读出。
      // 新仓库一律跟随全局,要自定义在详情里切两态开关。
      const response = await api("/repos", {
        method: "POST",
        body: JSON.stringify({ owner: picked.owner, repo: picked.repo }),
      });
      if (!response.ok) {
        setError(await errorText(response));
        return;
      }
      const created = (await response.json()) as { repoId: number };
      onDone(created.repoId, `${picked.owner}/${picked.repo}`);
    } catch {
      setError("暂时无法连接服务，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  const data = search.data;
  return (
    <Dialog.Content aria-describedby={undefined} maxWidth="640px" maxHeight="calc(100dvh - 2rem)" size={{ initial: "2", sm: "3" }}>
        <form onSubmit={submit} className="flex min-h-0 flex-col gap-3" aria-busy={busy}>
          <Dialog.Title size="4" mb="1" className="pr-9">注册仓库</Dialog.Title>
          {/* cmdk 自带的过滤按标签文本再筛一次,而结果已经是 Gitea 按关键字搜回来的。 */}
          <Command
            shouldFilter={false}
            aria-busy={search.isPending && debounced.trim() !== ""}
            className="rounded-md border border-card-line"
          >
            <CommandInput
              aria-label="搜索可访问的仓库"
              placeholder="搜索仓库（owner 或仓库名）"
              value={query}
              // 搜索词一变就丢掉选中项:留着的话改词到无结果再回车,提交的会是上一次
              // 选中的那个仓库,而列表里已经看不见它了。
              onValueChange={(next) => {
                setQuery(next);
                setPicked(null);
              }}
              autoFocus
            />
            <CommandList className="max-h-[300px]">
              {search.isError ? (
                <p role="alert" className="p-4 text-danger">
                  {(search.error as Error).message}
                </p>
              ) : search.isPending && debounced.trim() !== "" ? (
                <div className="flex flex-col gap-2 p-4" role="status" aria-live="polite" aria-busy="true">
                  <span className="sr-only">正在搜索仓库</span>
                  <Skeleton aria-hidden className="h-9" />
                  <Skeleton aria-hidden className="h-9" />
                  <Skeleton aria-hidden className="h-9" />
                </div>
              ) : data === undefined || debounced.trim() === "" ? (
                <p className="p-4 text-text-muted">输入关键词开始搜索可访问的仓库。</p>
              ) : data.state === "no-match" ? (
                <EmptyState
                  title="没有匹配的仓库"
                  description="请确认 Gitea 中的 bot 账号已获得该仓库的访问权限。"
                  className="p-4"
                />
              ) : (
                <CommandGroup>
                  {data.results.map((row) => {
                    const identity = `${row.owner}/${row.repo}`;
                    const selectable = !row.registered && row.admin;
                    return (
                      <CommandItem
                        key={row.repoId}
                        value={identity}
                        disabled={!selectable}
                        onSelect={() => setPicked(row)}
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="break-all">
                            {identity}
                            {picked?.repoId === row.repoId ? (
                              <span className="ml-2 font-sans text-primary">已选</span>
                            ) : null}
                          </span>
                          {row.reason === undefined ? null : (
                            <span className="break-words text-sm text-text-muted">
                              {row.reason}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-sm text-text-muted">
                          仓库 ID {row.repoId}
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
          {/* 只取第一页:剩下的靠继续输入缩小范围,面板不翻页。 */}
          {data?.truncated === true ? (
            <p className="text-sm text-warning">
              共 {data.total} 个匹配,这里只显示前 {data.results.length} 个。继续输入以缩小范围。
            </p>
          ) : null}
          <p className="text-sm text-text-muted">
            新仓库默认使用审查策略中的模型组合；注册后可在仓库详情中设置覆盖。
          </p>
          {error === null ? null : (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
          <Flex gap="3" mt="1" justify="end" direction={{ initial: "column-reverse", sm: "row" }}>
            <Dialog.Close><Button type="button" variant="soft" color="gray" size={{ initial: "4", sm: "2" }}>
              取消
            </Button></Dialog.Close>
            <Button type="submit" variant="solid" className="shadow-accent" size={{ initial: "4", sm: "2" }} disabled={busy || picked === null}>
              {busy ? "注册中…" : picked === null ? "注册" : `注册 ${picked.owner}/${picked.repo}`}
            </Button>
          </Flex>
        </form>
        <div className="absolute top-3 right-3">
          <Tooltip content="关闭注册仓库">
            <Dialog.Close>
              <IconButton
                variant="ghost"
                color="gray"
                size={{ initial: "3", sm: "1" }}
                className="max-sm:min-h-11 max-sm:min-w-11"
                aria-label="关闭注册仓库"
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
 * 自定义态从当前生效组合起步，并复用审查策略的同一个 `ModelComposer`。已落库但失效的
 * 标识原样留在编辑态里，移除不受阻；只有再次保存仍含不可用项时才门禁。
 */
function ReviewersEditor({
  repo,
  globalModels,
  onClose,
  onDone,
}: {
  repo: RepoRow;
  globalModels: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [models, setModels] = useState(() =>
    repo.reviewers === null ? globalModels : repo.reviewers.map(modelIdentity),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [validity, setValidity] = useState<ModelComposerValidity>({
    ready: false,
    unavailable: [],
  });

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await api(`/repos/${repo.repoId}/reviewers`, {
        method: "PUT",
        body: JSON.stringify({ reviewers: models.map(parseModelIdentity) }),
      });
      if (!response.ok) {
        setError(await errorText(response));
        return;
      }
      onDone();
    } catch {
      setError("暂时无法连接服务，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell aria-busy={busy}>
      <div className="flex flex-col gap-px px-4 pt-3.5 pb-[11px] sm:px-5">
        <h3 className="text-2xl font-bold tracking-[-0.015em] break-all">
          自定义 {repo.owner}/{repo.repo} 的模型组合
        </h3>
        <p className="text-base text-text-muted">
          本仓库覆盖会完全替换全局默认组合，至少选择一个模型。保存后下一次审查使用这组模型；取消则放弃本次修改。
        </p>
      </div>
      <div className="flex flex-col gap-4 border-t border-line px-4 py-3.5 sm:px-5">
        <ModelComposer
          value={models}
          onChange={(next) => {
            setModels(next);
            setError(null);
          }}
          onValidityChange={setValidity}
        />
        {error === null ? null : (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="solid"
            size={{ initial: "4", sm: "2" }}
            className="shadow-accent"
            disabled={
              busy ||
              models.length === 0 ||
              !validity.ready ||
              validity.unavailable.length > 0
            }
            onClick={() => void save()}
          >
            {busy ? "保存中…" : "保存"}
          </Button>
          <Button variant="soft" color="gray" size={{ initial: "4", sm: "2" }} onClick={onClose}>
            取消
          </Button>
          {models.length === 0 ? (
            <span className="text-base text-text-muted">
              至少选择一个模型才能保存。要改回全局默认，请取消编辑后选择“跟随全局”。
            </span>
          ) : validity.unavailable.length > 0 ? (
            <span className="text-base text-danger">先恢复或移除不可用模型，再保存覆盖。</span>
          ) : !validity.ready ? (
            <span className="text-base text-text-muted">模型状态确认后即可保存覆盖。</span>
          ) : null}
        </div>
      </div>
    </CardShell>
  );
}

/** 本仓库最近的审查记录，并提供输入 PR 编号重新运行审查的入口。 */
function RepoRuns({
  repo,
  canRead,
  canRerun,
  onFeedback,
}: {
  repo: RepoRow;
  canRead: boolean;
  canRerun: boolean;
  onFeedback: (feedback: { text: string; isError: boolean } | null) => void;
}) {
  const queryClient = useQueryClient();
  // 只为把每一轮指回它的 pull request——处置在那边做,不在面板里。与壳共用会话缓存。
  const session = useQuery({ queryKey: ["session"], queryFn: loadPanelSession });
  const runs = useQuery({
    queryKey: ["repo-runs", repo.owner, repo.repo],
    queryFn: () =>
      fetchJson<{ runs: RunItem[] }>(
        `/runs?owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.repo)}`,
      ),
    enabled: canRead,
  });
  const [pullNumber, setPullNumber] = useState("");
  /** 打开的那一轮。详情面板与评审记录页共用同一个组件,同一轮在两处看到的一样。 */
  const [openedRunId, setOpenedRunId] = useState<number | null>(null);
  const rerun = useMutation({
    mutationFn: rerunRequest,
    onSuccess: (text) => {
      onFeedback({ text, isError: false });
      setPullNumber("");
      void queryClient.invalidateQueries({ queryKey: ["repo-runs", repo.owner, repo.repo] });
    },
    onError: (error: Error) => onFeedback({ text: error.message, isError: true }),
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const number = Number(pullNumber);
    if (!Number.isSafeInteger(number) || number <= 0) {
      onFeedback({ text: "PR 编号必须是正整数。", isError: true });
      return;
    }
    rerun.mutate({ owner: repo.owner, repo: repo.repo, pullNumber: number });
  };

  const rows = runs.data?.runs.slice(0, 8) ?? [];
  const opened = rows.find((run) => run.id === openedRunId) ?? null;
  return (
    <CardShell aria-busy={canRead && runs.isPending}>
      <CardTitle
        title={canRead ? "评审记录" : "重新运行审查"}
        action={canRerun ? (
          <form onSubmit={submit} className="flex flex-wrap items-center gap-2" aria-busy={rerun.isPending}>
            <Text as="label" htmlFor={`rerun-pr-${repo.repoId}`} className="sr-only">
              PR 编号
            </Text>
            <TextField.Root
              id={`rerun-pr-${repo.repoId}`}
              size={{ initial: "3", sm: "2" }}
              placeholder="PR 编号"
              inputMode="numeric"
              className="w-[120px] min-w-0 max-sm:min-h-11"
              value={pullNumber}
              onChange={(event) => setPullNumber(event.target.value)}
            />
            <Button variant="soft" color="gray" size={{ initial: "4", sm: "2" }} type="submit" disabled={rerun.isPending}>
              {rerun.isPending ? "触发中…" : "重新运行"}
            </Button>
          </form>
        ) : undefined}
      />
      {canRead && runs.isError ? (
        <div className="border-t border-line px-4 py-3.5 sm:px-5">
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>{(runs.error as Error).message}</Callout.Text>
          </Callout.Root>
        </div>
      ) : null}
      {canRead && runs.isPending ? (
        <div className="flex flex-col gap-2 border-t border-line px-4 py-3.5 sm:px-5" role="status" aria-live="polite">
          <span className="sr-only">正在读取仓库评审记录</span>
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </div>
      ) : null}
      {canRead
        ? rows.map((run) => (
            // 一行一轮:左边是这一轮的身份与触发方式,右边是处置进度与结论。点开是
            // 评审记录页那同一个详情面板——同一件东西,两处看到的应该一样。
            <MasterListItem
              key={run.id}
              selected={run.id === openedRunId}
              onClick={() => setOpenedRunId(run.id)}
              aria-haspopup="dialog"
              data-run-id={run.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-3 sm:px-5"
            >
              <span className="min-w-0 flex-1 text-lg font-semibold tabular-nums">
                #{run.pullNumber}
                <span className="font-normal text-text-muted">
                  {` · ${run.startedAt.slice(0, 16).replace("T", " ")}`}
                  {` · ${run.triggeredBy === null ? "自动触发" : `手动 · ${run.triggeredBy}`}`}
                </span>
              </span>
              {/* 徽章说结论,这一格说进度。 */}
              <span className="shrink-0 text-base tabular-nums text-text-muted">
                {run.total === 0 ? "—" : `${run.resolved}/${run.total}`}
              </span>
              <RunPill run={run} />
            </MasterListItem>
          ))
        : null}
      {canRead && rows.length === 0 && !runs.isPending && !runs.isError ? (
        <div className="border-t border-line px-4 sm:px-5">
          <EmptyState title="暂无审查记录" />
        </div>
      ) : null}
      {opened === null ? null : (
        <RunDetailPanel
          run={opened}
          canRerun={canRerun}
          rerunning={rerun.isPending}
          pullUrl={session.data === undefined || session.data === null ? null : pullRequestUrl(session.data, opened)}
          onRerun={() => {
            rerun.mutate(opened);
            // 结果落在页面顶部的提示上,面板压着它人就看不见,所以触发即收面板。
            setOpenedRunId(null);
          }}
          onOpenOther={setOpenedRunId}
          onSwitchFilter={() => undefined}
          onClose={() => setOpenedRunId(null)}
        />
      )}
    </CardShell>
  );
}
