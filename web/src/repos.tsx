import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { api, errorText, fetchJson } from "./api.ts";
import { rerunRequest, RunPill, type RunItem } from "./runs.tsx";

type ReviewerSpec = { provider: string; model: string; apiKeyEnv: string };

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

export function ReposPage() {
  const queryClient = useQueryClient();
  const repos = useQuery({
    queryKey: ["repos"],
    queryFn: () => fetchJson<RepoRow[]>("/repos"),
  });
  const globalModels = useQuery({
    queryKey: ["global-models"],
    queryFn: () => fetchJson<{ models: string[] }>("/reviewers"),
  });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [registering, setRegistering] = useState(false);

  const rows = repos.data ?? [];
  const selected = rows.find((row) => row.repoId === selectedId) ?? rows[0];

  return (
    <div className="a-body">
      <aside className="a-list">
        <header>
          <span className="eyebrow">已注册 {rows.length} 个</span>
          <button
            className="btn primary"
            style={{ padding: "3px 9px", fontSize: 12 }}
            onClick={() => setRegistering(true)}
          >
            注册
          </button>
        </header>
        {rows.map((row) => (
          <button
            key={row.repoId}
            className={`a-repo ${row.repoId === selected?.repoId ? "on" : ""}`}
            onClick={() => setSelectedId(row.repoId)}
          >
            <div className="name">
              {row.owner}/{row.repo}
            </div>
            <div className="meta">
              {row.runCount} 轮
              {row.lastActivity === null ? " · 还没跑过" : ` · 最近 ${since(row.lastActivity)}`}
            </div>
          </button>
        ))}
        {rows.length === 0 && !repos.isPending ? (
          <p className="faint" style={{ padding: "10px 16px", fontSize: 13 }}>
            还没有注册仓库,点右上「注册」接入第一个。
          </p>
        ) : null}
      </aside>

      <main className="a-main">
        {repos.isError ? <p className="error">{(repos.error as Error).message}</p> : null}
        {selected === undefined ? null : (
          <RepoDetail
            key={selected.repoId}
            repo={selected}
            globalModels={globalModels.data?.models ?? []}
            onRemoved={() => {
              setSelectedId(null);
              void queryClient.invalidateQueries({ queryKey: ["repos"] });
            }}
          />
        )}
      </main>

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

  const issues = check.data?.issues ?? [];

  return (
    <>
      <div className="a-head">
        <h1 className="mono">
          {repo.owner}/{repo.repo}
        </h1>
        {check.isPending ? (
          <span className="pill">核对中…</span>
        ) : check.isError ? (
          <span className="pill warn">
            <i className="dot" />
            核对失败
          </span>
        ) : issues.length === 0 ? (
          <span className="pill ok">
            <i className="dot" />
            hook 一致
          </span>
        ) : (
          <span className="pill warn">
            <i className="dot" />
            {issues.length} 处差异
          </span>
        )}
        <span className="faint" style={{ fontSize: 12 }}>
          repo id {repo.repoId}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            className="btn"
            disabled={remove.isPending}
            onClick={() => setConfirmingRemoval(true)}
          >
            移除仓库
          </button>
        </div>
      </div>

      {feedback === null ? null : (
        <p className={feedback.isError ? "error" : "muted"} style={{ fontSize: 13 }}>
          {feedback.text}
        </p>
      )}
      {check.isError ? <p className="error">{(check.error as Error).message}</p> : null}

      {issues.length > 0 ? (
        <section className="card panel">
          <h2>与 Gitea 的差异</h2>
          {issues.map((issue) => (
            <div className="kv" key={issue.message}>
              <span className="k">{issue.message}</span>
              <span className="faint">{issue.action}</span>
            </div>
          ))}
          <button
            className="btn primary"
            style={{ alignSelf: "flex-start" }}
            disabled={rotate.isPending}
            onClick={() => rotate.mutate()}
          >
            轮转推平
          </button>
        </section>
      ) : null}

      <div className="a-grid">
        <section className="card panel">
          <h2>准入 key</h2>
          <div className="kv">
            <span className="k">状态</span>
            <span>已填进 hook,不回显</span>
          </div>
          <div className="kv">
            <span className="k">代次</span>
            <span className="num">
              {check.data === undefined ? "…" : check.data.expectedGenerations.join(" / ")}
            </span>
          </div>
          <p className="faint" style={{ fontSize: 12 }}>
            面板自己把 key 填进 hook 的 secret 字段,人全程不需要碰它。
          </p>
          <button
            className="btn"
            style={{ alignSelf: "flex-start" }}
            disabled={rotate.isPending}
            onClick={() => rotate.mutate()}
          >
            {rotate.isPending ? "轮转中…" : "轮转 key"}
          </button>
        </section>

        <section className="card panel">
          <h2>模型组合</h2>
          {(() => {
            const models =
              repo.reviewers === null ? globalModels : repo.reviewers.map((s) => s.model);
            return (
              <>
                <div className="kv">
                  <span className="k">
                    {repo.reviewers === null ? "跟随全局默认" : "本仓库覆盖"}
                  </span>
                  <span className="num">{models.length} 个</span>
                </div>
                {models.map((model) => (
                  <div key={model} className="mono" style={{ fontSize: 12 }}>
                    {model}
                  </div>
                ))}
              </>
            );
          })()}
          <button
            className="btn"
            style={{ alignSelf: "flex-start" }}
            onClick={() => setEditing(true)}
          >
            改组合
          </button>
        </section>
      </div>

      <section className="card panel">
        <h2>累计</h2>
        <div className="kv">
          <span className="k">Review Run</span>
          <span className="num">{repo.runCount} 轮</span>
        </div>
        <div className="kv">
          <span className="k">来源 Finding</span>
          <span className="num">{repo.findingCount} 条</span>
        </div>
      </section>

      <RepoRuns repo={repo} onFeedback={setFeedback} />

      {confirmingRemoval ? (
        <div className="modal-backdrop" onClick={() => setConfirmingRemoval(false)}>
          <div className="card modal" onClick={(event) => event.stopPropagation()}>
            <h2>
              移除 {repo.owner}/{repo.repo}?
            </h2>
            <p style={{ fontSize: 13 }}>
              会删掉 Gitea 上的 hook,投递从此按未注册拒绝;评审记录保留,模型选型的历史不断。
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirmingRemoval(false)}>
                取消
              </button>
              <button
                className="btn primary"
                disabled={remove.isPending}
                onClick={() => {
                  setConfirmingRemoval(false);
                  remove.mutate();
                }}
              >
                移除
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {editing ? (
        <ReviewersModal
          repo={repo}
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

/** 覆盖编辑框的说明:与配置文件 reviewers 同形状。 */
const REVIEWERS_HINT =
  '与配置文件 reviewers 同形状的 JSON 数组,如 [{"provider":"deepseek","model":"deepseek-v4-flash","apiKeyEnv":"DEEPSEEK_API_KEY"}];留空即跟随全局。';

function RegisterModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (repoId: number) => void;
}) {
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [reviewersText, setReviewersText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let reviewers: unknown;
      if (reviewersText.trim() !== "") {
        try {
          reviewers = JSON.parse(reviewersText);
        } catch {
          setError("模型组合不是合法 JSON。");
          return;
        }
      }
      const response = await api("/repos", {
        method: "POST",
        body: JSON.stringify({
          owner,
          repo,
          ...(reviewers === undefined ? {} : { reviewers }),
        }),
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
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="card modal"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <h2>注册仓库</h2>
        <label className="field">
          owner
          <input value={owner} onChange={(event) => setOwner(event.target.value)} autoFocus />
        </label>
        <label className="field">
          repo
          <input value={repo} onChange={(event) => setRepo(event.target.value)} />
        </label>
        <label className="field">
          模型组合(可选)
          <textarea
            value={reviewersText}
            onChange={(event) => setReviewersText(event.target.value)}
            placeholder={REVIEWERS_HINT}
          />
        </label>
        {error === null ? null : <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={busy || owner === "" || repo === ""}
          >
            {busy ? "注册中…" : "注册"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ReviewersModal({
  repo,
  onClose,
  onDone,
}: {
  repo: RepoRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [text, setText] = useState(
    repo.reviewers === null ? "" : JSON.stringify(repo.reviewers, null, 2),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let reviewers: unknown = null;
      if (text.trim() !== "") {
        try {
          reviewers = JSON.parse(text);
        } catch {
          setError("不是合法 JSON。");
          return;
        }
      }
      const response = await api(`/repos/${repo.repoId}/reviewers`, {
        method: "PUT",
        body: JSON.stringify({ reviewers }),
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
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="card modal"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <h2>
          改 {repo.owner}/{repo.repo} 的模型组合
        </h2>
        <label className="field">
          覆盖(全量替换;留空即清除覆盖、跟随全局)
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={REVIEWERS_HINT}
            autoFocus
          />
        </label>
        {error === null ? null : <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </div>
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
    <section className="card panel">
      <h2>评审记录</h2>
      <form onSubmit={submit} style={{ display: "flex", gap: 8 }}>
        <input
          placeholder="PR 号"
          inputMode="numeric"
          value={pullNumber}
          onChange={(event) => setPullNumber(event.target.value)}
          style={{ width: 110 }}
        />
        <button className="btn" type="submit" disabled={rerun.isPending}>
          {rerun.isPending ? "触发中…" : "重跑"}
        </button>
      </form>
      {runs.isError ? <p className="error">{(runs.error as Error).message}</p> : null}
      {rows.map((run) => (
        <div className="kv" key={run.id}>
          <span className="k mono">
            #{run.pullNumber} · {run.startedAt.slice(0, 16).replace("T", " ")}
          </span>
          <RunPill run={run} />
        </div>
      ))}
      {rows.length === 0 && !runs.isPending ? (
        <p className="faint" style={{ fontSize: 12 }}>
          这个仓库还没有 Review Run。
        </p>
      ) : null}
    </section>
  );
}
