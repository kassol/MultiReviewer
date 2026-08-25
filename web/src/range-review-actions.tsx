import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Cross2Icon } from "@radix-ui/react-icons";
import { AlertDialog, Dialog, Flex, IconButton } from "@radix-ui/themes";

import { Button } from "@/components/theme-button";

import { api, errorText } from "./api.ts";
import { CommitPicker } from "./commit-picker.tsx";

/** 一个范围审查。字段与 `GET <前缀>/api/range-reviews` 逐字对应。 */
export type RangeReview = {
  id: number;
  owner: string;
  repo: string;
  /** 发起时给的标题(issue #177);升级前的旧记录是 null,按 `#编号` 显示。 */
  title: string | null;
  baseSha: string;
  comparisonSha: string;
  state: "in-progress" | "completed" | "failed";
  /** 容器 PR 的序号;建出来之前是 null。 */
  containerPullNumber: number | null;
  baseBranch: string;
  headBranch: string;
  createdBy: string;
  createdAt: string;
  completedBy: string | null;
  completedAt: string | null;
  lastForgeFailure: string | null;
};

/**
 * 推进与审查完成之后要重取的两处:阶段详情与阶段汇总。首段整片失效,不逐个拼键——
 * 同一个阶段在详情页里两份查询各读一半,动作走完看到的都该是新状态。
 */
function refreshRangeReview(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["stage-detail"] });
  void queryClient.invalidateQueries({ queryKey: ["stage-summary"] });
}

/**
 * 标记审查完成(issue #158)。入口在阶段详情页的页头(issue #176)。
 *
 * 不可逆:容器 pull request 会被关掉、两条分支会被删掉,这个阶段的比较项从此不再推进,
 * 所以走 AlertDialog 二次确认,文案写明对象、影响与还剩什么。
 */
export function CompleteAction({
  rangeReview,
  disabled = false,
}: {
  rangeReview: RangeReview;
  /** 已经审查完成的阶段按钮留着但不可用(issue #176)。 */
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = useMutation({
    mutationFn: async () => {
      const response = await api(`/range-reviews/${rangeReview.id}/complete`, { method: "POST" });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: () => refreshRangeReview(queryClient),
    onError: (failure: Error) => setError(failure.message),
  });

  return (
    <>
      {error === null ? null : (
        <p role="alert" className="w-full text-danger">{error}</p>
      )}
      <AlertDialog.Root open={open} onOpenChange={setOpen}>
        <AlertDialog.Trigger>
          <Button
            variant="outline"
            color="gray"
            highContrast
            size={{ initial: "3", sm: "2" }}
            disabled={disabled || complete.isPending}
          >
            {complete.isPending ? "收尾中…" : "审查完成"}
          </Button>
        </AlertDialog.Trigger>
        <AlertDialog.Content maxWidth="440px" size={{ initial: "2", sm: "3" }}>
          <AlertDialog.Title size="4" mb="2">
            标记 {rangeReview.owner}/{rangeReview.repo} 的这个阶段为审查完成?
          </AlertDialog.Title>
          <AlertDialog.Description size="2" color="gray">
            承载 Finding 的 pull request 会关闭、两条分支会删除，比较项不再推进，未处置的 Finding
            按未处置计入处置率。全部 Finding、处置与备注仍然看得到；同一个 base 可以再发起一个新的范围审查。
          </AlertDialog.Description>
          <Flex gap="3" mt="4" justify="end" direction={{ initial: "column-reverse", sm: "row" }}>
            <AlertDialog.Cancel>
              <Button variant="soft" color="gray" size={{ initial: "4", sm: "2" }}>取消</Button>
            </AlertDialog.Cancel>
            <Button
              variant="solid"
              color="red"
              size={{ initial: "4", sm: "2" }}
              onClick={() => {
                setError(null);
                setOpen(false);
                complete.mutate();
              }}
            >
              审查完成
            </Button>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}

/**
 * 推进比较项(issue #157)。入口在阶段详情页的页头(issue #176)。
 */
export function AdvanceAction({
  rangeReview,
  disabled = false,
}: {
  rangeReview: RangeReview;
  /** 已经审查完成的阶段按钮留着但不可用(issue #176)。 */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button
          variant="solid"
          className="shadow-accent"
          size={{ initial: "3", sm: "2" }}
          disabled={disabled}
        >
          推进比较项
        </Button>
      </Dialog.Trigger>
      <AdvanceDialogContent rangeReview={rangeReview} onAdvanced={() => setOpen(false)} />
    </Dialog.Root>
  );
}

/**
 * 推进比较项的表单(issue #157)。
 *
 * 只收新的比较项:base 是这个阶段不变的基准,推进不改它,所以选择器走 `baseLocked`
 * 那一档(issue #179),base 只以短 sha 显示。手输框已删——人只记得分支与提交信息。
 *
 * 不是 base 后代的提交在列表里置灰:服务端本来就会拒,人不该点下去才知道。作者 rebase
 * 之后的 commit 仍在另一条从 base 分出去的分支上,换条分支照样选得到(user story 33)。
 */
function AdvanceDialogContent({
  rangeReview,
  onAdvanced,
}: {
  rangeReview: RangeReview;
  onAdvanced: () => void;
}) {
  const queryClient = useQueryClient();
  const [comparison, setComparison] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const advance = useMutation({
    mutationFn: async () => {
      const response = await api(`/range-reviews/${rangeReview.id}/advance`, {
        method: "POST",
        body: JSON.stringify({ comparison }),
      });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: () => {
      refreshRangeReview(queryClient);
      onAdvanced();
    },
    onError: (failure: Error) => setError(failure.message),
  });

  return (
    <Dialog.Content aria-describedby={undefined} maxWidth="560px" size={{ initial: "2", sm: "3" }}>
      <form
        className="flex min-h-0 flex-col gap-3"
        aria-busy={advance.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          if (comparison === null) return;
          advance.mutate();
        }}
      >
        <Dialog.Title size="4" mb="1" className="pr-9">推进比较项</Dialog.Title>

        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 text-base">
          <dt className="text-text-secondary">base（锁定）</dt>
          <dd className="min-w-0 font-mono">{rangeReview.baseSha.slice(0, 7)}</dd>
          <dt className="text-text-secondary">当前比较项</dt>
          <dd className="min-w-0 font-mono">{rangeReview.comparisonSha.slice(0, 7)}</dd>
          <dt className="text-text-secondary">新的比较项</dt>
          <dd className="min-w-0 font-mono">
            {comparison === null ? "还没选" : comparison.slice(0, 7)}
          </dd>
        </dl>

        <CommitPicker
          repo={{ owner: rangeReview.owner, repo: rangeReview.repo }}
          base={rangeReview.baseSha}
          comparison={comparison}
          baseLocked
          onPick={(_role, sha) => {
            setError(null);
            setComparison(sha);
          }}
        />

        <p className="text-sm text-text-muted">
          不是 base 后代的提交选不了。推进会把容器 pull request 的 head
          分支移到新 commit，并按 base..新比较项跑新的一轮。
        </p>
        {error === null ? null : <p role="alert" className="text-danger">{error}</p>}

        <Flex gap="3" mt="1" justify="end" direction={{ initial: "column-reverse", sm: "row" }}>
          <Dialog.Close>
            <Button type="button" variant="soft" color="gray" size={{ initial: "4", sm: "2" }}>
              取消
            </Button>
          </Dialog.Close>
          <Button
            type="submit"
            variant="solid"
            className="shadow-accent"
            size={{ initial: "4", sm: "2" }}
            disabled={comparison === null || advance.isPending}
          >
            {advance.isPending ? "推进中…" : "推进"}
          </Button>
        </Flex>
      </form>
      <div className="absolute top-3 right-3">
        <Dialog.Close>
          <IconButton
            variant="ghost"
            color="gray"
            size={{ initial: "3", sm: "1" }}
            className="max-sm:min-h-11 max-sm:min-w-11"
            aria-label="关闭推进比较项"
          >
            <Cross2Icon aria-hidden />
          </IconButton>
        </Dialog.Close>
      </div>
    </Dialog.Content>
  );
}
