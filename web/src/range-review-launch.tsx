import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Cross2Icon } from "@radix-ui/react-icons";
import { Dialog, IconButton, Text, TextArea, TextField } from "@radix-ui/themes";

import { Button } from "@/components/theme-button";

import { api, errorText, fetchJson } from "./api.ts";
import { RUN_DIRECTIVE_PLACEHOLDER } from "./repo-actions.tsx";
import {
  CommitPicker,
  type CommitSelection,
} from "./commit-picker.tsx";

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
      {open ? (
        <LaunchDialogContent
          // 关闭再打开、或换一个仓库时，表单与选择器都从该仓库的当前事实重来。
          key={`${repo.owner}/${repo.repo}`}
          repo={repo}
          onLaunched={(text) => {
            onLaunched(text);
            setOpen(false);
          }}
        />
      ) : null}
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
 *
 * 本轮指令(issue #225)选填,只进随发起触发的那一轮,与另外三个发起入口同一格。
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
  const [base, setBase] = useState<CommitSelection | null>(null);
  const [baseTouched, setBaseTouched] = useState(false);
  const [comparison, setComparison] = useState<CommitSelection | null>(null);
  const [directive, setDirective] = useState("");
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
    setBase({ sha: suggestedBase });
  }, [suggestedBase, baseTouched]);

  const pick = (role: "base" | "comparison", selection: CommitSelection): void => {
    setNeedsConfirmation(false);
    if (role === "base") {
      setBase(selection);
      setComparison(null);
      setBaseTouched(true);
      return;
    }
    setComparison(selection);
  };

  const create = useMutation({
    mutationFn: async (confirm: boolean) => {
      // 留空即不带这一格,与另外三个入口同一套判断。
      const trimmed = directive.trim();
      const response = await api("/range-reviews", {
        method: "POST",
        body: JSON.stringify({
          owner: repo.owner,
          repo: repo.repo,
          title: title.trim(),
          base: base?.sha ?? "",
          comparison: comparison?.sha ?? "",
          // 选比较项时用的分支或 Tag(issue #234),推进时的选择器据它打开。
          ...(comparison?.source === undefined ? {} : { comparisonSource: comparison.source }),
          ...(confirm ? { confirm: true } : {}),
          ...(trimmed === "" ? {} : { directive: trimmed }),
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

  const ready = title.trim() !== "" && base !== null && comparison !== null;

  return (
    <Dialog.Content
      aria-describedby={undefined}
      maxWidth="800px"
      size={{ initial: "2", sm: "3" }}
      className="h-[min(780px,calc(100dvh-4.5rem))] overflow-hidden p-0"
    >
      <form
        className="flex h-full min-h-0 flex-col"
        aria-busy={create.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          create.mutate(needsConfirmation);
        }}
      >
        <div className="shrink-0 border-b border-overlay-line px-4 py-3 sm:px-5 sm:py-4">
          {/* 仓库名放在同一个标题里:Heading 与 Text 各带 leading-trim 伪元素,分成两个元素做 baseline 对齐会错位。 */}
          <Dialog.Title size="4" mb="0" className="pr-10">
            发起范围审查
            <span className="ml-2 break-all text-md font-normal text-text-secondary">
              {repo.owner}/{repo.repo}
            </span>
          </Dialog.Title>

          <div className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
            <Text as="label" htmlFor="range-review-title" size="2" weight="medium">标题</Text>
            <TextField.Root
              id="range-review-title"
              autoFocus
              aria-describedby="range-review-title-help"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：认证流程重构"
              size={{ initial: "3", sm: "2" }}
              className="max-sm:min-h-11"
            />
          </div>
          <Text id="range-review-title-help" as="p" size="1" color="gray" className="mt-1 text-right">
            发起后不可修改
            {suggestedBase !== null && !baseTouched ? "；已沿用上次完成审查的最终比较项作为基准" : ""}
          </Text>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 py-3 sm:px-5 sm:py-4">
          <CommitPicker
            repo={repo}
            base={base}
            comparison={comparison}
            onPick={pick}
          />

          <div className="shrink-0">
            <Text as="label" htmlFor="range-review-directive" size="1" color="gray">
              本轮指令(选填)
            </Text>
            <TextArea
              id="range-review-directive"
              size="2"
              rows={2}
              maxLength={500}
              className="mt-1"
              aria-describedby="range-review-directive-help"
              placeholder={RUN_DIRECTIVE_PLACEHOLDER}
              value={directive}
              onChange={(event) => setDirective(event.target.value)}
            />
            <Text id="range-review-directive-help" as="p" size="1" color="gray" className="mt-1">
              指令只作用于发起出来的这一轮;要长期生效的要求请录进知识集。
            </Text>
          </div>
        </div>

        <div className="shrink-0 border-t border-overlay-line bg-sunken px-4 py-3 sm:px-5">
          {error === null ? null : (
            <p
              role="alert"
              className={`mb-2 break-words text-sm ${needsConfirmation ? "text-warning" : "text-danger"}`}
            >
              {error}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <Text as="p" size="1" color="gray">
              Finding 发布到 Forge；范围审查不会合并代码。
            </Text>
            <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex">
              <Dialog.Close>
                <Button type="button" variant="soft" color="gray" size={{ initial: "3", sm: "2" }} className="min-h-11 w-full sm:min-h-0 sm:w-auto">
                  取消
                </Button>
              </Dialog.Close>
              <Button
                type="submit"
                variant="solid"
                className="min-h-11 w-full shadow-accent sm:min-h-0 sm:w-auto"
                size={{ initial: "3", sm: "2" }}
                disabled={!ready || create.isPending}
              >
                {create.isPending ? "发起中…" : needsConfirmation ? "仍然发起" : "发起"}
              </Button>
            </div>
          </div>
        </div>
      </form>
      <div className="absolute top-2.5 right-2.5 sm:top-3.5 sm:right-3.5">
        <Dialog.Close>
          <IconButton
            variant="ghost"
            color="gray"
            size="3"
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
