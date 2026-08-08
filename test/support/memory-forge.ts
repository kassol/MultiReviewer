import type {
  ChangedFile,
  CloneCredentials,
  ExistingReviewComment,
  Forge,
  PullRequest,
  PullRequestRef,
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
  /** PR 上既有的 review 评论,可直接追加,用于预置上一轮留下的评论。 */
  existingComments: ExistingReviewComment[];
  resolvedIds: string[];
  unresolvedIds: string[];
};

export function memoryForge(init: {
  pullRequest: PullRequest;
  changedFiles: ChangedFile[];
  existingComments?: ExistingReviewComment[];
}): MemoryForge {
  const createdReviews: ReviewDraft[] = [];
  const resolvedIds: string[] = [];
  const unresolvedIds: string[] = [];
  const existing = [...(init.existingComments ?? [])];
  const state = { pullRequest: { ...init.pullRequest } };

  const forge: Forge = {
    getPullRequest: async (_ref: PullRequestRef) => state.pullRequest,
    listChangedFiles: async (_ref: PullRequestRef) => init.changedFiles,
    createReview: async (_ref: PullRequestRef, draft: ReviewDraft) => {
      createdReviews.push(draft);
    },
    listReviewComments: async (_ref: PullRequestRef) => existing,
    resolveComment: async (_ref: RepoRef, commentId: string) => {
      resolvedIds.push(commentId);
    },
    unresolveComment: async (_ref: RepoRef, commentId: string) => {
      unresolvedIds.push(commentId);
    },
    cloneCredentials: async (_ref: RepoRef): Promise<CloneCredentials> => ({
      username: "bot",
      password: "unused-for-local-clone",
    }),
  };

  return {
    forge,
    pullRequest: state.pullRequest,
    createdReviews,
    existingComments: existing,
    resolvedIds,
    unresolvedIds,
  };
}

/** 返回预设 Finding 的 Reviewer 桩。 */
export function scriptedReviewer(
  model: string,
  findings: readonly Omit<Finding, "model">[],
  extra?: Partial<
    Pick<ReviewerOutcome, "failure" | "anomalies" | "rejectedToolCalls" | "usage">
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
        findings: findings.map((f) => ({ ...f, model })),
        anomalies: extra?.anomalies ?? [],
        rejectedToolCalls: extra?.rejectedToolCalls ?? 0,
        ...(extra?.failure === undefined ? {} : { failure: extra.failure }),
        ...(extra?.usage === undefined ? {} : { usage: extra.usage }),
      };
    },
  };
}
