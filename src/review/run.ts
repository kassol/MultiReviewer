import type {
  ExistingReviewComment,
  Forge,
  PullRequestRef,
  ReviewCommentDraft,
} from "../forge/forge.ts";
import { prepareWorktree, readRangeDiff } from "../git/worktree.ts";
import {
  DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
  mergeBatchOutcomes,
  splitIntoBatches,
  type TimedOutcome,
} from "./batch.ts";
import { dedupeFindings, type MergedFinding } from "./dedupe.ts";
import type { Disposition, Reviewer, ReviewerOutcome } from "./finding.ts";
import {
  contentFingerprint,
  fingerprintAnchor,
  parseFingerprintAnchor,
} from "./fingerprint.ts";
import { changedLinesByFile, isInDiff, parseDiffRanges } from "./position.ts";
import { openStore, type FindingRecord, type OutcomeRecord } from "./store.ts";

export type PullRequestEvent = PullRequestRef;

export type ReviewRunDeps = {
  forge: Forge;
  reviewers: readonly Reviewer[];
  /** 工作副本的缓存根目录,按仓库分子目录。 */
  cacheDir: string;
  /** SQLite 数据库文件的位置。 */
  dbPath: string;
  /** 一批最多多少改动行。不传取 `DEFAULT_MAX_CHANGED_LINES_PER_BATCH`。 */
  maxChangedLinesPerBatch?: number;
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

/** 上一轮已提出、本轮匹配上的 Finding。它不再发行级评论,折进 review 正文。 */
type CarriedFinding = {
  finding: MergedFinding;
  /** 上一轮那条评论是否已被 resolve。 */
  resolved: boolean;
};

function findingBody(finding: MergedFinding, fingerprint: string | undefined): string {
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

  // 锚点是下一轮认出这条评论的唯一凭据,指纹算不出时就没有跨轮次匹配可言。
  if (fingerprint !== undefined) lines.push("", fingerprintAnchor(fingerprint));

  return lines.join("\n");
}

/** 折叠段里的一条。误匹配时人展开就能看到完整内容,不是只给个条数。 */
function findingLine(finding: MergedFinding): string {
  return `- \`${finding.file}:${finding.line}\` **[${finding.severity} · ${finding.category}]** ${finding.description} — ${finding.models.join(", ")}`;
}

function collapsedSection(summary: string, findings: readonly MergedFinding[]): string[] {
  return [
    "",
    `<details><summary>${summary}</summary>`,
    "",
    ...findings.map(findingLine),
    "",
    "</details>",
  ];
}

/**
 * Reaction 表达的是审查进度,是装饰。发不出去时忍下来——PR 上少一个 emoji 是小事,
 * 一次审查因此白跑不是。缺 `write:issue` 的 bot 令牌走的就是这条路。
 */
async function tryReaction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(
      "[review] reaction 更新失败,审查照常:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function reviewBody(
  fallbacks: readonly MergedFinding[],
  absent: readonly ReviewerOutcome[],
  partial: readonly ReviewerOutcome[],
  carried: readonly CarriedFinding[],
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

  // 与缺席分开呈现:这些模型的 Finding 照常发布了,只是没审完全部文件。
  if (partial.length > 0) {
    sections.push(
      "",
      "以下模型本次覆盖不全,只有部分批次的文件被审查:",
      "",
      ...partial.map((o) => {
        const coverage = o.incompleteCoverage!;
        const failures = coverage.failures
          .map((f) => `第 ${f.batchIndex} 批失败(${f.failure})`)
          .join(";");
        return `- ${o.model}:共 ${coverage.batchCount} 批,${failures}`;
      }),
    );
  }

  if (fallbacks.length > 0) {
    sections.push(
      "",
      "以下 Finding 的行号落在本次 Review Range 的 diff 之外,无法作为行级评论呈现:",
      "",
      ...fallbacks.map(findingLine),
    );
  }

  // 旧评论还挂在 PR 上,再发一模一样的一条就是重复打扰,因此两种匹配成功的情形都折叠。
  const resolved = carried.filter((c) => c.resolved).map((c) => c.finding);
  if (resolved.length > 0) {
    sections.push(
      ...collapsedSection(
        `曾被处置、代码未变的 Finding(${resolved.length} 条)`,
        resolved,
      ),
    );
  }

  const unresolved = carried.filter((c) => !c.resolved).map((c) => c.finding);
  if (unresolved.length > 0) {
    sections.push(
      ...collapsedSection(
        `已在上一轮提出,尚未处置的 Finding(${unresolved.length} 条)`,
        unresolved,
      ),
    );
  }

  return sections.join("\n");
}

/**
 * 上一轮由本工具发出的行级评论,按 `文件 + 指纹` 索引到它的 resolve 状态。
 *
 * 只认带锚点的评论:带锚点的是 bot 发的,人写的评论不参与匹配。指纹与文件一起做键,
 * 单看指纹会让不同文件里同样的 7 行代码互相误匹配。
 */
function priorDispositions(
  comments: readonly ExistingReviewComment[],
): Map<string, boolean> {
  const byKey = new Map<string, boolean>();
  for (const comment of comments) {
    const fingerprint = parseFingerprintAnchor(comment.body);
    if (fingerprint === undefined) continue;
    const key = `${comment.path}\n${fingerprint}`;
    // 同一处若有多条历史评论,任一条被 resolve 即视为已处置。
    byKey.set(key, (byKey.get(key) ?? false) || comment.resolved);
  }
  return byKey;
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

  // 挂上「正在审查」。同一个 PR 推了新 commit 会再跑一次,上一轮的结论先作废——
  // 否则新代码还没看,PR 上却还挂着上一版的通过标记。
  await tryReaction(() => forge.removeReaction(event, "+1"));
  await tryReaction(() => forge.addReaction(event, "eyes"));

  const [changedFiles, credentials, priorComments] = await Promise.all([
    forge.listChangedFiles(event),
    forge.cloneCredentials(event),
    forge.listReviewComments(event),
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

  // diff 在 Reviewer 之前读:Review Range 的规模要在开跑之前落库,分批也按它切。
  const diff = await readRangeDiff(
    worktree.path,
    worktree.mergeBaseSha,
    pullRequest.headSha,
  );
  const changedLines = changedLinesByFile(diff);
  const batches = splitIntoBatches(
    range.files,
    changedLines,
    deps.maxChangedLinesPerBatch ?? DEFAULT_MAX_CHANGED_LINES_PER_BATCH,
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
    changedLines: [...changedLines.values()].reduce((sum, n) => sum + n, 0),
    batchCount: batches.length,
  });

  try {
    // 批次串行,批内 Reviewer 并行:并行跑批会同时开「批数 × 模型数」个子进程。
    const perBatch: TimedOutcome[][] = [];
    for (const files of batches) {
      perBatch.push(
        await Promise.all(
          deps.reviewers.map(async (reviewer) => {
            const begin = Date.now();
            // 工作副本每批都是同一份完整的 head commit:Reviewer 要能读到其他批次
            // 改动后的代码,否则会报出"这个新函数没有调用者"这类因分批而来的误报。
            const outcome = await reviewer.review({ ...range, files }, worktree.path);
            return { outcome, durationMs: Date.now() - begin };
          }),
        ),
      );
    }
    // 汇总在全部批次跑完之后做一次:一次 Review Run 只发一次 review。
    const timed = deps.reviewers.map((_, index) =>
      mergeBatchOutcomes(perBatch.map((batch) => batch[index]!)),
    );
    const outcomes = timed.map((t) => t.outcome);

    const absent = outcomes.filter((outcome) => outcome.failure !== undefined);
    const partial = outcomes.filter((o) => o.incompleteCoverage !== undefined);
    // 全部失败时零 Finding 不代表代码没问题,发一条空 review 会把失败读成通过。
    const failed = outcomes.length > 0 && absent.length === outcomes.length;

    const findings = dedupeFindings(
      outcomes.filter((o) => o.failure === undefined).flatMap((o) => o.findings),
    );

    const diffRanges = parseDiffRanges(diff);
    const prior = priorDispositions(priorComments);

    const comments: ReviewCommentDraft[] = [];
    const fallbacks: MergedFinding[] = [];
    const carried: CarriedFinding[] = [];
    // 按合并组下标记住处置结论,落库时组内每条来源都取它。
    const dispositions: Disposition[] = [];

    for (const finding of findings) {
      // 指纹在新 head commit 的工作副本下重算:代码没变则与上一轮的锚点相同。
      const fingerprint = contentFingerprint(worktree.path, finding.file, finding.line);
      const resolved =
        fingerprint === undefined
          ? undefined
          : prior.get(`${finding.file}\n${fingerprint}`);

      if (resolved !== undefined) {
        carried.push({ finding, resolved });
        dispositions.push(resolved ? "resolved" : "unresolved");
        continue;
      }

      dispositions.push("unknown");
      if (isInDiff(diffRanges, finding.file, finding.line)) {
        comments.push({
          path: finding.file,
          line: finding.line,
          body: findingBody(finding, fingerprint),
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
          disposition: dispositions[groupIndex]!,
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

    // 有缺席或覆盖不全的模型时即便零 Finding 也要发:读者需要知道这次审查覆盖面
    // 打了折扣。
    const hasSomethingToSay =
      findings.length > 0 || absent.length > 0 || partial.length > 0;
    if (!failed && hasSomethingToSay) {
      await forge.createReview(event, {
        body: reviewBody(fallbacks, absent, partial, carried),
        commitSha: pullRequest.headSha,
        comments,
      });
    }

    // 跑成功却什么都没发现时,这次审查在 PR 上本来一点痕迹都不会留,与「审查根本
    // 没跑」无从区分。这个赞就是那条痕迹。
    if (!failed && !hasSomethingToSay) {
      await tryReaction(() => forge.addReaction(event, "+1"));
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
    // 「正在审查」一定要撤掉:成功、失败、中途抛异常都要。留着它 PR 上会永远挂着
    // 一只眼睛,看起来像审查卡死了。
    await tryReaction(() => forge.removeReaction(event, "eyes"));
  }
}
