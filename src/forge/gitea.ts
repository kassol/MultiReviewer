import type {
  ChangedFile,
  ChangedFileStatus,
  CloneCredentials,
  ExistingReviewComment,
  Forge,
  PullRequest,
  PullRequestRef,
  Reaction,
  RepoRef,
  ReviewDraft,
} from "./forge.ts";

/**
 * Gitea 的 Forge 实现,也是本项目的目标部署平台。
 *
 * 端点与字段名的依据全部取自 go-gitea/gitea 的 `release/v1.26` 分支,逐处标注在下方。
 * 猜错字段名的后果是评论发不出去或挂错位置,因此这里不容许"看起来合理"的写法。
 *
 * 每一次调用都携带凭据,读取类调用也不例外:目标实例要求登录后才能调用 API,
 * 匿名请求连 `GET /api/v1/version` 都会被拒(ADR 0002)。
 */

const PAGE_SIZE = 100;

/**
 * 社区版下限 1.26.0,企业版下限 26.0.0。
 *
 * `/pulls/comments/{id}/resolve` 与 `/unresolve` 自社区版 1.26.0 才提供
 * (`release/v1.25` 的 `routers/api/v1/api.go` 里没有这两条路由),而 Disposition
 * 整个建立在这对端点上。企业版另起一套版本号,官方规则是社区版 `v1.X.Y` 对应企业版
 * `vX.Y.*`,故下限换算为 26.0.0。
 */
const MIN_COMMUNITY_MINOR = 26;
const MIN_ENTERPRISE_MAJOR = 26;

export type GiteaForgeOptions = {
  /** 实例根地址,例如 `https://gitea.example.com`。末尾有没有斜杠都行。 */
  baseUrl: string;
  /** bot 账号的 scoped PAT(ADR 0005)。 */
  token: string;
};

function apiRoot(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/v1`;
}

/**
 * 发一次 Gitea API 请求。`gitea-hooks.ts` 的 hook 管理模块也用它,因此导出。
 *
 * `allow` 里的状态码不当失败抛出,原样返回给调用方判读——「删 hook 回 404 算成功」
 * 这类语义在调用点决定,这里只负责把确定的失败变成异常。
 *
 * `Authorization: token <PAT>` 是 Gitea 认的两种前缀之一(另一种是 `Bearer`),见
 * `modules/auth/httpauth/httpauth.go` 的 `ParseAuthorizationHeader`:
 * `util.AsciiEqualFold(parts[0], "token") || util.AsciiEqualFold(parts[0], "bearer")`。
 */
export async function request(
  options: GiteaForgeOptions,
  method: string,
  path: string,
  body?: unknown,
  allow: readonly number[] = [],
): Promise<Response> {
  const response = await fetch(`${apiRoot(options.baseUrl)}${path}`, {
    method,
    headers: {
      accept: "application/json",
      "user-agent": "multireviewer",
      authorization: `token ${options.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok && !allow.includes(response.status)) {
    // 只带方法、路径与响应体。凭据在请求头里,不会出现在这三者中的任何一个。
    // 响应体截断:一次 review 的全部评论正文被回显会把日志淹掉。
    const detail = await response.text();
    throw new Error(
      `Gitea ${method} ${path} failed: ${response.status} ${detail.slice(0, 500)}`,
    );
  }
  return response;
}

export async function requestJson<T>(
  options: GiteaForgeOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return (await request(options, method, path, body)).json() as Promise<T>;
}

/**
 * 服务启动时检查实例版本,不合格就带上原因报错。
 *
 * `GET /api/v1/version` 返回 `{"version": setting.AppVer}`
 * (`routers/api/v1/misc/version.go`,`modules/structs/miscellaneous.go` 的 `ServerVersion`)。
 *
 * 企业版返回的是自家的版本号:对企业版 26.4.4 实测,这个端点读到 `26.4.4` 而非对应
 * 的社区版 `1.26.4`。同一次实测里匿名调用它得到 403,读取类调用同样要带凭据。
 *
 * 版本号解析不出来时放行。把一个合规实例挡在门外比漏检更糟,只挡确定不合格的。
 */
export async function assertSupportedVersion(options: GiteaForgeOptions): Promise<void> {
  const { version } = await requestJson<{ version: string }>(options, "GET", "/version");

  const parsed = /^(\d+)\.(\d+)/.exec(version.trim());
  if (parsed === null) return;
  const major = Number(parsed[1]);
  const minor = Number(parsed[2]);
  const supported =
    major === 1 ? minor >= MIN_COMMUNITY_MINOR : major >= MIN_ENTERPRISE_MAJOR;
  if (supported) return;

  throw new Error(
    `Gitea 版本 ${version} 过低:需要社区版 1.26.0 或企业版 26.0.0 以上。` +
      `本工具用 review 评论的 resolve 状态承载 Disposition,` +
      `而 resolve / unresolve 两个端点自该版本才提供。`,
  );
}

export function createGiteaForge(options: GiteaForgeOptions): Forge {
  const repoPath = (ref: RepoRef): string => `/repos/${ref.owner}/${ref.repo}`;

  return {
    async getPullRequest(ref: PullRequestRef): Promise<PullRequest> {
      // `modules/structs/pull.go` 的 `PullRequest`:`Index int64 json:"number"`、
      // `Draft bool json:"draft"`、`Base/Head *PRBranchInfo`;`PRBranchInfo` 的
      // `Sha string json:"sha"` 与 `Repository *Repository json:"repo"`。
      const pr = await requestJson<{
        number: number;
        draft: boolean;
        base: { sha: string; repo: { clone_url: string } };
        head: { sha: string };
      }>(options, "GET", `${repoPath(ref)}/pulls/${ref.number}`);

      return {
        number: pr.number,
        draft: pr.draft,
        baseSha: pr.base.sha,
        headSha: pr.head.sha,
        // 始终 clone base 仓库,与 GitHub 实现一致。
        cloneUrl: pr.base.repo.clone_url,
      };
    },

    async listChangedFiles(ref: PullRequestRef): Promise<ChangedFile[]> {
      const files: ChangedFile[] = [];
      // `GET /repos/{owner}/{repo}/pulls/{index}/files`,分页参数 `page`(1 起)与
      // `limit`,见 `routers/api/v1/repo/pull.go` 的 `GetPullRequestFiles`。
      // 终止条件是「读到空页」而不是「不满一页」:实例的 `API.MAX_RESPONSE_ITEMS`
      // (默认 50)会把 limit 钳下去,恰好钳制值一页时「不满一页」会提前停,
      // 后续文件静默丢失。下面两处 review 列表同理。
      for (let page = 1; ; page += 1) {
        const batch = await requestJson<{ filename: string; status: string }[]>(
          options,
          "GET",
          `${repoPath(ref)}/pulls/${ref.number}/files?page=${page}&limit=${PAGE_SIZE}`,
        );
        if (batch.length === 0) break;
        for (const file of batch) {
          files.push({ path: file.filename, status: normalizeStatus(file.status) });
        }
      }
      return files;
    },

    async createReview(ref: PullRequestRef, draft: ReviewDraft): Promise<void> {
      // `CreatePullReviewOptions` 与 `CreatePullReviewComment`,见
      // `modules/structs/pull_review.go`。`event` 的合法取值是同文件里的
      // `ReviewStateType` 常量,COMMENT 不阻断合并。
      await request(options, "POST", `${repoPath(ref)}/pulls/${ref.number}/reviews`, {
        commit_id: draft.commitSha,
        body: draft.body,
        event: "COMMENT",
        comments: draft.comments.map((c) => ({
          path: c.path,
          body: c.body,
          // `NewLineNum int64 json:"new_position"`,注释写作 "if comment to new file
          // line or 0"——是新文件里的行号本身,不是 diff 内的偏移。
          // `routers/api/v1/repo/pull_review.go` 把它编码成带符号的单个 line:
          // 正数取自 `new_position`,负数取自 `old_position`。本工具只评论 head
          // commit,因此从不填 `old_position`。
          new_position: c.line,
        })),
      });
    },

    async listReviewComments(ref: PullRequestRef): Promise<ExistingReviewComment[]> {
      // Gitea 没有「一次列出 PR 全部 review comment」的端点,只能先列 review
      // (`GET .../pulls/{index}/reviews`,分页)再逐个取它的评论
      // (`GET .../reviews/{id}/comments`,一次返回全部,不分页)。
      const comments: ExistingReviewComment[] = [];

      for (let page = 1; ; page += 1) {
        const reviews = await requestJson<{ id: number; comments_count: number }[]>(
          options,
          "GET",
          `${repoPath(ref)}/pulls/${ref.number}/reviews?page=${page}&limit=${PAGE_SIZE}`,
        );
        if (reviews.length === 0) break;

        for (const review of reviews) {
          // 只有正文没有行级评论的 review(人点的 approve 就是)不必再发一次请求。
          if (review.comments_count === 0) continue;
          const batch = await requestJson<GiteaReviewComment[]>(
            options,
            "GET",
            `${repoPath(ref)}/pulls/${ref.number}/reviews/${review.id}/comments`,
          );
          for (const comment of batch) {
            // `services/convert/pull_review.go` 的 `ToPullReviewComment`:内部存的是
            // 带符号的单个 line,`comment.Line < 0` 时填 `original_position`,否则填
            // `position`,两者只有一个非零。`position` 因此是新文件的行号。
            // 挂在旧文件一侧的评论对应不到 head commit 里的行,跳过好过编一个行号。
            if (comment.position === 0) continue;
            comments.push({
              // resolve / unresolve 作用于单条评论,id 取评论自己的。
              id: String(comment.id),
              path: comment.path,
              line: comment.position,
              body: comment.body,
              // `Resolver *User json:"resolver"` 没有 omitempty,未处置时是 null。
              resolved: comment.resolver !== null,
            });
          }
        }
      }
      return comments;
    },

    async listReviewBodies(ref: PullRequestRef): Promise<string[]> {
      // 与 `listReviewComments` 同一个端点,取的是 review 自己的正文:
      // `modules/structs/pull_review.go` 的 `PullReview` 有 `Body string json:"body"`。
      // 这里不能跟着 `comments_count` 跳过——Finding 全部落在 diff 之外的那一轮发出的
      // 正是「有正文、零行级评论」的 review,而它的正文里就有要匹配的锚点。
      const bodies: string[] = [];

      for (let page = 1; ; page += 1) {
        const reviews = await requestJson<{ body: string }[]>(
          options,
          "GET",
          `${repoPath(ref)}/pulls/${ref.number}/reviews?page=${page}&limit=${PAGE_SIZE}`,
        );
        if (reviews.length === 0) break;
        for (const review of reviews) bodies.push(review.body);
      }
      return bodies;
    },

    async resolveComment(ref: RepoRef, commentId: string): Promise<void> {
      // `POST /repos/{owner}/{repo}/pulls/comments/{id}/resolve`,路径里没有 PR 序号。
      // 返回 204 无正文,因此不解析响应体。
      await request(options, "POST", `${repoPath(ref)}/pulls/comments/${commentId}/resolve`);
    },

    async unresolveComment(ref: RepoRef, commentId: string): Promise<void> {
      await request(
        options,
        "POST",
        `${repoPath(ref)}/pulls/comments/${commentId}/unresolve`,
      );
    },

    async addReaction(ref: PullRequestRef, reaction: Reaction): Promise<void> {
      // PR 在 Gitea 内部就是 issue,reaction 端点因此挂在 `/issues/{index}` 下,
      // 序号与 PR 序号同一个。实测:首次加返回 201,重复加返回 200 且不重复添加,
      // 因此不必先读回再判断。
      await request(options, "POST", `${repoPath(ref)}/issues/${ref.number}/reactions`, {
        content: reaction,
      });
    },

    async removeReaction(ref: PullRequestRef, reaction: Reaction): Promise<void> {
      // 按 content 删,不需要 reaction id(GitHub 那侧才需要)。实测删一个本来就
      // 不存在的 reaction 同样返回 204,因此这个调用是幂等的。
      await request(options, "DELETE", `${repoPath(ref)}/issues/${ref.number}/reactions`, {
        content: reaction,
      });
    },

    async cloneCredentials(_ref: RepoRef): Promise<CloneCredentials> {
      // `services/auth/basic.go`:password 非空且不是 `x-oauth-basic` 时,Gitea 把
      // password 当令牌验证,全程不校验 username 与令牌属主是否一致。username 填一个
      // 固定标识,只为在实例的访问日志里认得出这些请求来自本工具。
      return { username: "multireviewer", password: options.token };
    },
  };
}

type GiteaReviewComment = {
  id: number;
  path: string;
  position: number;
  body: string;
  resolver: unknown;
};

/**
 * `services/convert/convert.go` 里填 `ChangedFile.Status` 的取值全集:
 * `added` / `copied` / `changed` / `unchanged` / `deleted` / `renamed`。
 *
 * 「修改」在 Gitea 是 `changed`、「删除」是 `deleted`,与 GitHub 的 `modified` /
 * `removed` 拼写不同,照抄 GitHub 的分支会把全部修改过的文件误判成新增。
 */
function normalizeStatus(status: string): ChangedFileStatus {
  switch (status) {
    case "added":
    case "copied":
      return "added";
    case "deleted":
      return "removed";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}
