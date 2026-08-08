import type { Forge, PullRequestRef, ReviewCommentDraft } from "../forge/forge.ts";
import { prepareWorktree, readRangeDiff } from "../git/worktree.ts";
import { dedupeFindings, type MergedFinding } from "./dedupe.ts";
import type { Reviewer, ReviewerOutcome } from "./finding.ts";
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
  /** 去重合并后的 Finding。 */
  findings: readonly MergedFinding[];
  /** 每个 Reviewer 的执行结果,含失败原因、异常条目与被拒的工具调用数。 */
  outcomes: readonly ReviewerOutcome[];
  /** 全部 Reviewer 都失败。此时不发布 review——零 Finding 不代表代码没问题。 */
  failed: boolean;
  /** 发布为行级评论的 Finding 条数。 */
  inlineCount: number;
  /** 行号落不到 diff 内、退化为 PR 级评论的 Finding 条数。 */
  fallbackCount: number;
};

function findingBody(finding: MergedFinding): string {
  const lines = [
    `**[${finding.severity} · ${finding.category}]** ${finding.description}`,
    "",
    `— ${finding.models.join(", ")}`,
  ];

  // 多个模型对同一处的表述常常不同,只留一条会丢掉另一个模型看到的角度。
  const others = finding.sources.filter((s) => s.description !== finding.description);
  if (others.length > 0) {
    lines.push(
      "",
      "<details><summary>其他模型的表述</summary>",
      "",
      ...others.map((s) => `- ${s.model}: ${s.description}`),
      "",
      "</details>",
    );
  }

  return lines.join("\n");
}

function reviewBody(
  fallbacks: readonly MergedFinding[],
  absent: readonly ReviewerOutcome[],
): string {
  const sections: string[] = ["MultiReviewer"];

  if (absent.length > 0) {
    sections.push(
      "",
      "以下模型本次缺席,审查覆盖面因此打了折扣:",
      "",
      ...absent.map((o) => `- ${o.model}:${o.failure}`),
    );
  }

  if (fallbacks.length > 0) {
    sections.push(
      "",
      "以下 Finding 的行号落在本次 Review Range 的 diff 之外,无法作为行级评论呈现:",
      "",
      ...fallbacks.map(
        (f) =>
          `- \`${f.file}:${f.line}\` **[${f.severity} · ${f.category}]** ${f.description} — ${f.models.join(", ")}`,
      ),
    );
  }

  return sections.join("\n");
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

  const outcomes = await Promise.all(
    deps.reviewers.map((reviewer) => reviewer.review(range, worktree.path)),
  );

  const absent = outcomes.filter((outcome) => outcome.failure !== undefined);
  // 全部失败时零 Finding 不代表代码没问题,发一条空 review 会把失败读成通过。
  const failed = outcomes.length > 0 && absent.length === outcomes.length;

  const findings = dedupeFindings(
    outcomes.filter((o) => o.failure === undefined).flatMap((o) => o.findings),
  );

  const diffRanges = parseDiffRanges(
    await readRangeDiff(worktree.path, worktree.mergeBaseSha, pullRequest.headSha),
  );

  const comments: ReviewCommentDraft[] = [];
  const fallbacks: MergedFinding[] = [];
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

  // 有缺席模型时即便零 Finding 也要发:读者需要知道这次审查覆盖面打了折扣。
  if (!failed && (findings.length > 0 || absent.length > 0)) {
    await forge.createReview(event, {
      body: reviewBody(fallbacks, absent),
      commitSha: pullRequest.headSha,
      comments,
    });
  }

  return {
    headSha: pullRequest.headSha,
    findings,
    outcomes,
    failed,
    inlineCount: comments.length,
    fallbackCount: fallbacks.length,
  };
}
