/**
 * 按批次跑的 Review Run 夹具(issue #248、#249)。
 *
 * 续跑与排空两条用例看的是同一件事的两面——一批跑完就落库,以及停在批次边界之后续得
 * 回来,夹具因此只有一份:三个文件的仓库、内存 Forge、一批报一条 Finding 的 Reviewer 桩,
 * 加一个只读的库查询。
 */
import { DatabaseSync } from "node:sqlite";

import type {
  Finding,
  HistoryFinding,
  ReviewRange,
  Reviewer,
  ReviewerUsage,
} from "../../src/review/finding.ts";
import type { FileTree } from "./git-fixture.ts";
import { makeCacheDir, makeDbPath, makeRepo } from "./git-fixture.ts";
import { memoryForge } from "./memory-forge.ts";

export const EVENT = { owner: "acme", repo: "widgets", number: 7 };
export const FILES = ["src/a.ts", "src/b.ts", "src/c.ts"];
export const STUB = "const a = 1;\nconst b = 2;\nconst c = 3;\n";

/** 每批都回同一份用量。三批合起来的总量因此是它的三倍,续跑前后必须一致。 */
export const USAGE: ReviewerUsage = {
  inputTokens: 10,
  outputTokens: 3,
  cacheReadTokens: 1,
  cacheWriteTokens: 2,
  totalTokens: 16,
};

/** base 是三行的桩,head 追加两行,第 4 行因此是每个文件的首个新增行。 */
function trees(): { base: FileTree; head: FileTree } {
  const base: FileTree = {};
  const head: FileTree = {};
  for (const path of FILES) {
    base[path] = STUB;
    head[path] = `${STUB}const x = 0;\nconst y = 1;\n`;
  }
  return { base, head };
}

/** 仓库、缓存目录、临时库与内存 Forge。清理登记进调用方的 `cleanups`。 */
export function setup(cleanups: (() => void)[]) {
  const { base, head } = trees();
  const repo = makeRepo({ base, head });
  const cache = makeCacheDir();
  const db = makeDbPath();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);
  const forge = memoryForge({
    pullRequest: {
      number: EVENT.number,
      title: "示例 PR",
      draft: false,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      cloneUrl: repo.dir,
    },
    changedFiles: FILES.map((path) => ({ path, status: "modified" as const })),
  });
  return { repo, cache, db, forge };
}

export function query(dbPath: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all() as unknown as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function findingAt(file: string): Omit<Finding, "model"> {
  return {
    file,
    line: 4,
    severity: "P0",
    category: "bug",
    title: `${file} 有问题`,
    description: `${file} 的第一处新增行有问题`,
    impact: "",
    suggestion: "",
  };
}

/**
 * 一批报一条 Finding 的 Reviewer 桩。`throwOnCall` 给了就在第几次调用时抛——用它模拟
 * 服务在那一批上被重启:前面的批次已经落库,这一轮停在没有结束时间的状态。`onBatch`
 * 在每一批开跑时执行,用它模拟批次跑到一半收到停机信号。
 */
export function batchReviewer(
  model: string,
  options: { throwOnCall?: number; onBatch?: (call: number) => void } = {},
): Reviewer & { calls: { range: ReviewRange; history: readonly HistoryFinding[] }[] } {
  const calls: { range: ReviewRange; history: readonly HistoryFinding[] }[] = [];
  return {
    model,
    calls,
    review: async ({ range, history }) => {
      calls.push({ range, history });
      options.onBatch?.(calls.length);
      if (options.throwOnCall === calls.length) throw new Error("进程被重启了");
      return {
        model,
        findings: range.files.map((file) => ({ ...findingAt(file), model })),
        anomalies: [],
        rejectedToolCalls: 0,
        anchorRejections: 0,
        usage: USAGE,
        verdicts: history.map((entry) => ({ findingId: entry.id, verdict: "present" as const })),
      };
    },
  };
}
