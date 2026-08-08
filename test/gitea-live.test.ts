/**
 * 对真实 pull request 验证 Gitea 的 Forge 实现。
 *
 * 默认跳过。它会在指定的 PR 上真实发布评论并改动 resolve 状态,只应指向一个专用的
 * 验证 PR。跑通它同时也确认了 bot 账号那枚 PAT 的 scope 够用——它覆盖到本实现会用
 * 到的全部端点:版本、PR 元数据、变更文件、创建 review、读回评论、resolve 与
 * unresolve、以及 clone。实测确认 `write:repository` 一个 scope 就够。
 *
 * **每次要指向一个没被本工具评论过的 PR。**同一个 PR 重跑时,上一轮留下的带锚点评论
 * 会让本轮 Finding 匹配成功而被折叠,`inlineCount` 因此是 0,断言会失败——那是跨轮次
 * 匹配在正常工作(issue #7),不是本实现出了问题。
 *
 *   MULTIREVIEWER_GITEA_URL=https://gitea.example.com \
 *   MULTIREVIEWER_GITEA_TOKEN=<bot 账号的 PAT> \
 *   MULTIREVIEWER_GITEA_LIVE_PR=owner/repo#123 \
 *   pnpm test
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { assertSupportedVersion, createGiteaForge } from "../src/forge/gitea.ts";
import { prepareWorktree, readRangeDiff } from "../src/git/worktree.ts";
import { parseDiffRanges } from "../src/review/position.ts";
import { runReview } from "../src/review/run.ts";
import { scriptedReviewer } from "./support/memory-forge.ts";

const target = process.env["MULTIREVIEWER_GITEA_LIVE_PR"];
const baseUrl = process.env["MULTIREVIEWER_GITEA_URL"];
const token = process.env["MULTIREVIEWER_GITEA_TOKEN"];
const skip =
  target === undefined || baseUrl === undefined || token === undefined
    ? "设置 MULTIREVIEWER_GITEA_URL、MULTIREVIEWER_GITEA_TOKEN 与 MULTIREVIEWER_GITEA_LIVE_PR=owner/repo#123 后运行"
    : false;

const MARKER = "multireviewer gitea live check";

function parseTarget(value: string) {
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(value);
  if (match === null) {
    throw new Error(`MULTIREVIEWER_GITEA_LIVE_PR 应形如 owner/repo#123,收到 ${value}`);
  }
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

test("Gitea 实现对真实 pull request 完成整条发布与处置链路", { skip }, async () => {
  const ref = parseTarget(target!);
  const options = { baseUrl: baseUrl!, token: token! };
  const forge = createGiteaForge(options);
  const cacheDir = mkdtempSync(join(tmpdir(), "multireviewer-gitea-live-"));
  cleanups.push(() => rmSync(cacheDir, { recursive: true, force: true }));

  // 服务启动时做的那次检查,在这里对真实实例走一遍。
  await assertSupportedVersion(options);

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
      severity: "low",
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

  // 行号读回来必须是 head commit 里的文件行号,与发出去的那个一致。
  const comment = posted.at(-1)!;
  assert.equal(comment.path, file);
  assert.equal(comment.line, line);
  assert.equal(comment.resolved, false);

  await forge.resolveComment(ref, comment.id);
  const afterResolve = (await forge.listReviewComments(ref)).find(
    (c) => c.id === comment.id,
  );
  assert.equal(afterResolve?.resolved, true);

  await forge.unresolveComment(ref, comment.id);
  const afterUnresolve = (await forge.listReviewComments(ref)).find(
    (c) => c.id === comment.id,
  );
  assert.equal(afterUnresolve?.resolved, false);
});
