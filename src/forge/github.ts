import { createSign } from "node:crypto";

import type {
  ChangedFile,
  ChangedFileStatus,
  CloneCredentials,
  ExistingReviewComment,
  Forge,
  NewPullRequest,
  PublishedReviewComment,
  PullRequest,
  PullRequestRef,
  Reaction,
  RepoRef,
  ReviewDraft,
} from "./forge.ts";

/**
 * GitHub 的 Forge 实现。
 *
 * 接口按 Gitea 的能力定义(ADR 0002),此处不因 GitHub 能力更强而扩张。
 * resolve 状态与 resolve/unresolve 在 GitHub 上只有 GraphQL 提供,REST 没有对应端点,
 * 因此这三个方法走 GraphQL,其余走 REST。
 */

const API_ROOT = "https://api.github.com";
const PAGE_SIZE = 100;

/**
 * 生产部署使用 GitHub App(ADR 0005)。`token` 变体供开发阶段直接用个人令牌
 * 对真实 pull request 验证实现,不进入生产配置。
 */
export type GitHubAuth =
  | { kind: "app"; appId: string; privateKey: string }
  | { kind: "token"; token: string };

export type GitHubForgeOptions = {
  auth: GitHubAuth;
};

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** GitHub App 的 JWT:RS256,有效期上限 10 分钟,iat 回拨以容忍时钟偏差。 */
function appJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

type InstallationToken = { token: string; expiresAt: number };

/** 封存期间新增的 Forge 能力在这一侧的统一说法(ADR 0014)。 */
function frozen(method: string): string {
  return `GitHub 实现已封存(ADR 0014):${method} 未实现,容器 PR 的写能力只做 Gitea。`;
}

export function createGitHubForge(options: GitHubForgeOptions): Forge {
  const installationTokens = new Map<string, InstallationToken>();

  async function send(
    path: string,
    init: RequestInit & { token: string },
  ): Promise<Response> {
    const { token, ...rest } = init;
    const response = await fetch(`${API_ROOT}${path}`, {
      ...rest,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "multireviewer",
        authorization: `Bearer ${token}`,
        ...(rest.body === undefined ? {} : { "content-type": "application/json" }),
        ...rest.headers,
      },
    });
    if (!response.ok) {
      // 截断响应体:GitHub 在 422 时会回显整个请求负载,一次 review 的全部评论正文
      // 会把日志淹掉。
      const detail = await response.text();
      throw new Error(
        `GitHub ${init.method ?? "GET"} ${path} failed: ${response.status} ${detail.slice(0, 500)}`,
      );
    }
    return response;
  }

  async function request<T>(
    path: string,
    init: RequestInit & { token: string },
  ): Promise<T> {
    return (await send(path, init)).json() as Promise<T>;
  }

  /** 回 204 无正文的调用。这类响应上解析 JSON 会抛。 */
  async function requestVoid(
    path: string,
    init: RequestInit & { token: string },
  ): Promise<void> {
    await send(path, init);
  }

  /** 仓库级令牌:App 模式按仓库换取 installation token 并缓存到过期前。 */
  async function tokenFor(ref: RepoRef): Promise<string> {
    if (options.auth.kind === "token") return options.auth.token;

    const key = `${ref.owner}/${ref.repo}`;
    const cached = installationTokens.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }

    const jwt = appJwt(options.auth.appId, options.auth.privateKey);
    const installation = await request<{ id: number }>(
      `/repos/${ref.owner}/${ref.repo}/installation`,
      { token: jwt },
    );
    const issued = await request<{ token: string; expires_at: string }>(
      `/app/installations/${installation.id}/access_tokens`,
      { method: "POST", token: jwt },
    );
    const token = {
      token: issued.token,
      expiresAt: Date.parse(issued.expires_at),
    };
    installationTokens.set(key, token);
    return token.token;
  }

  async function graphql<T>(ref: RepoRef, query: string, variables: unknown): Promise<T> {
    const token = await tokenFor(ref);
    const result = await request<{ data: T; errors?: { message: string }[] }>(
      "/graphql",
      {
        method: "POST",
        token,
        body: JSON.stringify({ query, variables }),
      },
    );
    if (result.errors !== undefined && result.errors.length > 0) {
      throw new Error(
        `GitHub GraphQL failed: ${result.errors.map((e) => e.message).join("; ")}`,
      );
    }
    return result.data;
  }

  return {
    async getPullRequest(ref: PullRequestRef): Promise<PullRequest> {
      const token = await tokenFor(ref);
      const pr = await request<{
        number: number;
        draft: boolean;
        base: { sha: string; repo: { clone_url: string } };
        head: { sha: string };
      }>(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, { token });

      return {
        number: pr.number,
        draft: pr.draft,
        baseSha: pr.base.sha,
        headSha: pr.head.sha,
        // 始终 clone base 仓库。来自 fork 的 head commit 经 pull ref 取得。
        cloneUrl: pr.base.repo.clone_url,
      };
    },

    async listChangedFiles(ref: PullRequestRef): Promise<ChangedFile[]> {
      const token = await tokenFor(ref);
      const files: ChangedFile[] = [];
      for (let page = 1; ; page += 1) {
        const batch = await request<{ filename: string; status: string }[]>(
          `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=${PAGE_SIZE}&page=${page}`,
          { token },
        );
        for (const file of batch) {
          files.push({ path: file.filename, status: normalizeStatus(file.status) });
        }
        if (batch.length < PAGE_SIZE) break;
      }
      return files;
    },

    async createReview(
      ref: PullRequestRef,
      draft: ReviewDraft,
    ): Promise<PublishedReviewComment[]> {
      const token = await tokenFor(ref);
      await request(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`, {
        method: "POST",
        token,
        body: JSON.stringify({
          commit_id: draft.commitSha,
          body: draft.body,
          // 审查不阻断合并,人保留最终判断权。
          event: "COMMENT",
          comments: draft.comments.map((c) => ({
            path: c.path,
            line: c.line,
            side: "RIGHT",
            body: c.body,
          })),
        }),
      });
      // GitHub 实现已封存(ADR 0014):不为它补读回评论标识的那一步。空数组的含义是
      // 「这一侧读不回评论 id 与链接」,该轮 Finding 的这两项因此留空。
      return [];
    },

    async listReviewComments(ref: PullRequestRef): Promise<ExistingReviewComment[]> {
      const comments: ExistingReviewComment[] = [];
      let cursor: string | null = null;

      for (;;) {
        const data: ReviewThreadsPage = await graphql<ReviewThreadsPage>(
          ref,
          REVIEW_THREADS_QUERY,
          { owner: ref.owner, repo: ref.repo, number: ref.number, cursor },
        );
        const threads = data.repository.pullRequest.reviewThreads;
        for (const thread of threads.nodes) {
          const first = thread.comments.nodes[0];
          if (first === undefined) continue;
          // `line` 在评论所指的代码已被后续 commit 改掉时为 null,此时退回它当初挂上的行。
          // 两者都没有的 thread 无法对应任何代码位置,跳过好过编一个 0 行号传下去。
          const line = first.line ?? first.originalLine;
          if (line === null) continue;
          comments.push({
            // resolve/unresolve 作用于 thread 而非单条评论,id 取 thread 的。
            id: thread.id,
            path: first.path,
            line,
            body: first.body,
            resolved: thread.isResolved,
          });
        }
        if (!threads.pageInfo.hasNextPage) break;
        cursor = threads.pageInfo.endCursor;
      }
      return comments;
    },

    async listReviewBodies(ref: PullRequestRef): Promise<string[]> {
      // 走 REST:`listReviewComments` 用的 GraphQL reviewThreads 里只有行级评论,
      // review 自己的正文不在其中。
      const token = await tokenFor(ref);
      const bodies: string[] = [];
      for (let page = 1; ; page += 1) {
        const batch = await request<{ body: string }[]>(
          `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews?per_page=${PAGE_SIZE}&page=${page}`,
          { token },
        );
        for (const review of batch) bodies.push(review.body);
        if (batch.length < PAGE_SIZE) break;
      }
      return bodies;
    },

    async resolveComment(ref: RepoRef, commentId: string): Promise<void> {
      await graphql(ref, RESOLVE_MUTATION, { threadId: commentId });
    },

    async unresolveComment(ref: RepoRef, commentId: string): Promise<void> {
      await graphql(ref, UNRESOLVE_MUTATION, { threadId: commentId });
    },

    // 容器 PR 的四个写能力只做 Gitea(ADR 0014)。封存期间不为 GitHub 保留兼容层:
    // 调到就当场报错,静默什么都不做只会让范围审查建出半个容器 PR。
    async createBranch(_ref: RepoRef, _branch: string, _fromSha: string): Promise<void> {
      throw new Error(frozen("createBranch"));
    },

    async deleteBranch(_ref: RepoRef, _branch: string): Promise<void> {
      throw new Error(frozen("deleteBranch"));
    },

    async createPullRequest(_ref: RepoRef, _input: NewPullRequest): Promise<number> {
      throw new Error(frozen("createPullRequest"));
    },

    async closePullRequest(_ref: PullRequestRef): Promise<void> {
      throw new Error(frozen("closePullRequest"));
    },

    async addReaction(ref: PullRequestRef, reaction: Reaction): Promise<void> {
      // PR 在 GitHub 内部也是 issue,reaction 端点挂在 `/issues/{number}` 下。
      // 已经加过时返回 200 而非 201,不重复添加,因此不必先读回。
      await request(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/reactions`, {
        method: "POST",
        token: await tokenFor(ref),
        body: JSON.stringify({ content: reaction }),
      });
    },

    async removeReaction(ref: PullRequestRef, reaction: Reaction): Promise<void> {
      // GitHub 按 reaction id 删,不像 Gitea 那样按 content 删,因此要先列出来。
      // 过滤参数只收窄到 content,列表里仍可能有别人加的同一个 emoji——GitHub 不允许
      // 删别人的 reaction,那些 DELETE 会失败,当作「不是我的」跳过即可,不必先问
      // 「我是谁」。
      const token = await tokenFor(ref);
      const base = `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/reactions`;
      const existing = await request<{ id: number }[]>(
        `${base}?content=${encodeURIComponent(reaction)}&per_page=100`,
        { token },
      );
      for (const { id } of existing) {
        try {
          await requestVoid(`${base}/${id}`, { method: "DELETE", token });
        } catch {
          // 别人加的同一个 emoji。审查进度是装饰,删不掉不该掀翻整次审查。
        }
      }
    },

    async cloneCredentials(ref: RepoRef): Promise<CloneCredentials> {
      return { username: "x-access-token", password: await tokenFor(ref) };
    },
  };
}

function normalizeStatus(status: string): ChangedFileStatus {
  switch (status) {
    case "added":
    case "copied":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}

type ReviewThreadsPage = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string };
        nodes: {
          id: string;
          isResolved: boolean;
          comments: {
            nodes: {
              path: string;
              line: number | null;
              originalLine: number | null;
              body: string;
            }[];
          };
        }[];
      };
    };
  };
};

const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: ${PAGE_SIZE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { path line originalLine body }
          }
        }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`;

const UNRESOLVE_MUTATION = `
mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`;
