import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Cross2Icon } from "@radix-ui/react-icons";
import { Dialog, Flex, IconButton, Text, TextField } from "@radix-ui/themes";

import { Button } from "@/components/theme-button";

import { api, errorText, fetchJson } from "./api.ts";
import { CommitPicker } from "./commit-picker.tsx";

/** 表单里的那个仓库。入口只在选中具体仓库时出现,所以它一开始就有(issue #195)。 */
type PickedRepo = { owner: string; repo: string };

/**
 * 「发起范围审查」入口(issue #177):一个按钮加它的表单,只有首页右栏头部这一处调用
 * (issue #195)——发起一件事只该有一个入口、一种表单。
 *
 * 仓库由调用方给定并预填:选「全部仓库」时这个入口整个不出现(issue #195),表单里
 * 因此不再有仓库选择。
 */
export function RangeReviewLaunch({
  repo,
  onLaunched,
}: {
  repo: PickedRepo;
  onLaunched: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button variant="solid" className="shadow-accent" size={{ initial: "3", sm: "2" }}>
          发起范围审查
        </Button>
      </Dialog.Trigger>
      <LaunchDialogContent
        // 换一个仓库,标题与两端跟着重来:它们说的是上一个仓库的事。
        key={`${repo.owner}/${repo.repo}`}
        repo={repo}
        onLaunched={(text) => {
          onLaunched(text);
          setOpen(false);
        }}
      />
    </Dialog.Root>
  );
}

/**
 * 发起表单。标题、base 与比较项三个字段,标题必填(CONTEXT.md 范围审查)。
 *
 * base 与比较项都从 commit 选择器里点选(issue #178),没有手输框:人只记得分支与提交
 * 信息,记不住 sha。
 *
 * base 打开时按服务端给的预填值填上:同仓库最近一个审查完成的范围审查的最终比较项,
 * 连续两个阶段因此首尾相接。预填的是一个 sha,它未必在当前分支的第一页里,那就只以
 * 「已选 base」显示。人自己点过 base 就不再覆盖,换仓库时连同预填一起重来。
 *
 * 同仓库同 base 已经有进行中的时候服务端回 409 并要求确认:那一档不当错误提示,改成
 * 把提交按钮换成「仍然发起」,再点一次带确认标志重发。
 */
function LaunchDialogContent({
  repo,
  onLaunched,
}: {
  repo: PickedRepo;
  onLaunched: (text: string) => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [base, setBase] = useState("");
  const [baseTouched, setBaseTouched] = useState(false);
  const [comparison, setComparison] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);

  const prefill = useQuery({
    queryKey: ["range-review-prefill", repo.owner, repo.repo],
    queryFn: () =>
      fetchJson<{ base: string | null }>(
        `/range-reviews/prefill?owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.repo)}`,
      ),
  });
  const suggestedBase = prefill.data?.base ?? null;
  useEffect(() => {
    if (suggestedBase === null || baseTouched) return;
    setBase(suggestedBase);
  }, [suggestedBase, baseTouched]);

  const pick = (role: "base" | "comparison", sha: string): void => {
    setNeedsConfirmation(false);
    if (role === "base") {
      setBase(sha);
      setBaseTouched(true);
      return;
    }
    setComparison(sha);
  };

  const create = useMutation({
    mutationFn: async (confirm: boolean) => {
      const response = await api("/range-reviews", {
        method: "POST",
        body: JSON.stringify({
          owner: repo.owner,
          repo: repo.repo,
          title: title.trim(),
          base: base.trim(),
          comparison: comparison.trim(),
          ...(confirm ? { confirm: true } : {}),
        }),
      });
      if (response.status === 409) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
          needsConfirmation?: boolean;
        } | null;
        if (body?.needsConfirmation === true) {
          return { reminder: body.error ?? "同一个 base 上已经有进行中的范围审查" };
        }
        throw new Error(body?.error ?? "请求失败(409)");
      }
      if (!response.ok) throw new Error(await errorText(response));
      return { reminder: null };
    },
    onSuccess: (result) => {
      if (result.reminder !== null) {
        setNeedsConfirmation(true);
        setError(result.reminder);
        return;
      }
      // 新阶段要出现在评审记录列表里,而列表只有这一份(issue #189)。
      void queryClient.invalidateQueries({ queryKey: ["stages"] });
      onLaunched(`已发起 ${repo.owner}/${repo.repo} 的范围审查，首轮 Review Run 已开始运行`);
    },
    onError: (failure: Error) => {
      setNeedsConfirmation(false);
      setError(failure.message);
    },
  });

  const ready = title.trim() !== "" && base.trim() !== "" && comparison.trim() !== "";

  return (
    <Dialog.Content aria-describedby={undefined} maxWidth="560px" size={{ initial: "2", sm: "3" }}>
      <form
        className="flex min-h-0 flex-col gap-3"
        aria-busy={create.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          create.mutate(needsConfirmation);
        }}
      >
        <Dialog.Title size="4" mb="1" className="pr-9">发起范围审查</Dialog.Title>

        <p className="text-base text-text-muted">
          仓库 {repo.owner}/{repo.repo}
        </p>

        <div className="flex flex-col gap-1.5">
          <Text as="label" htmlFor="range-review-title" size="2" weight="medium">标题</Text>
          <TextField.Root
            id="range-review-title"
            aria-describedby="range-review-title-help"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：认证流程重构"
            size={{ initial: "3", sm: "2" }}
          />
          <Text id="range-review-title-help" as="span" size="1" color="gray">
            标题在范围审查发起后不可修改。
          </Text>
        </div>

        <div className="flex flex-col gap-1">
          <Text as="span" size="2" weight="medium">已选</Text>
          <p className="text-base text-text-muted">
            base {base === "" ? "尚未选择" : <code className="font-mono">{base.slice(0, 7)}</code>}
            ，比较项{" "}
            {comparison === "" ? "尚未选择" : <code className="font-mono">{comparison.slice(0, 7)}</code>}
          </p>
          {suggestedBase !== null && !baseTouched ? (
            <Text as="span" size="1" color="gray">
              base 已填入上一个审查完成的范围审查的最终比较项。
            </Text>
          ) : null}
        </div>

        <CommitPicker
          repo={repo}
          base={base === "" ? null : base}
          comparison={comparison === "" ? null : comparison}
          onPick={pick}
        />

        <p className="text-sm text-text-muted">
          Finding 将发布到 Forge；范围审查不会合并代码。
        </p>
        {error === null ? null : (
          <p role="alert" className={needsConfirmation ? "text-warning" : "text-danger"}>
            {error}
          </p>
        )}

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
            disabled={!ready || create.isPending}
          >
            {create.isPending ? "发起中…" : needsConfirmation ? "仍然发起" : "发起"}
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
            aria-label="关闭发起范围审查"
          >
            <Cross2Icon aria-hidden />
          </IconButton>
        </Dialog.Close>
      </div>
    </Dialog.Content>
  );
}
