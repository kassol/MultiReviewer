import type { Forge, PullRequestRef, ReviewCommentDraft } from "../forge/forge.ts";
import { prepareWorktree, readRangeDiff } from "../git/worktree.ts";
import type { Finding, Reviewer } from "./finding.ts";
import { isInDiff, parseDiffRanges } from "./position.ts";

export type PullRequestEvent = PullRequestRef;

export type ReviewRunDeps = {
  forge: Forge;
  reviewers: readonly Reviewer[];
  /** 工作副本的缓存根目录,按仓库分子目录。 */
  cacheDir: string;
};

export type ReviewRunResult = {
  headSha: string;
  findings: readonly Finding[];
  /** 发布为行级评论的 Finding 条数。 */
  inlineCount: number;
  /** 行号落不到 diff 内、退化为 PR 级评论的 Finding 条数。 */
  fallbackCount: number;
};

function findingBody(finding: Finding): string {
  return `**[${finding.severity} · ${finding.category}]** ${finding.description}\n\n— ${finding.model}`;
}

function reviewBody(fallbacks: readonly Finding[]): string {
  if (fallbacks.length === 0) return "MultiReviewer";
  const lines = fallbacks.map(
    (f) =>
      `- \`${f.file}:${f.line}\` **[${f.severity} · ${f.category}]** ${f.description} — ${f.model}`,
  );
  return [
    "MultiReviewer",
    "",
    "以下 Finding 的行号落在本次 Review Range 的 diff 之外,无法作为行级评论呈现:",
    "",
    ...lines,
  ].join("\n");
}

/**
 * 一次 Review Run:解析 Review Range、准备工作副本、运行 Reviewer、发布 review 评论。
 */
export async function runReview(
  event: PullRequestEvent,
  deps: ReviewRunDeps,
): Promise<ReviewRunResult> {
  const { forge } = deps;
  const pullRequest = await forge.getPullRequest(event);
  const [changedFiles, credentials] = await Promise.all([
    forge.listChangedFiles(event),
    forge.cloneCredentials(event),
  ]);

  const worktree = await prepareWorktree({
    cacheDir: deps.cacheDir,
    ref: event,
    cloneUrl: pullRequest.cloneUrl,
    credentials,
    headSha: pullRequest.headSha,
    baseSha: pullRequest.baseSha,
  });

  const range = {
    baseSha: worktree.mergeBaseSha,
    headSha: pullRequest.headSha,
    files: changedFiles
      .filter((f) => f.status !== "removed")
      .map((f) => f.path),
  };

  const findings = (
    await Promise.all(
      deps.reviewers.map((reviewer) => reviewer.review(range, worktree.path)),
    )
  ).flat();

  const diffRanges = parseDiffRanges(
    await readRangeDiff(worktree.path, worktree.mergeBaseSha, pullRequest.headSha),
  );

  const comments: ReviewCommentDraft[] = [];
  const fallbacks: Finding[] = [];
  for (const finding of findings) {
    if (isInDiff(diffRanges, finding.file, finding.line)) {
      comments.push({
        path: finding.file,
        line: finding.line,
        body: findingBody(finding),
      });
    } else {
      fallbacks.push(finding);
    }
  }

  if (findings.length > 0) {
    await forge.createReview(event, {
      body: reviewBody(fallbacks),
      commitSha: pullRequest.headSha,
      comments,
    });
  }

  return {
    headSha: pullRequest.headSha,
    findings,
    inlineCount: comments.length,
    fallbackCount: fallbacks.length,
  };
}
