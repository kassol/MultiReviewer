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

/**
 * PR 上的 emoji reaction,用来表达审查进度。
 *
 * 只有这两个:`eyes` 是「正在审查」,`+1` 是「审查完毕,未发现问题」。取值用两个平台
 * 共用的 reaction 名,不做成开放字符串——没有第三种状态要表达(ADR 0002)。
 */
export type Reaction = "eyes" | "+1";

export interface Forge {
  getPullRequest(ref: PullRequestRef): Promise<PullRequest>;
  listChangedFiles(ref: PullRequestRef): Promise<ChangedFile[]>;
  createReview(ref: PullRequestRef, draft: ReviewDraft): Promise<void>;
  listReviewComments(ref: PullRequestRef): Promise<ExistingReviewComment[]>;
  /**
   * PR 上每条 review 的正文,人写的与本工具发的都在内。
   *
   * 行号落在 diff 之外的 Finding 没有行级评论承载,只活在 review 正文里,跨轮次匹配
   * 要把它们读回来。正文没有 resolve 状态,两个平台都没有。
   */
  listReviewBodies(ref: PullRequestRef): Promise<string[]>;
  resolveComment(ref: RepoRef, commentId: string): Promise<void>;
  unresolveComment(ref: RepoRef, commentId: string): Promise<void>;
  cloneCredentials(ref: RepoRef): Promise<CloneCredentials>;
  /** 加一个 reaction。已经加过时不重复添加,也不报错。 */
  addReaction(ref: PullRequestRef, reaction: Reaction): Promise<void>;
  /** 撤掉一个 reaction。本来就没有时什么都不做,也不报错。 */
  removeReaction(ref: PullRequestRef, reaction: Reaction): Promise<void>;
}
