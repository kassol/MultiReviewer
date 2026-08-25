import type {
  ChangedFile,
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
} from "../../src/forge/forge.ts";
import type {
  Finding,
  ReviewRange,
  Reviewer,
  ReviewerOutcome,
} from "../../src/review/finding.ts";

export type MemoryForge = {
  forge: Forge;
  /** 可直接改写,用于模拟 PR 推送新 commit 后的下一次 Review Run。 */
  pullRequest: PullRequest;
  /** 按调用顺序记录发布的 review。 */
  createdReviews: ReviewDraft[];
  /** 本内存 Forge 为自己发出去的每条行级评论分配的 id 与链接,按发布顺序。 */
  publishedComments: PublishedReviewComment[];
  /** PR 上既有的 review 评论,可直接追加,用于预置上一轮留下的评论。 */
  existingComments: ExistingReviewComment[];
  /** PR 上既有的 review 正文,可直接追加,用于预置上一轮发出去的正文。 */
  existingReviewBodies: string[];
  resolvedIds: string[];
  unresolvedIds: string[];
  /** 容器 PR 的四个写能力,各按调用顺序记录(ADR 0012)。 */
  createdBranches: { branch: string; fromSha: string }[];
  deletedBranches: string[];
  createdPullRequests: (NewPullRequest & { number: number })[];
  closedPullRequests: number[];
  /** PR 上此刻挂着的 reaction。 */
  reactions: Set<Reaction>;
  /** 全部 reaction 操作,按调用顺序,形如 `add:eyes` / `remove:+1`。 */
  reactionLog: string[];
};

export function memoryForge(init: {
  pullRequest: PullRequest;
  changedFiles: ChangedFile[];
  existingComments?: ExistingReviewComment[];
}): MemoryForge {
  const createdReviews: ReviewDraft[] = [];
  const publishedComments: PublishedReviewComment[] = [];
  const resolvedIds: string[] = [];
  const unresolvedIds: string[] = [];
  const createdBranches: { branch: string; fromSha: string }[] = [];
  const deletedBranches: string[] = [];
  const createdPullRequests: (NewPullRequest & { number: number })[] = [];
  const closedPullRequests: number[] = [];
  const existing = [...(init.existingComments ?? [])];
  const existingReviewBodies: string[] = [];
  const reactions = new Set<Reaction>();
  const reactionLog: string[] = [];
  const state = { pullRequest: { ...init.pullRequest } };

  const forge: Forge = {
    getPullRequest: async (_ref: PullRequestRef) => state.pullRequest,
    listChangedFiles: async (_ref: PullRequestRef) => init.changedFiles,
    createReview: async (_ref: PullRequestRef, draft: ReviewDraft) => {
      createdReviews.push(draft);
      // 真实平台在发布之后才给出评论 id 与链接,内存 Forge 照做:按发布顺序编号。
      const published = draft.comments.map((comment, index) => {
        const serial = publishedComments.length + index + 1;
        return {
          path: comment.path,
          line: comment.line,
          body: comment.body,
          id: `comment-${serial}`,
          htmlUrl: `https://forge.invalid/pulls/7/files#comment-${serial}`,
        };
      });
      publishedComments.push(...published);
      return published;
    },
    listReviewComments: async (_ref: PullRequestRef) => existing,
    listReviewBodies: async (_ref: PullRequestRef) => existingReviewBodies,
    resolveComment: async (_ref: RepoRef, commentId: string) => {
      resolvedIds.push(commentId);
    },
    unresolveComment: async (_ref: RepoRef, commentId: string) => {
      unresolvedIds.push(commentId);
    },
    createBranch: async (_ref: RepoRef, branch: string, fromSha: string) => {
      createdBranches.push({ branch, fromSha });
    },
    deleteBranch: async (_ref: RepoRef, branch: string) => {
      deletedBranches.push(branch);
    },
    createPullRequest: async (_ref: RepoRef, input: NewPullRequest) => {
      // 容器 PR 的序号与被审的 PR 分开,从 101 起,免得测试把两者看混。
      const number = 101 + createdPullRequests.length;
      createdPullRequests.push({ ...input, number });
      return number;
    },
    closePullRequest: async (ref: PullRequestRef) => {
      closedPullRequests.push(ref.number);
    },
    cloneCredentials: async (_ref: RepoRef): Promise<CloneCredentials> => ({
      username: "bot",
      password: "unused-for-local-clone",
    }),
    // 两个平台的真实端点都是幂等的:重复加不重复挂,删不存在的不报错。
    addReaction: async (_ref: PullRequestRef, reaction: Reaction) => {
      reactions.add(reaction);
      reactionLog.push(`add:${reaction}`);
    },
    removeReaction: async (_ref: PullRequestRef, reaction: Reaction) => {
      reactions.delete(reaction);
      reactionLog.push(`remove:${reaction}`);
    },
  };

  return {
    forge,
    pullRequest: state.pullRequest,
    createdReviews,
    publishedComments,
    existingComments: existing,
    existingReviewBodies,
    resolvedIds,
    unresolvedIds,
    createdBranches,
    deletedBranches,
    createdPullRequests,
    closedPullRequests,
    reactions,
    reactionLog,
  };
}

/**
 * 测试里书写 Finding 的省略形:title / impact / suggestion 与呈现有关,大多数用例
 * 不关心,省略时补空串。关心呈现的用例显式写上。
 */
type ScriptedFinding = Omit<Finding, "model" | "title" | "impact" | "suggestion"> &
  Partial<Pick<Finding, "title" | "impact" | "suggestion">>;

/** 返回预设 Finding 的 Reviewer 桩。 */
export function scriptedReviewer(
  model: string,
  findings: readonly ScriptedFinding[],
  extra?: Partial<
    Pick<
      ReviewerOutcome,
      "failure" | "anomalies" | "rejectedToolCalls" | "anchorRejections" | "usage"
    >
  >,
): Reviewer & { calls: { range: ReviewRange; worktreePath: string }[] } {
  const calls: { range: ReviewRange; worktreePath: string }[] = [];
  return {
    model,
    calls,
    review: async (range, worktreePath) => {
      calls.push({ range, worktreePath });
      return {
        model,
        findings: findings.map((f) => ({
          title: "",
          impact: "",
          suggestion: "",
          ...f,
          model,
        })),
        anomalies: extra?.anomalies ?? [],
        rejectedToolCalls: extra?.rejectedToolCalls ?? 0,
        anchorRejections: extra?.anchorRejections ?? 0,
        ...(extra?.failure === undefined ? {} : { failure: extra.failure }),
        ...(extra?.usage === undefined ? {} : { usage: extra.usage }),
      };
    },
  };
}
