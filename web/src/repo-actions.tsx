import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  CheckCircledIcon,
  Cross2Icon,
  CrossCircledIcon,
  DotsHorizontalIcon,
  ExclamationTriangleIcon,
  UpdateIcon,
} from "@radix-ui/react-icons";
import {
  AlertDialog,
  Callout,
  Dialog,
  DropdownMenu,
  Flex,
  IconButton,
  Skeleton,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";

import { HelpTooltip } from "@/components/help-tooltip";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
import { useDialogReturnFocus } from "@/components/use-dialog-return-focus";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import {
  ModelComposer,
  type ModelComposerValidity,
} from "@/components/model-composer";
import { localMinute } from "@/lib/time";

import { api, errorText, fetchJson } from "./api.ts";
import { modelIdentity, parseModelIdentity } from "./model-services.ts";
import { useSetupStatus } from "./setup-checklist.tsx";

/**
 * 仓库注册表的管理动作(issue #195):注册、配置(模型组合 / 准入 Key / 工作副本)、移除,
 * 以及输 PR 号重跑。它们原先各占仓库页的一块,现在挂在首页左栏的行操作与右栏头部上——
 * 管仓库不再离开评审记录。接口一个没改。
 *
 * 这个模块不 import `runs.tsx`:首页要用的仓库契约类型与重跑请求都在这里,方向只有
 * `runs.tsx` → 这里一条,不成环。
 */

type Feedback = { text: string; isError: boolean };

type HookCheck = {
  expectedGenerations: number[];
  hooks: { id: number; generation: number; active: boolean }[];
  issues: { message: string; action: string }[];
};

/**
 * 工作副本的准备状态(issue #184)。`unknown` 是升级前注册的仓库与从没备过副本的那些
 * 行:副本可能在也可能不在,和失败一样给出准备入口。
 */
export type WorktreeStatus = {
  state: "unknown" | "preparing" | "ready" | "failed";
  failure: string | null;
  checkedAt: string | null;
};

export type ReviewerSpec = { provider: string; model: string };

/** `GET /repos` 的一行。服务端已按最近活动倒序给出,也已按仓库分配收窄。 */
export type RepoRow = {
  repoId: number;
  owner: string;
  repo: string;
  reviewers: ReviewerSpec[] | null;
  runCount: number;
  findingCount: number;
  lastActivity: string | null;
  worktree: WorktreeStatus;
};

/** 手动重新运行。首页右栏头部与阶段页共用这一个请求。 */
export async function rerunRequest(run: {
  owner: string;
  repo: string;
  pullNumber: number;
}): Promise<string> {
  const response = await api("/rerun", {
    method: "POST",
    body: JSON.stringify(run),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return `已触发 ${run.owner}/${run.repo} #${run.pullNumber} 的新一轮审查`;
}

/**
 * 桌面左栏与窄视口那一行各挂一份注册入口,同一时刻只有一份真正占位——`display: none`
 * 的那个 `focus()` 静默无效,焦点会直接丢在 body 上。这里挑看得见的那一个。
 */
function visibleElement(selector: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    if (element.getClientRects().length > 0) return element;
  }
  return null;
}

/** 键值行:配置弹窗里成对出现的那一行。 */
function Kv({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
      <span className="text-text-muted">{label}</span>
      <span className="ml-auto text-right">{children}</span>
    </div>
  );
}

/** 配置弹窗里的一个区块。区块之间一条分隔线,首个区块不画。 */
function Section({
  title,
  action,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5 border-t border-line pt-3.5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h3 className="flex items-center gap-1.5 text-2xl font-bold tracking-[-0.015em]">{title}</h3>
        {action}
      </div>
      {children}
    </section>
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

/**
 * 左栏顶部的「注册仓库」(issue #195):按钮加原仓库页那一份注册弹窗。审查配置未就绪时
 * 按钮禁用——首次配置检查单已经在指路去审查策略,这里不再重复一段说明。
 */
export function RegisterRepo({
  onRegistered,
  className,
}: {
  onRegistered: (repo: { owner: string; repo: string }) => void;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const setup = useSetupStatus();
  const [open, setOpen] = useState(false);
  const registrationReady = setup.data?.reviewConfigurationReady === true;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button
          data-register-repo-trigger
          variant="solid"
          size={{ initial: "4", sm: "2" }}
          disabled={!registrationReady}
          className={cn("shadow-accent", className)}
        >
          注册仓库
        </Button>
      </Dialog.Trigger>
      {/* 按需挂载:常驻会把上一次的输入与错误留在 state 里,下次打开回显的就不是当前值。 */}
      {registrationReady && open ? (
        <RegisterDialogContent
          onDone={(repo) => {
            setOpen(false);
            void queryClient.invalidateQueries({ queryKey: ["repos"] });
            onRegistered(repo);
          }}
        />
      ) : null}
    </Dialog.Root>
  );
}

/**
 * 一行仓库的行操作(issue #195):「配置」开一个分三区块的弹窗,「移除」沿用二次确认。
 * 两项都是写动作,由调用方按 `repo:write` 决定渲不渲染这个菜单。
 */
export function RepoRowMenu({
  repo,
  canReadModels,
  onRemoved,
  onFeedback,
  className,
}: {
  repo: RepoRow;
  canReadModels: boolean;
  /** 移除成功。调用方据此把选中项退回「全部仓库」。 */
  onRemoved: () => void;
  onFeedback: (feedback: Feedback) => void;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const [configuring, setConfiguring] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  // 菜单项一选中菜单就关,触发元素因此不是浮层自己记得住的那一个:点开菜单时记下这个
  // 「…」,关闭后显式还回去。这一行连同它的菜单被移除掉时退到注册按钮。
  const returnFocus = useDialogReturnFocus(() =>
    visibleElement("[data-register-repo-trigger]"),
  );

  const remove = useMutation({
    mutationFn: async () => {
      const response = await api(`/repos/${repo.repoId}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["repos"] });
      onRemoved();
    },
    // 「移除被阻止」是这里最重要的一类失败,必须以错误的样子出现,不能混进普通提示。
    onError: (error: Error) => onFeedback({ text: error.message, isError: true }),
  });

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <IconButton
            variant="ghost"
            color="gray"
            size={{ initial: "3", sm: "1" }}
            className={cn("max-sm:min-h-11 max-sm:min-w-11", className)}
            aria-label={`${repo.owner}/${repo.repo} 的操作`}
            onClick={returnFocus.captureTrigger}
          >
            <DotsHorizontalIcon aria-hidden />
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" size="2">
          <DropdownMenu.Item onSelect={() => setConfiguring(true)}>配置</DropdownMenu.Item>
          <DropdownMenu.Item color="red" onSelect={() => setConfirmingRemoval(true)}>
            移除
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>

      {/* 两个浮层都按需挂载:上一次的编辑态与错误不该在下次打开时回显。 */}
      <Dialog.Root open={configuring} onOpenChange={setConfiguring}>
        {configuring ? (
          <ConfigureDialogContent
            repo={repo}
            canReadModels={canReadModels}
            onCloseAutoFocus={returnFocus.onCloseAutoFocus}
          />
        ) : null}
      </Dialog.Root>

      <AlertDialog.Root open={confirmingRemoval} onOpenChange={setConfirmingRemoval}>
        <AlertDialog.Content
          maxWidth="440px"
          maxHeight="calc(100dvh - 2rem)"
          size={{ initial: "2", sm: "3" }}
          onCloseAutoFocus={returnFocus.onCloseAutoFocus}
        >
          <AlertDialog.Title size="4" mb="2">
            移除 {repo.owner}/{repo.repo}?
          </AlertDialog.Title>
          <AlertDialog.Description size="2" color="gray">
            将删除 Gitea 中的 Hook；后续审查请求会因仓库未注册而被拒绝。评审记录和历史模型选择会保留。
          </AlertDialog.Description>
          <Flex gap="3" mt="4" justify="end" direction={{ initial: "column-reverse", sm: "row" }}>
            <AlertDialog.Cancel>
              <Button variant="soft" color="gray" size={{ initial: "4", sm: "2" }}>
                取消
              </Button>
            </AlertDialog.Cancel>
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
      </AlertDialog.Root>
    </>
  );
}

/**
 * 配置弹窗(issue #195):模型组合、准入 Key 与工作副本三个区块,逻辑就是原仓库页那三块。
 * 结果与失败都落在弹窗顶上那一条提示里——它们说的是这个仓库的事,关掉弹窗就过去了。
 */
function ConfigureDialogContent({
  repo,
  canReadModels,
  onCloseAutoFocus,
}: {
  repo: RepoRow;
  canReadModels: boolean;
  onCloseAutoFocus: (event: { preventDefault: () => void }) => void;
}) {
  const queryClient = useQueryClient();
  // 打开仓库时拉一次核对。只展示差异与下一步动作，不自动修改 Hook。
  const check = useQuery({
    queryKey: ["repo-hooks", repo.repoId],
    queryFn: () => fetchJson<HookCheck>(`/repos/${repo.repoId}/hooks`),
  });
  // 审查策略在库里,「跟随全局」跟的就是它的 reviewers。
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => fetchJson<{ reviewers: ReviewerSpec[] }>("/settings"),
    enabled: canReadModels,
  });
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [editing, setEditing] = useState(false);

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

  // 备工作副本(issue #184)。注册时后台已经备过一次,这里是失败或从没备过时的入口。
  const prepareWorktree = useMutation({
    mutationFn: async () => {
      const response = await api(`/repos/${repo.repoId}/worktree`, { method: "POST" });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: () => {
      setFeedback({ text: "工作副本正在后台准备,备好后这里会显示就绪。", isError: false });
      refresh();
    },
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

  const globalModels = settings.data?.reviewers.map(modelIdentity);
  const issues = check.data?.issues ?? [];
  const following = repo.reviewers === null;
  // 覆盖存的是 spec,展示要和全局那侧一样是模型标识 `provider:model`。
  const shownModels = repo.reviewers === null ? globalModels : repo.reviewers.map(modelIdentity);

  return (
    <Dialog.Content
      aria-describedby={undefined}
      maxWidth="760px"
      maxHeight="calc(100dvh - 2rem)"
      size={{ initial: "2", sm: "3" }}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <Dialog.Title size="4" mb="1" className="pr-9 break-all">
        配置 {repo.owner}/{repo.repo}
      </Dialog.Title>
      <div className="flex flex-col gap-3.5">
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
        {settings.isError ? (
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>{(settings.error as Error).message}</Callout.Text>
          </Callout.Root>
        ) : null}
        {check.isError ? (
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>{(check.error as Error).message}</Callout.Text>
          </Callout.Root>
        ) : null}

        {/* 两态开关(issue #69):要么跟随全局,要么本仓库自定义。「一个都没选」这种既不是
            跟随、也不是有效覆盖的状态在界面上不存在。分段控件手写而不用 Radix
            SegmentedControl:那个组件点已激活项不回调,而这里点已激活的「自定义」正是
            重新打开编辑器的唯一入口。 */}
        <Section
          title="模型组合"
          action={editing ? undefined : (
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
          )}
        >
          {editing ? (
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
            <>
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
                {following
                  ? "审查策略更新后，这个仓库会同步使用新组合。"
                  : "这组模型仅对这个仓库生效，不随审查策略变化。"}
              </p>
            </>
          )}
        </Section>

        <Section
          title={
            <>
              准入 Key
              <HelpTooltip label="准入 Key 说明" content="面板会自动维护 Hook 凭据，页面不会显示明文。" />
            </>
          }
          action={
            check.isPending ? (
              <StatusBadge tone="neutral" icon={UpdateIcon}>核对中…</StatusBadge>
            ) : check.isError ? (
              <StatusBadge tone="error">核对失败</StatusBadge>
            ) : issues.length === 0 ? (
              <StatusBadge tone="success">Hook 配置正常</StatusBadge>
            ) : (
              <StatusBadge tone="warning">{issues.length} 处差异</StatusBadge>
            )
          }
        >
          <Kv label="代次">
            <span className="font-mono tabular-nums">
              {check.data === undefined ? "…" : check.data.expectedGenerations.join(" / ")}
            </span>
          </Kv>
          {issues.map((issue) => (
            <Kv key={issue.message} label={issue.message}>
              <span className="text-text-muted">{issue.action}</span>
            </Kv>
          ))}
          <Button
            variant="soft"
            color="gray"
            size={{ initial: "4", sm: "2" }}
            className="mt-0.5 self-start"
            disabled={rotate.isPending}
            onClick={() => rotate.mutate()}
          >
            {rotate.isPending ? "轮转中…" : issues.length > 0 ? "轮转并修复" : "轮转 Key"}
          </Button>
        </Section>

        {/* 工作副本的状态(issue #184)。就绪即之后的审查与 diff 都不必等 clone。 */}
        <Section title="工作副本">
          <div>
            {repo.worktree.state === "preparing" ? (
              <StatusBadge tone="neutral" icon={UpdateIcon}>工作副本准备中…</StatusBadge>
            ) : repo.worktree.state === "ready" ? (
              <StatusBadge tone="success">工作副本就绪</StatusBadge>
            ) : repo.worktree.state === "failed" ? (
              <StatusBadge tone="error">工作副本准备失败</StatusBadge>
            ) : (
              <StatusBadge tone="warning">工作副本未准备</StatusBadge>
            )}
          </div>
          {/* 副本没备好时说清楚原因,并给出准备入口:权限与注册、移除同一格。 */}
          {repo.worktree.state === "failed" || repo.worktree.state === "unknown" ? (
            <>
              <p className="text-base text-text-muted">
                {repo.worktree.failure
                  ?? "这个仓库还没备过工作副本。备好之后,审查、diff 与分支列表都不必再等一次 clone。"}
                {repo.worktree.checkedAt === null
                  ? null
                  : `(${localMinute(repo.worktree.checkedAt)})`}
              </p>
              <Button
                variant="solid"
                size={{ initial: "4", sm: "2" }}
                className="self-start shadow-accent"
                disabled={prepareWorktree.isPending}
                onClick={() => prepareWorktree.mutate()}
              >
                {prepareWorktree.isPending ? "准备中…" : "准备工作副本"}
              </Button>
            </>
          ) : null}
        </Section>
      </div>
      <div className="absolute top-3 right-3">
        <Tooltip content="关闭配置">
          <Dialog.Close>
            <IconButton
              variant="ghost"
              color="gray"
              size={{ initial: "3", sm: "1" }}
              className="max-sm:min-h-11 max-sm:min-w-11"
              aria-label="关闭配置"
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
    <div className="flex flex-col gap-4" aria-busy={busy}>
      <p className="text-base text-text-muted">
        本仓库覆盖会完全替换全局默认组合，至少选择一个模型。保存后下一次审查使用这组模型；取消则放弃本次修改。
      </p>
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
  );
}

/**
 * 右栏头部的「重跑 PR」(issue #195):输一个 PR 编号,在选中的这个仓库上再跑一轮。
 * 按 `review:rerun` 出现,由调用方决定渲不渲染。
 */
export function RerunPullRequest({
  repo,
  onFeedback,
}: {
  repo: { owner: string; repo: string };
  onFeedback: (feedback: Feedback) => void;
}) {
  const [pullNumber, setPullNumber] = useState("");
  const rerun = useMutation({
    mutationFn: rerunRequest,
    onSuccess: (text) => {
      onFeedback({ text, isError: false });
      setPullNumber("");
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

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2" aria-busy={rerun.isPending}>
      <Text as="label" htmlFor="rerun-pull-number" className="sr-only">
        PR 编号
      </Text>
      <TextField.Root
        id="rerun-pull-number"
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
  onDone: (repo: { owner: string; repo: string }) => void;
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
      // 新仓库一律跟随全局,要自定义在行操作的「配置」里切两态开关。
      const response = await api("/repos", {
        method: "POST",
        body: JSON.stringify({ owner: picked.owner, repo: picked.repo }),
      });
      if (!response.ok) {
        setError(await errorText(response));
        return;
      }
      onDone({ owner: picked.owner, repo: picked.repo });
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
            新仓库默认使用审查策略中的模型组合；注册后可在行操作的「配置」中设置覆盖。
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
