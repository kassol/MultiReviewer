/**
 * Reviewer 会话里的受控 git 工具(只读)。
 *
 * Reviewer 只读 head 状态的工作副本,看不到被删掉的行与被删掉的文件——审查删除类缺陷
 * (删掉的判空、锁、校验)只能靠现状间接推断。这个工具把 diff / show / log / blame 四个
 * 只读子命令交给模型,变更内容因此直接可见。
 *
 * 安全边界靠三道闸,与 bash 的差别正在于这三道都能确定性地执行:
 *
 * - **子命令白名单**:只有四个只读子命令。fetch/push 这类网络命令挡在最前面——容器有网,
 *   共享 gitdir 的 config 里有 remote 地址。
 * - **参数默认拒绝**:flag 走白名单,白名单外一律打回。`--no-index`(读 worktree 外任意
 *   文件)、`--output`(写文件)、`--ext-diff` / `--textconv`(执行外部命令)、`-c`(注入
 *   配置)因此都不存在放行路径。位置参数只认 commit 引用与 worktree 内的相对路径。
 * - **干净环境**:子进程只继承 PATH,模型凭据(`MODEL_API_KEY_ENV`)不进它的环境;
 *   `GIT_CONFIG_NOSYSTEM` 与 `GIT_CONFIG_GLOBAL=/dev/null` 挡住宿主 config 里的
 *   alias、pager 与 diff driver。
 *
 * 工作树是 linked worktree,与缓存 clone 共享 object store,历史齐全,log/blame/show
 * 都到得了任何一个 commit。只读子命令不会写共享的 refs。
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

export const GIT_TOOL = "git";

/** 只读子命令白名单。status 不在其中:一次性工作树永远是干净的,它没有可看的东西。 */
const SUBCOMMANDS = new Set(["diff", "show", "log", "blame"]);

/**
 * flag 白名单。默认拒绝,这里只列确认无副作用的:全部只影响输出形状或匹配范围,
 * 没有一个会写文件、读 worktree 外的文件或执行外部命令。
 */
const FLAG_PATTERNS: readonly RegExp[] = [
  /^--(stat|numstat|shortstat|summary|name-only|name-status|patch|oneline|graph|reverse|follow|no-color|full-index)$/,
  /^-p$/,
  /^-w$/,
  /^-b$/,
  /^--ignore-(all-space|space-change)$/,
  /^-U\d*$/,
  /^--unified=\d+$/,
  /^-M\d*%?$/,
  /^-C\d*%?$/,
  /^--find-renames(=\d+%?)?$/,
  /^-n\d+$/,
  /^-\d+$/,
  /^--max-count=\d+$/,
  /^-S.+$/s,
  /^-G.+$/s,
  /^--(pretty|format)=.+$/s,
  /^--abbrev(=\d+)?$/,
];

/**
 * commit 引用:裸 SHA、`a..b` / `a...b` 区间,或字面 HEAD。分支名词法上与相对路径无法
 * 区分,不在这里认——它按路径的判据放行后交给 git 自己裁决 rev 还是 pathspec,读本仓库
 * 任何 ref 本来无害。这个模式只负责让明显的 ref 不被路径闸误拒。
 */
const REF_PATTERN = /^(HEAD|[0-9a-f]{7,40})(\.{2,3}(HEAD|[0-9a-f]{7,40}))?$/i;

/**
 * worktree 内的相对路径。判据是词法的,不查文件存在与否——`log -- 已删除的文件` 是
 * 这个工具存在的理由之一,被删的文件在 head 上本来就不存在。
 */
function safeRelativePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.startsWith("~")) return false;
  return !path.split("/").includes("..");
}

/** `-L<start>,<end>[:<file>]`(blame 与 log 的行区间)。带文件的那段同样要过路径闸。 */
function safeLineRange(flag: string): boolean {
  const match = /^-L\d+(,[+-]?\d+)?(?::(.+))?$/s.exec(flag);
  if (match === null) return false;
  return match[2] === undefined || safeRelativePath(match[2]);
}

/**
 * 校验一次调用的完整参数。返回打回理由,合格返回 undefined。
 *
 * 打回理由直接交给模型:它要据此改写参数重试,含糊的"invalid"只会让它乱猜。
 */
export function rejectGitArgs(args: readonly string[]): string | undefined {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || !SUBCOMMANDS.has(subcommand)) {
    return `rejected: first argument must be one of ${[...SUBCOMMANDS].join(", ")}. Network and write subcommands are not available.`;
  }
  for (const token of rest) {
    if (token === "--") continue;
    if (token.startsWith("-L")) {
      if (safeLineRange(token)) continue;
      return `rejected: ${token} — use the attached form -L<start>,<end> or -L<start>,<end>:<file> with a repository-relative file.`;
    }
    if (token.startsWith("-")) {
      if (FLAG_PATTERNS.some((pattern) => pattern.test(token))) continue;
      return `rejected: flag ${token} is not in the allowed set. Only output-shaping flags are available; flags that write files, read outside the repository or run external commands are not.`;
    }
    if (REF_PATTERN.test(token)) continue;
    const colon = /^(HEAD|[0-9a-f]{7,40}):(.+)$/is.exec(token);
    if (colon !== null) {
      if (safeRelativePath(colon[2]!)) continue;
      return `rejected: ${token} — the path after the colon must be repository-relative.`;
    }
    if (safeRelativePath(token)) continue;
    return `rejected: ${token} — paths must be repository-relative, refs must be commit SHAs (optionally as a..b ranges) or HEAD.`;
  }
  return undefined;
}

/** 输出上限。diff 一整批最多几千行,十万字符够用;刷爆的那些让模型缩小查询范围。 */
const OUTPUT_CHAR_LIMIT = 100_000;

export function truncateOutput(text: string): string {
  if (text.length <= OUTPUT_CHAR_LIMIT) return text;
  return `${text.slice(0, OUTPUT_CHAR_LIMIT)}\n[output truncated at ${OUTPUT_CHAR_LIMIT} characters — narrow the query with paths, -U0 or --stat]`;
}

/** 单次调用的墙上时限。共享 object store 上的只读命令超过它就是查询本身写错了。 */
const GIT_TIMEOUT_MS = 30_000;

/**
 * 执行一次校验过的调用。环境从零构造:PATH 之外什么都不继承,模型凭据因此不在
 * 子进程环境里;`--no-pager` 与 `GIT_PAGER=cat` 双保险,任何配置都唤不起 pager。
 */
export async function runGit(worktreePath: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--no-pager", ...args], {
    cwd: worktreePath,
    env: {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
  });
  return stdout;
}

/**
 * 跑一次受控 git,把输出整成工具回应的正文。两个 git 工具共用:失败的措辞对模型是同一件事,
 * 分两份写只会有一份带上可行动的那一句(会话那一份当初就少了 maxBuffer 触顶这一句)。
 */
async function runGitTool(cwd: string, args: readonly string[]): Promise<string> {
  try {
    return truncateOutput(await runGit(cwd, args));
  } catch (error) {
    // maxBuffer 触顶抛的是裸 Node 错误,先于 truncateOutput 的软截断。换成模型
    // 能行动的一句话,与截断提示同一口径。
    if ((error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDOUT_MAXBUFFER") {
      throw new Error(
        "output exceeded the hard limit — narrow the query with paths, -U0 or --stat",
      );
    }
    const stderr = (error as { stderr?: unknown }).stderr;
    throw new Error(
      typeof stderr === "string" && stderr.trim() !== ""
        ? stderr.trim()
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }
}

/**
 * 会话里的 git 工具。打回走正常返回而不是工具错误,与 `report_finding` 的锚定打回
 * 同一条口径:这是"请换个参数",不是"调用坏了"。git 自身的失败(坏 ref、不存在的
 * 路径)则如实抛出,stderr 里的原因模型看得懂。
 */
export function gitTool(worktreePath: string) {
  return defineTool({
    name: GIT_TOOL,
    label: "Git",
    description:
      "Read-only git against this repository. First argument is the subcommand: diff, show, log or blame. Refs are commit SHAs (ranges like <base>..<head> work) or HEAD; paths are repository-relative, after a `--` separator. Only output-shaping flags are allowed. Examples: [\"diff\", \"<base>..<head>\", \"--stat\"], [\"diff\", \"<base>..<head>\", \"--\", \"src/a.ts\"], [\"show\", \"<sha>:src/a.ts\"], [\"log\", \"--oneline\", \"<base>..<head>\"], [\"blame\", \"-L10,40\", \"HEAD\", \"--\", \"src/a.ts\"].",
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        description: "Arguments passed to git, subcommand first, one token per element.",
      }),
    }),
    execute: async (_id, { args }) => {
      const rejection = rejectGitArgs(args);
      if (rejection !== undefined) {
        return { content: [{ type: "text", text: rejection }], details: {} };
      }
      return {
        content: [{ type: "text", text: await runGitTool(worktreePath, args) }],
        details: {},
      };
    },
  });
}

/**
 * Agent 会话的会话根下,一次调用落在哪棵工作树上(issue #333)。
 *
 * 会话根下按 `<owner>/<repo>` 各挂一棵工作树,路径前缀即仓库。调用因此必须自己说清查的是
 * 哪个仓库:每个路径参数以 `<owner>/<repo>/` 开头,按前缀选那棵工作树作 cwd,前缀随后从
 * 参数里摘掉——命令认的是仓库内的相对路径。没有路径参数的调用一律拒:没有前缀就选不出
 * 工作树,而默认挑一棵等于让模型以为自己查的是另一个仓库。
 *
 * 返回选中的仓库与改写后的参数,或者一句交给模型的打回理由。白名单那三道闸仍由
 * `rejectGitArgs` 在改写之后判,一道都不少。
 */
export function repoPrefixedGitArgs(
  args: readonly string[],
  repos: readonly string[],
): { repo: string; args: string[] } | { rejection: string } {
  const allowed = new Set(repos);
  const prefixHint = `paths must start with <owner>/<repo>/, one of: ${[...allowed].join(", ")}`;
  let repo: string | undefined;
  const rewritten: string[] = [];
  let rejection: string | undefined;

  /** 一个路径参数:认出它的仓库前缀、记下选中的工作树,回仓库内的相对路径。 */
  const strip = (path: string): string | undefined => {
    // `<owner>/<repo>` 与 `<owner>/<repo>/` 指仓库根本身(整个仓库的 log / ls-tree 就这么写),
    // 摘掉前缀后是 `.`;更深的路径至少三段,中间不能有空段。
    const segments = path.endsWith("/") && path.split("/").length === 3 ? path.slice(0, -1).split("/") : path.split("/");
    if (segments.length < 2 || segments.some((segment) => segment === "")) {
      rejection = `rejected: ${path} — ${prefixHint}`;
      return undefined;
    }
    const prefix = `${segments[0]}/${segments[1]}`;
    if (!allowed.has(prefix)) {
      rejection = `rejected: ${prefix} is not a repository in this session — ${prefixHint}`;
      return undefined;
    }
    if (repo !== undefined && repo !== prefix) {
      rejection = `rejected: one call reads one repository; ${repo} and ${prefix} are two. Call the tool once per repository.`;
      return undefined;
    }
    repo = prefix;
    return segments.length === 2 ? "." : segments.slice(2).join("/");
  };

  for (const token of args) {
    if (rejection !== undefined) break;
    // 子命令、`--` 分隔符、flag 与 commit 引用原样带过去:它们不指仓库。
    if (token === "--" || REF_PATTERN.test(token)) {
      rewritten.push(token);
      continue;
    }
    const lineRange = /^(-L\d+(?:,[+-]?\d+)?):(.+)$/s.exec(token);
    if (lineRange !== null) {
      const rest = strip(lineRange[2]!);
      if (rest !== undefined) rewritten.push(`${lineRange[1]}:${rest}`);
      continue;
    }
    const colon = /^((?:HEAD|[0-9a-f]{7,40})):(.+)$/is.exec(token);
    if (colon !== null) {
      const rest = strip(colon[2]!);
      if (rest !== undefined) rewritten.push(`${colon[1]}:${rest}`);
      continue;
    }
    // 第一个参数是子命令,flag 同样不是路径。
    if (rewritten.length === 0 || token.startsWith("-")) {
      rewritten.push(token);
      continue;
    }
    const rest = strip(token);
    if (rest !== undefined) rewritten.push(rest);
  }

  if (rejection !== undefined) return { rejection };
  if (repo === undefined) {
    // 没有路径参数时选不出工作树——除非会话根下只有一个仓库,那就是它。
    if (repos.length === 1) return { repo: repos[0]!, args: rewritten };
    return {
      rejection: `rejected: name the repository you are reading — ${prefixHint}. A call without a path cannot pick one.`,
    };
  }
  return { repo, args: rewritten };
}

/**
 * Agent 会话里的受控只读工具(issue #333)。白名单、干净环境与输出上限沿用 Reviewer 那一
 * 份,唯一的差别是工作树按路径前缀选(`repoPrefixedGitArgs`)——会话根下不止一个仓库。
 */
export function sessionGitTool(sessionRoot: string, repos: readonly string[]) {
  return defineTool({
    name: GIT_TOOL,
    label: "Git",
    description:
      'Read-only git against one repository of this session. First argument is the subcommand: diff, show, log or blame. Every path argument starts with the repository prefix <owner>/<repo>/, and one call reads one repository. Refs are commit SHAs (ranges like <base>..<head> work) or HEAD. Only output-shaping flags are allowed. Examples: ["log", "--oneline", "-5", "--", "acme/widgets/src"], ["diff", "HEAD", "--", "acme/widgets/src/a.ts"], ["show", "HEAD:acme/widgets/src/a.ts"], ["blame", "-L10,40", "HEAD", "--", "acme/widgets/src/a.ts"].',
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        description: "Arguments passed to git, subcommand first, one token per element.",
      }),
    }),
    execute: async (_id, { args }) => {
      const picked = repoPrefixedGitArgs(args, repos);
      if ("rejection" in picked) {
        return { content: [{ type: "text", text: picked.rejection }], details: {} };
      }
      const rejection = rejectGitArgs(picked.args);
      if (rejection !== undefined) {
        return { content: [{ type: "text", text: rejection }], details: {} };
      }
      // 工作树在会话根下,前缀已经认过一遍,拼出来的路径圈在会话根内。
      const cwd = join(sessionRoot, ...picked.repo.split("/"));
      return { content: [{ type: "text", text: await runGitTool(cwd, picked.args) }], details: {} };
    },
  });
}
