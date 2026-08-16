import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ModelPicker,
  modelIdentity,
  parseModelIdentity,
  useModelCatalog,
} from "@/components/model-picker";

import { api, errorText, fetchJson } from "./api.ts";
import { rerunRequest, RunPill, type RunItem } from "./runs.tsx";

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
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}

export function ReposPage() {
  const queryClient = useQueryClient();
  const repos = useQuery({
    queryKey: ["repos"],
    queryFn: () => fetchJson<RepoRow[]>("/repos"),
  });
  // 全局设置在库里(issue #66),「跟随全局」跟的就是它的 reviewers。
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => fetchJson<{ reviewers: ReviewerSpec[] }>("/settings"),
  });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [registering, setRegistering] = useState(false);

  const rows = repos.data ?? [];
  const selected = rows.find((row) => row.repoId === selectedId) ?? rows[0];

  return (
    <div className="flex min-h-full flex-col sm:grid sm:grid-cols-[248px_1fr]">
      <aside className="border-border bg-card max-sm:border-b sm:border-r">
        <header className="flex items-center justify-between px-4 pt-3.5 pb-2.5">
          <span className="text-[11px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">
            已注册 {rows.length} 个
          </span>
          <Button size="xs" onClick={() => setRegistering(true)}>
            注册
          </Button>
        </header>
        {rows.map((row) => (
          <button
            key={row.repoId}
            className={`block w-full border-l-[3px] px-4 py-2.5 text-left hover:bg-muted ${
              row.repoId === selected?.repoId
                ? "border-l-primary bg-accent"
                : "border-l-transparent"
            }`}
            onClick={() => setSelectedId(row.repoId)}
          >
            <div className="font-mono">
              {row.owner}/{row.repo}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {row.runCount} 轮
              {row.lastActivity === null ? " · 还没跑过" : ` · 最近 ${since(row.lastActivity)}`}
            </div>
          </button>
        ))}
        {rows.length === 0 && !repos.isPending ? (
          <p className="px-4 py-2.5 text-muted-foreground">
            还没有注册仓库,点右上「注册」接入第一个。
          </p>
        ) : null}
      </aside>

      <main className="flex min-w-0 max-w-[900px] flex-col gap-4 p-4">
        {repos.isError ? (
          <p className="text-destructive">{(repos.error as Error).message}</p>
        ) : null}
        {selected === undefined ? null : (
          <RepoDetail
            key={selected.repoId}
            repo={selected}
            globalModels={(settings.data?.reviewers ?? []).map(modelIdentity)}
            onRemoved={() => {
              setSelectedId(null);
              void queryClient.invalidateQueries({ queryKey: ["repos"] });
            }}
          />
        )}
      </main>

      {/* 两个表单模态都按需挂载:常驻会把上一次的输入与错误留在 state 里,下次打开
          回显的就不是当前值了。 */}
      {registering ? (
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
  );
}

function RepoDetail({
  repo,
  globalModels,
  onRemoved,
}: {
  repo: RepoRow;
  globalModels: string[];
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
  const shownModels =
    repo.reviewers === null ? globalModels : repo.reviewers.map(modelIdentity);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-[19px] font-semibold tracking-tight">
          {repo.owner}/{repo.repo}
        </h1>
        {check.isPending ? (
          <Badge variant="secondary">核对中…</Badge>
        ) : check.isError ? (
          <Badge variant="destructive">
            <span className="size-1.5 rounded-full bg-current" />
            核对失败
          </Badge>
        ) : issues.length === 0 ? (
          <Badge className="bg-success/12 text-success">
            <span className="size-1.5 rounded-full bg-current" />
            hook 一致
          </Badge>
        ) : (
          <Badge className="bg-warning/12 text-warning">
            <span className="size-1.5 rounded-full bg-current" />
            {issues.length} 处差异
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">repo id {repo.repoId}</span>
        <Button
          variant="outline"
          className="ml-auto"
          disabled={remove.isPending}
          onClick={() => setConfirmingRemoval(true)}
        >
          移除仓库
        </Button>
      </div>

      {feedback === null ? null : (
        <p className={feedback.isError ? "text-destructive" : "text-muted-foreground"}>
          {feedback.text}
        </p>
      )}
      {check.isError ? (
        <p className="text-destructive">{(check.error as Error).message}</p>
      ) : null}

      {issues.length > 0 ? (
        <Card className="gap-2.5 border-l-[3px] border-l-warning px-4">
          <h2 className="font-semibold">与 Gitea 的差异</h2>
          {issues.map((issue) => (
            <Kv key={issue.message} label={issue.message}>
              <span className="text-muted-foreground">{issue.action}</span>
            </Kv>
          ))}
          <Button
            className="self-start"
            disabled={rotate.isPending}
            onClick={() => rotate.mutate()}
          >
            轮转推平
          </Button>
        </Card>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <Card className="gap-2.5 px-4">
          <h2 className="font-semibold">准入 key</h2>
          <Kv label="状态">已填进 hook,不回显</Kv>
          <Kv label="代次">
            <span className="font-mono tabular-nums">
              {check.data === undefined ? "…" : check.data.expectedGenerations.join(" / ")}
            </span>
          </Kv>
          <p className="text-xs text-muted-foreground">
            面板自己把 key 填进 hook 的 secret 字段,人全程不需要碰它。
          </p>
          <Button
            variant="outline"
            className="self-start"
            disabled={rotate.isPending}
            onClick={() => rotate.mutate()}
          >
            {rotate.isPending ? "轮转中…" : "轮转 key"}
          </Button>
        </Card>

        <Card className="gap-2.5 px-4">
          <h2 className="font-semibold">模型组合</h2>
          {/* 两态开关(issue #69):要么跟随全局,要么本仓库自定义。「一个都没选」
              这种既不是跟随、也不是有效覆盖的状态在界面上不存在。 */}
          <div className="flex gap-2">
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
          </div>
          <Kv label={following ? "跟随全局默认" : "本仓库覆盖"}>
            <span className="font-mono tabular-nums">{shownModels.length} 个</span>
          </Kv>
          {shownModels.map((model) => (
            <div key={model} className="font-mono text-xs">
              {model}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            {following
              ? "改全局设置这里跟着变。点「自定义」从当前组合改起。"
              : "只对这个仓库生效。点「跟随全局」即清除覆盖。"}
          </p>
        </Card>
      </div>

      <Card className="gap-2.5 px-4">
        <h2 className="font-semibold">累计</h2>
        <Kv label="Review Run">
          <span className="font-mono tabular-nums">{repo.runCount} 轮</span>
        </Kv>
        <Kv label="来源 Finding">
          <span className="font-mono tabular-nums">{repo.findingCount} 条</span>
        </Kv>
      </Card>

      <RepoRuns repo={repo} onFeedback={setFeedback} />

      <Dialog open={confirmingRemoval} onOpenChange={setConfirmingRemoval}>
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
      </Dialog>

      {editing ? (
        <ReviewersModal
          repo={repo}
          globalModels={globalModels}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false);
            setFeedback({ text: "模型组合已更新,下一次投递生效。", isError: false });
            refresh();
          }}
        />
      ) : null}
    </>
  );
}

function RegisterModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (repoId: number) => void;
}) {
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // 新仓库一律跟随全局,要自定义在详情里切两态开关。
      const response = await api("/repos", {
        method: "POST",
        body: JSON.stringify({ owner, repo }),
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

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent aria-describedby={undefined}>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <DialogHeader>
            <DialogTitle>注册仓库</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <Label htmlFor="register-owner">owner</Label>
            <Input
              id="register-owner"
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="register-repo">repo</Label>
            <Input
              id="register-repo"
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            模型组合先跟随全局设置,注册完在仓库详情里可以改成自定义。
          </p>
          {error === null ? null : <p className="text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={busy || owner === "" || repo === ""}>
              {busy ? "注册中…" : "注册"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 自定义态的编辑框(issue #69)。还在跟随全局时以当前全局组合为初值——人从一个已知
 * 跑得起来的组合上改,而不是从空列表开始拼。选择器与全局设置页是同一个组件。
 */
function ReviewersModal({
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
  const catalog = useModelCatalog();
  const [models, setModels] = useState(() =>
    repo.reviewers === null ? globalModels : repo.reviewers.map(modelIdentity),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
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
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent aria-describedby={undefined}>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <DialogHeader>
            <DialogTitle>
              自定义 {repo.owner}/{repo.repo} 的模型组合
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label>本仓库覆盖(全量替换,至少选一个)</Label>
            <ModelPicker
              providers={catalog.data?.providers ?? []}
              value={models}
              onChange={setModels}
            />
          </div>
          {catalog.isError ? (
            <p className="text-destructive">
              模型目录读不到:{(catalog.error as Error).message}
            </p>
          ) : null}
          {error === null ? null : <p className="text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={busy || models.length === 0}>
              {busy ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 本仓库最近的 Review Run,加「输 PR 号重跑」入口(issue #37,从 #34 递延的 runs 表)。 */
function RepoRuns({
  repo,
  onFeedback,
}: {
  repo: RepoRow;
  onFeedback: (feedback: { text: string; isError: boolean } | null) => void;
}) {
  const queryClient = useQueryClient();
  const runs = useQuery({
    queryKey: ["repo-runs", repo.owner, repo.repo],
    queryFn: () =>
      fetchJson<{ runs: RunItem[] }>(
        `/runs?owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.repo)}`,
      ),
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
    <Card className="gap-2.5 px-4">
      <h2 className="font-semibold">评审记录</h2>
      <form onSubmit={submit} className="flex gap-2">
        <Input
          placeholder="PR 号"
          inputMode="numeric"
          className="w-[110px]"
          value={pullNumber}
          onChange={(event) => setPullNumber(event.target.value)}
        />
        <Button variant="outline" type="submit" disabled={rerun.isPending}>
          {rerun.isPending ? "触发中…" : "重跑"}
        </Button>
      </form>
      {runs.isError ? (
        <p className="text-destructive">{(runs.error as Error).message}</p>
      ) : null}
      {rows.map((run) => (
        <Kv
          key={run.id}
          label={
            <span className="font-mono">
              #{run.pullNumber} · {run.startedAt.slice(0, 16).replace("T", " ")}
            </span>
          }
        >
          <RunPill run={run} />
        </Kv>
      ))}
      {rows.length === 0 && !runs.isPending ? (
        <p className="text-xs text-muted-foreground">这个仓库还没有 Review Run。</p>
      ) : null}
    </Card>
  );
}
