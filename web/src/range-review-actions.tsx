import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Cross2Icon, ReloadIcon } from "@radix-ui/react-icons";
import {
  Badge,
  Checkbox,
  Dialog,
  IconButton,
  Text,
  TextArea,
  TextField,
  Tooltip,
} from "@radix-ui/themes";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
import { localMinute } from "@/lib/time";

import { send } from "./api.ts";
import {
  FULL_REVIEW_HINT,
  RUN_DIRECTIVE_HINT,
  RUN_DIRECTIVE_PLACEHOLDER,
  type RerunMode,
} from "./repo-actions.tsx";
import {
  BranchCombobox,
  CommitPicker,
  commitSelectionLabel,
  useBranchOptions,
  type CommitSelection,
} from "./commit-picker.tsx";

/** 一个范围审查。字段与 `GET /api/stages/{stageId}` 的 `rangeReview` 那一格逐字对应。 */
export type RangeReview = {
  id: number;
  owner: string;
  repo: string;
  /** 发起时给的标题(issue #177);升级前的旧记录是 null,按 `#编号` 显示。 */
  title: string | null;
  baseSha: string;
  comparisonSha: string;
  /** 选定当前比较项时用的分支或 Tag(issue #234);旧记录与没带来源的都是 null。 */
  comparisonSource: { kind: "branch" | "tag"; name: string } | null;
  state: "in-progress" | "completed" | "failed";
  /** 容器 PR 的序号;建出来之前是 null。 */
  containerPullNumber: number | null;
  baseBranch: string;
  headBranch: string;
  createdBy: string;
  createdAt: string;
  completedBy: string | null;
  completedAt: string | null;
  lastForgeFailure: string | null;
  /** 每日增量(issue #313)开着没有。 */
  dailyIncrementEnabled: boolean;
  /** 每日增量跟的那条分支;关着时是 null。 */
  dailyIncrementBranch: string | null;
  /** 最近一次定时检查的时刻(issue #314);一次都没检查过时是 null。 */
  scheduledCheckAt: string | null;
  /** 最近一次定时检查的结果;一次都没检查过时是 null。 */
  scheduledCheckResult: ScheduledCheckResult | null;
  /** 每天几点检查(issue #315),实例时区 `HH:mm`;默认 `00:00`。 */
  scheduledCheckTime: string;
  /** 定时检查按哪种模式推进;默认只复核。 */
  scheduledCheckMode: RerunMode;
};

/** 一次定时检查的结果(issue #314),与服务端那一格逐字对应。 */
export type ScheduledCheckResult =
  | "advanced"
  | "no-new-commit"
  | "run-in-flight"
  | "nothing-to-verdict"
  | "not-descendant"
  | "branch-unknown"
  | "push-failed"
  | "draining"
  | "check-failed";

/** 每一档的说法。九档都写出来:结果本身就是人要看的那句话,不另起解释。 */
const SCHEDULED_CHECK_RESULT_LABEL: Record<ScheduledCheckResult, string> = {
  advanced: "已开轮次",
  "no-new-commit": "无新提交",
  "run-in-flight": "有轮次在跑",
  "nothing-to-verdict": "无未处置历史",
  "not-descendant": "非 base 后代",
  "branch-unknown": "分支不存在或取不到",
  "push-failed": "推分支失败",
  draining: "排空中",
  "check-failed": "检查失败",
};

/** 检查模式的说法(issue #315),与推进弹窗「完整审查」勾选的两档同名。 */
const SCHEDULED_CHECK_MODE_LABEL: Record<RerunMode, string> = {
  "verdict-only": "只复核",
  full: "完整审查",
};

/**
 * 结果徽章的三档(DESIGN.md §4.3):开了轮次是成功,要人去动手的那几档是失败,其余是
 * 常规跳过。
 */
function scheduledCheckTone(result: ScheduledCheckResult): StatusTone {
  if (result === "advanced") return "success";
  return result === "not-descendant" ||
    result === "branch-unknown" ||
    result === "push-failed" ||
    result === "check-failed"
    ? "error"
    : "neutral";
}

/** 最近一次定时检查读成一句话。一次都没检查过时说明白,不留空。 */
function lastScheduledCheck(rangeReview: RangeReview): string {
  if (rangeReview.scheduledCheckResult === null || rangeReview.scheduledCheckAt === null) {
    return "最近一次定时检查:还没检查过";
  }
  return `最近一次定时检查:${localMinute(rangeReview.scheduledCheckAt)} · ${
    SCHEDULED_CHECK_RESULT_LABEL[rangeReview.scheduledCheckResult]
  }`;
}

/**
 * 推进与审查完成之后要重取的两处:阶段详情与阶段汇总。首段整片失效,不逐个拼键——
 * 同一个阶段在详情页里两份查询各读一半,动作走完看到的都该是新状态。
 */
function refreshRangeReview(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["stage-detail"] });
  void queryClient.invalidateQueries({ queryKey: ["stage-summary"] });
}

/**
 * 标记审查完成(issue #158)。入口在阶段详情页的页头(issue #176)。
 *
 * 不可逆:容器 pull request 会被关掉、两条分支会被删掉,这个阶段的比较项从此不再推进,
 * 所以走 AlertDialog 二次确认,文案写明对象、影响与还剩什么。
 */
export function CompleteAction({
  rangeReview,
  disabled = false,
}: {
  rangeReview: RangeReview;
  /** 已经审查完成的阶段按钮留着但不可用(issue #176)。 */
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = useMutation({
    mutationFn: async () => {
      await send(`/range-reviews/${rangeReview.id}/complete`, "POST");
    },
    onSuccess: () => refreshRangeReview(queryClient),
    onError: (failure: Error) => setError(failure.message),
  });

  return (
    <>
      {error === null ? null : (
        <p role="alert" className="w-full text-danger">{error}</p>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button
            variant="outline"
            color="gray"
            highContrast
            size={{ initial: "3", sm: "2" }}
            disabled={disabled || complete.isPending}
          >
            {complete.isPending ? "正在标记完成…" : "审查完成"}
          </Button>
        }
        title={`将 ${rangeReview.owner}/${rangeReview.repo} 的当前范围审查标记为审查完成？`}
        titleSize="4"
        titleMb="2"
        maxWidth="440px"
        description={
          <>
            承载 Finding 的 Forge pull request 将关闭，两个临时分支将删除，比较项将无法继续推进。
            未处置 Finding 继续按未处置计入处置率；Finding、处置和备注均会保留。
            后续可使用相同 base 发起新的范围审查。
          </>
        }
        direction={{ initial: "column-reverse", sm: "row" }}
        cancelLabel="取消"
        cancelVariant="soft"
        confirm={{
          label: "审查完成",
          color: "red",
          onClick: () => {
            setError(null);
            setOpen(false);
            complete.mutate();
          },
        }}
      />
    </>
  );
}

/**
 * 每日增量的开关(issue #313)。入口在阶段详情页头,与推进、审查完成并列;阶段结束之后
 * 不显示——终态没有明天可跟。
 *
 * 开、关、改任一项都只改状态:推进由定时检查在配置的检查时刻做,点开关不等于现在跑一轮
 * (CONTEXT.md 每日增量)。开着时按钮上直接写它跟的那条分支与「时刻 · 模式」(issue #315)。
 */
export function DailyIncrementAction({ rangeReview }: { rangeReview: RangeReview }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button
          variant="outline"
          color="gray"
          highContrast
          size={{ initial: "3", sm: "2" }}
          title={lastScheduledCheck(rangeReview)}
        >
          每日增量
          {/* 绿只承载运行状态(DESIGN.md §4.3):开着就是有人在替这个阶段盯着。 */}
          <StatusBadge tone={rangeReview.dailyIncrementEnabled ? "success" : "neutral"}>
            <span className="max-w-32 truncate">
              {rangeReview.dailyIncrementEnabled ? rangeReview.dailyIncrementBranch : "关"}
            </span>
          </StatusBadge>
          {rangeReview.dailyIncrementEnabled ? (
            <StatusBadge tone="neutral">
              {rangeReview.scheduledCheckTime} · {SCHEDULED_CHECK_MODE_LABEL[rangeReview.scheduledCheckMode]}
            </StatusBadge>
          ) : null}
          {/* 最近一次的结果就在开关旁(issue #314):昨晚推没推进、为什么没推,一眼看得到。 */}
          {rangeReview.scheduledCheckResult === null ? null : (
            <StatusBadge tone={scheduledCheckTone(rangeReview.scheduledCheckResult)}>
              {SCHEDULED_CHECK_RESULT_LABEL[rangeReview.scheduledCheckResult]}
            </StatusBadge>
          )}
        </Button>
      </Dialog.Trigger>
      {open ? (
        <DailyIncrementDialogContent rangeReview={rangeReview} onDone={() => setOpen(false)} />
      ) : null}
    </Dialog.Root>
  );
}

/**
 * 每日增量的弹窗(issue #313、#315):分支、检查时刻与检查模式。
 *
 * 时刻用原生时间输入,值就是 24 小时制的 `HH:mm`,与接口同形;模式复用推进弹窗「完整
 * 审查」那个勾选与文案,两处说的是同一件事。两项都从此刻的配置预填。
 *
 * 分支列表与刷新复用提交选择器那一份(`useBranchOptions`):两处读同一个接口,分支刚推
 * 上去时点一次刷新就同步得到。
 *
 * 预填按这个顺序:已经开着就是它此刻跟的那条,否则取上次选比较项记下的分支;上次是从
 * Tag 选的或没有来源时留空,必须自己选一条——定时检查永远要有一条明确的分支可跟。
 */
function DailyIncrementDialogContent({
  rangeReview,
  onDone,
}: {
  rangeReview: RangeReview;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const branchOptions = useBranchOptions(rangeReview.owner, rangeReview.repo, refreshGeneration);
  const [branch, setBranch] = useState<string | null>(
    rangeReview.dailyIncrementBranch
      ?? (rangeReview.comparisonSource?.kind === "branch"
        ? rangeReview.comparisonSource.name
        : null),
  );
  const [time, setTime] = useState(rangeReview.scheduledCheckTime);
  const [fullReview, setFullReview] = useState(rangeReview.scheduledCheckMode === "full");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (next: string | null) => {
      await send(
        `/range-reviews/${rangeReview.id}/daily-increment`,
        "PUT",
        next === null
          ? { enabled: false }
          : {
              enabled: true,
              branch: next,
              time,
              mode: fullReview ? "full" : "verdict-only",
            },
      );
    },
    onSuccess: () => {
      refreshRangeReview(queryClient);
      onDone();
    },
    onError: (failure: Error) => setError(failure.message),
  });

  return (
    <Dialog.Content aria-describedby={undefined} maxWidth="460px" size={{ initial: "2", sm: "3" }}>
      <Dialog.Title size="4" mb="2" className="pr-10">
        每日增量
        <span className="ml-2 break-all text-md font-normal text-text-secondary">
          {rangeReview.owner}/{rangeReview.repo}
        </span>
      </Dialog.Title>
      <Text as="p" size="2" color="gray">
        开着时每天到检查时刻由定时检查把这条分支的最新提交推成新比较项，按检查模式开一轮。
        开、关、改任一项都不会立刻推进。
      </Text>
      {/* 最近一次定时检查的时间与结果(issue #314)。 */}
      <Text as="p" size="2" color="gray" mt="2">
        {lastScheduledCheck(rangeReview)}
      </Text>
      <div className="mt-3 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <BranchCombobox
            branch={branch}
            branches={branchOptions.branches}
            search={branchOptions.search}
            loading={branchOptions.loading}
            truncated={branchOptions.truncated}
            onSearch={branchOptions.setSearch}
            onSelect={(value) => {
              setError(null);
              setBranch(value);
            }}
          />
        </div>
        <Tooltip content="同步并刷新分支">
          <IconButton
            type="button"
            variant="ghost"
            color="gray"
            size={{ initial: "3", sm: "2" }}
            className="shrink-0 max-sm:min-h-11 max-sm:min-w-11"
            aria-label="刷新分支"
            disabled={branchOptions.synced.isFetching}
            onClick={() => setRefreshGeneration((current) => current + 1)}
          >
            <ReloadIcon
              aria-hidden
              className={branchOptions.synced.isFetching ? "animate-spin" : ""}
            />
          </IconButton>
        </Tooltip>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Text as="label" size="2" className="flex items-center gap-2">
          检查时刻
          <TextField.Root
            type="time"
            required
            size={{ initial: "3", sm: "2" }}
            className="max-sm:min-h-11"
            value={time}
            onChange={(event) => {
              setError(null);
              setTime(event.currentTarget.value);
            }}
          />
        </Text>
        <Text as="label" size="2" className="flex cursor-pointer items-center gap-2 max-sm:min-h-11">
          <Checkbox
            checked={fullReview}
            onCheckedChange={(checked) => {
              setError(null);
              setFullReview(checked === true);
            }}
          />
          完整审查
          <Text size="1" color="gray">
            {FULL_REVIEW_HINT}
          </Text>
        </Text>
      </div>
      {error === null ? null : (
        <p role="alert" className="mt-2 break-words text-sm text-danger">{error}</p>
      )}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:justify-end">
        <Dialog.Close>
          <Button
            type="button"
            variant="soft"
            color="gray"
            size={{ initial: "3", sm: "2" }}
            className="min-h-11 w-full sm:min-h-0 sm:w-auto"
          >
            取消
          </Button>
        </Dialog.Close>
        {rangeReview.dailyIncrementEnabled ? (
          <Button
            type="button"
            variant="soft"
            color="red"
            size={{ initial: "3", sm: "2" }}
            className="min-h-11 w-full sm:min-h-0 sm:w-auto"
            disabled={save.isPending}
            onClick={() => {
              setError(null);
              save.mutate(null);
            }}
          >
            关闭每日增量
          </Button>
        ) : null}
        <Button
          type="button"
          variant="solid"
          size={{ initial: "3", sm: "2" }}
          className="col-span-2 min-h-11 w-full shadow-accent sm:col-span-1 sm:min-h-0 sm:w-auto"
          disabled={branch === null || time === "" || save.isPending}
          onClick={() => {
            setError(null);
            save.mutate(branch);
          }}
        >
          {rangeReview.dailyIncrementEnabled ? "保存" : "开启"}
        </Button>
      </div>
    </Dialog.Content>
  );
}

/**
 * 增量评审(issue #157)。入口在阶段详情页的页头(issue #176)。
 */
export function AdvanceAction({
  rangeReview,
  disabled = false,
  onAdvanced,
}: {
  rangeReview: RangeReview;
  /** 已经审查完成的阶段按钮留着但不可用(issue #176)。 */
  disabled?: boolean;
  /** 推进成功后通知外层:新一轮要过一会才建出来,页面据此续查。 */
  onAdvanced?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button
          variant="solid"
          className="shadow-accent"
          size={{ initial: "3", sm: "2" }}
          disabled={disabled}
        >
          增量评审
        </Button>
      </Dialog.Trigger>
      {open ? (
        <AdvanceDialogContent
          rangeReview={rangeReview}
          onAdvanced={() => {
            setOpen(false);
            onAdvanced?.();
          }}
        />
      ) : null}
    </Dialog.Root>
  );
}

/**
 * 增量评审的表单(issue #157)。
 *
 * 只收新的比较项:base 是这个阶段不变的基准,推进不改它,所以选择器走 `baseLocked`
 * 那一档(issue #179),base 只以短 sha 显示。手输框已删——人只记得分支与提交信息。
 *
 * 不是 base 后代的提交在列表里置灰:服务端本来就会拒,人不该点下去才知道。作者 rebase
 * 之后的 commit 仍在另一条从 base 分出去的分支上,换条分支照样选得到(user story 33)。
 *
 * 选择器停在上次选比较项用的那条分支或 Tag 模式上,默认只列当前比较项之后的提交
 * (issue #234):base 的后代里还有比当前比较项早的,人每次推进要的是作者这次推了什么。
 *
 * 「完整审查」默认不勾,与重跑弹窗同一个默认:不勾那一轮只复核这个阶段未处置的历史,
 * 要审作者新推的代码时勾上。勾选与指令一样随弹窗关闭卸载,下次打开回到默认。
 */
function AdvanceDialogContent({
  rangeReview,
  onAdvanced,
}: {
  rangeReview: RangeReview;
  onAdvanced: () => void;
}) {
  const queryClient = useQueryClient();
  const [comparison, setComparison] = useState<CommitSelection | null>(null);
  const [directive, setDirective] = useState("");
  const [fullReview, setFullReview] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const advance = useMutation({
    mutationFn: async () => {
      // 本轮指令(issue #225)选填,留空即不带这一格,只作用于推进出来的这一轮。
      const trimmed = directive.trim();
      // 只在只复核那一档带上模式(issue #250):接口不带即完整审查,弹窗默认因此要显式带上。
      const mode: RerunMode = fullReview ? "full" : "verdict-only";
      await send(`/range-reviews/${rangeReview.id}/advance`, "POST", {
        comparison: comparison?.sha ?? "",
        // 这一次是从哪条分支或 Tag 选的(issue #234),下次开弹窗就停在这里。
        ...(comparison?.source === undefined ? {} : { comparisonSource: comparison.source }),
        ...(trimmed === "" ? {} : { directive: trimmed }),
        ...(mode === "full" ? {} : { mode }),
      });
    },
    onSuccess: () => {
      refreshRangeReview(queryClient);
      onAdvanced();
    },
    onError: (failure: Error) => setError(failure.message),
  });

  return (
    <Dialog.Content
      aria-describedby={undefined}
      maxWidth="800px"
      size={{ initial: "2", sm: "3" }}
      className="h-[min(780px,calc(100dvh-4.5rem))] overflow-hidden p-0"
    >
      <form
        className="flex h-full min-h-0 flex-col"
        aria-busy={advance.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          if (comparison === null) return;
          advance.mutate();
        }}
      >
        <div className="shrink-0 border-b border-overlay-line px-4 py-3 sm:px-5 sm:py-4">
          {/* 仓库名放在同一个标题里:Heading 与 Text 各带 leading-trim 伪元素,分成两个元素做 baseline 对齐会错位。 */}
          <Dialog.Title size="4" mb="0" className="pr-10">
            增量评审
            <span className="ml-2 break-all text-md font-normal text-text-secondary">
              {rangeReview.owner}/{rangeReview.repo}
            </span>
          </Dialog.Title>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 py-3 sm:px-5 sm:py-4">
          <dl className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="min-w-0 rounded-lg bg-sunken px-3 py-2">
              <dt className="flex items-center gap-1.5 text-sm text-text-muted">
                基准 <Badge color="gray" variant="soft">锁定</Badge>
              </dt>
              <dd className="mt-0.5 min-w-0 truncate font-mono text-base" title={rangeReview.baseSha}>
                {rangeReview.baseSha.slice(0, 7)}
              </dd>
            </div>
            <div className="min-w-0 rounded-lg bg-sunken px-3 py-2">
              <dt className="text-sm text-text-muted">当前比较项</dt>
              <dd className="mt-0.5 min-w-0 truncate font-mono text-base" title={rangeReview.comparisonSha}>
                {rangeReview.comparisonSha.slice(0, 7)}
              </dd>
            </div>
            <div className="col-span-2 min-w-0 rounded-lg bg-accent-tint px-3 py-2 sm:col-span-1">
              <dt className="text-sm text-primary">新比较项</dt>
              <dd
                className="mt-0.5 min-w-0 truncate text-base"
                title={comparison === null ? undefined : commitSelectionLabel(comparison)}
              >
                {comparison === null ? "待选择" : commitSelectionLabel(comparison)}
              </dd>
            </div>
          </dl>

          <CommitPicker
            repo={{ owner: rangeReview.owner, repo: rangeReview.repo }}
            base={{ sha: rangeReview.baseSha }}
            comparison={comparison}
            baseLocked
            {...(rangeReview.comparisonSource === null
              ? {}
              : {
                  initialMode: rangeReview.comparisonSource.kind,
                  ...(rangeReview.comparisonSource.kind === "branch"
                    ? { initialBranch: rangeReview.comparisonSource.name }
                    : {}),
                })}
            current={{ sha: rangeReview.comparisonSha }}
            onPick={(_role, selection) => {
              setError(null);
              setComparison(selection);
            }}
          />

          <div className="shrink-0">
            <Text as="label" htmlFor="advance-directive" size="1" color="gray">
              本轮指令(选填,只作用于推进出来的这一轮)
            </Text>
            <TextArea
              id="advance-directive"
              size="2"
              rows={2}
              maxLength={500}
              className="mt-1"
              placeholder={RUN_DIRECTIVE_PLACEHOLDER}
              value={directive}
              onChange={(event) => setDirective(event.target.value)}
            />
            <Text as="p" size="1" color="gray" className="mt-1">
              {RUN_DIRECTIVE_HINT}
            </Text>
            <Text
              as="label"
              size="2"
              className="mt-3 flex cursor-pointer items-center gap-2 max-sm:min-h-11"
            >
              <Checkbox
                checked={fullReview}
                onCheckedChange={(checked) => setFullReview(checked === true)}
              />
              完整审查
              <Text size="1" color="gray">
                {FULL_REVIEW_HINT}
              </Text>
            </Text>
          </div>
        </div>

        <div className="shrink-0 border-t border-overlay-line bg-sunken px-4 py-3 sm:px-5">
          {error === null ? null : (
            <p role="alert" className="mb-2 break-words text-sm text-danger">{error}</p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <Text as="p" size="1" color="gray">
              仅可选择基准的后代；推进后启动新一轮 Review Run。
            </Text>
            <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex">
              <Dialog.Close>
                <Button type="button" variant="soft" color="gray" size={{ initial: "3", sm: "2" }} className="min-h-11 w-full sm:min-h-0 sm:w-auto">
                  取消
                </Button>
              </Dialog.Close>
              <Button
                type="submit"
                variant="solid"
                className="min-h-11 w-full shadow-accent sm:min-h-0 sm:w-auto"
                size={{ initial: "3", sm: "2" }}
                disabled={comparison === null || advance.isPending}
              >
                {advance.isPending ? "推进中…" : "推进"}
              </Button>
            </div>
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
            aria-label="关闭增量评审"
          >
            <Cross2Icon aria-hidden />
          </IconButton>
        </Dialog.Close>
      </div>
    </Dialog.Content>
  );
}
