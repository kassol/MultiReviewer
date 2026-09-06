/**
 * 恢复已有评审记录中可追溯的影响与修改建议(issue #268)的一次性操作入口。
 *
 * 默认只预览:只读打开库,算出能补什么、补不了什么,一个字都不写。加 `--apply` 才写,
 * 写之前先用 `VACUUM INTO` 留一份库的快照。范围三选一:`--repo owner/name`、`--run <id>`
 * 或 `--all`。配了 Gitea 凭据(与服务同一组环境变量)时轨迹里找不到的会去读它自己发出
 * 去的那条原评论;不配就只认轨迹与延续关系。不调用模型,不重跑,不写 Forge。
 *
 * 与 `main.ts` 一样是进程入口,随源码进镜像,在容器里跑:
 *   node src/recover-finding-content.ts --repo owner/name
 *   node src/recover-finding-content.ts --repo owner/name --apply
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { createGiteaForge } from "./forge/gitea.ts";
import {
  applyRecovery,
  assertRecoverySchema,
  planRecovery,
  type CommentSource,
  type RecoveryPlan,
  type RecoveryScope,
} from "./review/recover.ts";

const USAGE = `用法:node src/recover-finding-content.ts (--repo owner/name | --run <id> | --all) [--db <路径>] [--apply]

默认只预览、不写库。--db 不给时读 MULTIREVIEWER_DB,再不给用 multireviewer.db。
配了 MULTIREVIEWER_GITEA_URL 与 MULTIREVIEWER_GITEA_TOKEN 时会读原评论作第二来源。`;

function fail(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

function scopeFromArgs(values: { repo?: string; run?: string; all?: boolean }): RecoveryScope {
  const given = [values.repo !== undefined, values.run !== undefined, values.all === true].filter(
    Boolean,
  ).length;
  if (given !== 1) fail(`范围要且只要给一个。\n${USAGE}`, 2);
  if (values.all === true) return { kind: "all" };
  if (values.run !== undefined) {
    const runId = Number(values.run);
    if (!Number.isInteger(runId) || runId < 1) fail(`--run 要是正整数:${values.run}`, 2);
    return { kind: "run", runId };
  }
  const match = /^([^/]+)\/([^/]+)$/.exec(values.repo!);
  if (match === null) fail(`--repo 要写成 owner/name:${values.repo}`, 2);
  return { kind: "repo", owner: match[1]!, repo: match[2]! };
}

function commentSourceFromEnv(): CommentSource | undefined {
  const baseUrl = process.env["MULTIREVIEWER_GITEA_URL"];
  const token = process.env["MULTIREVIEWER_GITEA_TOKEN"];
  if (baseUrl === undefined || baseUrl === "" || token === undefined || token === "") {
    return undefined;
  }
  const forge = createGiteaForge({ baseUrl, token });
  return (ref) => forge.listReviewComments(ref);
}

const SOURCE_LABEL = { trace: "成功上报轨迹", comment: "原评论", continuation: "延续合成" } as const;

/** 预览与执行共用的报告:先总数,再逐条说来源或原因,凭据一个都不出现。 */
function render(plan: RecoveryPlan): string {
  const lines: string[] = [];
  const bySource = { trace: 0, comment: 0, continuation: 0 };
  for (const fill of plan.fills) bySource[fill.source] += 1;
  lines.push(`范围内轮次 ${plan.runs} 个,模型归属 ${plan.attributions} 条`);
  lines.push(
    `缺影响或建议的归属 ${plan.fills.length + plan.skips.length} 条:可补回 ${plan.fills.length} 条` +
      `(${SOURCE_LABEL.trace} ${bySource.trace}、${SOURCE_LABEL.comment} ${bySource.comment}、${SOURCE_LABEL.continuation} ${bySource.continuation}),跳过 ${plan.skips.length} 条`,
  );
  for (const fill of plan.fills) {
    lines.push(
      `  补回 finding ${fill.findingId} #${fill.position} ${fill.model} ${fill.file}:${fill.line}(第 ${fill.runId} 轮)← ${SOURCE_LABEL[fill.source]}(${fill.evidence})`,
    );
  }
  for (const skip of plan.skips) {
    lines.push(
      `  跳过 finding ${skip.findingId} #${skip.position} ${skip.model} ${skip.file}:${skip.line}(第 ${skip.runId} 轮):${skip.reason}`,
    );
  }
  const inserted = plan.carriedInserts.reduce((n, insert) => n + insert.rows.length, 0);
  lines.push(
    `延续承接的历史说法:${plan.carriedInserts.length} 条 Finding 补进 ${inserted} 段,已有的补齐 ${plan.carriedFills.length} 段,跳过 ${plan.carriedSkips.length} 段`,
  );
  for (const insert of plan.carriedInserts) {
    lines.push(
      `  finding ${insert.findingId}(第 ${insert.runId} 轮)← 抄自 finding ${insert.predecessorId}:${insert.rows
        .map((row) => `${row.model}@第 ${row.runId} 轮`)
        .join("、")}`,
    );
  }
  for (const fill of plan.carriedFills) {
    lines.push(`  补齐 finding ${fill.findingId} 第 ${fill.position} 段 ← 上一处 finding ${fill.predecessorId}`);
  }
  for (const skip of plan.carriedSkips) {
    lines.push(
      `  跳过 finding ${skip.findingId} 第 ${skip.position} 段 ${skip.model}@第 ${skip.runId} 轮:${skip.reason}`,
    );
  }
  lines.push(`历史说法整份恢复不了的 Finding ${plan.carriedUnrecoverable.length} 条`);
  for (const entry of plan.carriedUnrecoverable) {
    lines.push(`  finding ${entry.findingId}(第 ${entry.runId} 轮):${entry.reason}`);
  }
  return lines.join("\n");
}

function backupPath(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const path = `${dbPath}.bak-${stamp}`;
  if (existsSync(path)) fail(`备份文件已存在:${path}`, 1);
  return path;
}

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    repo: { type: "string" },
    run: { type: "string" },
    all: { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const scope = scopeFromArgs(values);
const dbPath = values.db ?? process.env["MULTIREVIEWER_DB"] ?? "multireviewer.db";
if (!existsSync(dbPath)) fail(`数据库不存在:${dbPath}`, 1);

// 预览只读打开:没有任何写入,也不会触发建表补列。
const db = new DatabaseSync(dbPath, { readOnly: !values.apply });
try {
  db.exec("PRAGMA busy_timeout = 5000");
  assertRecoverySchema(db);
  const comments = commentSourceFromEnv();
  const plan = await planRecovery(db, scope, comments);
  console.log(render(plan));
  if (comments === undefined) console.log("没配 Gitea 凭据,本次没有读原评论。");
  if (!values.apply) {
    console.log("预览模式,未写库。要执行就加 --apply。");
  } else if (plan.fills.length + plan.carriedInserts.length + plan.carriedFills.length === 0) {
    console.log("没有可写的内容,未改库。");
  } else {
    const backup = backupPath(dbPath);
    db.prepare("VACUUM INTO ?").run(backup);
    console.log(`已备份到 ${backup}`);
    applyRecovery(db, plan);
    console.log(
      `已写入:补回归属 ${plan.fills.length} 条,历史说法新增 ${plan.carriedInserts.reduce((n, insert) => n + insert.rows.length, 0)} 段、补齐 ${plan.carriedFills.length} 段。`,
    );
  }
} finally {
  db.close();
}
