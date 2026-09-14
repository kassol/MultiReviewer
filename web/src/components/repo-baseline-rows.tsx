/**
 * 按仓库选基点的行组(issue #352)。建会话与重梳两处共用这一份:两处读的都是一个产品的全部
 * 仓库,选法一字不差,各写一份迟早在其中一处漏掉「预选生效的默认分支」或「只提交动过的行」。
 */
import { CommitIcon, Cross2Icon } from "@radix-ui/react-icons";
import { Badge, Dialog, IconButton, Skeleton, Text } from "@radix-ui/themes";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { CommitChip } from "@/components/commit-chip";
import { Button } from "@/components/theme-button";

import { fetchJson } from "../api.ts";
import { CommitPicker, type CommitSelection } from "../commit-picker.tsx";

/** 一个仓库的坐标。行组只认这一格,产品的仓库清单与仓库页各自的多余字段不进来。 */
export type BaselineRepo = { owner: string; repo: string };

/** 建会话与重梳接口收的那一行基点(issue #352)。`branch` 是他选它时浏览的那条分支或那个 Tag 的名字。 */
export type SessionBaseline = { owner: string; repo: string; sha: string; branch?: string };

/** 一个仓库在行组里的键。调用方按它存人选过的那几行。 */
export function baselineRepoKey(repo: BaselineRepo): string {
  return `${repo.owner}/${repo.repo}`;
}

type BranchPage = { branches: { name: string; isDefault: boolean }[] };
type CommitPage = { commits: { sha: string }[] };

/**
 * 这个仓库生效的默认分支当前 head:分支列表里标了 `isDefault` 的那一条(服务端标的就是生效
 * 的那一条,issue #350),再取它的第一条提交。查询键与 commit 选择器同一份,弹窗打开时不必
 * 再同步一次远端。
 */
function useDefaultBranchHead(owner: string, repo: string): {
  branch: string | null;
  sha: string | null;
  loading: boolean;
  failed: boolean;
} {
  const branches = useQuery({
    queryKey: ["repo-picker-sync", owner, repo, 0],
    queryFn: () => fetchJson<BranchPage>(
      `/repo-branches?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&refresh=1`,
    ),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const branch = branches.data?.branches.find((one) => one.isDefault)?.name
    ?? branches.data?.branches[0]?.name
    ?? null;
  const head = useQuery({
    queryKey: ["repo-default-head", owner, repo, branch],
    queryFn: () => fetchJson<CommitPage>(
      `/repo-commits?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`
      + `&branch=${encodeURIComponent(branch ?? "")}&offset=0&limit=1`,
    ),
    enabled: branch !== null,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return {
    branch,
    sha: head.data?.commits[0]?.sha ?? null,
    loading: branches.isPending || (branch !== null && head.isPending),
    failed: branches.isError || head.isError || (branches.isSuccess && branch === null),
  };
}

/** 一行:仓库名、这一行此刻停在哪个 commit,以及开选择器的入口。 */
function BaselineRow({
  repo,
  picked,
  pickerLabel,
  onPick,
}: {
  repo: BaselineRepo;
  picked: CommitSelection | undefined;
  pickerLabel: string;
  onPick: (selection: CommitSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const fallback = useDefaultBranchHead(repo.owner, repo.repo);
  const sha = picked?.sha ?? fallback.sha;
  const source = picked === undefined ? fallback.branch : picked.source?.name ?? null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-line py-2 first:border-t-0">
      <div className="flex min-w-0 flex-col">
        <Text as="span" size="2" weight="medium" className="break-all">
          {repo.owner}/{repo.repo}
        </Text>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {fallback.loading && picked === undefined ? <Skeleton className="h-4 w-40" /> : null}
          {sha === null && !fallback.loading ? (
            <Text as="span" size="1" color="gray">
              {fallback.failed ? "读不到默认分支,开选择器自己选一个提交" : "跟随生效的默认分支"}
            </Text>
          ) : null}
          {sha === null ? null : <CommitChip sha={sha} />}
          {source === null ? null : <Badge color="gray" variant="soft">{source}</Badge>}
          {picked === undefined && sha !== null ? (
            <Text as="span" size="1" color="gray">生效的默认分支</Text>
          ) : null}
        </span>
      </div>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger>
          <Button type="button" variant="outline" color="gray" size={{ initial: "3", sm: "2" }}>
            <CommitIcon aria-hidden />
            选提交
          </Button>
        </Dialog.Trigger>
        {/* 关着的时候整块不挂:选择器的筛选与已加载页数随之重置,几个仓库的选择器也不会一起
            去读提交列表。与发起基点探索那一处同律。 */}
        {open ? (
          <Dialog.Content
            maxWidth="800px"
            size={{ initial: "2", sm: "3" }}
            className="h-[min(780px,calc(100dvh-4.5rem))] overflow-hidden p-0"
          >
            <div className="flex h-full min-h-0 flex-col">
              <div className="shrink-0 border-b border-overlay-line px-4 py-3 sm:px-5 sm:py-4">
                <Dialog.Title size="4" mb="0" className="pr-10">
                  选{pickerLabel}
                  <span className="ml-2 break-all text-md font-normal text-text-secondary">
                    {repo.owner}/{repo.repo}
                  </span>
                </Dialog.Title>
              </div>
              <div className="flex min-h-0 flex-1 px-3 py-3 sm:px-5 sm:py-4">
                <CommitPicker
                  repo={repo}
                  base={picked ?? null}
                  comparison={null}
                  singleLabel={pickerLabel}
                  onPick={(_role, selection) => {
                    onPick(selection);
                    setOpen(false);
                  }}
                />
              </div>
            </div>
            <div className="absolute top-2.5 right-2.5 sm:top-3.5 sm:right-3.5">
              <Dialog.Close>
                <IconButton variant="ghost" color="gray" size="2" aria-label="关闭">
                  <Cross2Icon />
                </IconButton>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        ) : null}
      </Dialog.Root>
    </div>
  );
}

/**
 * 一个仓库一行,预选这个仓库生效的默认分支当前 head;人只动要改的那几行,没动过的行不进
 * `picked`,调用方因此只提交动过的那几行——服务端对缺的仓库回落到生效的默认分支,两侧说的是
 * 同一件事。
 */
export function RepoBaselineRows({
  repos,
  picked,
  onPick,
  pickerLabel = "基点",
}: {
  repos: readonly BaselineRepo[];
  /** 人动过的那几行,键是 `baselineRepoKey(repo)`。 */
  picked: Readonly<Record<string, CommitSelection>>;
  onPick: (repo: BaselineRepo, selection: CommitSelection) => void;
  /** 选择器里这一侧的名字,缺省「基点」。 */
  pickerLabel?: string;
}) {
  return (
    <div className="flex flex-col">
      {repos.map((repo) => (
        <BaselineRow
          key={baselineRepoKey(repo)}
          repo={repo}
          picked={picked[baselineRepoKey(repo)]}
          pickerLabel={pickerLabel}
          onPick={(selection) => onPick(repo, selection)}
        />
      ))}
    </div>
  );
}

/**
 * 行组里人动过的那几行,换成建会话与重梳接口收的那一份(issue #352)。`branch` 记他选它时
 * 浏览的来源名——分支名或 Tag 名——会话头部说的就是这个来源;直接给 sha 没有来源的那一行
 * 不带,服务端按生效的默认分支记。
 */
export function pickedBaselines(
  picked: Readonly<Record<string, CommitSelection>>,
): SessionBaseline[] {
  return Object.entries(picked).map(([key, selection]) => {
    const [owner = "", repo = ""] = key.split("/");
    return {
      owner,
      repo,
      sha: selection.sha,
      ...(selection.source === undefined ? {} : { branch: selection.source.name }),
    };
  });
}
