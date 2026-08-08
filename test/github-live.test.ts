/**
 * 对真实 pull request 验证 GitHub 的 Forge 实现。
 *
 * 默认跳过。它会在指定的 PR 上真实发布评论并改动 resolve 状态,只应指向一个专用的验证 PR。
 *
 *   MULTIREVIEWER_LIVE_PR=owner/repo#123 GITHUB_TOKEN=$(gh auth token) pnpm test
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createGitHubForge } from "../src/forge/github.ts";
import { prepareWorktree, readRangeDiff } from "../src/git/worktree.ts";
import { parseDiffRanges } from "../src/review/position.ts";
import { runReview } from "../src/review/run.ts";
import { scriptedReviewer } from "./support/memory-forge.ts";

const target = process.env["MULTIREVIEWER_LIVE_PR"];
const token = process.env["GITHUB_TOKEN"];
const skip =
  target === undefined || token === undefined
    ? "设置 MULTIREVIEWER_LIVE_PR=owner/repo#123 与 GITHUB_TOKEN 后运行"
    : false;

const MARKER = "multireviewer live check";

function parseTarget(value: string) {
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(value);
  if (match === null) throw new Error(`MULTIREVIEWER_LIVE_PR 应形如 owner/repo#123,收到 ${value}`);
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

test("GitHub 实现对真实 pull request 完成整条发布与处置链路", { skip }, async () => {
  const ref = parseTarget(target!);
  const forge = createGitHubForge({ auth: { kind: "token", token: token! } });
  const cacheDir = mkdtempSync(join(tmpdir(), "multireviewer-live-"));
  cleanups.push(() => rmSync(cacheDir, { recursive: true, force: true }));

  const pullRequest = await forge.getPullRequest(ref);
  assert.match(pullRequest.headSha, /^[0-9a-f]{40}$/);
  assert.match(pullRequest.baseSha, /^[0-9a-f]{40}$/);

  const changedFiles = await forge.listChangedFiles(ref);
  assert.ok(changedFiles.length > 0, "验证用的 PR 必须至少有一个变更文件");

  // 从工作副本算出一个确实落在 diff 内的位置,使行级评论走真实路径。
  const worktree = await prepareWorktree({
    cacheDir,
    ref,
    cloneUrl: pullRequest.cloneUrl,
    credentials: await forge.cloneCredentials(ref),
    headSha: pullRequest.headSha,
    baseSha: pullRequest.baseSha,
  });
  const ranges = parseDiffRanges(
    await readRangeDiff(worktree.path, worktree.mergeBaseSha, pullRequest.headSha),
  );
  const [file, fileRanges] = [...ranges].find(([, r]) => r.length > 0) ?? [];
  assert.ok(file !== undefined && fileRanges !== undefined, "PR 的 diff 中没有可评论的位置");

  const line = fileRanges[0]!.start;
  const reviewer = scriptedReviewer("live-check", [
    {
      file,
      line,
      severity: "P2",
      category: "maintainability",
      description: MARKER,
    },
  ]);

  const result = await runReview(ref, {
    forge,
    reviewers: [reviewer],
    cacheDir,
    dbPath: join(cacheDir, "multireviewer.db"),
  });
  assert.equal(result.inlineCount, 1);
  assert.equal(result.fallbackCount, 0);

  const posted = (await forge.listReviewComments(ref)).filter((c) =>
    c.body.includes(MARKER),
  );
  assert.ok(posted.length > 0, "刚发布的行级评论没有被读回");

  const thread = posted.at(-1)!;
  assert.equal(thread.path, file);
  assert.equal(thread.line, line);
  assert.equal(thread.resolved, false);

  await forge.resolveComment(ref, thread.id);
  const afterResolve = (await forge.listReviewComments(ref)).find((c) => c.id === thread.id);
  assert.equal(afterResolve?.resolved, true);

  await forge.unresolveComment(ref, thread.id);
  const afterUnresolve = (await forge.listReviewComments(ref)).find((c) => c.id === thread.id);
  assert.equal(afterUnresolve?.resolved, false);
});
