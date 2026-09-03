import {
  Badge,
  Box,
  Checkbox,
  Flex,
  IconButton,
  Popover,
  SegmentedControl,
  Select,
  Skeleton,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import { CheckIcon, ChevronDownIcon, MagnifyingGlassIcon, ReloadIcon } from "@radix-ui/react-icons";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { fetchJson } from "./api.ts";
import { CommitChip } from "./components/commit-chip.tsx";
import { DateRangePicker, type DateRangeValue } from "./components/date-range-picker.tsx";
import { EmptyState } from "./components/empty-state.tsx";

/** 结果区的空态:这块是弹窗里的一整块高容器,贴左上角会让整块留白悬空,统一居中。 */
function PickerEmpty(props: Parameters<typeof EmptyState>[0]) {
  return <EmptyState align="center" className="h-full justify-center" {...props} />;
}
import { MasterListItem } from "./components/master-list-item.tsx";
import { Button } from "./components/theme-button.ts";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "./components/ui/command";
import { localMinute } from "./lib/time.ts";
import { cn } from "./lib/utils.ts";

/** v8 描边型控件(DESIGN.md §9.1):白底 + 输入框描边 + 控件阴影,与 DateRangePicker 的触发按钮同一形态。 */
const OUTLINED_CONTROL = "rounded-md border border-input bg-surface text-md font-medium text-text shadow-control";
/** 常规控件桌面 size 2,窄屏 size 3 并保 44px 触控目标(DESIGN.md §6.1)。 */
const CONTROL_SIZE = { initial: "3", sm: "2" } as const;

type CommitRole = "base" | "comparison";
type PickerMode = "branch" | "tag";
type DatePreset = "all" | "7" | "30" | "90" | "custom";
type MergeFilter = "all" | "only" | "non";

export type CommitSelection = {
  sha: string;
  source?: {
    kind: PickerMode;
    name: string;
  };
};

type RepoBranch = {
  name: string;
  isDefault: boolean;
};

type BranchPage = {
  branches: RepoBranch[];
  truncated: boolean;
};

type RepoCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authoredAt: string;
  descendsFromBase?: boolean;
  messageMatchExcerpt?: string;
};

type CommitPage = {
  commits: RepoCommit[];
  nextOffset: number | null;
};

type RepoTag = {
  name: string;
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authoredAt: string;
  tagger?: string;
  taggedAt?: string;
  descendsFromBase?: boolean;
  messageMatchExcerpt?: string;
};

type TagPage = {
  tags: RepoTag[];
  nextOffset: number | null;
  hasUsableTags: boolean;
};

type FilterState = {
  search: string;
  datePreset: DatePreset;
  customRange: DateRangeValue;
  merge: MergeFilter;
  legalOnly: boolean;
};

type CommitPickerProps = {
  repo: { owner: string; repo: string };
  base: CommitSelection | null;
  comparison: CommitSelection | null;
  baseLocked?: boolean;
  /** 打开时停在哪一种来源(issue #234);不给就是分支模式。 */
  initialMode?: PickerMode;
  /** 打开时浏览哪条分支(issue #234);不给就是仓库默认分支,分支没了走既有空态。 */
  initialBranch?: string;
  /**
   * 当前比较项(issue #234)。在场时勾选「仅当前比较项之后」发 `after=<sha>`,当前
   * 那一行标「当前」且不可选:它是这段的边界,再选一次只会跑一轮同样的 diff。
   */
  current?: { sha: string };
  /**
   * 只选一个 commit 的那一档(issue #205 的基点探索):固定停在 `base` 这一侧,不显示
   * 两格切换、选完也不跳到比较项。`singleLabel` 是这一侧在结果栏里的名字。
   */
  singleLabel?: string;
  onPick: (role: CommitRole, selection: CommitSelection) => void;
};

const PAGE_SIZE = 30;

function defaultFilters(): FilterState {
  return {
    search: "",
    datePreset: "all",
    customRange: { from: "", to: "" },
    merge: "all",
    legalOnly: true,
  };
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debounced;
}

function localDayBoundary(day: Date, end: boolean): string {
  const boundary = new Date(day);
  boundary.setHours(end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0);
  return boundary.toISOString();
}

function dayFromInput(value: string): Date | undefined {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (parts === null) return undefined;
  return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
}

function filterQuery(
  filters: FilterState,
  search: string,
  role: CommitRole,
  baseSha?: string,
  currentSha?: string,
): string {
  const query = new URLSearchParams();
  if (search.trim() !== "") query.set("q", search.trim());
  if (filters.datePreset === "custom") {
    const from = dayFromInput(filters.customRange.from);
    const to = dayFromInput(filters.customRange.to);
    if (from !== undefined) {
      query.set("from", localDayBoundary(from, false));
    }
    if (to !== undefined) {
      query.set("to", localDayBoundary(to, true));
    }
  } else if (filters.datePreset !== "all") {
    const days = Number(filters.datePreset);
    const now = new Date();
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const from = new Date(to);
    from.setDate(from.getDate() - days + 1);
    query.set("from", localDayBoundary(from, false));
    query.set("to", localDayBoundary(to, true));
  }
  if (filters.merge !== "all") query.set("merge", filters.merge);
  if (role === "comparison" && baseSha !== undefined) {
    query.set("base", baseSha);
    query.set("legal", filters.legalOnly ? "only" : "all");
    // 服务端只在「只看合法后代」那一档收 after(issue #234)。
    if (filters.legalOnly && currentSha !== undefined) query.set("after", currentSha);
  }
  return query.toString();
}

export function commitSelectionLabel(selection: CommitSelection): string {
  const shortSha = selection.sha.slice(0, 7);
  return selection.source === undefined
    ? shortSha
    : `经 ${selection.source.name} 选择 · ${shortSha}`;
}

function BranchCombobox({
  branch,
  branches,
  search,
  loading,
  truncated,
  onSearch,
  onSelect,
}: {
  branch: string | null;
  branches: RepoBranch[];
  search: string;
  loading: boolean;
  truncated: boolean;
  onSearch: (value: string) => void;
  onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <Button
          type="button"
          variant="outline"
          color="gray"
          size={CONTROL_SIZE}
          className={cn(OUTLINED_CONTROL, "w-full justify-between px-3 text-left max-sm:min-h-11")}
          aria-label="选择分支"
        >
          <span className={cn("min-w-0 truncate", branch === null && "font-normal text-text-muted")}>
            {branch ?? "选择一条分支"}
          </span>
          <ChevronDownIcon aria-hidden className="shrink-0 text-text-muted" />
        </Button>
      </Popover.Trigger>
      <Popover.Content
        sideOffset={6}
        align="start"
        className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={search}
            onValueChange={onSearch}
            placeholder="搜索分支…"
            aria-label="搜索分支"
          />
          <CommandList>
            {loading ? (
              <div className="space-y-2 p-3">
                <Skeleton height="28px" />
                <Skeleton height="28px" />
              </div>
            ) : null}
            {!loading ? <CommandEmpty>没有匹配的分支</CommandEmpty> : null}
            {!loading ? branches.map((item) => (
              <CommandItem
                key={item.name}
                value={item.name}
                onSelect={() => {
                  onSelect(item.name);
                  setOpen(false);
                }}
                className="max-sm:min-h-11"
              >
                <CheckIcon aria-hidden className={item.name === branch ? "opacity-100" : "opacity-0"} />
                <span className="min-w-0 flex-1 break-all">{item.name}</span>
                {item.isDefault ? <Badge color="gray" variant="soft">默认</Badge> : null}
              </CommandItem>
            )) : null}
          </CommandList>
          {truncated ? (
            <Text as="p" size="1" color="gray" className="border-t border-line px-3 py-2">
              只显示前 50 条，请继续输入缩小范围。
            </Text>
          ) : null}
        </Command>
      </Popover.Content>
    </Popover.Root>
  );
}

function SelectionBadges({
  sha,
  base,
  comparison,
}: {
  sha: string;
  base: CommitSelection | null;
  comparison: CommitSelection | null;
}) {
  if (sha !== base?.sha && sha !== comparison?.sha) return null;
  // 两个角色都是身份标签,走蓝色 Badge;绿只承载运行状态(DESIGN.md §4.3)。
  return (
    <Flex gap="1" wrap="wrap" className="shrink-0">
      {sha === base?.sha ? <Badge color="blue" variant="soft">基准</Badge> : null}
      {sha === comparison?.sha ? <Badge color="blue" variant="soft">比较项</Badge> : null}
    </Flex>
  );
}

/**
 * 审查范围的一格:基准或比较项。既是这一步的切换按钮,也是已选结果的展示位。
 * 当前步蓝 tint 底(编辑中的选择,DESIGN.md §8.3),其余步是 v8 描边型控件。
 */
function RoleCell({
  label,
  placeholder,
  selection,
  active,
  disabled,
  onClick,
}: {
  label: string;
  placeholder: string;
  selection: CommitSelection | null;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      title={selection === null ? undefined : commitSelectionLabel(selection)}
      className={cn(
        "min-w-0 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 max-sm:min-h-11",
        active
          ? "border-accent-track bg-accent-tint"
          : "border-input bg-surface shadow-control hover:bg-sunken",
        disabled && "cursor-not-allowed opacity-60 hover:bg-surface",
      )}
    >
      <span className={cn("block text-sm font-semibold", active ? "text-primary" : "text-text-secondary")}>
        {label}
      </span>
      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-base">
        {selection === null ? (
          <span className="truncate text-text-muted">{placeholder}</span>
        ) : (
          <>
            <CommitChip sha={selection.sha} />
            {selection.source === undefined ? null : (
              <span className="min-w-0 truncate text-text-muted">经 {selection.source.name}</span>
            )}
          </>
        )}
      </span>
    </button>
  );
}

function PickerFilters({
  filters,
  legalContext,
  legalLabel,
  onChange,
}: {
  filters: FilterState;
  legalContext: boolean;
  /** 勾选的口径:发起是「仅合法后代」,增量评审是「仅当前比较项之后」(issue #234)。 */
  legalLabel: string;
  onChange: (patch: Partial<FilterState>) => void;
}) {
  return (
    <>
      <Select.Root
        size={CONTROL_SIZE}
        value={filters.datePreset}
        onValueChange={(value) => onChange({ datePreset: value as DatePreset })}
      >
        <Select.Trigger aria-label="提交日期" className="w-full max-sm:min-h-11 sm:w-auto" />
        <Select.Content>
          <Select.Item value="all">不限日期</Select.Item>
          <Select.Item value="7">最近 7 天</Select.Item>
          <Select.Item value="30">最近 30 天</Select.Item>
          <Select.Item value="90">最近 90 天</Select.Item>
          <Select.Item value="custom">自定义日期</Select.Item>
        </Select.Content>
      </Select.Root>
      <Select.Root
        size={CONTROL_SIZE}
        value={filters.merge}
        onValueChange={(value) => onChange({ merge: value as MergeFilter })}
      >
        <Select.Trigger aria-label="合并提交筛选" className="w-full max-sm:min-h-11 sm:w-auto" />
        <Select.Content>
          <Select.Item value="all">全部提交</Select.Item>
          <Select.Item value="only">仅合并提交</Select.Item>
          <Select.Item value="non">排除合并提交</Select.Item>
        </Select.Content>
      </Select.Root>
      {legalContext ? (
        <Text as="label" size="2" className="flex cursor-pointer items-center gap-2 px-1 whitespace-nowrap max-sm:min-h-11">
          <Checkbox
            checked={filters.legalOnly}
            onCheckedChange={(checked) => onChange({ legalOnly: checked === true })}
          />
          {legalLabel}
        </Text>
      ) : null}
    </>
  );
}

function PickerResultRow({
  disabled,
  selected,
  onClick,
  content,
  badges,
  metadata,
}: {
  disabled: boolean;
  selected: boolean;
  onClick: () => void;
  content: ReactNode;
  badges: ReactNode;
  metadata: ReactNode;
}) {
  // 行是页内选择项,走 MasterListItem 的选中态(蓝 tint + 左条 + 650,DESIGN.md §8.2)。
  // 不可选的行留在 Tab 序里并保留 aria-disabled:读屏用户要能读到「不是基准的后代」。
  return (
    <li className="border-t border-line first:border-t-0">
      <MasterListItem
        selected={selected}
        aria-disabled={disabled}
        onClick={() => {
          if (!disabled) onClick();
        }}
        className={cn(
          "block px-4 py-2.5 data-[selected=false]:font-medium",
          disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
        )}
      >
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0 flex-1">{content}</span>
          {badges}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-normal text-text-muted">
          {metadata}
        </span>
      </MasterListItem>
    </li>
  );
}

function ResultsSkeleton() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-2 px-4 py-3">
      <span className="sr-only">正在读取可选提交</span>
      {[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-12" />)}
    </div>
  );
}

export function CommitPicker({
  repo: repoRef,
  base,
  comparison,
  baseLocked = false,
  initialMode,
  initialBranch,
  current,
  singleLabel,
  onPick,
}: CommitPickerProps) {
  const { owner, repo } = repoRef;
  const [mode, setMode] = useState<PickerMode>(initialMode ?? "branch");
  const single = singleLabel !== undefined;
  const [role, setRole] = useState<CommitRole>(
    !single && (baseLocked || base !== null) ? "comparison" : "base",
  );
  const [filters, setFilters] = useState<Record<PickerMode, FilterState>>({
    branch: defaultFilters(),
    tag: defaultFilters(),
  });
  // undefined 表示「还没选过,跟着仓库默认分支」;上次选比较项用的那条分支取代它。
  const [browsedBranch, setBrowsedBranch] = useState<string | null | undefined>(initialBranch);
  const [missingBranch, setMissingBranch] = useState<string>();
  const [branchSearch, setBranchSearch] = useState("");
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const sourceLabelId = useId();
  const roleLabelId = useId();
  const resultsLabelId = useId();
  const activeFilters = filters[mode];
  const debouncedBranchCommitSearch = useDebounced(filters.branch.search, 250);
  const debouncedTagSearch = useDebounced(filters.tag.search, 250);
  const debouncedSearch = mode === "branch" ? debouncedBranchCommitSearch : debouncedTagSearch;
  const debouncedBranchSearch = useDebounced(branchSearch, 250);

  useEffect(() => {
    if (single) return;
    if (baseLocked || base !== null) setRole("comparison");
    else setRole("base");
  }, [base?.sha, baseLocked, single]);

  const syncedBranches = useQuery({
    queryKey: ["repo-picker-sync", owner, repo, refreshGeneration],
    queryFn: () => fetchJson<BranchPage>(
      `/repo-branches?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&refresh=1`,
    ),
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const defaultBranch = syncedBranches.data?.branches.find((item) => item.isDefault)?.name
    ?? syncedBranches.data?.branches[0]?.name
    ?? null;
  const branch = browsedBranch === undefined ? defaultBranch : browsedBranch;

  const branchMatches = useQuery({
    queryKey: ["repo-branch-search", owner, repo, refreshGeneration, debouncedBranchSearch],
    queryFn: () => fetchJson<BranchPage>(
      `/repo-branches?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`
      + `&refresh=0&q=${encodeURIComponent(debouncedBranchSearch)}`,
    ),
    enabled: syncedBranches.isSuccess && debouncedBranchSearch.trim() !== "",
  });

  const branchExists = useQuery({
    queryKey: ["repo-branch-exists", owner, repo, refreshGeneration, branch],
    queryFn: async () => {
      const page = await fetchJson<BranchPage>(
        `/repo-branches?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`
        + `&refresh=0&exact=1&q=${encodeURIComponent(branch ?? "")}`,
      );
      return page.branches.some((item) => item.name === branch);
    },
    enabled: syncedBranches.isSuccess && branch !== null,
  });

  useEffect(() => {
    if (branch !== null && branchExists.data === false) {
      setMissingBranch(branch);
      setBrowsedBranch(null);
    }
  }, [branch, branchExists.data]);

  const pickerFilterQuery = useMemo(
    () => filterQuery(activeFilters, debouncedSearch, role, base?.sha, current?.sha),
    [activeFilters, base?.sha, current?.sha, debouncedSearch, role],
  );

  const commits = useInfiniteQuery({
    queryKey: ["repo-commits", owner, repo, branch, refreshGeneration, pickerFilterQuery],
    queryFn: ({ pageParam }) => fetchJson<CommitPage>(
      `/repo-commits?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`
      + `&branch=${encodeURIComponent(branch ?? "")}&offset=${pageParam}&limit=${PAGE_SIZE}`
      + (pickerFilterQuery === "" ? "" : `&${pickerFilterQuery}`),
    ),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    enabled: mode === "branch"
      && branch !== null
      && syncedBranches.isSuccess
      && !syncedBranches.isFetching
      && branchExists.data === true,
  });

  const tags = useInfiniteQuery({
    queryKey: ["repo-tags", owner, repo, refreshGeneration, pickerFilterQuery],
    queryFn: ({ pageParam }) => fetchJson<TagPage>(
      `/repo-tags?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`
      + `&offset=${pageParam}&limit=${PAGE_SIZE}`
      + (pickerFilterQuery === "" ? "" : `&${pickerFilterQuery}`),
    ),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    enabled: mode === "tag" && syncedBranches.isSuccess && !syncedBranches.isFetching,
  });

  const commitRows = commits.data?.pages.flatMap((page) => page.commits) ?? [];
  const tagRows = tags.data?.pages.flatMap((page) => page.tags) ?? [];
  const branches = debouncedBranchSearch.trim() === ""
    ? syncedBranches.data?.branches ?? []
    : branchMatches.data?.branches ?? [];
  const branchOptionsLoading = debouncedBranchSearch.trim() === ""
    ? syncedBranches.isPending
    : branchMatches.isPending;
  const branchesTruncated = debouncedBranchSearch.trim() === ""
    ? syncedBranches.data?.truncated ?? false
    : branchMatches.data?.truncated ?? false;
  const legalContext = role === "comparison" && base !== null;
  // 增量评审那一档的口径是「当前比较项之后」,发起时仍是「合法后代」(issue #234)。
  const legalLabel = current === undefined ? "仅合法后代" : "仅当前比较项之后";
  const hasExplicitFilters = activeFilters.search.trim() !== ""
    || activeFilters.datePreset !== "all"
    || activeFilters.merge !== "all";
  const legalOnlyIsSoleFilter = legalContext && activeFilters.legalOnly && !hasExplicitFilters;
  const hasFilters = hasExplicitFilters || (legalContext && activeFilters.legalOnly);
  const secondaryFilterCount = Number(activeFilters.datePreset !== "all")
    + Number(activeFilters.merge !== "all")
    + Number(legalContext && activeFilters.legalOnly);
  const rowCount = mode === "branch" ? commitRows.length : tagRows.length;

  function updateFilters(patch: Partial<FilterState>) {
    setFilters((current) => ({
      ...current,
      [mode]: { ...current[mode], ...patch },
    }));
  }

  function resetFilters() {
    setFilters((current) => ({ ...current, [mode]: defaultFilters() }));
  }

  function pick(sha: string, source: CommitSelection["source"], descendsFromBase?: boolean) {
    if (role === "comparison" && (base === null || descendsFromBase === false)) return;
    // 当前比较项那一行只标边界,选它等于再跑一轮同样的 diff,服务端也会拒(issue #234)。
    if (sha === current?.sha) return;
    onPick(role, { sha, ...(source === undefined ? {} : { source }) });
    if (role === "base" && !baseLocked && !single) setRole("comparison");
  }

  function refreshRefs() {
    setMissingBranch(undefined);
    setRefreshGeneration((current) => current + 1);
  }

  const currentQuery = mode === "branch" ? commits : tags;
  const initialLoading = syncedBranches.isPending || (mode === "branch"
    ? branch !== null && (branchExists.isPending || (branchExists.data === true && commits.isPending))
    : tags.isPending);
  const queryError = syncedBranches.error ?? (mode === "branch"
    ? branchExists.error ?? commits.error
    : tags.error);

  return (
    <Box className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-card-line bg-surface shadow-card">
      {!baseLocked && !single ? (
        <div className="shrink-0 border-b border-line bg-sunken px-3 py-2.5 sm:px-4 sm:py-3">
          <Text id={roleLabelId} as="div" className="sr-only">
            审查范围
          </Text>
          <div role="group" aria-labelledby={roleLabelId} className="grid grid-cols-2 gap-2">
            <RoleCell
              label="基准"
              placeholder="选择审查起点"
              selection={base}
              active={role === "base"}
              disabled={false}
              onClick={() => setRole("base")}
            />
            <RoleCell
              label="比较项"
              placeholder={base === null ? "先选择基准" : "选择审查终点"}
              selection={comparison}
              active={role === "comparison"}
              disabled={base === null}
              onClick={() => setRole("comparison")}
            />
          </div>
        </div>
      ) : null}

      <div className="shrink-0 space-y-2 border-b border-line px-3 py-2.5 sm:px-4 sm:py-3">
        <Flex gap="2" align="center">
          <Box className="w-28 shrink-0 sm:w-32">
            <Text id={sourceLabelId} as="div" className="sr-only">
              来源
            </Text>
            <SegmentedControl.Root
              aria-labelledby={sourceLabelId}
              size={CONTROL_SIZE}
              value={mode}
              onValueChange={(value) => setMode(value as PickerMode)}
              className="w-full max-sm:min-h-11"
            >
              <SegmentedControl.Item value="branch" className="flex-1">分支</SegmentedControl.Item>
              <SegmentedControl.Item value="tag" className="flex-1">Tag</SegmentedControl.Item>
            </SegmentedControl.Root>
          </Box>
          <Box className="min-w-0 flex-1">
            {mode === "branch" ? (
              <BranchCombobox
                branch={branch}
                branches={branches}
                search={branchSearch}
                loading={branchOptionsLoading}
                truncated={branchesTruncated}
                onSearch={setBranchSearch}
                onSelect={(value) => {
                  setBrowsedBranch(value);
                  setMissingBranch(undefined);
                }}
              />
            ) : (
              <Text as="p" size="2" color="gray" className="truncate px-1">
                浏览仓库中已同步的 Tag
              </Text>
            )}
          </Box>
          <Tooltip content="同步并刷新分支与 Tag">
            <IconButton
              type="button"
              variant="ghost"
              color="gray"
              size={CONTROL_SIZE}
              className="shrink-0 max-sm:min-h-11 max-sm:min-w-11"
              aria-label="刷新分支与 Tag"
              disabled={syncedBranches.isFetching}
              onClick={refreshRefs}
            >
              <ReloadIcon aria-hidden className={syncedBranches.isFetching ? "animate-spin" : ""} />
            </IconButton>
          </Tooltip>
        </Flex>

        <Flex gap="2" align="center">
          <TextField.Root
            value={activeFilters.search}
            onChange={(event) => updateFilters({ search: event.currentTarget.value })}
            placeholder={mode === "branch"
              ? "搜索 SHA、提交信息或作者…"
              : "搜索 Tag、SHA、提交信息或作者…"}
            aria-label={mode === "branch" ? "搜索提交" : "搜索 Tag"}
            autoFocus={baseLocked}
            size={CONTROL_SIZE}
            className="min-w-0 flex-1 max-sm:min-h-11"
          >
            <TextField.Slot><MagnifyingGlassIcon aria-hidden /></TextField.Slot>
          </TextField.Root>

          <div className="hidden items-center gap-2 sm:flex">
            <PickerFilters
              filters={activeFilters}
              legalContext={legalContext}
              legalLabel={legalLabel}
              onChange={updateFilters}
            />
          </div>

          <div className="sm:hidden">
            <Popover.Root>
              <Popover.Trigger>
                <Button
                  type="button"
                  variant="outline"
                  color="gray"
                  size={CONTROL_SIZE}
                  className={cn(OUTLINED_CONTROL, "whitespace-nowrap max-sm:min-h-11")}
                >
                  筛选
                  {secondaryFilterCount > 0 ? (
                    <Badge color="blue" variant="soft" className="ml-1 tabular-nums">
                      {secondaryFilterCount}
                    </Badge>
                  ) : null}
                </Button>
              </Popover.Trigger>
              <Popover.Content
                align="end"
                sideOffset={6}
                className="w-[min(20rem,calc(100vw-2rem))]"
              >
                <Text as="p" size="2" weight="bold" className="mb-2">筛选提交</Text>
                <div className="space-y-2">
                  <PickerFilters
                    filters={activeFilters}
                    legalContext={legalContext}
                    legalLabel={legalLabel}
                    onChange={updateFilters}
                  />
                  {activeFilters.datePreset === "custom" ? (
                    <DateRangePicker
                      value={activeFilters.customRange}
                      onChange={(customRange) => updateFilters({ customRange })}
                    />
                  ) : null}
                </div>
              </Popover.Content>
            </Popover.Root>
          </div>
        </Flex>

        {activeFilters.datePreset === "custom" ? (
          <div className="hidden sm:block">
            <DateRangePicker
              value={activeFilters.customRange}
              onChange={(customRange) => updateFilters({ customRange })}
            />
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-sunken px-4 py-1.5">
        <span id={resultsLabelId} className="text-sm font-bold text-text-secondary">
          选择{singleLabel ?? (role === "base" ? "基准" : "比较项")}
        </span>
        <span className="text-sm text-text-muted tabular-nums">
          {initialLoading ? "正在读取…" : `已加载 ${rowCount} 条`}
        </span>
      </div>
      <Text as="span" className="sr-only" aria-live="polite">
        {initialLoading
          ? `正在读取可选${mode === "branch" ? "提交" : "Tag"}`
          : queryError !== null && queryError !== undefined
            ? "可选提交读取失败"
            : `已加载 ${rowCount} 条可选${mode === "branch" ? "提交" : "Tag"}`}
      </Text>

      <Box
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
        aria-labelledby={resultsLabelId}
      >
        {initialLoading ? <ResultsSkeleton /> : null}
        {queryError !== null && queryError !== undefined ? (
          <PickerEmpty
            title="取不到可选提交"
            description={queryError instanceof Error ? queryError.message : "请稍后重试。"}
          />
        ) : null}
        {!initialLoading && queryError === null && mode === "branch"
          && syncedBranches.data?.branches.length === 0 ? (
            <PickerEmpty title="没有可选分支" description="仓库里还没有可用于范围审查的分支。" />
          ) : null}
        {!initialLoading && queryError === null && mode === "branch" && missingBranch !== undefined ? (
          <PickerEmpty
            title="原分支已不可用"
            description={`“${missingBranch}” 已消失或无法解析，请重新选择分支。已选的提交 SHA 不受影响。`}
          />
        ) : null}
        {!initialLoading && queryError === null && mode === "branch" && branch === null
          && syncedBranches.data !== undefined && syncedBranches.data.branches.length > 0 ? (
            <PickerEmpty title="请选择分支" description="同步后原分支已不可用，请从上方重新选择。" />
          ) : null}

        {!initialLoading && queryError === null && mode === "branch" && commitRows.length === 0
          && branch !== null && branchExists.data === true ? (
            <PickerEmpty
              title={legalOnlyIsSoleFilter
                ? current === undefined ? "没有合法后代" : "当前比较项之后没有新提交"
                : hasFilters
                  ? "筛选后没有结果"
                  : "这条分支没有可选提交"}
              description={legalOnlyIsSoleFilter
                ? current === undefined
                  ? "当前分支没有可选的合法后代；可查看全部提交以确认分支位置。"
                  : "作者可能把提交推到了别处；查看全部提交后仍只能选基准的后代。"
                : hasFilters
                  ? "调整筛选条件，或恢复默认筛选。"
                  : "请改选其他分支。"}
              {...(legalOnlyIsSoleFilter
                ? {
                    action: (
                      <Button type="button" variant="soft" onClick={() => updateFilters({ legalOnly: false })}>
                        查看全部提交
                      </Button>
                    ),
                  }
                : hasFilters
                  ? { action: <Button type="button" variant="soft" onClick={resetFilters}>重置筛选</Button> }
                  : {})}
            />
          ) : null}

        {!initialLoading && queryError === null && mode === "tag" && tagRows.length === 0 ? (
          tags.data?.pages[0]?.hasUsableTags === false ? (
            <PickerEmpty
              title="没有可用 Tag"
              description="仓库没有指向提交的 Tag；指向 tree 或 blob 的 Tag 不会出现在这里。"
            />
          ) : (
            <PickerEmpty
              title={legalOnlyIsSoleFilter
                ? current === undefined ? "没有合法后代" : "当前比较项之后没有新 Tag"
                : "筛选后没有结果"}
              description={legalOnlyIsSoleFilter
                ? current === undefined
                  ? "没有 Tag 指向可选的合法后代；可查看全部 Tag 以确认范围。"
                  : "没有 Tag 指向当前比较项之后的提交；查看全部 Tag 后仍只能选基准的后代。"
                : "调整筛选条件，或恢复默认筛选。"}
              action={legalOnlyIsSoleFilter
                ? (
                    <Button type="button" variant="soft" onClick={() => updateFilters({ legalOnly: false })}>
                      查看全部 Tag
                    </Button>
                  )
                : <Button type="button" variant="soft" onClick={resetFilters}>重置筛选</Button>}
            />
          )
        ) : null}

        {mode === "branch" && commitRows.length > 0 ? (
          <ul aria-label="提交列表">
            {commitRows.map((commit) => {
              // 当前比较项那一行是这段的边界:标出来但点不下去(issue #234)。
              const isCurrent = commit.sha === current?.sha;
              const blocked = isCurrent
                || (role === "comparison" && (base === null || commit.descendsFromBase === false));
              return (
                <PickerResultRow
                  key={commit.sha}
                  disabled={blocked}
                  selected={role === "base" ? commit.sha === base?.sha : commit.sha === comparison?.sha}
                  onClick={() => pick(
                    commit.sha,
                    branch === null ? undefined : { kind: "branch", name: branch },
                    commit.descendsFromBase,
                  )}
                  content={
                    <>
                      <span className="block break-words text-lg">{commit.subject}</span>
                      {commit.messageMatchExcerpt !== undefined ? (
                        <span className="mt-0.5 block break-words text-base font-normal text-text-muted">
                          …{commit.messageMatchExcerpt}…
                        </span>
                      ) : null}
                    </>
                  }
                  badges={<SelectionBadges sha={commit.sha} base={base} comparison={comparison} />}
                  metadata={
                    <>
                      <CommitChip sha={commit.sha} />
                      <span className="break-all">{commit.author}</span>
                      <span className="tabular-nums">{localMinute(commit.authoredAt)}</span>
                      {isCurrent ? <Badge color="gray" variant="soft">当前</Badge> : null}
                      {role === "comparison" && commit.descendsFromBase === false ? (
                        <Badge color="gray" variant="soft">不是基准的后代</Badge>
                      ) : null}
                    </>
                  }
                />
              );
            })}
          </ul>
        ) : null}

        {mode === "tag" && tagRows.length > 0 ? (
          <ul aria-label="Tag 列表">
            {tagRows.map((tag) => {
              const isCurrent = tag.sha === current?.sha;
              const blocked = isCurrent
                || (role === "comparison" && (base === null || tag.descendsFromBase === false));
              return (
                <PickerResultRow
                  key={tag.name}
                  disabled={blocked}
                  selected={role === "base" ? tag.sha === base?.sha : tag.sha === comparison?.sha}
                  onClick={() => pick(
                    tag.sha,
                    { kind: "tag", name: tag.name },
                    tag.descendsFromBase,
                  )}
                  content={
                    <>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="break-all text-lg">{tag.name}</span>
                        {tag.tagger !== undefined ? <Badge color="gray" variant="soft">附注</Badge> : null}
                      </span>
                      <span className="mt-0.5 block break-words text-base font-normal text-text-secondary">
                        {tag.subject}
                      </span>
                      {tag.messageMatchExcerpt !== undefined ? (
                        <span className="mt-0.5 block break-words text-base font-normal text-text-muted">
                          …{tag.messageMatchExcerpt}…
                        </span>
                      ) : null}
                    </>
                  }
                  badges={<SelectionBadges sha={tag.sha} base={base} comparison={comparison} />}
                  metadata={
                    <>
                      <CommitChip sha={tag.sha} />
                      <span className="break-all">{tag.author}</span>
                      <span>提交于 <span className="tabular-nums">{localMinute(tag.authoredAt)}</span></span>
                      {tag.tagger !== undefined && tag.taggedAt !== undefined ? (
                        <span>
                          {tag.tagger} 标记于 <span className="tabular-nums">{localMinute(tag.taggedAt)}</span>
                        </span>
                      ) : null}
                      {isCurrent ? <Badge color="gray" variant="soft">当前</Badge> : null}
                      {role === "comparison" && tag.descendsFromBase === false ? (
                        <Badge color="gray" variant="soft">不是基准的后代</Badge>
                      ) : null}
                    </>
                  }
                />
              );
            })}
          </ul>
        ) : null}

        {currentQuery.hasNextPage ? (
          <Button
            type="button"
            variant="soft"
            color="gray"
            highContrast
            size={CONTROL_SIZE}
            className="m-3 w-[calc(100%-1.5rem)] max-sm:min-h-11"
            disabled={currentQuery.isFetchingNextPage}
            aria-busy={currentQuery.isFetchingNextPage}
            onClick={() => void currentQuery.fetchNextPage()}
          >
            加载更多
          </Button>
        ) : null}
      </Box>
    </Box>
  );
}
