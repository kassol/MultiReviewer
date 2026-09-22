/**
 * 按批次跑的 Review Run 夹具(issue #248、#249)。
 *
 * 续跑与排空两条用例看的是同一件事的两面——一批跑完就落库,以及停在批次边界之后续得
 * 回来,夹具因此只有一份:三个文件的仓库、内存 Forge、一批报一条 Finding 的 Reviewer 桩,
 * 加一个只读的库查询。
 */
import type {
  Finding,
  HistoryFinding,
  ReviewRange,
  Reviewer,
  ReviewerUsage,
} from "../../src/review/finding.ts";
import type { FileTree } from "./git-fixture.ts";
import { makeCacheDir, makeTestDatabase, makeRepo, withTestDb } from "./git-fixture.ts";
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

/**
 * 仓库、缓存目录、临时库与内存 Forge。清理登记进调用方的 `cleanups`。
 *
 * 省略 `tree` 即用本模块默认的三文件桩(`FILES`/`STUB`);`changedFiles` 省略即取
 * head 树里的每个路径,状态都是 modified。
 */
export async function setup(
  cleanups: (() => void | Promise<void>)[],
  options: {
    tree?: { base: FileTree; head: FileTree };
    pullNumber?: number;
    changedFiles?: { path: string; status: "modified" }[];
  } = {},
) {
  const { base, head } = options.tree ?? trees();
  const repo = makeRepo({ base, head });
  const cache = makeCacheDir();
  const db = await makeTestDatabase();
  cleanups.push(repo.cleanup, cache.cleanup, db.cleanup);
  const forge = memoryForge({
    pullRequest: {
      number: options.pullNumber ?? EVENT.number,
      title: "示例 PR",
      draft: false,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
      cloneUrl: repo.dir,
    },
    changedFiles:
      options.changedFiles ??
      Object.keys(head).map((path) => ({ path, status: "modified" as const })),
  });
  return { repo, cache, db, forge };
}

/** 绕过 Store 直连测试库跑一句 SQL。占位符是 `$1`、`$2`;写语句回空数组。 */
export async function query(
  databaseUrl: string,
  sql: string,
  ...params: unknown[]
): Promise<Record<string, unknown>[]> {
  return await withTestDb(databaseUrl, async (run) => await run(sql, ...params));
}

function findingAt(file: string, said?: { impact: string; suggestion: string }): Omit<Finding, "model"> {
  return {
    file,
    line: 4,
    severity: "P0",
    category: "bug",
    title: `${file} 有问题`,
    description: `${file} 的第一处新增行有问题`,
    impact: said?.impact ?? "",
    suggestion: said?.suggestion ?? "",
  };
}

/**
 * 一批报一条 Finding 的 Reviewer 桩。`throwOnCall` 给了就在第几次调用时抛——用它模拟
 * 服务在那一批上被重启:前面的批次已经落库,这一轮停在没有结束时间的状态。`onBatch`
 * 在每一批开跑时执行,用它模拟批次跑到一半收到停机信号。`said` 给每条 Finding 的影响
 * 与建议(issue #266),不给即两段为空。`failOnCall` 给了就在第几次调用时回一个失败的
 * 结论(不抛):跑不成与超时在注入边界上是同一个形状。
 *
 * `yieldBeforeThrow` 让抛之前先让出一次事件循环(issue #410):同一批里另一个 Reviewer
 * 的落库排在微任务里,让出之后它一定已经落完,「批内一个跑完、一个没跑完」因此是确定
 * 的状态,不靠两个 promise 的先后碰运气。
 */
export function batchReviewer(
  model: string,
  options: {
    throwOnCall?: number;
    failOnCall?: number;
    yieldBeforeThrow?: boolean;
    onBatch?: (call: number) => void;
    said?: { impact: string; suggestion: string };
  } = {},
): Reviewer & { calls: { range: ReviewRange; history: readonly HistoryFinding[] }[] } {
  const calls: { range: ReviewRange; history: readonly HistoryFinding[] }[] = [];
  return {
    model,
    calls,
    review: async ({ range, history }) => {
      calls.push({ range, history });
      options.onBatch?.(calls.length);
      if (options.throwOnCall === calls.length) {
        if (options.yieldBeforeThrow === true) await new Promise(setImmediate);
        throw new Error("进程被重启了");
      }
      const failed = options.failOnCall === calls.length;
      return {
        model,
        findings: failed
          ? []
          : range.files.map((file) => ({ ...findingAt(file, options.said), model })),
        anomalies: [],
        rejectedToolCalls: 0,
        anchorRejections: 0,
        usage: USAGE,
        verdicts: failed
          ? []
          : history.map((entry) => ({ findingId: entry.id, verdict: "present" as const })),
        ...(failed ? { failure: "这一批跑不成" } : {}),
      };
    },
  };
}
