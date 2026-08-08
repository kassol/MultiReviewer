import type { Forge, PullRequestRef, ReviewCommentDraft } from "../forge/forge.ts";
import { prepareWorktree, readRangeDiff } from "../git/worktree.ts";
import { dedupeFindings, type MergedFinding } from "./dedupe.ts";
import type { Reviewer, ReviewerOutcome } from "./finding.ts";
import { contentFingerprint } from "./fingerprint.ts";
import { isInDiff, parseDiffRanges } from "./position.ts";
import { openStore, type FindingRecord, type OutcomeRecord } from "./store.ts";

export type PullRequestEvent = PullRequestRef;

export type ReviewRunDeps = {
  forge: Forge;
  reviewers: readonly Reviewer[];
  /** 工作副本的缓存根目录,按仓库分子目录。 */
  cacheDir: string;
  /** SQLite 数据库文件的位置。 */
  dbPath: string;
};

/** 分批尚未实现,每次 Review Run 恒为一批。 */
const BATCH_COUNT = 1;

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

/** Review Range 的规模,用增删行数衡量。文件头的 `+++`/`---` 不算改动行。 */
function countChangedLines(diff: string): number {
  let count = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) count += 1;
  }
  return count;
}

/**
 * 一次 Review Run:解析 Review Range、准备工作副本、运行 Reviewer、发布 review 评论。
 */
export async function runReview(
  event: PullRequestEvent,
  deps: ReviewRunDeps,
): Promise<ReviewRunResult> {
  const { forge } = deps;
  const startedAt = new Date();
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

  // diff 在 Reviewer 之前读:Review Range 的规模要在开跑之前落库。
  const diff = await readRangeDiff(
    worktree.path,
    worktree.mergeBaseSha,
    pullRequest.headSha,
  );

  // 句柄的存活期覆盖整段审查(最长二十分钟),中途出错必须归还:webhook 服务是长跑
  // 进程,泄漏的连接会一次次攒下来。
  const store = openStore(deps.dbPath);
  const runId = store.startRun({
    owner: event.owner,
    repo: event.repo,
    pullNumber: event.number,
    headSha: pullRequest.headSha,
    startedAt: startedAt.toISOString(),
    changedFiles: range.files.length,
    changedLines: countChangedLines(diff),
    batchCount: BATCH_COUNT,
  });

  try {
    const timed = await Promise.all(
      deps.reviewers.map(async (reviewer) => {
        const begin = Date.now();
        const outcome = await reviewer.review(range, worktree.path);
        return { outcome, durationMs: Date.now() - begin };
      }),
    );
    const outcomes = timed.map((t) => t.outcome);

    const absent = outcomes.filter((outcome) => outcome.failure !== undefined);
    // 全部失败时零 Finding 不代表代码没问题,发一条空 review 会把失败读成通过。
    const failed = outcomes.length > 0 && absent.length === outcomes.length;

    const findings = dedupeFindings(
      outcomes.filter((o) => o.failure === undefined).flatMap((o) => o.findings),
    );

    const diffRanges = parseDiffRanges(diff);

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

    const outcomeRecords: OutcomeRecord[] = timed.map(({ outcome, durationMs }) => ({
      model: outcome.model,
      findingCount: outcome.findings.length,
      anomalyCount: outcome.anomalies.length,
      rejectedToolCalls: outcome.rejectedToolCalls,
      durationMs,
      ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
      ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
    }));

    // 落库的是每一条来源 Finding 而非合并后的那一条:采纳率要按提出它的模型统计。
    // `groupIndex` 记住它们被合并成了同一条评论。
    const findingRecords: FindingRecord[] = findings.flatMap((merged, groupIndex) =>
      merged.sources.map((source) => {
        const fingerprint = contentFingerprint(worktree.path, source.file, source.line);
        return {
          model: source.model,
          file: source.file,
          line: source.line,
          severity: source.severity,
          category: source.category,
          description: source.description,
          groupIndex,
          ...(fingerprint === undefined ? {} : { fingerprint }),
        };
      }),
    );

    // 先落库再发布:发布失败不该把这次 Review Run 的过程记录一并丢掉。
    store.finishRun(runId, {
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      failed,
      outcomes: outcomeRecords,
      findings: findingRecords,
    });

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
  } finally {
    store.close();
  }
}
