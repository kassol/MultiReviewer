import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Badge, Select, Skeleton, Text } from "@radix-ui/themes";

import { Button } from "@/components/theme-button";
import { localMinute } from "@/lib/time";

import { fetchJson } from "./api.ts";

type Branch = { name: string; isDefault: boolean };

type RepoCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authoredAt: string;
};

type CommitsPage = { commits: RepoCommit[]; nextOffset: number | null };

/** 选择器里两端的角色。词按 CONTEXT.md:阶段基准是 base,当前被审的是比较项。 */
export type CommitRole = "base" | "comparison";

const ROLE_LABEL: Record<CommitRole, string> = { base: "base", comparison: "比较项" };

/**
 * commit 选择器(issue #178):分支下拉加这条分支的提交列表,点行上的按钮把那个 commit
 * 设成 base 或比较项。人不再手输 sha——没人记得住 sha,只记得分支与提交信息。
 *
 * 数据来自服务端本地 clone(`GET /repo-branches` / `GET /repo-commits`),与 Reviewer 读的
 * 是同一份;列分支那一步在服务端先 fetch,刚推上去的 commit 因此立刻选得到。
 *
 * 两端各自记的是 sha,分支只是找它的路径:选完 base 换一条分支再选比较项,已选的 base
 * 不受影响(user story 33)。`baseLocked` 是推进比较项那一档(issue #179):base 由调用方
 * 定死,列表里只出现「设为比较项」。
 */
export function CommitPicker({
  repo,
  base,
  comparison,
  baseLocked = false,
  onPick,
}: {
  repo: { owner: string; repo: string };
  base: string | null;
  comparison: string | null;
  baseLocked?: boolean;
  onPick: (role: CommitRole, sha: string) => void;
}) {
  const scope = `owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.repo)}`;
  const branches = useQuery({
    queryKey: ["repo-branches", repo.owner, repo.repo],
    queryFn: () => fetchJson<{ branches: Branch[] }>(`/repo-branches?${scope}`),
  });

  // 没选过就是仓库默认分支(user story 25);人选过之后以人选的为准。
  const [picked, setPicked] = useState<string | null>(null);
  const rows = branches.data?.branches ?? [];
  const branch =
    picked ?? rows.find((row) => row.isDefault)?.name ?? rows[0]?.name ?? null;

  const commits = useInfiniteQuery({
    queryKey: ["repo-commits", repo.owner, repo.repo, branch],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      fetchJson<CommitsPage>(
        `/repo-commits?${scope}&branch=${encodeURIComponent(branch!)}&offset=${pageParam}`,
      ),
    getNextPageParam: (last) => last.nextOffset,
    enabled: branch !== null,
  });
  const flat = commits.data?.pages.flatMap((page) => page.commits) ?? [];

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1.5">
        <Text as="span" size="2" weight="medium">分支</Text>
        <Select.Root
          value={branch ?? ""}
          onValueChange={setPicked}
          disabled={rows.length === 0}
          size={{ initial: "3", sm: "2" }}
        >
          <Select.Trigger placeholder="读取分支中…" aria-label="分支" />
          <Select.Content>
            {rows.map((row) => (
              <Select.Item key={row.name} value={row.name}>
                {row.name}
                {row.isDefault ? "（默认分支）" : ""}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </label>

      {branches.isError ? (
        <p role="alert" className="text-danger">{(branches.error as Error).message}</p>
      ) : null}

      <div
        className="flex max-h-72 flex-col overflow-x-hidden overflow-y-auto rounded-lg border border-overlay-line"
        aria-busy={commits.isPending || commits.isFetchingNextPage}
        aria-label="提交列表"
      >
        {commits.isPending ? (
          <div className="flex flex-col gap-2 p-2" role="status" aria-live="polite">
            <span className="sr-only">正在加载提交</span>
            {[0, 1, 2].map((slot) => <Skeleton key={slot} className="h-12" />)}
          </div>
        ) : null}

        {commits.isError ? (
          <p role="alert" className="px-4 py-3 text-danger">
            {(commits.error as Error).message}
          </p>
        ) : null}

        {flat.map((commit) => (
          <CommitRow
            key={commit.sha}
            commit={commit}
            roles={
              // 已经选成一端的 commit 不再出现同一个角色的按钮:它已经在那儿了。
              (baseLocked ? (["comparison"] as const) : (["base", "comparison"] as const)).filter(
                (role) => (role === "base" ? base : comparison) !== commit.sha,
              )
            }
            {...(base === commit.sha ? { picked: "base" as const } : {})}
            {...(comparison === commit.sha ? { picked: "comparison" as const } : {})}
            onPick={onPick}
          />
        ))}

        {commits.hasNextPage ? (
          <div className="border-t border-line p-2">
            <Button
              type="button"
              variant="soft"
              color="gray"
              size={{ initial: "3", sm: "2" }}
              className="w-full"
              disabled={commits.isFetchingNextPage}
              onClick={() => void commits.fetchNextPage()}
            >
              {commits.isFetchingNextPage ? "读取中…" : "加载更多"}
            </Button>
          </div>
        ) : null}

        {flat.length === 0 && !commits.isPending && !commits.isError ? (
          <p className="px-4 py-3 text-base text-text-muted">这条分支上没有提交。</p>
        ) : null}
      </div>
    </div>
  );
}

/** 提交列表的一行:短 sha、信息首行、作者与时间,加把它设成一端的按钮。 */
function CommitRow({
  commit,
  roles,
  picked,
  onPick,
}: {
  commit: RepoCommit;
  roles: readonly CommitRole[];
  picked?: CommitRole;
  onPick: (role: CommitRole, sha: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 border-t border-line px-4 py-[11px] first:border-t-0">
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="flex min-w-0 items-center gap-1.5">
          <code className="rounded-chip bg-accent-tint-strong px-[5px] font-mono text-xs text-primary">
            {commit.shortSha}
          </code>
          <span className="truncate text-lg">{commit.subject}</span>
          {picked === undefined ? null : (
            <Badge color="blue" variant="soft">{ROLE_LABEL[picked]}</Badge>
          )}
        </span>
        <span className="text-base text-text-muted">
          {commit.author} · <span className="tabular-nums">{localMinute(commit.authoredAt)}</span>
        </span>
      </span>
      {roles.map((role) => (
        <Button
          key={role}
          type="button"
          variant="soft"
          color="gray"
          size="1"
          className="shrink-0"
          onClick={() => onPick(role, commit.sha)}
        >
          设为 {ROLE_LABEL[role]}
        </Button>
      ))}
    </div>
  );
}
