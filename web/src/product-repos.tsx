import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cross2Icon, Pencil1Icon } from "@radix-ui/react-icons";
import { Dialog, Flex, IconButton, Select, Skeleton, Text, TextArea, TextField } from "@radix-ui/themes";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { FeedbackCallout, type Feedback } from "@/components/feedback-callout";
import { Button } from "@/components/theme-button";
import {
  PRODUCTS_QUERY_KEY,
  repoPath,
  unassignedRepos,
  type Product,
  type ProductRepo,
  type RegisteredRepo,
} from "@/lib/products";

import { fetchJson, send } from "./api.ts";

/**
 * 移出确认框的说明。产品知识不跟着仓库退役(issue #360):条目说的是这个产品是什么、它的
 * 仓库之间怎么协作,少一个仓库并不让某一条当场不成立,说的正是那个仓库的那几条由下一场梳理
 * 改写或撤回,而那一场由人在产品页上开(issue #365)。
 */
const DETACH_CONSEQUENCE =
  "说到这个仓库的产品知识留着，由下一场产品梳理改写。仓库本身留在注册表里。";

/**
 * 「管理仓库」弹窗(CONTEXT.md 产品、仓库职责):一个产品的仓库集与各自的职责在这里改——归入、
 * 改职责、移出。它挂在产品页页头的「…」菜单下,按 `repo:write` 显隐;左栏的仓库卡只读,会话页
 * 因此不再出现这几个写动作:它们改的是整个产品,不是这一场会话。
 *
 * 弹窗做完一件不关:归入两三个仓库、挨个改职责是一次连着做的事。回执因此落在弹窗里——页顶
 * 那条 Callout 被弹窗挡着,人看不到。
 */
export function ManageReposDialog({
  open,
  product,
  products,
  onClose,
  onPending,
}: {
  open: boolean;
  product: Product;
  /** 这个账号看得到的全部产品:归入候选要去掉已经归在任何一个产品下的仓库。 */
  products: readonly Product[];
  onClose: () => void;
  /** 写动作在跑时报给产品页,页头与左栏的写动作跟着置灰。 */
  onPending: (pending: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  /** 正要移出的仓库:移出前先过一道确认。 */
  const [detaching, setDetaching] = useState<ProductRepo | null>(null);
  const [repoId, setRepoId] = useState("");
  const [role, setRole] = useState("");
  useEffect(() => {
    if (!open) return;
    setFeedback(null);
    setRepoId("");
    setRole("");
  }, [open]);

  // `GET /repos` 已经按仓库分配收窄过(ADR 0018)。
  const reposQuery = useQuery({
    queryKey: ["repos"],
    queryFn: () => fetchJson<RegisteredRepo[]>("/repos"),
    enabled: open,
  });
  /** 还没归入任何产品、且在这个账号分配内的仓库。归入第二个产品服务端会回 409。 */
  const attachable = unassignedRepos(reposQuery.data ?? [], products);
  const chosen = attachable.find((row) => String(row.repoId) === repoId);

  /**
   * 重读产品列表。详情与会话列表的缓存键排在它之下,一次失效三份都跟着重读——仓库集一变,
   * 知识与会话都可能不是原来那一份了。
   */
  const settled = (text: string): Promise<void> => {
    setFeedback({ text, error: false });
    return queryClient.invalidateQueries({ queryKey: PRODUCTS_QUERY_KEY });
  };
  const failed = (error: Error): void => setFeedback({ text: error.message, error: true });

  const attach = useMutation({
    mutationFn: (input: { repo: RegisteredRepo; role: string }) =>
      send(`/products/${product.id}/repos/${input.repo.repoId}`, "PUT", { role: input.role }),
    onSuccess: (_value, { repo }) => {
      setRepoId("");
      setRole("");
      return settled(`已把 ${repoPath(repo)} 归入 ${product.name}。`);
    },
    onError: failed,
  });

  /**
   * 改一行的仓库职责(CONTEXT.md 仓库职责,issue #341)。走的是归属那个端点:已经归属的
   * 那一次就是改职责,整格覆盖,空串即清掉。
   */
  const setRepoRole = useMutation({
    mutationFn: (input: { repo: ProductRepo; role: string }) =>
      send(`/products/${product.id}/repos/${input.repo.repoId}`, "PUT", { role: input.role }),
    onSuccess: (_value, { repo, role: next }) =>
      settled(next === "" ? `已清掉 ${repoPath(repo)} 的职责。` : `已记下 ${repoPath(repo)} 的职责。`),
    onError: failed,
  });

  const detach = useMutation({
    mutationFn: (repo: ProductRepo) => send(`/products/${product.id}/repos/${repo.repoId}`, "DELETE"),
    onSuccess: (_value, repo) => {
      setDetaching(null);
      return settled(`已把 ${repoPath(repo)} 移出产品。`);
    },
    onError: failed,
  });

  const working = attach.isPending || setRepoRole.isPending || detach.isPending;
  useEffect(() => onPending(working), [working, onPending]);

  const submitAttach = (event: FormEvent): void => {
    event.preventDefault();
    if (chosen === undefined) return;
    setFeedback(null);
    attach.mutate({ repo: chosen, role: role.trim() });
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Content
        maxWidth="560px"
        size={{ initial: "2", sm: "3" }}
        aria-busy={working}
        // 默认焦点会落在第一行的职责上,打开即给它套一圈焦点环,看着像一格已经在编辑的输入框。
        // 焦点改落浮层本身,与仓库配置、知识集两个弹窗同一处理。
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
        // 在职责框里按 Escape 是放弃这一格的改动,不是关掉整个弹窗(`RoleField` 自己处理它)。
        onEscapeKeyDown={(event) => {
          if (event.target instanceof HTMLTextAreaElement) event.preventDefault();
        }}
      >
        <Dialog.Title size="4" mb="2">
          管理仓库
        </Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="4">
          「{product.name}」的仓库与各自的职责。职责会写进 Agent 会话的系统提示；一个仓库至多属于一个产品。
        </Dialog.Description>
        <div className="flex flex-col gap-4">
          <FeedbackCallout feedback={feedback} />

          {product.repos.length === 0 ? (
            <Text as="p" size="2" color="gray">
              还没有归入仓库。
            </Text>
          ) : (
            <ul className="overflow-hidden rounded-[var(--v8-radius-control)] border border-card-line">
              {product.repos.map((repo) => (
                <li
                  key={repo.repoId}
                  className="group/repo flex items-start justify-between gap-2 border-t border-line px-3 py-2.5 first:border-t-0"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="min-w-0 wrap-anywhere font-mono text-base">{repoPath(repo)}</span>
                    <RoleField
                      repo={repo}
                      busy={working}
                      onSave={(next) => {
                        setFeedback(null);
                        setRepoRole.mutate({ repo, role: next });
                      }}
                    />
                  </div>
                  <IconButton
                    variant="ghost"
                    color="gray"
                    size={{ initial: "3", sm: "1" }}
                    className="shrink-0 transition-opacity md:opacity-0 md:group-hover/repo:opacity-100 md:group-focus-within/repo:opacity-100 md:focus-visible:opacity-100"
                    aria-label={`把 ${repoPath(repo)} 移出 ${product.name}`}
                    disabled={working}
                    onClick={() => {
                      setFeedback(null);
                      setDetaching(repo);
                    }}
                  >
                    <Cross2Icon aria-hidden />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={submitAttach} className="flex flex-col gap-3 border-t border-line pt-4">
            {/* 标签 ↔ 控件 ↔ 说明 6px,字段之间 12px,与发起范围审查、重跑两处同一个节奏。 */}
            <div className="flex flex-col gap-1.5">
              <Text as="span" id="attach-repo-label" size="2" weight="medium">
                归入仓库
              </Text>
              {reposQuery.isPending ? (
                <Skeleton aria-hidden height="32px" />
              ) : reposQuery.isError ? (
                <FeedbackCallout feedback={{ text: reposQuery.error.message, error: true }} />
              ) : attachable.length === 0 ? (
                <Text as="p" size="1" color="gray">
                  没有可归入的仓库：分配内的仓库都已经归在某个产品下了。
                </Text>
              ) : (
                <Select.Root size={{ initial: "3", sm: "2" }} value={repoId} onValueChange={setRepoId}>
                  <Select.Trigger
                    aria-labelledby="attach-repo-label"
                    placeholder="选一个仓库"
                    className="min-w-0 w-full"
                  />
                  <Select.Content position="popper">
                    {attachable.map((row) => (
                      <Select.Item key={row.repoId} value={String(row.repoId)}>
                        {repoPath(row)}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              )}
            </div>
            {reposQuery.isSuccess && attachable.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <Text as="label" htmlFor="attach-repo-role" size="2" weight="medium">
                  职责
                </Text>
                {/* 提交键跟在职责框右侧、与它同高:它提交的是这一段,放到下面单占一行会与弹窗的
                    「完成」叠成两颗右对齐的键,分不清哪颗管哪件事。 */}
                <div className="flex items-start gap-2">
                  <TextField.Root
                    id="attach-repo-role"
                    size={{ initial: "3", sm: "2" }}
                    className="min-w-0 flex-1"
                    placeholder="选填，例如：后端 API(Node)"
                    maxLength={64}
                    aria-describedby="attach-repo-role-hint"
                    value={role}
                    onChange={(event) => setRole(event.target.value)}
                  />
                  <Button
                    type="submit"
                    variant="soft"
                    size={{ initial: "3", sm: "2" }}
                    className="shrink-0"
                    disabled={working || chosen === undefined}
                  >
                    {attach.isPending ? "归入中…" : "归入"}
                  </Button>
                </div>
                <Text as="p" id="attach-repo-role-hint" size="1" color="gray">
                  这个仓库在这个产品里干什么，最多 64 字；归入之后在上面的列表里也改得了。
                </Text>
              </div>
            ) : null}
          </form>

          <Flex justify="end">
            <Dialog.Close>
              <Button type="button" variant="outline" color="gray" size={{ initial: "4", sm: "2" }}>
                完成
              </Button>
            </Dialog.Close>
          </Flex>
        </div>

        <ConfirmDialog
          open={detaching !== null}
          onOpenChange={(next) => {
            if (!next) setDetaching(null);
          }}
          title={detaching === null ? "" : `把 ${repoPath(detaching)} 移出 ${product.name}?`}
          titleSize="4"
          description={DETACH_CONSEQUENCE}
          cancelLabel="取消"
          cancelVariant="outline"
          cancelDisabled={detach.isPending}
          confirm={{
            label: detach.isPending ? "移出中…" : "移出",
            color: "red",
            disabled: detach.isPending || detaching === null,
            onClick: () => {
              if (detaching === null) return;
              setFeedback(null);
              detach.mutate(detaching);
            },
          }}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * 一行仓库的职责(CONTEXT.md 仓库职责,issue #341)。平时是一段可换行的文本,点它进编辑:
 * Enter 或失焦保存并退出,Escape 放回原值并退出;与库里那一份相同时一律不发请求,失焦不该
 * 变成一次空写。
 */
function RoleField({
  repo,
  busy,
  onSave,
}: {
  repo: ProductRepo;
  busy: boolean;
  onSave: (role: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(repo.role ?? "");
  useEffect(() => setText(repo.role ?? ""), [repo.role]);
  // Escape 之后输入框卸载,浏览器可能还补一次 blur;那一次不能把改了一半的文字存下去。
  const cancelled = useRef(false);
  // 职责最长 64 字,一行常装不下;编辑框随内容长高,不让开头滚出视野。
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = area.current;
    if (el === null) return;
    el.style.overflow = "hidden";
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text, editing]);

  if (!editing) {
    return (
      <button
        type="button"
        aria-label={`改 ${repoPath(repo)} 的职责`}
        disabled={busy}
        onClick={() => setEditing(true)}
        className="-mx-1 flex min-w-0 items-start gap-1 rounded-sm px-1 py-0.5 text-left text-base transition-colors hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:min-h-11"
      >
        <span className={repo.role === null ? "min-w-0 break-words text-text-disabled" : "min-w-0 break-words"}>
          {repo.role ?? "填写职责"}
        </span>
        <Pencil1Icon
          aria-hidden
          className="mt-0.5 shrink-0 text-text-faint transition-opacity md:opacity-0 md:group-hover/repo:opacity-100 md:group-focus-within/repo:opacity-100"
        />
      </button>
    );
  }

  const finish = (): void => {
    setEditing(false);
    if (cancelled.current) return;
    if (text.trim() !== (repo.role ?? "")) onSave(text.trim());
  };

  return (
    <TextArea
      ref={area}
      size="1"
      rows={1}
      resize="none"
      className="min-h-0 min-w-0 w-full"
      aria-label={`${repoPath(repo)} 的职责`}
      placeholder="职责（选填）"
      maxLength={64}
      autoFocus
      disabled={busy}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onFocus={() => {
        cancelled.current = false;
      }}
      onBlur={finish}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          // 职责是一行文本,回车即保存,不进换行。
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          cancelled.current = true;
          setText(repo.role ?? "");
          setEditing(false);
        }
      }}
    />
  );
}
