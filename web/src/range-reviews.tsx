import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useState } from "react";

import {
  CheckCircledIcon,
  Cross2Icon,
  CrossCircledIcon,
  ExternalLinkIcon,
} from "@radix-ui/react-icons";
import { Callout, Dialog, Flex, IconButton, Select, Skeleton, Text, TextField } from "@radix-ui/themes";

import { EmptyState } from "@/components/empty-state";
import { MasterListItem } from "@/components/master-list-item";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { Button } from "@/components/theme-button";

import { api, errorText, fetchJson } from "./api.ts";
import { runStatus, type RunItem } from "./runs.tsx";
import { loadPanelSession, pullRequestUrl } from "./session.ts";

/** 一个范围审查。字段与 `GET <前缀>/api/range-reviews` 逐字对应。 */
export type RangeReview = {
  id: number;
  owner: string;
  repo: string;
  baseSha: string;
  comparisonSha: string;
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
};

/** 一个范围审查审过的一个比较项,发起时那个也在内。按记录先后返回。 */
export type RangeReviewComparison = {
  id: number;
  sha: string;
  recordedBy: string;
  recordedAt: string;
};

type RepoRow = { repoId: number; owner: string; repo: string };

const STATE_LABEL: Record<RangeReview["state"], { tone: StatusTone; label: string }> = {
  "in-progress": { tone: "running", label: "进行中" },
  completed: { tone: "success", label: "审查完成" },
  failed: { tone: "error", label: "发起失败" },
};

function localMinute(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** commit hash 的统一表面,与评审记录页同一份写法。 */
function CommitChip({ sha }: { sha: string }) {
  return (
    <code className="rounded-chip bg-accent-tint-strong px-[5px] font-mono text-xs font-normal text-primary">
      {sha.slice(0, 7)}
    </code>
  );
}

const RANGE_REVIEWS_QUERY_KEY = ["range-reviews"] as const;

export function RangeReviewsPage({ canCreate }: { canCreate: boolean }) {
  const session = useQuery({ queryKey: ["session"], queryFn: loadPanelSession });
  const list = useQuery({
    queryKey: RANGE_REVIEWS_QUERY_KEY,
    queryFn: () => fetchJson<{ rangeReviews: RangeReview[] }>("/range-reviews"),
    /*
     * 发起之后第一轮 Review Run 在后台跑,列表里的容器 PR 序号与轮次都要等它。还有
     * 进行中的就每 10 秒续查,全都进终态即停——人最想看结果的正是这几分钟。
     */
    refetchInterval: (query) =>
      (query.state.data?.rangeReviews ?? []).some((item) => item.state === "in-progress")
        ? 10_000
        : false,
  });
  const [creating, setCreating] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; isError: boolean } | null>(null);

  // 打开哪一条记在地址里:链接能指到具体一个阶段,浏览器后退键能收起详情。
  const navigate = useNavigate();
  const openedId = useRouterState({
    select: (state) => {
      const value = (state.location.search as { range?: unknown }).range;
      const id = typeof value === "number" ? value : Number(value);
      return Number.isSafeInteger(id) && id > 0 ? id : null;
    },
  });
  const setOpenedId = (id: number | null): void => {
    void navigate({
      to: "/range-reviews",
      search: (prev: Record<string, unknown>) => ({ ...prev, range: id ?? undefined }),
    });
  };

  const rangeReviews = list.data?.rangeReviews ?? [];
  const opened = rangeReviews.find((item) => item.id === openedId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageBody width="wide" className="min-h-0 flex-1 pb-4 sm:pb-4">
        <PageHeader
          title="范围审查"
          {...(list.isPending
            ? {}
            : {
                description: `${rangeReviews.length} 个 · ${
                  rangeReviews.filter((item) => item.state === "in-progress").length
                } 进行中`,
              })}
          actions={
            canCreate ? (
              <Dialog.Root open={creating} onOpenChange={setCreating}>
                <Dialog.Trigger>
                  <Button variant="solid" className="shadow-accent" size={{ initial: "3", sm: "2" }}>
                    发起范围审查
                  </Button>
                </Dialog.Trigger>
                <CreateDialogContent
                  onCreated={(text) => {
                    setFeedback({ text, isError: false });
                    setCreating(false);
                  }}
                />
              </Dialog.Root>
            ) : undefined
          }
        />

        {feedback === null ? null : (
          <Callout.Root role={feedback.isError ? "alert" : "status"} color={feedback.isError ? "red" : "green"} size="1">
            <Callout.Icon>
              {feedback.isError ? <CrossCircledIcon aria-hidden /> : <CheckCircledIcon aria-hidden />}
            </Callout.Icon>
            <Callout.Text>{feedback.text}</Callout.Text>
          </Callout.Root>
        )}
        {list.isError ? (
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>{(list.error as Error).message}</Callout.Text>
          </Callout.Root>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain" aria-label="范围审查列表">
          {list.isPending ? (
            <div
              className="flex flex-col gap-2 overflow-hidden rounded-lg border border-card-line bg-surface p-2 shadow-card"
              role="status"
              aria-live="polite"
            >
              <span className="sr-only">正在加载范围审查</span>
              {[0, 1, 2].map((slot) => <Skeleton key={slot} className="h-14" />)}
            </div>
          ) : rangeReviews.length === 0 ? (
            <div className="rounded-lg border border-card-line bg-surface px-5 py-4 shadow-card">
              <EmptyState
                title="还没有范围审查"
                titleAs="h2"
                description={
                  canCreate
                    ? "选一个已注册仓库，填 base commit 与比较项即可发起，不需要仓库里存在 pull request。"
                    : "发起范围审查需要「评审 · 发起」权限，请联系系统管理员。"
                }
                action={
                  canCreate ? undefined : (
                    <Button variant="outline" color="gray" size={{ initial: "4", sm: "1" }} asChild>
                      <Link to="/runs">去评审记录</Link>
                    </Button>
                  )
                }
              />
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-card-line bg-surface shadow-card">
              {rangeReviews.map((item) => (
                <MasterListItem
                  key={item.id}
                  selected={item.id === openedId}
                  onClick={() => setOpenedId(item.id)}
                  aria-haspopup="dialog"
                  className="group flex items-center gap-3 border-t border-line px-5 py-3 first:border-t-0"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="truncate text-lg font-semibold group-data-[selected=true]:font-bold">
                      {item.owner}/{item.repo}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-1.5 text-base font-normal text-text-muted">
                      <CommitChip sha={item.baseSha} />
                      <span aria-hidden>..</span>
                      <CommitChip sha={item.comparisonSha} />
                      <span aria-hidden>·</span>
                      <span className="break-all">{item.createdBy}</span>
                      <span aria-hidden>·</span>
                      <span className="tabular-nums">{localMinute(item.createdAt)}</span>
                    </span>
                  </span>
                  <span className="shrink-0">
                    <StatusBadge tone={STATE_LABEL[item.state].tone}>
                      {STATE_LABEL[item.state].label}
                    </StatusBadge>
                  </span>
                </MasterListItem>
              ))}
            </div>
          )}
        </div>
      </PageBody>

      {opened === null ? null : (
        <RangeReviewDetailPanel
          rangeReview={opened}
          canCreate={canCreate}
          containerUrl={
            session.data === undefined ||
            session.data === null ||
            opened.containerPullNumber === null
              ? null
              : pullRequestUrl(session.data, {
                  owner: opened.owner,
                  repo: opened.repo,
                  pullNumber: opened.containerPullNumber,
                })
          }
          onClose={() => setOpenedId(null)}
        />
      )}
    </div>
  );
}

/**
 * 详情面板:base、当前比较项与这个阶段跑过的轮次。
 *
 * 与评审记录页同一个形态——主从列表的详情浮在列表上,列表仍然露出来,「我是从哪一条
 * 点进来的」这个上下文不丢。
 */
function RangeReviewDetailPanel({
  rangeReview,
  canCreate,
  containerUrl,
  onClose,
}: {
  rangeReview: RangeReview;
  /** 有「评审 · 发起」权限才出现推进入口。 */
  canCreate: boolean;
  /** 容器 PR 的地址;没有 Forge 基址或还没建出来时是 null,那一格不渲染。 */
  containerUrl: string | null;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: ["range-review", rangeReview.id],
    queryFn: () =>
      fetchJson<{
        rangeReview: RangeReview;
        comparisons: RangeReviewComparison[];
        runs: RunItem[];
      }>(`/range-reviews/${rangeReview.id}`),
    refetchInterval: (query) =>
      (query.state.data?.runs ?? []).some((run) => run.finishedAt === null) ? 10_000 : false,
  });
  const runs = detail.data?.runs ?? [];
  // 最近推的排在最前,与轮次同序;一个比较项的轮次按 head 归到它名下。
  const comparisons = [...(detail.data?.comparisons ?? [])].reverse();
  const status = STATE_LABEL[rangeReview.state];
  const [advancing, setAdvancing] = useState(false);
  // 已完成与发起失败的都没有可推进的容器 PR,那两档不出现入口。
  const canAdvance = canCreate && rangeReview.state === "in-progress";

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Content
        aria-describedby={undefined}
        className="!fixed !top-auto !right-0 !bottom-0 !left-0 !m-0 !flex !h-[86dvh] !w-full !max-w-none !flex-col !overflow-hidden !rounded-3xl !rounded-b-none !border-0 !bg-[color:var(--v8-drawer-bg)] !p-0 !shadow-overlay backdrop-blur-[40px] md:!top-3.5 md:!right-3.5 md:!bottom-3.5 md:!left-auto md:!h-auto md:!w-[464px] md:!max-w-[calc(100vw-28px)] md:!rounded-b-3xl"
      >
        <header className="flex shrink-0 flex-col gap-3 border-b border-overlay-line px-6 pt-5 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              <Dialog.Title className="!mb-0 min-w-0 !text-3xl !font-extrabold !tracking-[-0.02em] break-all">
                {rangeReview.owner}/{rangeReview.repo}
              </Dialog.Title>
              <div className="flex flex-wrap items-center gap-1.5 text-base text-text-muted">
                <span className="break-all">{rangeReview.createdBy}</span>
                <span aria-hidden>·</span>
                <span className="tabular-nums">{localMinute(rangeReview.createdAt)}</span>
              </div>
            </div>
            <Dialog.Close>
              <IconButton size="1" variant="soft" color="gray" radius="full" aria-label="关闭详情">
                <Cross2Icon />
              </IconButton>
            </Dialog.Close>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-base">
            <dt className="text-text-secondary">base</dt>
            <dd className="min-w-0 break-all font-mono text-base">{rangeReview.baseSha}</dd>
            <dt className="text-text-secondary">当前比较项</dt>
            <dd className="min-w-0 break-all font-mono text-base">{rangeReview.comparisonSha}</dd>
          </dl>

          {rangeReview.lastForgeFailure === null ? null : (
            <Callout.Root role="alert" color="red" size="1">
              <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
              <Callout.Text>{rangeReview.lastForgeFailure}</Callout.Text>
            </Callout.Root>
          )}

          <h3 className="pt-1 text-2xl font-semibold">
            比较项
            <span className="ml-1.5 font-mono tabular-nums text-text-muted">
              {comparisons.length}
            </span>
          </h3>
          {detail.isPending ? (
            <Skeleton aria-hidden className="h-14" />
          ) : (
            comparisons.map((comparison) => (
              <section key={comparison.id} className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-x-1.5 text-base text-text-muted">
                  <CommitChip sha={comparison.sha} />
                  <span className="break-all">{comparison.recordedBy}</span>
                  <span aria-hidden>·</span>
                  <span className="tabular-nums">{localMinute(comparison.recordedAt)}</span>
                </div>
                {/* 一个比较项对应它被推上去之后跑的那些轮次,按 head 认。 */}
                {runs
                  .filter((run) => run.headSha === comparison.sha)
                  .map((run) => {
                    const conclusion = runStatus(run);
                    return (
                      <div
                        key={run.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-overlay-line bg-surface px-4 py-2.5 shadow-control"
                      >
                        <span className="flex min-w-0 flex-col gap-px">
                          <span className="text-base text-text-muted tabular-nums">
                            {localMinute(run.startedAt)}
                          </span>
                          <span className="text-sm text-text-muted tabular-nums">
                            {run.total === 0 ? "无可处置项" : `${run.resolved}/${run.total} 已处置`}
                          </span>
                        </span>
                        <StatusBadge tone={conclusion.tone}>{conclusion.label}</StatusBadge>
                      </div>
                    );
                  })}
              </section>
            ))
          )}
        </div>

        {containerUrl === null && !canAdvance ? null : (
          <footer className="flex shrink-0 items-center justify-end gap-3 border-t border-overlay-line px-6 py-3.5">
            {/* 处置在评审记录的详情面板行内做,这一格留给推进与「去看原版」。 */}
            {containerUrl === null ? null : (
              <Button asChild variant="soft" color="gray" size={{ initial: "3", sm: "2" }}>
                <a href={containerUrl} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon aria-hidden />
                  去 pull request 看原版
                </a>
              </Button>
            )}
            {canAdvance ? (
              <Dialog.Root open={advancing} onOpenChange={setAdvancing}>
                <Dialog.Trigger>
                  <Button
                    variant="solid"
                    className="shadow-accent"
                    size={{ initial: "3", sm: "2" }}
                  >
                    推进比较项
                  </Button>
                </Dialog.Trigger>
                <AdvanceDialogContent
                  rangeReview={rangeReview}
                  onAdvanced={() => setAdvancing(false)}
                />
              </Dialog.Root>
            ) : null}
          </footer>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * 推进比较项的表单(issue #157)。
 *
 * 只收新的比较项:base 是这个阶段不变的基准,推进不改它。服务端只要求新比较项是 base
 * 的后代,作者 rebase 之后的 commit 照样填得进来。
 */
function AdvanceDialogContent({
  rangeReview,
  onAdvanced,
}: {
  rangeReview: RangeReview;
  onAdvanced: () => void;
}) {
  const queryClient = useQueryClient();
  const [comparison, setComparison] = useState("");
  const [error, setError] = useState<string | null>(null);

  const advance = useMutation({
    mutationFn: async () => {
      const response = await api(`/range-reviews/${rangeReview.id}/advance`, {
        method: "POST",
        body: JSON.stringify({ comparison: comparison.trim() }),
      });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RANGE_REVIEWS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["range-review", rangeReview.id] });
      onAdvanced();
    },
    onError: (failure: Error) => setError(failure.message),
  });

  return (
    <Dialog.Content aria-describedby={undefined} maxWidth="560px" size={{ initial: "2", sm: "3" }}>
      <form
        className="flex min-h-0 flex-col gap-3"
        aria-busy={advance.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          if (comparison.trim() === "") return;
          advance.mutate();
        }}
      >
        <Dialog.Title size="4" mb="1" className="pr-9">推进比较项</Dialog.Title>

        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 text-base">
          <dt className="text-text-secondary">base</dt>
          <dd className="min-w-0 break-all font-mono">{rangeReview.baseSha}</dd>
          <dt className="text-text-secondary">当前比较项</dt>
          <dd className="min-w-0 break-all font-mono">{rangeReview.comparisonSha}</dd>
        </dl>

        <label className="flex flex-col gap-1.5">
          <Text as="span" size="2" weight="medium">新的比较项</Text>
          <TextField.Root
            value={comparison}
            onChange={(event) => setComparison(event.target.value)}
            placeholder="作者迭代之后的 commit sha，必须是 base 的后代"
            spellCheck={false}
            className="font-mono"
            size={{ initial: "3", sm: "2" }}
          />
        </label>

        <p className="text-sm text-text-muted">
          推进会把容器 pull request 的 head 分支移到新 commit，并按 base..新比较项跑新的一轮。
        </p>
        {error === null ? null : <p role="alert" className="text-danger">{error}</p>}

        <Flex gap="3" mt="1" justify="end" direction={{ initial: "column-reverse", sm: "row" }}>
          <Dialog.Close>
            <Button type="button" variant="soft" color="gray" size={{ initial: "4", sm: "2" }}>
              取消
            </Button>
          </Dialog.Close>
          <Button
            type="submit"
            variant="solid"
            className="shadow-accent"
            size={{ initial: "4", sm: "2" }}
            disabled={comparison.trim() === "" || advance.isPending}
          >
            {advance.isPending ? "推进中…" : "推进"}
          </Button>
        </Flex>
      </form>
      <div className="absolute top-3 right-3">
        <Dialog.Close>
          <IconButton
            variant="ghost"
            color="gray"
            size={{ initial: "3", sm: "1" }}
            className="max-sm:min-h-11 max-sm:min-w-11"
            aria-label="关闭推进比较项"
          >
            <Cross2Icon aria-hidden />
          </IconButton>
        </Dialog.Close>
      </div>
    </Dialog.Content>
  );
}

/**
 * 发起表单。
 *
 * 同仓库同 base 已经有进行中的时候服务端回 409 并要求确认:那一档不当错误提示,改成
 * 把提交按钮换成「仍然发起」,再点一次带确认标志重发(#152 的 user story 3、4)。
 */
function CreateDialogContent({ onCreated }: { onCreated: (text: string) => void }) {
  const repos = useQuery({ queryKey: ["repos"], queryFn: () => fetchJson<RepoRow[]>("/repos") });
  const queryClient = useQueryClient();
  const [repoId, setRepoId] = useState<string>("");
  const [base, setBase] = useState("");
  const [comparison, setComparison] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);

  const rows = repos.data ?? [];
  const picked = rows.find((row) => String(row.repoId) === repoId) ?? null;

  const create = useMutation({
    mutationFn: async (confirm: boolean) => {
      const response = await api("/range-reviews", {
        method: "POST",
        body: JSON.stringify({
          owner: picked!.owner,
          repo: picked!.repo,
          base: base.trim(),
          comparison: comparison.trim(),
          ...(confirm ? { confirm: true } : {}),
        }),
      });
      if (response.status === 409) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
          needsConfirmation?: boolean;
        } | null;
        if (body?.needsConfirmation === true) {
          return { reminder: body.error ?? "同一个 base 上已经有进行中的范围审查" };
        }
        throw new Error(body?.error ?? "请求失败(409)");
      }
      if (!response.ok) throw new Error(await errorText(response));
      return { reminder: null };
    },
    onSuccess: (result) => {
      if (result.reminder !== null) {
        setNeedsConfirmation(true);
        setError(result.reminder);
        return;
      }
      void queryClient.invalidateQueries({ queryKey: RANGE_REVIEWS_QUERY_KEY });
      onCreated(`已发起 ${picked!.owner}/${picked!.repo} 的范围审查，第一轮审查开始运行`);
    },
    onError: (failure: Error) => {
      setNeedsConfirmation(false);
      setError(failure.message);
    },
  });

  const ready = picked !== null && base.trim() !== "" && comparison.trim() !== "";

  return (
    <Dialog.Content aria-describedby={undefined} maxWidth="560px" size={{ initial: "2", sm: "3" }}>
      <form
        className="flex min-h-0 flex-col gap-3"
        aria-busy={create.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          create.mutate(needsConfirmation);
        }}
      >
        <Dialog.Title size="4" mb="1" className="pr-9">发起范围审查</Dialog.Title>

        <label className="flex flex-col gap-1.5">
          <Text as="span" size="2" weight="medium">仓库</Text>
          <Select.Root
            value={repoId}
            onValueChange={(next) => {
              setRepoId(next);
              setNeedsConfirmation(false);
            }}
            size={{ initial: "3", sm: "2" }}
          >
            <Select.Trigger placeholder="选一个已注册仓库" aria-label="仓库" />
            <Select.Content>
              {rows.map((row) => (
                <Select.Item key={row.repoId} value={String(row.repoId)}>
                  {row.owner}/{row.repo}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </label>

        <label className="flex flex-col gap-1.5">
          <Text as="span" size="2" weight="medium">base commit</Text>
          <TextField.Root
            value={base}
            onChange={(event) => {
              setBase(event.target.value);
              setNeedsConfirmation(false);
            }}
            placeholder="这个阶段不变的基准 commit sha"
            spellCheck={false}
            className="font-mono"
            size={{ initial: "3", sm: "2" }}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <Text as="span" size="2" weight="medium">比较项</Text>
          <TextField.Root
            value={comparison}
            onChange={(event) => setComparison(event.target.value)}
            placeholder="当前被审的 commit sha，必须是 base 的后代"
            spellCheck={false}
            className="font-mono"
            size={{ initial: "3", sm: "2" }}
          />
        </label>

        <p className="text-sm text-text-muted">
          MultiReviewer 会在 Forge 上自建一个永不合并的 pull request 承载 Finding。
        </p>
        {error === null ? null : (
          <p role="alert" className={needsConfirmation ? "text-warning" : "text-danger"}>
            {error}
          </p>
        )}

        <Flex gap="3" mt="1" justify="end" direction={{ initial: "column-reverse", sm: "row" }}>
          <Dialog.Close>
            <Button type="button" variant="soft" color="gray" size={{ initial: "4", sm: "2" }}>
              取消
            </Button>
          </Dialog.Close>
          <Button
            type="submit"
            variant="solid"
            className="shadow-accent"
            size={{ initial: "4", sm: "2" }}
            disabled={!ready || create.isPending}
          >
            {create.isPending ? "发起中…" : needsConfirmation ? "仍然发起" : "发起"}
          </Button>
        </Flex>
      </form>
      <div className="absolute top-3 right-3">
        <Dialog.Close>
          <IconButton
            variant="ghost"
            color="gray"
            size={{ initial: "3", sm: "1" }}
            className="max-sm:min-h-11 max-sm:min-w-11"
            aria-label="关闭发起范围审查"
          >
            <Cross2Icon aria-hidden />
          </IconButton>
        </Dialog.Close>
      </div>
    </Dialog.Content>
  );
}
