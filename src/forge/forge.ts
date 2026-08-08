/**
 * Forge 是托管代码与 pull request 的平台。
 *
 * 接口按 Gitea 的能力定义(ADR 0002):只包含 Gitea 与 GitHub 都具备的能力。
 * GitHub 独有的能力不进入接口,即便开发阶段用得上。
 */

export type RepoRef = {
  owner: string;
  repo: string;
};

export type PullRequestRef = RepoRef & {
  number: number;
};

export type PullRequest = {
  number: number;
  draft: boolean;
  /** PR 的 base 分支尖端。Review Range 的基准是它与 head 的 merge-base,不是它本身。 */
  baseSha: string;
  headSha: string;
  /** 可供服务端 clone 的地址,凭据由 `cloneCredentials` 单独取得。 */
  cloneUrl: string;
};

export type ChangedFileStatus = "added" | "modified" | "removed" | "renamed";

export type ChangedFile = {
  path: string;
  status: ChangedFileStatus;
};

/** 一条待发布的行级评论。`line` 是 head commit 中该文件的 1-indexed 行号。 */
export type ReviewCommentDraft = {
  path: string;
  line: number;
  body: string;
};

export type ReviewDraft = {
  body: string;
  commitSha: string;
  comments: ReviewCommentDraft[];
};

/** Forge 上已存在的一条 review 评论。`resolved` 即 Disposition 的载体。 */
export type ExistingReviewComment = {
  id: string;
  path: string;
  line: number;
  body: string;
  resolved: boolean;
};

/** clone 用的凭据。两个平台都以 basic auth 的形式使用。 */
export type CloneCredentials = {
  username: string;
  password: string;
};

export interface Forge {
  getPullRequest(ref: PullRequestRef): Promise<PullRequest>;
  listChangedFiles(ref: PullRequestRef): Promise<ChangedFile[]>;
  createReview(ref: PullRequestRef, draft: ReviewDraft): Promise<void>;
  listReviewComments(ref: PullRequestRef): Promise<ExistingReviewComment[]>;
  resolveComment(ref: RepoRef, commentId: string): Promise<void>;
  unresolveComment(ref: RepoRef, commentId: string): Promise<void>;
  cloneCredentials(ref: RepoRef): Promise<CloneCredentials>;
}
