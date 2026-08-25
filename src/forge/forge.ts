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
  /** PR 此刻的标题。Review Run 开跑时把它记进那一轮,评审记录据此有名字。 */
  title: string;
  draft: boolean;
  /** PR 的 base 分支尖端。Review Range 的基准是它与 head 的 merge-base,不是它本身。 */
  baseSha: string;
  headSha: string;
  /** 可供服务端 clone 的地址,凭据由 `cloneCredentials` 单独取得。 */
  cloneUrl: string;
};

/**
 * 仓库自身的元数据。
 *
 * 范围审查发起时仓库里可能一个 pull request 都没有,而工作副本仍要 clone 得下来
 * (ADR 0012),所以 clone 地址不能只从 `getPullRequest` 那条路取。
 */
export type Repository = {
  /** 可供服务端 clone 的地址,凭据由 `cloneCredentials` 单独取得。 */
  cloneUrl: string;
  /** 仓库的默认分支。commit 选择器的分支下拉默认选中它(issue #178)。 */
  defaultBranch: string;
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
  /** 这条评论在 Forge 页面上的地址。GitHub 实现不回传它(ADR 0014),因此可缺。 */
  htmlUrl?: string;
};

/**
 * 刚发布出去的一条行级评论。
 *
 * `id` 与 `htmlUrl` 落到 Finding 上:面板处置要按评论 id resolve,「跳到 Forge 看原版」
 * 要这个链接。调用方按 `path` + `line` + `body` 把它对应回自己发出去的草稿。
 */
export type PublishedReviewComment = {
  path: string;
  line: number;
  body: string;
  id: string;
  htmlUrl: string;
};

/** clone 用的凭据。两个平台都以 basic auth 的形式使用。 */
export type CloneCredentials = {
  username: string;
  password: string;
};

/**
 * 新建一个 pull request 所需的全部内容。
 *
 * `head` 与 `base` 都是分支名:Gitea 1.26 的建 PR 端点不收 commit sha
 * (`CreatePullRequestOption.Head` 只认分支名或 `<用户>:<分支>`),容器 PR 因此需要
 * 两条分支(ADR 0012)。
 */
export type NewPullRequest = {
  head: string;
  base: string;
  title: string;
  body: string;
};

/**
 * PR 上的 emoji reaction,用来表达审查进度。
 *
 * 只有这两个:`eyes` 是「正在审查」,`+1` 是「审查完毕,未发现问题」。取值用两个平台
 * 共用的 reaction 名,不做成开放字符串——没有第三种状态要表达(ADR 0002)。
 */
export type Reaction = "eyes" | "+1";

export interface Forge {
  /**
   * 读仓库自身的元数据。范围审查发起时还没有容器 PR,clone 地址只能从这里来
   * (ADR 0012)。
   */
  getRepository(ref: RepoRef): Promise<Repository>;
  getPullRequest(ref: PullRequestRef): Promise<PullRequest>;
  listChangedFiles(ref: PullRequestRef): Promise<ChangedFile[]>;
  /**
   * 发布一条 review,返回本次真正落成行级评论的那些条目。
   *
   * 返回值的顺序不作保证;读不回评论标识的平台返回空数组,该轮的 Finding 两项留空。
   */
  createReview(ref: PullRequestRef, draft: ReviewDraft): Promise<PublishedReviewComment[]>;
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
  /**
   * 从一个 commit 建分支。容器 PR 的两条分支都这么来(ADR 0012)。
   *
   * 只建新分支,不移动已有分支——把分支指到某个 commit 没有 API,那走本地 clone 的
   * `pushBranch`。
   */
  createBranch(ref: RepoRef, branch: string, fromSha: string): Promise<void>;
  /** 删分支。审查完成时清掉容器 PR 的两条分支,仓库里不留机器人残留。 */
  deleteBranch(ref: RepoRef, branch: string): Promise<void>;
  /** 建 pull request,返回它的序号。 */
  createPullRequest(ref: RepoRef, input: NewPullRequest): Promise<number>;
  /** 关闭 pull request。容器 PR 永不合并,终态只有关闭。 */
  closePullRequest(ref: PullRequestRef): Promise<void>;
  cloneCredentials(ref: RepoRef): Promise<CloneCredentials>;
  /** 加一个 reaction。已经加过时不重复添加,也不报错。 */
  addReaction(ref: PullRequestRef, reaction: Reaction): Promise<void>;
  /** 撤掉一个 reaction。本来就没有时什么都不做,也不报错。 */
  removeReaction(ref: PullRequestRef, reaction: Reaction): Promise<void>;
}
