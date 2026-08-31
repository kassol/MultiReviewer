/**
 * 行级评论的位置必须落在 diff 内,否则 Forge 会拒绝或把评论挂到看不见的地方。
 * 判定依据是 unified diff 中每个 hunk 在新文件一侧覆盖的行区间,包含上下文行。
 */

export type LineRange = { start: number; end: number };

/**
 * 每个文件在新文件一侧的可评论行区间,按仓库相对路径索引。
 *
 * 用普通对象而非 Map:它要随 Reviewer 请求跨进程传给子进程做锚定校验(issue #224),
 * 而 IPC 走的是 JSON 序列化,Map 到那头会变成一个空对象。
 */
export type DiffRanges = Readonly<Record<string, readonly LineRange[]>>;

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * git 在路径含引号或控制字符时会把 `+++` 行的路径整体加引号并转义。
 * 转义是 C 风格的,与 JSON 只在常见情形下重合(八进制转义就不重合),
 * 解不开时退回原样,让该文件的 Finding 退化为 PR 级评论而非中断整次 Review Run。
 */
function unquotePath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw;
  }
}

export function parseDiffRanges(diff: string): DiffRanges {
  // 先收在 Map 里:路径由 diff 给出,`ranges["__proto__"] = …` 这样的赋值在普通对象上
  // 改的是原型而不是自己的成员,那个文件的区间会静默丢掉。
  const ranges = new Map<string, LineRange[]>();
  let current: LineRange[] | undefined;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      current = undefined;
      continue;
    }
    // 文件头只出现在 `diff --git` 与第一个 hunk 之间。进了 hunk 之后,`+++ ` 开头的
    // 行是新增的正文——新增一行以 `++ ` 起头的代码就长这样,把它读成文件头会让此后
    // 整个文件的改动都记到一个不存在的路径上。
    if (line.startsWith("@@ ")) inHunk = true;

    if (!inHunk && line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        // 文件被删除,新侧没有可评论的位置。
        current = undefined;
        continue;
      }
      const path = unquotePath(target).replace(/^b\//, "");
      current = [];
      ranges.set(path, current);
      continue;
    }

    if (current === undefined) continue;

    const hunk = HUNK_HEADER.exec(line);
    if (hunk === null) continue;

    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue; // 纯删除的 hunk 在新侧不占行。
    current.push({ start, end: start + count - 1 });
  }

  return Object.fromEntries(ranges);
}

export function isInDiff(
  ranges: DiffRanges,
  file: string,
  line: number,
): boolean {
  // 经 IPC 传过来的那一份是 JSON.parse 出的普通对象,直接下标会读到原型上的成员。
  if (!Object.hasOwn(ranges, file)) return false;
  return ranges[file]!.some((r) => line >= r.start && line <= r.end);
}

/**
 * 每个文件的改动行数,增与删各计一行。分批与规模统计都按它衡量,它比文件数更贴近
 * 真实的 token 成本。
 *
 * 文件的分界与 `parseDiffRanges` 一致,取 `+++` 行;文件被删除时新侧是 `/dev/null`,
 * 规模记在 `---` 行给出的旧路径上。二进制文件与纯重命名在 diff 里没有改动行,不出现。
 */
export function changedLinesByFile(diff: string): Map<string, number> {
  const counts = new Map<string, number>();
  let path: string | undefined;
  let removedPath: string | undefined;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      path = undefined;
      removedPath = undefined;
      continue;
    }
    // 与 `parseDiffRanges` 同一道守卫:进了 hunk 之后 `--- ` 与 `+++ ` 开头的行是正文,
    // 删掉一行 SQL 注释就长成 `--- `,把它读成文件头会漏计甚至错记整个文件。
    if (line.startsWith("@@ ")) inHunk = true;

    if (!inHunk && line.startsWith("--- ")) {
      const source = line.slice(4).trim();
      removedPath =
        source === "/dev/null" ? undefined : unquotePath(source).replace(/^a\//, "");
      continue;
    }

    if (!inHunk && line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      path =
        target === "/dev/null" ? removedPath : unquotePath(target).replace(/^b\//, "");
      continue;
    }

    if (path === undefined) continue;
    if (line.startsWith("+") || line.startsWith("-")) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }

  return counts;
}
