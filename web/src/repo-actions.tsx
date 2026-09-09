import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  CheckCircledIcon,
  Cross2Icon,
  CrossCircledIcon,
  DotsHorizontalIcon,
  UpdateIcon,
} from "@radix-ui/react-icons";
import {
  AlertDialog,
  Callout,
  Checkbox,
  Dialog,
  DropdownMenu,
  Flex,
  IconButton,
  Popover,
  Select,
  Skeleton,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";

import { HelpTooltip } from "@/components/help-tooltip";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
import { AuxiliaryModelLine } from "@/components/auxiliary-model-line";
import { AuxiliaryModelPicker } from "@/components/auxiliary-model-picker";
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
import { sameModelRef, sameModelRefs } from "@/lib/model-ref";

import { api, errorText, fetchJson } from "./api.ts";
import { useAuxiliaryModel } from "./auxiliary-model.ts";
import {
  fromModelRef,
  THINKING_LEVEL_LABEL,
  toModelRef,
  type ModelRef,
  type ThinkingLevel,
} from "./model-services.ts";
import { MIN_REPORT_SEVERITY_LABEL, type MinReportSeverity } from "./settings.tsx";
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

export type ReviewerSpec = { provider: string; model: string; thinkingLevel?: ThinkingLevel };

/** `GET /repos` 的一行。服务端已按最近活动倒序给出,也已按仓库分配收窄。 */
export type RepoRow = {
  repoId: number;
  owner: string;
  repo: string;
  reviewers: ReviewerSpec[] | null;
  /** 辅助模型的仓库覆盖(issue #303),null 即跟随全局。 */
  auxiliaryModel: ReviewerSpec | null;
  /** 最低报告等级的仓库覆盖(issue #273),null 即跟随全局。 */
  minReportSeverity: MinReportSeverity | null;
  /** 眼下的全局最低报告等级。「跟随全局」跟的就是它,列表每行都带一份。 */
  globalMinReportSeverity: MinReportSeverity;
  /** 模型覆盖与最低报告等级的整块版本号(issue #302)。保存时原样回传作期望版本。 */
  settingsVersion: number;
  runCount: number;
  findingCount: number;
  lastActivity: string | null;
  worktree: WorktreeStatus;
};

/**
 * 手动重新运行。首页右栏头部与阶段页共用这一个请求。
 *
 * `directive` 是本轮指令(issue #225),非必填:留空即不带这一格,只作用于这一轮。
 * `mode` 是这一轮的模式(issue #242),同样非必填:不带即只复核历史 Finding。
 */
export async function rerunRequest(run: {
  owner: string;
  repo: string;
  pullNumber: number;
  directive?: string;
  mode?: RerunMode;
}): Promise<string> {
  const response = await api("/rerun", {
    method: "POST",
    body: JSON.stringify(run),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return `已触发 ${run.owner}/${run.repo} #${run.pullNumber} 的新一轮审查`;
}

/**
 * 本轮指令输入框的共同措辞:三处重审入口挂同一句,人不必分别理解一遍。
 * 字段名义与一次性语义由各处可见的 label 与提示承担,placeholder 只举例。
 */
export const RUN_DIRECTIVE_PLACEHOLDER = "如:只报 P0";

/**
 * 本轮指令的能力边界(issue #270)。四处指令输入框挂同一句:指令进的是 Reviewer 的
 * prompt,它改的只有这一轮看什么、报什么,处置一条 Finding 是面板动作,写在指令里不会
 * 发生。线上有过一句「P2 可以都关闭」的指令,评审方等来的是「指令没生效」。
 */
export const RUN_DIRECTIVE_HINT =
  "指令只影响本轮审查看什么、报什么,不会处置任何 Finding;处置请用面板动作。";

/**
 * 一次重跑的模式(CONTEXT.md 只复核,issue #242)。两处重跑入口共用一个类型与一句
 * 措辞:同一个勾选在两个地方读起来必须是同一件事。
 */
export type RerunMode = "verdict-only" | "full";

/** 「完整审查」勾选的说明。勾上才会新报;重跑与增量评审两处默认都不勾。 */
export const FULL_REVIEW_HINT = "不勾即只复核历史 Finding,不新报";

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
  // 配置表单有没有未保存改动(issue #302)。关弹窗的三条路(取消、遮罩、Esc)都汇到
  // `requestClose`,脏状态下先弹一次确认——误点遮罩不该把刚改的东西丢掉。
  const [dirty, setDirty] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const closeConfigure = (): void => {
    setConfirmingDiscard(false);
    setDirty(false);
    setConfiguring(false);
  };
  const requestClose = (): void => {
    if (dirty) setConfirmingDiscard(true);
    else closeConfigure();
  };
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
      <Dialog.Root
        open={configuring}
        onOpenChange={(next) => {
          if (next) setConfiguring(true);
          else requestClose();
        }}
      >
        {configuring ? (
          <ConfigureDialogContent
            repo={repo}
            canReadModels={canReadModels}
            onCloseAutoFocus={returnFocus.onCloseAutoFocus}
            onDirtyChange={setDirty}
            onRequestClose={requestClose}
          />
        ) : null}
      </Dialog.Root>

      <AlertDialog.Root open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
        <AlertDialog.Content maxWidth="440px" size={{ initial: "2", sm: "3" }}>
          <AlertDialog.Title size="4">放弃未保存的改动？</AlertDialog.Title>
          <AlertDialog.Description size="2" color="gray">
            这个仓库的配置还没保存，关闭后改动会丢失。
          </AlertDialog.Description>
          <Flex gap="3" mt="4" justify="end">
            <AlertDialog.Cancel>
              <Button variant="soft" color="gray" size={{ initial: "4", sm: "2" }}>
                继续编辑
              </Button>
            </AlertDialog.Cancel>
            <Button
              variant="solid"
              color="red"
              size={{ initial: "4", sm: "2" }}
              onClick={closeConfigure}
            >
              放弃改动
            </Button>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>

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

/** 弹窗里三项配置的草稿(issue #302、#303)。三项都是 null 即跟随全局。 */
type RepoSettingsDraft = {
  models: ModelRef[] | null;
  auxiliary: ModelRef | null;
  minReportSeverity: MinReportSeverity | null;
};

/** 服务端此刻的这三项与它们的整块版本号:载入与 409 换基线都读它。 */
type RepoSettingsSnapshot = {
  reviewers: ReviewerSpec[] | null;
  auxiliaryModel: ReviewerSpec | null;
  minReportSeverity: MinReportSeverity | null;
  settingsVersion: number;
};

const draftOf = (snapshot: {
  reviewers: ReviewerSpec[] | null;
  auxiliaryModel: ReviewerSpec | null;
  minReportSeverity: MinReportSeverity | null;
}): RepoSettingsDraft => ({
  models: snapshot.reviewers === null ? null : snapshot.reviewers.map(toModelRef),
  auxiliary: snapshot.auxiliaryModel === null ? null : toModelRef(snapshot.auxiliaryModel),
  minReportSeverity: snapshot.minReportSeverity,
});

/** 三项各按各的比:模型组合与辅助模型走与审查策略页同一份规则(`lib/model-ref.ts`)。 */
const sameDraft = (a: RepoSettingsDraft, b: RepoSettingsDraft): boolean =>
  sameModelRefs(a.models, b.models) &&
  sameModelRef(a.auxiliary, b.auxiliary) &&
  a.minReportSeverity === b.minReportSeverity;

/** 一次保存的两种收场:写成了,或者被版本号拦下并带回服务端当前值。 */
type SaveOutcome =
  | { kind: "saved"; settingsVersion: number }
  | { kind: "conflict"; current: RepoSettingsSnapshot };

/**
 * 配置弹窗(issue #195):模型组合、最低报告等级、准入 Key 与工作副本四个区块。
 *
 * 前两块是配置,合成一张表单(issue #302):各自「跟随全局 / 自定义」两态,切到自定义从当前
 * 生效值起步,改动只留在表单里,底部固定的「保存」一次写两项、带整块版本号。后两块是动作,
 * 各有自己的按钮与端点,不进这张表单。结果与失败都落在弹窗顶上那一条提示里——它们说的是
 * 这个仓库的事,关掉弹窗就过去了。
 */
function ConfigureDialogContent({
  repo,
  canReadModels,
  onCloseAutoFocus,
  onDirtyChange,
  onRequestClose,
}: {
  repo: RepoRow;
  canReadModels: boolean;
  onCloseAutoFocus: (event: { preventDefault: () => void }) => void;
  /** 表单有没有未保存改动。调用方据它决定关弹窗前要不要先确认。 */
  onDirtyChange: (dirty: boolean) => void;
  onRequestClose: () => void;
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
  // 生效辅助模型的只读投影(issue #303):解析在服务端那一处,弹窗不自己算一遍。
  const effectiveAuxiliary = useAuxiliaryModel(repo.repoId);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // 基线是服务端此刻那一份,草稿是人在表单里改出来的那一份;两者不等即有未保存改动。
  const [baseline, setBaseline] = useState<RepoSettingsDraft>(() => draftOf(repo));
  const [version, setVersion] = useState(repo.settingsVersion);
  const [draft, setDraft] = useState<RepoSettingsDraft>(() => draftOf(repo));
  // 辅助模型「自定义」但还没选出一处时,草稿里那一格仍是 null(与跟随全局同值),两态因此
  // 另用这一格分。全局与模型组合都空时,仓库管理员从空选择起步给自己这个仓库设一处。
  const [customAuxiliary, setCustomAuxiliary] = useState(() => repo.auxiliaryModel !== null);
  const [validity, setValidity] = useState<ModelComposerValidity>({
    ready: false,
    unavailable: [],
  });

  const dirty = !sameDraft(draft, baseline);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["repos"] });
    void queryClient.invalidateQueries({ queryKey: ["repo-auxiliary-model", repo.repoId] });
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
      setFeedback({ text: "工作副本正在后台准备，完成后状态将更新为“就绪”。", isError: false });
      refresh();
    },
    onError: (error: Error) => setFeedback({ text: error.message, isError: true }),
  });

  // 整块保存(issue #302、#303):三项与期望版本一起发出去,服务端全量替换。
  const save = useMutation({
    mutationFn: async (): Promise<SaveOutcome> => {
      const response = await api(`/repos/${repo.repoId}/settings`, {
        method: "PUT",
        body: JSON.stringify({
          reviewers: draft.models === null ? null : draft.models.map(fromModelRef),
          auxiliaryModel: draft.auxiliary === null ? null : fromModelRef(draft.auxiliary),
          minReportSeverity: draft.minReportSeverity,
          expectedVersion: version,
        }),
      });
      if (response.status === 409) {
        const conflict = (await response.json()) as {
          error: string;
          current?: RepoSettingsSnapshot;
        };
        // 带当前值的那一档才是版本冲突;模型服务变化那一档没有当前值,照常报错。
        if (conflict.current === undefined) throw new Error(conflict.error);
        return { kind: "conflict", current: conflict.current };
      }
      if (!response.ok) throw new Error(await errorText(response));
      const { settingsVersion } = (await response.json()) as { settingsVersion: number };
      return { kind: "saved", settingsVersion };
    },
    onSuccess: (outcome) => {
      if (outcome.kind === "saved") {
        setBaseline(draft);
        setVersion(outcome.settingsVersion);
        setFeedback({ text: "配置已保存，下一次审查时生效。", isError: false });
      } else {
        // 换基线、接受新版本号,人的改动原样留在表单里,核对之后再保存一次。
        setBaseline(draftOf(outcome.current));
        setVersion(outcome.current.settingsVersion);
        setFeedback({
          text: "这个仓库的配置刚被改过，你的改动尚未保存，请核对后再保存。",
          isError: true,
        });
      }
      refresh();
    },
    onError: (error: Error) => setFeedback({ text: error.message, isError: true }),
  });

  const globalModels = settings.data?.reviewers.map(toModelRef);
  const view = effectiveAuxiliary.data;
  const effectiveAuxiliaryRef: ModelRef | null =
    view?.identity == null
      ? null
      : {
        identity: view.identity,
        ...(view.thinkingLevel === null ? {} : { thinkingLevel: view.thinkingLevel }),
      };
  const issues = check.data?.issues ?? [];
  const followingModels = draft.models === null;
  const followingAuxiliary = !customAuxiliary;
  const followingSeverity = draft.minReportSeverity === null;
  // 只读那一档展示的是生效值:跟随态即全局那一份。
  const shownModels = draft.models ?? globalModels;
  const effectiveSeverity = draft.minReportSeverity ?? repo.globalMinReportSeverity;
  // 自定义态选空、或选中的组合含不可用模型时保存不了;跟随态与这两条无关。
  const modelsBlocked =
    draft.models !== null &&
    (draft.models.length === 0 || !validity.ready || validity.unavailable.length > 0);

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
          action={
            <div className="flex shrink-0 rounded-sm bg-fill p-0.5 text-base" role="group" aria-label="模型组合来源">
              <SegmentButton
                active={followingModels}
                disabled={save.isPending}
                onClick={() => setDraft((current) => ({ ...current, models: null }))}
              >
                跟随全局
              </SegmentButton>
              <SegmentButton
                active={!followingModels}
                disabled={save.isPending}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    // 自定义从当前生效组合起步:人从一个已知跑得起来的组合上改。
                    models: current.models ?? baseline.models ?? globalModels ?? [],
                  }))
                }
              >
                自定义
              </SegmentButton>
            </div>
          }
        >
          {followingModels ? (
            <>
              <Kv label="跟随全局默认">
                {shownModels === undefined ? (
                  <span className="text-text-muted">使用全局组合</span>
                ) : (
                  <span><span className="tabular-nums">{shownModels.length}</span> 个</span>
                )}
              </Kv>
              {shownModels === undefined || shownModels.length === 0 ? null : (
                <div className="flex flex-wrap gap-2">
                  {shownModels.map(({ identity, thinkingLevel }) => (
                    <span
                      key={identity}
                      className="rounded-full bg-fill px-3 py-[3px] font-mono text-base break-all"
                    >
                      {identity}
                      {thinkingLevel === undefined ? null : (
                        <span className="ml-1.5 font-sans text-text-muted">
                          思考 {THINKING_LEVEL_LABEL[thinkingLevel]}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              )}
              <p className="text-base text-text-muted">
                审查策略更新后，本仓库将同步使用新组合。
              </p>
            </>
          ) : (
            <>
              <p className="text-base text-text-muted">
                本仓库覆盖会完全替换全局默认组合，至少选择一个模型。保存后下一次审查使用这组模型。
              </p>
              {/* 已落库但失效的标识原样留在编辑态里,移除不受阻;只有保存仍含不可用项时才门禁。 */}
              <ModelComposer
                value={draft.models ?? []}
                onChange={(next) => setDraft((current) => ({ ...current, models: next }))}
                onValidityChange={setValidity}
              />
              {draft.models !== null && draft.models.length === 0 ? (
                <span className="text-base text-text-muted">
                  至少选择一个模型才能保存。要改回全局默认，请点“跟随全局”。
                </span>
              ) : validity.unavailable.length > 0 ? (
                <span className="text-base text-danger">先恢复或移除不可用模型，再保存。</span>
              ) : !validity.ready ? (
                <span className="text-base text-text-muted">模型状态确认后即可保存。</span>
              ) : null}
            </>
          )}
        </Section>

        {/* 辅助模型(CONTEXT.md 辅助模型,issue #303)与模型组合同形的两态:Reviewer 之外的
            agent 工作用它。自定义从生效值起步,生效值由服务端那一处解析给出。 */}
        <Section
          title={
            <>
              辅助模型
              <HelpTooltip
                label="辅助模型说明"
                content="Reviewer 之外的全部 agent 工作用它：合并 agent、基点探索、知识整理、处置反哺与人工提议。跟随全局即用审查策略里的辅助模型；两处都没设时用这个仓库生效模型组合的第一个。"
              />
            </>
          }
          action={
            <div
              className="flex shrink-0 rounded-sm bg-fill p-0.5 text-base"
              role="group"
              aria-label="辅助模型来源"
            >
              <SegmentButton
                active={followingAuxiliary}
                disabled={save.isPending}
                onClick={() => {
                  setCustomAuxiliary(false);
                  setDraft((current) => ({ ...current, auxiliary: null }));
                }}
              >
                跟随全局
              </SegmentButton>
              <SegmentButton
                active={!followingAuxiliary}
                disabled={save.isPending}
                onClick={() => {
                  setCustomAuxiliary(true);
                  setDraft((current) => ({
                    ...current,
                    // 自定义从当前生效值起步:人从一处已知跑得起来的引用上改。三处都给不出
                    // 生效值时从空选择起步,那时这个仓库自己先设一处也是合法的下一步。
                    auxiliary: current.auxiliary ?? baseline.auxiliary ?? effectiveAuxiliaryRef,
                  }));
                }}
              >
                自定义
              </SegmentButton>
            </div>
          }
        >
          {followingAuxiliary ? (
            <>
              <Kv label="跟随全局默认">
                {/* 只读投影说的是库里此刻那一份。草稿刚把仓库覆盖清掉时它还指着那处覆盖,
                    那时不冒充「跟随后会用哪一处」——保存之后再读它才是真的。 */}
                {view?.source === "repo" || view?.identity == null ? (
                  <span className="text-text-muted">
                    {view?.source === "repo" ? "保存后跟随全局那一处" : "还没有可用的辅助模型"}
                  </span>
                ) : (
                  // 引用、档位与来源交给知识集弹窗那三处同一个组件,同一份只读投影。
                  <AuxiliaryModelLine view={view} />
                )}
              </Kv>
              <p className="text-base text-text-muted">
                {view === undefined || view.source === null
                  ? "到审查策略设一处辅助模型或配好模型组合，这个仓库的知识任务才发起得了。"
                  : view.source === "repo"
                  ? "跟随全局后用审查策略里的辅助模型，没设时用这个仓库生效模型组合的第一个。"
                  : "审查策略里的辅助模型改了，本仓库跟着换。"}
              </p>
            </>
          ) : (
            <>
              <p className="text-base text-text-muted">
                本仓库的辅助模型替换审查策略里的辅助模型，只对这个仓库生效。
              </p>
              <AuxiliaryModelPicker
                id={`repo-${repo.repoId}-auxiliary`}
                value={draft.auxiliary}
                disabled={save.isPending}
                onChange={(next) => setDraft((current) => ({ ...current, auxiliary: next }))}
              />
            </>
          )}
        </Section>

        {/* 最低报告等级(CONTEXT.md,issue #273)与模型组合同形的两态,同一张表单一起保存。 */}
        <Section
          title={
            <>
              最低报告等级
              <HelpTooltip
                label="最低报告等级说明"
                content="低于它的 Finding 不发出。它只管新报的问题：未处置的历史 Finding 照旧注入并复核，等级再低也一样。改了之后下一轮审查生效，已开跑的轮次沿用开跑时的值。"
              />
            </>
          }
          action={
            <div
              className="flex shrink-0 rounded-sm bg-fill p-0.5 text-base"
              role="group"
              aria-label="最低报告等级来源"
            >
              <SegmentButton
                active={followingSeverity}
                disabled={save.isPending}
                onClick={() => setDraft((current) => ({ ...current, minReportSeverity: null }))}
              >
                跟随全局
              </SegmentButton>
              <SegmentButton
                active={!followingSeverity}
                disabled={save.isPending}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    minReportSeverity: current.minReportSeverity ?? effectiveSeverity,
                  }))
                }
              >
                自定义
              </SegmentButton>
            </div>
          }
        >
          <Kv label={followingSeverity ? "跟随全局默认" : "本仓库覆盖"}>
            {MIN_REPORT_SEVERITY_LABEL[effectiveSeverity]}
          </Kv>
          {followingSeverity ? null : (
            <Select.Root
              value={effectiveSeverity}
              disabled={save.isPending}
              onValueChange={(next) =>
                setDraft((current) => ({
                  ...current,
                  minReportSeverity: next as MinReportSeverity,
                }))
              }
            >
              <Select.Trigger
                aria-label="本仓库的最低报告等级"
                className="w-full max-sm:min-h-11 sm:w-auto"
              />
              <Select.Content>
                {(["P0", "P1", "P2"] as const).map((severity) => (
                  <Select.Item key={severity} value={severity}>
                    {MIN_REPORT_SEVERITY_LABEL[severity]}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          )}
          <p className="text-base text-text-muted">
            {followingSeverity
              ? "审查策略更新后，本仓库将同步使用新的最低报告等级。"
              : "该等级仅对本仓库生效，不随审查策略变化。"}
          </p>
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
                  ?? "该仓库尚未准备工作副本。准备完成后，审查、代码差异和分支列表可直接使用本地副本。"}
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

      {/* 配置的动作条固定在底部:上面两块是表单,准入 Key 与工作副本是各自的动作。 */}
      <div className="sticky bottom-0 mt-3.5 flex flex-wrap items-center gap-3 border-t border-line bg-surface pt-3">
        <Button
          variant="solid"
          size={{ initial: "4", sm: "2" }}
          className="shadow-accent"
          disabled={!dirty || save.isPending || modelsBlocked}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "保存中…" : "保存"}
        </Button>
        <Button
          variant="soft"
          color="gray"
          size={{ initial: "4", sm: "2" }}
          disabled={save.isPending}
          onClick={onRequestClose}
        >
          取消
        </Button>
        {dirty ? <span className="text-base text-text-muted">有未保存改动</span> : null}
      </div>

      <div className="absolute top-3 right-3">
        <Tooltip content="关闭配置">
          <IconButton
            variant="ghost"
            color="gray"
            size={{ initial: "3", sm: "1" }}
            className="max-sm:min-h-11 max-sm:min-w-11"
            aria-label="关闭配置"
            onClick={onRequestClose}
          >
            <Cross2Icon aria-hidden />
          </IconButton>
        </Tooltip>
      </div>
    </Dialog.Content>
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
  const [open, setOpen] = useState(false);
  const [pullNumber, setPullNumber] = useState("");
  const [directive, setDirective] = useState("");
  const [fullReview, setFullReview] = useState(false);
  const rerun = useMutation({
    mutationFn: rerunRequest,
    onSuccess: (text) => {
      onFeedback({ text, isError: false });
      setOpen(false);
      setPullNumber("");
      // 指令一并清空:它只属于刚发出去的那一轮,留在框里下次会被顺手带上。
      setDirective("");
      // 模式同律:下一次重跑仍从「只复核」起步。
      setFullReview(false);
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
    const trimmed = directive.trim();
    rerun.mutate({
      owner: repo.owner,
      repo: repo.repo,
      pullNumber: number,
      ...(trimmed === "" ? {} : { directive: trimmed }),
      mode: fullReview ? "full" : "verdict-only",
    });
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <Button variant="soft" color="gray" size={{ initial: "3", sm: "2" }}>
          重跑 PR
        </Button>
      </Popover.Trigger>
      {/* 工具行里只留这颗按钮:三个控件平铺会把整行挤到换行,而自由文本框贴着
          筛选 chips 会被读成筛选器。表单收进 Popover,字段名义由可见 label 承担。 */}
      <Popover.Content width="300px" align="end">
        <form onSubmit={submit} className="flex flex-col gap-2" aria-busy={rerun.isPending}>
          <label className="flex flex-col gap-1">
            <Text size="1" color="gray">
              PR 编号
            </Text>
            <TextField.Root
              size={{ initial: "3", sm: "2" }}
              placeholder="如:42"
              inputMode="numeric"
              className="max-sm:min-h-11"
              value={pullNumber}
              onChange={(event) => setPullNumber(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <Text size="1" color="gray">
              本轮指令(选填)
            </Text>
            <TextField.Root
              size={{ initial: "3", sm: "2" }}
              placeholder={RUN_DIRECTIVE_PLACEHOLDER}
              maxLength={500}
              className="max-sm:min-h-11"
              value={directive}
              onChange={(event) => setDirective(event.target.value)}
            />
          </label>
          <Text size="1" color="gray">
            {RUN_DIRECTIVE_HINT}
          </Text>
          {/* 默认只复核历史(issue #242):清历史是重跑的常态,整段范围再审一遍不是。 */}
          <Text
            as="label"
            size="2"
            className="flex cursor-pointer items-center gap-2 max-sm:min-h-11"
          >
            <Checkbox
              checked={fullReview}
              onCheckedChange={(checked) => setFullReview(checked === true)}
            />
            完整审查
          </Text>
          <Text size="1" color="gray">
            {FULL_REVIEW_HINT}。指令只作用于这一轮;要长期生效的要求请录进知识集。
          </Text>
          <Flex justify="end" mt="1">
            <Button size={{ initial: "3", sm: "2" }} type="submit" disabled={rerun.isPending}>
              {rerun.isPending ? "触发中…" : "重新运行"}
            </Button>
          </Flex>
        </form>
      </Popover.Content>
    </Popover.Root>
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
 * 搜索经本服务代理(`GET /api/repos/search`),浏览器不直连 Gitea。已注册与
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
              共 {data.total} 个匹配，当前显示前 {data.results.length} 个。继续输入以缩小范围。
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
