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
import { DateRangePicker, type DateRangeValue } from "./components/date-range-picker.tsx";
import { EmptyState } from "./components/empty-state.tsx";
import { Button } from "./components/theme-button.ts";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "./components/ui/command";
import { localMinute } from "./lib/time.ts";

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

function filterQuery(filters: FilterState, search: string, role: CommitRole, baseSha?: string): string {
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
          variant="soft"
          color="gray"
          className="min-h-11 w-full justify-between text-left"
          aria-label="选择分支"
        >
          <span className="min-w-0 truncate">{branch ?? "选择一条分支"}</span>
          <ChevronDownIcon className="shrink-0" />
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
                className="min-h-11"
              >
                <CheckIcon className={item.name === branch ? "opacity-100" : "opacity-0"} />
                <span className="min-w-0 flex-1 break-all">{item.name}</span>
                {item.isDefault ? <Badge color="gray" variant="soft">默认</Badge> : null}
              </CommandItem>
            )) : null}
          </CommandList>
          {truncated ? (
            <Text as="p" size="1" color="gray" className="border-t px-3 py-2">
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
  return (
    <Flex gap="1" wrap="wrap" className="shrink-0">
      {sha === base?.sha ? <Badge color="blue" variant="soft">基准</Badge> : null}
      {sha === comparison?.sha ? <Badge color="green" variant="soft">比较项</Badge> : null}
    </Flex>
  );
}

function PickerFilters({
  filters,
  legalContext,
  onChange,
}: {
  filters: FilterState;
  legalContext: boolean;
  onChange: (patch: Partial<FilterState>) => void;
}) {
  return (
    <>
      <Select.Root
        value={filters.datePreset}
        onValueChange={(value) => onChange({ datePreset: value as DatePreset })}
      >
        <Select.Trigger aria-label="提交日期" className="min-h-11 w-full sm:min-h-10 sm:w-auto" />
        <Select.Content>
          <Select.Item value="all">不限日期</Select.Item>
          <Select.Item value="7">最近 7 天</Select.Item>
          <Select.Item value="30">最近 30 天</Select.Item>
          <Select.Item value="90">最近 90 天</Select.Item>
          <Select.Item value="custom">自定义日期</Select.Item>
        </Select.Content>
      </Select.Root>
      <Select.Root
        value={filters.merge}
        onValueChange={(value) => onChange({ merge: value as MergeFilter })}
      >
        <Select.Trigger aria-label="合并提交筛选" className="min-h-11 w-full sm:min-h-10 sm:w-auto" />
        <Select.Content>
          <Select.Item value="all">全部提交</Select.Item>
          <Select.Item value="only">仅合并提交</Select.Item>
          <Select.Item value="non">排除合并提交</Select.Item>
        </Select.Content>
      </Select.Root>
      {legalContext ? (
        <Text as="label" size="2" className="flex min-h-11 cursor-pointer items-center gap-2 px-1 whitespace-nowrap">
          <Checkbox
            checked={filters.legalOnly}
            onCheckedChange={(checked) => onChange({ legalOnly: checked === true })}
          />
          仅合法后代
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
  return (
    <li>
      <Button
        type="button"
        variant="ghost"
        color="gray"
        highContrast
        aria-disabled={disabled}
        aria-pressed={selected}
        onClick={() => {
          if (!disabled) onClick();
        }}
        className={`m-0 h-auto min-h-16 w-full justify-start rounded-none whitespace-normal px-3 py-2.5 text-left focus-visible:z-10${
          selected ? " bg-accent-tint hover:bg-accent-tint-strong" : " hover:bg-sunken"
        }${disabled ? " cursor-not-allowed opacity-55" : ""}`}
      >
        <Box className="w-full">
          <Flex justify="between" gap="3" align="start">
            <div className="min-w-0">{content}</div>
            {badges}
          </Flex>
          <Flex gap="2" wrap="wrap" align="center" className="mt-1.5">
            {metadata}
          </Flex>
        </Box>
      </Button>
    </li>
  );
}

function ResultsSkeleton() {
  return (
    <div className="divide-y divide-overlay-line">
      {[0, 1, 2].map((index) => (
        <div key={index} className="px-3 py-2.5">
          <Skeleton height="56px" />
        </div>
      ))}
    </div>
  );
}

export function CommitPicker({
  repo: repoRef,
  base,
  comparison,
  baseLocked = false,
  onPick,
}: CommitPickerProps) {
  const { owner, repo } = repoRef;
  const [mode, setMode] = useState<PickerMode>("branch");
  const [role, setRole] = useState<CommitRole>(baseLocked || base !== null ? "comparison" : "base");
  const [filters, setFilters] = useState<Record<PickerMode, FilterState>>({
    branch: defaultFilters(),
    tag: defaultFilters(),
  });
  const [browsedBranch, setBrowsedBranch] = useState<string | null | undefined>(undefined);
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
    if (baseLocked || base !== null) setRole("comparison");
    else setRole("base");
  }, [base?.sha, baseLocked]);

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
    () => filterQuery(activeFilters, debouncedSearch, role, base?.sha),
    [activeFilters, base?.sha, debouncedSearch, role],
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
    onPick(role, { sha, ...(source === undefined ? {} : { source }) });
    if (role === "base" && !baseLocked) setRole("comparison");
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
    <Box className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-overlay-line bg-surface">
      {!baseLocked ? (
        <div className="shrink-0 border-b border-overlay-line bg-sunken p-2.5">
          <Text id={roleLabelId} as="div" size="1" color="gray" weight="medium" className="mb-1.5">
            审查范围
          </Text>
          <div role="group" aria-labelledby={roleLabelId} className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={role === "base" ? "soft" : "ghost"}
              color={role === "base" ? "blue" : "gray"}
              aria-pressed={role === "base"}
              onClick={() => setRole("base")}
              className="h-auto min-h-14 min-w-0 justify-start whitespace-normal px-2.5 py-2 text-left"
            >
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 font-semibold">
                  基准
                  {base === null ? null : <Badge color="blue" variant="soft">已选</Badge>}
                </span>
                <span
                  title={base === null ? undefined : commitSelectionLabel(base)}
                  className="mt-0.5 block truncate text-sm text-text-muted"
                >
                  {base === null ? "选择审查起点" : commitSelectionLabel(base)}
                </span>
              </span>
            </Button>
            <Button
              type="button"
              variant={role === "comparison" ? "soft" : "ghost"}
              color={role === "comparison" ? "blue" : "gray"}
              aria-pressed={role === "comparison"}
              disabled={base === null}
              onClick={() => setRole("comparison")}
              className="h-auto min-h-14 min-w-0 justify-start whitespace-normal px-2.5 py-2 text-left"
            >
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 font-semibold">
                  比较项
                  {comparison === null ? null : <Badge color="green" variant="soft">已选</Badge>}
                </span>
                <span
                  title={comparison === null ? undefined : commitSelectionLabel(comparison)}
                  className="mt-0.5 block truncate text-sm text-text-muted"
                >
                  {base === null
                    ? "先选择基准"
                    : comparison === null
                      ? "选择审查终点"
                      : commitSelectionLabel(comparison)}
                </span>
              </span>
            </Button>
          </div>
        </div>
      ) : null}

      <div className="shrink-0 space-y-2 border-b border-overlay-line p-2.5 sm:p-3">
        <Flex gap="2" align="center">
          <Box className="w-32 shrink-0 sm:w-36">
            <Text id={sourceLabelId} as="div" className="sr-only">
              来源
            </Text>
            <SegmentedControl.Root
              aria-labelledby={sourceLabelId}
              value={mode}
              onValueChange={(value) => setMode(value as PickerMode)}
              className="min-h-11 w-full"
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
              variant="soft"
              color="gray"
              size="3"
              className="min-h-11 min-w-11"
              aria-label="刷新分支与 Tag"
              disabled={syncedBranches.isFetching}
              onClick={refreshRefs}
            >
              <ReloadIcon className={syncedBranches.isFetching ? "animate-spin" : ""} />
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
            size="3"
            className="min-h-11 min-w-0 flex-1"
          >
            <TextField.Slot><MagnifyingGlassIcon /></TextField.Slot>
          </TextField.Root>

          <div className="hidden items-center gap-2 sm:flex">
            <PickerFilters
              filters={activeFilters}
              legalContext={legalContext}
              onChange={updateFilters}
            />
          </div>

          <div className="sm:hidden">
            <Popover.Root>
              <Popover.Trigger>
                <Button type="button" variant="soft" color="gray" className="min-h-11 whitespace-nowrap">
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

      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-overlay-line bg-sunken px-3 py-2">
        <Text id={resultsLabelId} as="span" size="2" weight="medium">
          选择{role === "base" ? "基准" : "比较项"}
        </Text>
        <Text as="span" size="1" color="gray" className="tabular-nums">
          {initialLoading ? "正在读取…" : `已加载 ${rowCount} 条`}
        </Text>
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
          <EmptyState
            title="取不到可选提交"
            description={queryError instanceof Error ? queryError.message : "请稍后重试。"}
          />
        ) : null}
        {!initialLoading && queryError === null && mode === "branch"
          && syncedBranches.data?.branches.length === 0 ? (
            <EmptyState title="没有可选分支" description="仓库里还没有可用于范围审查的分支。" />
          ) : null}
        {!initialLoading && queryError === null && mode === "branch" && missingBranch !== undefined ? (
          <EmptyState
            title="原分支已不可用"
            description={`“${missingBranch}” 已消失或无法解析，请重新选择分支。已选的提交 SHA 不受影响。`}
          />
        ) : null}
        {!initialLoading && queryError === null && mode === "branch" && branch === null
          && syncedBranches.data !== undefined && syncedBranches.data.branches.length > 0 ? (
            <EmptyState title="请选择分支" description="同步后原分支已不可用，请从上方重新选择。" />
          ) : null}

        {!initialLoading && queryError === null && mode === "branch" && commitRows.length === 0
          && branch !== null && branchExists.data === true ? (
            <EmptyState
              title={legalOnlyIsSoleFilter
                ? "没有合法后代"
                : hasFilters
                  ? "筛选后没有结果"
                  : "这条分支没有可选提交"}
              description={legalOnlyIsSoleFilter
                ? "当前分支没有可选的合法后代；可查看全部提交以确认分支位置。"
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
            <EmptyState
              title="没有可用 Tag"
              description="仓库没有指向提交的 Tag；指向 tree 或 blob 的 Tag 不会出现在这里。"
            />
          ) : (
            <EmptyState
              title={legalOnlyIsSoleFilter ? "没有合法后代" : "筛选后没有结果"}
              description={legalOnlyIsSoleFilter
                ? "没有 Tag 指向可选的合法后代；可查看全部 Tag 以确认范围。"
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
          <ul className="divide-y divide-overlay-line" aria-label="提交列表">
            {commitRows.map((commit) => {
              const blocked = role === "comparison"
                && (base === null || commit.descendsFromBase === false);
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
                      <Text as="p" size="2" weight="medium" className="break-words">
                        {commit.subject}
                      </Text>
                      {commit.messageMatchExcerpt !== undefined ? (
                        <Text as="p" size="1" color="gray" className="mt-1 break-words">
                          …{commit.messageMatchExcerpt}…
                        </Text>
                      ) : null}
                    </>
                  }
                  badges={<SelectionBadges sha={commit.sha} base={base} comparison={comparison} />}
                  metadata={
                    <>
                      <Text size="1" color="gray" className="font-mono">{commit.shortSha}</Text>
                      <Text size="1" color="gray">{commit.author}</Text>
                      <Text size="1" color="gray" className="tabular-nums">{localMinute(commit.authoredAt)}</Text>
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
          <ul className="divide-y divide-overlay-line" aria-label="Tag 列表">
            {tagRows.map((tag) => {
              const blocked = role === "comparison" && (base === null || tag.descendsFromBase === false);
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
                      <Flex gap="2" wrap="wrap" align="center">
                        <Text size="2" weight="bold" className="break-all">{tag.name}</Text>
                        {tag.tagger !== undefined ? <Badge color="purple" variant="soft">附注</Badge> : null}
                      </Flex>
                      <Text as="p" size="2" className="mt-1 break-words">{tag.subject}</Text>
                      {tag.messageMatchExcerpt !== undefined ? (
                        <Text as="p" size="1" color="gray" className="mt-1 break-words">
                          …{tag.messageMatchExcerpt}…
                        </Text>
                      ) : null}
                    </>
                  }
                  badges={<SelectionBadges sha={tag.sha} base={base} comparison={comparison} />}
                  metadata={
                    <>
                      <Text size="1" color="gray" className="font-mono">{tag.shortSha}</Text>
                      <Text size="1" color="gray">{tag.author}</Text>
                      <Text size="1" color="gray">提交于 <span className="tabular-nums">{localMinute(tag.authoredAt)}</span></Text>
                      {tag.tagger !== undefined && tag.taggedAt !== undefined ? (
                        <Text size="1" color="gray">
                          {tag.tagger} 标记于 <span className="tabular-nums">{localMinute(tag.taggedAt)}</span>
                        </Text>
                      ) : null}
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
            className="m-3 min-h-11 w-[calc(100%-1.5rem)]"
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
