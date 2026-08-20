import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { CircleAlert, CircleCheck, CircleDashed, CircleX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ModelComposer,
  type ModelComposerValidity,
} from "@/components/model-composer";

import { api, errorText, fetchJson } from "./api.ts";
import { modelIdentity, parseModelIdentity } from "./model-services.ts";
import { rerunRequest, RunPill, type RunItem } from "./runs.tsx";
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
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto text-right">{children}</span>
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

  const rows = repos.data ?? [];
  const selected = rows.find((row) => row.repoId === selectedId) ?? rows[0];
  const registrationReady = setup.data?.reviewConfigurationReady === true;

  return (
    <>
      <PageHeader
        title="仓库"
        description="接入 MultiReviewer 的仓库。选一个看它的准入 key、模型组合与最近几轮 Review Run。"
        actions={canWrite ? (
          <Button disabled={!registrationReady} onClick={() => setRegistering(true)}>注册仓库</Button>
        ) : undefined}
      />
      <div className="flex min-h-full flex-col lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
        <aside
          aria-label="已注册仓库"
          className="max-h-56 overflow-y-auto border-b border-border bg-chrome lg:max-h-none lg:border-r lg:border-b-0"
        >
          <p className="sticky top-0 z-10 bg-chrome px-4 pt-3.5 pb-2 font-mono text-xs font-semibold tracking-[0.07em] text-muted-foreground">
            已注册 {rows.length} 个
          </p>
          {repos.isPending ? (
            <div className="flex flex-col gap-2 px-4 py-1">
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </div>
          ) : null}
          {/* 一份列表就是一份列表:屏幕阅读器会念出「共 N 项、第 K 项」。 */}
          <ul>
            {rows.map((row) => (
              <li key={row.repoId} className="px-2">
                <button
                  type="button"
                  // 选中项直接刷成右边内容区的底色,读起来是「这一格连着右边那一屏」。
                  aria-current={row.repoId === selected?.repoId ? "true" : undefined}
                  className={`block w-full rounded-sm border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
                    row.repoId === selected?.repoId
                      ? "border-border bg-background font-medium"
                      : "border-transparent hover:bg-background/70"
                  }`}
                  onClick={() => setSelectedId(row.repoId)}
                >
                  <span className="block truncate font-mono">
                    {row.owner}/{row.repo}
                  </span>
                  <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                    <span className="tabular-nums">{row.runCount}</span> 轮
                    {row.lastActivity === null
                      ? " · 还没跑过"
                      : ` · 最近 ${since(row.lastActivity)}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {rows.length === 0 && !repos.isPending && !repos.isError ? (
            <p className="px-4 py-2.5 text-muted-foreground">还没有注册仓库。</p>
          ) : null}
        </aside>

        <div className="flex min-w-0 max-w-[900px] flex-col gap-4 p-4 sm:p-5">
          {canWrite && setup.data !== undefined && !setup.data.reviewConfigurationReady ? (
            <Card className="items-start gap-2 border-warning/40 bg-warning/5 px-4">
              <p>审查配置就绪后才能注册仓库。先在审查策略中保存至少一个当前可用模型。</p>
              <Button variant="outline" size="sm" asChild>
                <Link to="/settings">前往审查策略</Link>
              </Button>
            </Card>
          ) : null}
          {repos.isError ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive"
            >
              <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{(repos.error as Error).message}</span>
            </p>
          ) : null}
          {selected !== undefined && settings.isError ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive"
            >
              <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{(settings.error as Error).message}</span>
            </p>
          ) : null}
          {repos.isPending ? (
            <>
              <Skeleton className="h-10" />
              <Skeleton className="h-44" />
              <Skeleton className="h-56" />
            </>
          ) : null}
          {selected === undefined && !repos.isPending && !repos.isError ? (
            <Card className="items-start gap-1.5 px-4">
              <h2 className="text-base font-semibold">还没有注册仓库</h2>
              <p className="text-muted-foreground">
                {canWrite ? "点右上「注册仓库」搜一个接进来——搜的是 bot 能看见的仓库。" : "当前没有已注册仓库。"}
              </p>
            </Card>
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

        {/* 两个表单模态都按需挂载:常驻会把上一次的输入与错误留在 state 里,下次打开
            回显的就不是当前值了。 */}
        {canWrite && registrationReady && registering ? (
          <RegisterModal
            onClose={() => setRegistering(false)}
            onDone={(repoId) => {
              setRegistering(false);
              setSelectedId(repoId);
              void queryClient.invalidateQueries({ queryKey: ["repos"] });
            }}
          />
        ) : null}
      </div>
    </>
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
  // 打开仓库时拉一次核对。只展示差异与下一步动作,不自动修——推平由人点轮转。
  const check = useQuery({
    queryKey: ["repo-hooks", repo.repoId],
    queryFn: () => fetchJson<HookCheck>(`/repos/${repo.repoId}/hooks`),
  });
  const [feedback, setFeedback] = useState<{ text: string; isError: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);

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
    onSuccess: onRemoved,
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
      setFeedback({ text: "覆盖已清除,跟随全局,下一次投递生效。", isError: false });
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
      <div className="flex flex-wrap items-center gap-3 border-b border-border pb-4">
        {/* 页标题是「仓库」,这里是选中的那一个:降一级,字号也降一档。 */}
        <h2 className="min-w-0 break-all font-mono text-lg font-semibold tracking-tight">
          {repo.owner}/{repo.repo}
        </h2>
        {check.isPending ? (
          <Badge variant="secondary">
            <CircleDashed aria-hidden />
            核对中…
          </Badge>
        ) : check.isError ? (
          <Badge variant="destructive">
            <CircleX aria-hidden />
            核对失败
          </Badge>
        ) : issues.length === 0 ? (
          <Badge className="bg-success/12 text-success">
            <CircleCheck aria-hidden />
            hook 一致
          </Badge>
        ) : (
          <Badge className="bg-warning/12 text-warning">
            <CircleAlert aria-hidden />
            {issues.length} 处差异
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">repo id {repo.repoId}</span>
        {canWrite ? (
          <Button
            variant="outline"
            className="ml-auto max-sm:w-full"
            disabled={remove.isPending}
            onClick={() => setConfirmingRemoval(true)}
          >
            移除仓库
          </Button>
        ) : null}
      </div>

      {feedback === null ? null : (
        <div
          role={feedback.isError ? "alert" : "status"}
          className={`flex items-start gap-2 rounded-sm border px-3 py-2 ${
            feedback.isError
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "bg-muted text-foreground"
          }`}
        >
          {feedback.isError ? (
            <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden />
          ) : (
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          )}
          <span>{feedback.text}</span>
        </div>
      )}
      {check.isError ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive"
        >
          <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{(check.error as Error).message}</span>
        </p>
      ) : null}

      {issues.length > 0 ? (
        <Card className="gap-3 bg-warning/5 px-4">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <CircleAlert className="size-4 text-warning" aria-hidden />
            与 Gitea 的差异
          </h3>
          {issues.map((issue) => (
            <Kv key={issue.message} label={issue.message}>
              <span className="text-muted-foreground">{issue.action}</span>
            </Kv>
          ))}
          {canWrite ? (
            <Button
              className="self-start"
              disabled={rotate.isPending}
              onClick={() => rotate.mutate()}
            >
              {rotate.isPending ? "推平中…" : "轮转推平"}
            </Button>
          ) : null}
        </Card>
      ) : null}

      {/* 编辑态并成一栏:两栏面板是 220px 的厂商列加一整栏模型列,半宽的格子装不下。 */}
      <div className={editing ? "grid gap-3" : "grid gap-3 md:grid-cols-2"}>
        <Card className="gap-2.5 px-4">
          <h3 className="text-base font-semibold">准入 key</h3>
          <Kv label="状态">已填进 hook,不回显</Kv>
          <Kv label="代次">
            <span className="font-mono tabular-nums">
              {check.data === undefined ? "…" : check.data.expectedGenerations.join(" / ")}
            </span>
          </Kv>
          <p className="text-xs text-muted-foreground">
            面板自己把 key 填进 hook 的 secret 字段,人全程不需要碰它。
          </p>
          {canWrite ? (
            <Button
              variant="outline"
              className="self-start"
              disabled={rotate.isPending}
              onClick={() => rotate.mutate()}
            >
              {rotate.isPending ? "轮转中…" : "轮转 key"}
            </Button>
          ) : null}
        </Card>

        {canWrite && editing ? (
          <ReviewersEditor
            repo={repo}
            globalModels={globalModels ?? []}
            onClose={() => setEditing(false)}
            onDone={() => {
              setEditing(false);
              setFeedback({ text: "模型组合已更新,下一次投递生效。", isError: false });
              refresh();
            }}
          />
        ) : (
          <Card className="gap-2.5 px-4">
            <h3 className="text-base font-semibold">模型组合</h3>
            {/* 两态开关(issue #69):要么跟随全局,要么本仓库自定义。「一个都没选」
                这种既不是跟随、也不是有效覆盖的状态在界面上不存在。 */}
            {canWrite ? <div className="flex gap-2">
              <Button
                size="xs"
                variant={following ? "default" : "outline"}
                disabled={followGlobal.isPending}
                onClick={() => {
                  if (!following) followGlobal.mutate();
                }}
              >
                跟随全局
              </Button>
              <Button
                size="xs"
                variant={following ? "outline" : "default"}
                disabled={followGlobal.isPending}
                onClick={() => setEditing(true)}
              >
                自定义
              </Button>
            </div> : null}
            <Kv label={following ? "跟随全局默认" : "本仓库覆盖"}>
              {shownModels === undefined ? (
                <span className="text-muted-foreground">跟随中</span>
              ) : (
                <span><span className="font-mono tabular-nums">{shownModels.length}</span> 个</span>
              )}
            </Kv>
            {(shownModels ?? []).map((model) => (
              <div key={model} className="break-all font-mono text-xs">
                {model}
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              {following && canWrite
                ? "改审查策略这里跟着变。点「自定义」从当前组合改起。"
                : following
                  ? "这个仓库使用全局模型组合。"
                  : canWrite
                    ? "只对这个仓库生效。点「跟随全局」即清除覆盖。"
                    : "这组模型只对这个仓库生效。"}
            </p>
          </Card>
        )}
      </div>

      <section className="flex flex-wrap items-center gap-x-6 gap-y-2 border-y border-border py-3">
        <h3 className="text-base font-semibold">累计</h3>
        <span className="text-muted-foreground">
          Review Run {" "}
          <b className="font-mono font-semibold tabular-nums text-foreground">{repo.runCount}</b> 轮
        </span>
        <span className="text-muted-foreground">
          来源 Finding {" "}
          <b className="font-mono font-semibold tabular-nums text-foreground">
            {repo.findingCount}
          </b>{" "}
          条
        </span>
      </section>

      {canReadReviews || canRerun ? (
        <RepoRuns
          repo={repo}
          canRead={canReadReviews}
          canRerun={canRerun}
          onFeedback={setFeedback}
        />
      ) : null}

      {canWrite ? <Dialog open={confirmingRemoval} onOpenChange={setConfirmingRemoval}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              移除 {repo.owner}/{repo.repo}?
            </DialogTitle>
            <DialogDescription>
              会删掉 Gitea 上的 hook,投递从此按未注册拒绝;评审记录保留,模型选型的历史不断。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmingRemoval(false)}>
              取消
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={() => {
                setConfirmingRemoval(false);
                remove.mutate();
              }}
            >
              移除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog> : null}
    </>
  );
}

/** 搜索结果的一条。不可选的两类照样返回,`reason` 说明缺什么。 */
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

/** 输入停下这么久才发搜索请求。每个按键都发会让后端替浏览器打满 Gitea。 */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * 注册仓库(issue #70):输关键字搜 bot 可见的仓库直接选中,不必先去 Gitea 上把
 * owner 与 repo 抄下来。手输两个框已删除——bot 看不见的仓库手输进去也过不了注册时的
 * 权限检查,留个兜底只会把「搜不到」的问题推迟到注册那一刻才暴露。
 *
 * 搜索经本服务代理(`GET <前缀>/api/repos/search`),浏览器不直连 Gitea。已注册与
 * 无 admin 权限两类照样列出、只是置灰:过滤掉会让人明知仓库存在却搜不到。
 */
function RegisterModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (repoId: number) => void;
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
      onDone(created.repoId);
    } catch {
      setError("请求没发出去:后端可达吗?");
    } finally {
      setBusy(false);
    }
  }

  const data = search.data;
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent aria-describedby={undefined}>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <DialogHeader>
            <DialogTitle>注册仓库</DialogTitle>
          </DialogHeader>
          {/* cmdk 自带的过滤按标签文本再筛一次,而结果已经是 Gitea 按关键字搜回来的。 */}
          <Command shouldFilter={false} className="border-border rounded-md border">
            <CommandInput
              placeholder="搜仓库:owner 或仓库名"
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
                <p role="alert" className="p-4 text-destructive">
                  {(search.error as Error).message}
                </p>
              ) : search.isPending && debounced.trim() !== "" ? (
                <div className="flex flex-col gap-2 p-4" role="status">
                  <span className="sr-only">正在搜索仓库</span>
                  <Skeleton aria-hidden className="h-9" />
                  <Skeleton aria-hidden className="h-9" />
                  <Skeleton aria-hidden className="h-9" />
                </div>
              ) : data === undefined || debounced.trim() === "" ? (
                <p className="p-4 text-muted-foreground">输关键字开始搜,搜的是 bot 能看见的仓库。</p>
              ) : data.state === "no-match" ? (
                <p className="p-4 text-muted-foreground">
                  没有匹配的仓库。搜不到通常是 bot 还不是它的协作者,先把 bot 加进那个仓库。
                </p>
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
                          <span className="truncate font-mono">
                            {identity}
                            {picked?.repoId === row.repoId ? (
                              <span className="text-primary ml-2 font-sans">已选</span>
                            ) : null}
                          </span>
                          {row.reason === undefined ? null : (
                            <span className="text-muted-foreground truncate text-xs">
                              {row.reason}
                            </span>
                          )}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-xs">
                          repo id {row.repoId}
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
            <p className="text-warning text-xs">
              共 {data.total} 个匹配,这里只显示前 {data.results.length} 个。继续输入以缩小范围。
            </p>
          ) : null}
          <p className="text-muted-foreground text-xs">
            模型组合先跟随审查策略,注册完在仓库详情里可以改成自定义。
          </p>
          {error === null ? null : (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={busy || picked === null}>
              {busy ? "注册中…" : picked === null ? "注册" : `注册 ${picked.owner}/${picked.repo}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
      setError("请求没发出去:后端可达吗?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">
          自定义 {repo.owner}/{repo.repo} 的模型组合
        </h3>
        <p className="text-muted-foreground">
          {/* prettier-ignore */}
          本仓库覆盖:全量替换全局默认,至少选一个。保存后下一次投递按它跑,点「取消」回到上一屏、什么都不改。
        </p>
      </div>
      <ModelComposer
        value={models}
        onChange={(next) => {
          setModels(next);
          setError(null);
        }}
        onValidityChange={setValidity}
      />
      {error === null ? null : (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
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
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        {models.length === 0 ? (
          <span className="text-muted-foreground">
            一个都没选存不了。要回到跟随全局，点「取消」再点「跟随全局」。
          </span>
        ) : validity.unavailable.length > 0 ? (
          <span className="text-destructive">先恢复或移除不可用模型，再保存覆盖。</span>
        ) : !validity.ready ? (
          <span className="text-muted-foreground">候选状态确认后可以保存覆盖。</span>
        ) : null}
      </div>
    </div>
  );
}

/** 本仓库最近的 Review Run,加「输 PR 号重跑」入口(issue #37,从 #34 递延的 runs 表)。 */
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
  const runs = useQuery({
    queryKey: ["repo-runs", repo.owner, repo.repo],
    queryFn: () =>
      fetchJson<{ runs: RunItem[] }>(
        `/runs?owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.repo)}`,
      ),
    enabled: canRead,
  });
  const [pullNumber, setPullNumber] = useState("");
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
      onFeedback({ text: "PR 号要是正整数", isError: true });
      return;
    }
    rerun.mutate({ owner: repo.owner, repo: repo.repo, pullNumber: number });
  };

  const rows = runs.data?.runs.slice(0, 8) ?? [];
  return (
    <Card className="gap-3 px-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">{canRead ? "评审记录" : "手动重跑"}</h3>
        {canRerun ? <form onSubmit={submit} className="flex flex-wrap gap-2">
          <label htmlFor={`rerun-pr-${repo.repoId}`} className="sr-only">
            PR 号
          </label>
          <Input
            id={`rerun-pr-${repo.repoId}`}
            placeholder="PR 号"
            inputMode="numeric"
            className="w-28"
            value={pullNumber}
            onChange={(event) => setPullNumber(event.target.value)}
          />
          <Button variant="outline" type="submit" disabled={rerun.isPending}>
            {rerun.isPending ? "触发中…" : "重跑"}
          </Button>
        </form> : null}
      </div>
      {canRead && runs.isError ? (
        <p role="alert" className="flex items-start gap-2 text-destructive">
          <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{(runs.error as Error).message}</span>
        </p>
      ) : null}
      {canRead && runs.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </div>
      ) : null}
      {canRead && rows.length > 0 ? (
        <div className="divide-y divide-border border-y border-border">
          {rows.map((run) => (
            <div key={run.id} className="py-2.5">
              <Kv
                label={
                  <span>
                    <span className="font-mono">
                      #{run.pullNumber} · {run.startedAt.slice(0, 16).replace("T", " ")}
                    </span>
                    {` · ${run.triggeredBy === null ? "投递" : `手动 · ${run.triggeredBy}`}`}
                  </span>
                }
              >
                <RunPill run={run} />
              </Kv>
            </div>
          ))}
        </div>
      ) : null}
      {canRead && rows.length === 0 && !runs.isPending && !runs.isError ? (
        <p className="text-xs text-muted-foreground">这个仓库还没有 Review Run。</p>
      ) : null}
    </Card>
  );
}
