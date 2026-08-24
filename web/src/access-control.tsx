import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LockClosedIcon, PlusIcon, ResetIcon, TrashIcon } from "@radix-ui/react-icons";
import { Badge, Skeleton, Text, TextField } from "@radix-ui/themes";
import { useMemo, useState, type FormEvent } from "react";

import { HelpTooltip } from "@/components/help-tooltip";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
import { Card } from "@radix-ui/themes";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { api, errorText, fetchJson } from "./api.ts";
import {
  PANEL_PERMISSIONS,
  permissionImpliedBy,
  roleHasPermission,
  type PanelPermission,
} from "./session.ts";

type Role = {
  id: number;
  name: string;
  permissions: PanelPermission[];
  createdAt: string;
};

type User = {
  username: string;
  displayName: string | null;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  isSystemAdmin: boolean;
  roleId: number | null;
};

type PermissionInfo = {
  id: PanelPermission;
  resource: "仓库" | "评审" | "模型" | "凭据";
  action: string;
  hint: string;
};

const PERMISSION_INFO: readonly PermissionInfo[] = [
  { id: "repo:read", resource: "仓库", action: "查看", hint: "查看仓库列表和 hook 核对结果。" },
  { id: "repo:write", resource: "仓库", action: "管理", hint: "搜索、注册和移除仓库，修改模型组合和轮转 Key。" },
  { id: "review:read", resource: "评审", action: "查看", hint: "查看评审记录和处置率。" },
  { id: "review:rerun", resource: "评审", action: "重新运行", hint: "重新运行一次评审，会产生模型调用费用并在 PR 上发布评论。" },
  { id: "model:read", resource: "模型", action: "查看", hint: "查看审查策略和模型服务。" },
  { id: "model:write", resource: "模型", action: "管理", hint: "修改模型组合、手动添加模型和管理自定义模型服务。" },
  { id: "credential:read", resource: "凭据", action: "查看", hint: "查看已配置凭据和 Key 末 4 位。" },
  { id: "credential:write", resource: "凭据", action: "管理", hint: "新增、更新和删除模型凭据。" },
];

const RESOURCES = ["仓库", "评审", "模型", "凭据"] as const;

function localMinute(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await errorText(response));
  return (await response.json()) as T;
}

export function AccessControlPage() {
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [createKind, setCreateKind] = useState<"user" | "role" | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "reset" | "delete-user" | "delete-role"; id: string; label: string } | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: async () => (await fetchJson<{ users: User[] }>("/users")).users,
  });
  const rolesQuery = useQuery({
    queryKey: ["roles"],
    queryFn: async () => (await fetchJson<{ roles: Role[] }>("/roles")).roles,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["users"] });
    void queryClient.invalidateQueries({ queryKey: ["roles"] });
  };

  const createUser = useMutation({
    mutationFn: async (input: { username: string; displayName: string; password: string }) =>
      responseJson<{ username: string }>(await api("/users", { method: "POST", body: JSON.stringify(input) })),
    onSuccess: ({ username }) => {
      setCreateKind(null);
      setFeedback({ text: `已创建用户 ${username}；首次登录必须修改密码。`, error: false });
      refresh();
    },
    onError: (error: Error) => setFeedback({ text: error.message, error: true }),
  });

  const createRole = useMutation({
    mutationFn: async (name: string) =>
      responseJson<Role>(await api("/roles", { method: "POST", body: JSON.stringify({ name, permissions: [] }) })),
    onSuccess: ({ name }) => {
      setCreateKind(null);
      setFeedback({ text: `已创建角色 ${name}，初始不包含任何权限。`, error: false });
      refresh();
    },
    onError: (error: Error) => setFeedback({ text: error.message, error: true }),
  });

  const updateUser = useMutation({
    mutationFn: async (input: { user: User; roleId: number | null }) => {
      const response = await api(`/users/${encodeURIComponent(input.user.username)}`, {
        method: "PUT",
        body: JSON.stringify({
          displayName: input.user.displayName,
          roleId: input.roleId,
          isSystemAdmin: false,
        }),
      });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: () => {
      setFeedback({ text: "用户角色已更新，无需重新登录。", error: false });
      refresh();
    },
    onError: (error: Error) => {
      setFeedback({ text: error.message, error: true });
      refresh();
    },
  });

  const updateRole = useMutation({
    mutationFn: async (input: { role: Role; permission: PanelPermission }) => {
      const permissions = input.role.permissions.includes(input.permission)
        ? input.role.permissions.filter((item) => item !== input.permission)
        : [...input.role.permissions, input.permission];
      return responseJson<Role>(
        await api(`/roles/${input.role.id}`, {
          method: "PUT",
          body: JSON.stringify({ name: input.role.name, permissions }),
        }),
      );
    },
    onSuccess: () => {
      setFeedback({ text: "角色权限已更新，无需重新登录。", error: false });
      refresh();
    },
    onError: (error: Error) => setFeedback({ text: error.message, error: true }),
  });

  const destructive = useMutation({
    mutationFn: async (input: { target: NonNullable<typeof confirm>; password?: string }) => {
      const { target } = input;
      const path = target.kind === "reset"
        ? `/users/${encodeURIComponent(target.id)}/reset-password`
        : target.kind === "delete-user"
          ? `/users/${encodeURIComponent(target.id)}`
          : `/roles/${target.id}`;
      const response = await api(path, {
        method: target.kind === "reset" ? "POST" : "DELETE",
        ...(target.kind === "reset" ? { body: JSON.stringify({ password: input.password }) } : {}),
      });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: (_value, { target }) => {
      setConfirm(null);
      setResetPassword("");
      setFeedback({
        text: target.kind === "reset" ? `${target.label} 的密码已重置，现有会话已作废。` : `${target.label} 已删除。`,
        error: false,
      });
      refresh();
    },
    onError: (error: Error) => setFeedback({ text: error.message, error: true }),
  });

  const users = usersQuery.data ?? [];
  const roles = rolesQuery.data ?? [];
  const adminCount = users.filter((user) => user.isSystemAdmin).length;
  const unclaimed = useMemo(() => {
    return new Set(
      PANEL_PERMISSIONS.filter(
        (permission) => !roles.some((role) => roleHasPermission(role.permissions, permission)),
      ),
    );
  }, [roles]);
  const pending = usersQuery.isPending || rolesQuery.isPending;
  const loadError = usersQuery.error ?? rolesQuery.error;

  return (
    <>
      <PageHeader
        title="访问控制"
        description="管理用户、角色和权限。此页仅系统管理员可见。"
        actions={
          <>
            <Button variant="outline" color="gray" size={{ initial: "4", sm: "2" }} onClick={() => setCreateKind("role")}><PlusIcon />新建角色</Button>
            <Button variant="solid" highContrast size={{ initial: "4", sm: "2" }} onClick={() => setCreateKind("user")}><PlusIcon />新建用户</Button>
          </>
        }
      />
      <PageBody width="wide" className="pb-5 sm:pb-5">
        {feedback === null ? null : (
          <p
            role={feedback.error ? "alert" : "status"}
            className={feedback.error
              ? "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive"
              : "rounded-md border border-success/30 bg-success/10 px-3 py-2 text-success"}
          >
            {feedback.text}
          </p>
        )}
        {loadError === null ? null : (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
            {(loadError as Error).message}
          </p>
        )}
        {pending ? (
          <div className="flex flex-col gap-5" role="status" aria-label="正在加载访问控制">
            <Skeleton className="h-56" />
            <Skeleton className="h-80" />
          </div>
        ) : (
          <>
            <section className="flex min-w-0 flex-col gap-3" aria-labelledby="users-heading">
              <h2 id="users-heading" className="flex items-baseline gap-2 text-base font-semibold">
                用户 <span className="font-mono text-xs font-normal text-muted-foreground">{users.length}</span>
              </h2>
              <div className="contain-inline-size min-w-0 max-w-full overflow-x-auto overscroll-x-contain rounded-md border border-border">
                <table className="w-full min-w-max border-collapse text-left">
                  <thead className="bg-muted text-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">用户名</th>
                      <th scope="col" className="px-3 py-2 font-medium">显示名</th>
                      <th scope="col" className="px-3 py-2 font-medium">角色</th>
                      <th scope="col" className="px-3 py-2 font-medium">创建</th>
                      <th scope="col" className="px-3 py-2 font-medium">最后登录</th>
                      <th scope="col" className="px-3 py-2"><span className="sr-only">操作</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={user.username} className="border-t border-border align-top hover:bg-muted/30">
                        <td className="px-3 py-2.5 font-medium">
                          <div className="flex max-w-64 flex-wrap items-center gap-1.5">
                            <span className="max-w-56 truncate" title={user.username}>{user.username}</span>
                            {user.isSystemAdmin ? <Badge color="gray" variant="soft">系统管理员</Badge> : null}
                            {user.mustChangePassword ? <StatusBadge tone="warning">待改密</StatusBadge> : null}
                          </div>
                        </td>
                        <td className="max-w-48 truncate px-3 py-2.5 text-muted-foreground" title={user.displayName ?? undefined}>{user.displayName ?? "—"}</td>
                        <td className="px-3 py-2.5">
                          {user.isSystemAdmin ? (
                            <span className="text-muted-foreground">全部权限</span>
                          ) : (
                            <select
                              aria-label={`${user.username} 的角色`}
                              value={user.roleId ?? ""}
                              disabled={updateUser.isPending}
                              onChange={(event) => updateUser.mutate({ user, roleId: event.target.value === "" ? null : Number(event.target.value) })}
                              className={`h-8 max-w-44 rounded-sm border px-2 outline-none max-sm:min-h-11 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 ${user.roleId === null ? "border-warning/50 bg-warning/10 text-warning" : "border-border bg-background"}`}
                            >
                              <option value="">未分配角色</option>
                              {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                            </select>
                          )}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs whitespace-nowrap text-muted-foreground">{localMinute(user.createdAt)}</td>
                        <td className="px-3 py-2.5 text-xs whitespace-nowrap text-muted-foreground">{user.lastLoginAt === null ? "从未" : <span className="font-mono">{localMinute(user.lastLoginAt)}</span>}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex justify-end gap-1 whitespace-nowrap">
                            <Button variant="ghost" color="gray" size={{ initial: "4", sm: "1" }} onClick={() => setConfirm({ kind: "reset", id: user.username, label: user.username })}><ResetIcon />重置密码</Button>
                            <Button variant="ghost" color="red" size={{ initial: "4", sm: "1" }} onClick={() => setConfirm({ kind: "delete-user", id: user.username, label: user.username })}><TrashIcon />删除用户</Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="flex min-w-0 flex-col gap-3" aria-labelledby="permissions-heading">
              <h2 id="permissions-heading" className="text-base font-semibold">权限矩阵</h2>
              <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2">
                <LockClosedIcon className="mt-0.5 size-4 shrink-0" />
                <p className="min-w-0 flex-1 text-muted-foreground"><span className="font-medium text-foreground">系统管理员</span>不参与矩阵，始终拥有全部权限（当前 <span className="font-mono">{adminCount}</span> 位）。下方仅管理自定义角色。</p>
                <HelpTooltip label="系统管理员权限说明" content="系统管理员无需分配自定义角色，始终可以管理用户、角色、仓库、模型服务和审查策略。" />
              </div>
              {unclaimed.size === 0 || roles.length === 0 ? null : (
                <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-warning">
                  有 <span className="font-mono">{unclaimed.size}</span> 项权限尚未授予任何角色。除系统管理员外，相关功能当前无人可用。
                </div>
              )}
              {roles.length === 0 ? (
                <Card size="2" className="flex flex-col items-start gap-2">
                  <p className="font-medium">还没有角色</p>
                  <p className="text-muted-foreground">角色不会预置。创建角色后，可在权限矩阵中授予权限。</p>
                  <Button variant="solid" highContrast size={{ initial: "4", sm: "2" }} className="mt-1" onClick={() => setCreateKind("role")}><PlusIcon />新建角色</Button>
                </Card>
              ) : (
                <div className="contain-inline-size min-w-0 max-w-full overflow-x-auto overscroll-x-contain rounded-md border border-border">
                  <table className="w-full min-w-max border-collapse text-left">
                    <thead>
                      <tr className="bg-muted text-xs text-muted-foreground">
                        <th scope="col" className="sticky left-0 z-10 min-w-56 bg-muted px-3 py-2 font-medium sm:min-w-72">权限</th>
                        {roles.map((role) => (
                          <th key={role.id} scope="col" className="w-36 min-w-36 max-w-36 border-l border-border px-3 py-2 text-center font-medium">
                            <span className="block break-words text-foreground" title={role.name}>{role.name}</span>
                            <span className="block font-normal"><span className="font-mono">{users.filter((user) => user.roleId === role.id).length}</span> 人</span>
                            <Button variant="ghost" color="red" size={{ initial: "4", sm: "1" }} className="mt-1" onClick={() => setConfirm({ kind: "delete-role", id: String(role.id), label: role.name })}><TrashIcon />删除</Button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {RESOURCES.flatMap((resource) => [
                        <tr key={`${resource}-heading`} className="border-t border-border bg-muted/40">
                          <td colSpan={roles.length + 1} className="sticky left-0 px-3 py-1 text-xs font-medium text-muted-foreground">{resource}</td>
                        </tr>,
                        ...PERMISSION_INFO.filter((permission) => permission.resource === resource).map((permission) => {
                          const missing = unclaimed.has(permission.id);
                          return (
                            <tr key={permission.id} className={`border-t border-border ${missing ? "bg-warning/10" : ""}`}>
                              <td className={`sticky left-0 z-10 min-w-56 px-3 py-2 sm:min-w-72 ${missing ? "bg-[color-mix(in_oklab,var(--warning)_10%,var(--background))]" : "bg-background"}`}>
                                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                  <span className="font-medium">{permission.action}</span>
                                  <HelpTooltip label={`${permission.resource}${permission.action}权限说明`} content={permission.hint} />
                                  {missing ? <span className="text-xs text-warning">尚未授予</span> : null}
                                </div>
                              </td>
                              {roles.map((role) => {
                                const impliedBy = permissionImpliedBy(permission.id);
                                const implied =
                                  impliedBy !== undefined && role.permissions.includes(impliedBy);
                                return (
                                  <td key={role.id} className="border-l border-border px-3 py-1.5 text-center">
                                    <Text as="label" size="2" className="inline-flex min-h-8 cursor-pointer flex-col items-center justify-center rounded-sm px-1 max-sm:min-h-11 max-sm:min-w-11 hover:bg-muted focus-within:ring-2 focus-within:ring-ring/25 focus-within:ring-offset-1 focus-within:ring-offset-background has-disabled:cursor-not-allowed has-disabled:opacity-70">
                                      <input
                                        type="checkbox"
                                        aria-label={`${role.name}的${permission.resource}${permission.action}权限${implied ? "，已随管理权限授予" : ""}`}
                                        checked={roleHasPermission(role.permissions, permission.id)}
                                        disabled={updateRole.isPending || implied}
                                        onChange={() => updateRole.mutate({ role, permission: permission.id })}
                                        className="size-4 accent-primary outline-none"
                                      />
                                      {implied ? <span className="text-xs text-muted-foreground">随管理权限生效</span> : null}
                                    </Text>
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        }),
                      ])}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </PageBody>
      <CreateDialog kind={createKind} busy={createUser.isPending || createRole.isPending} onClose={() => setCreateKind(null)} onUser={(input) => { setFeedback(null); createUser.mutate(input); }} onRole={(name) => { setFeedback(null); createRole.mutate(name); }} />
      <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open) { setConfirm(null); setResetPassword(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm?.kind === "reset" ? "重置密码" : "确认删除"}</DialogTitle>
            <DialogDescription className="break-words">
              {confirm?.kind === "reset"
                ? `为 ${confirm.label} 设置一枚临时密码。现有会话会全部作废，下次登录必须改密码。`
                : confirm?.kind === "delete-role"
                  ? `删除角色 ${confirm.label}？仍有人使用时服务会拒绝删除。`
                  : `删除用户 ${confirm?.label}？其现有会话会一起作废，且无法撤销。`}
            </DialogDescription>
          </DialogHeader>
          {confirm?.kind === "reset" ? (
            <div className="flex flex-col gap-1.5">
              <Text as="label" htmlFor="reset-password" size="2" weight="medium">临时密码</Text>
              <TextField.Root id="reset-password" type="password" size={{ initial: "3", sm: "2" }} className="min-w-0 w-full max-sm:min-h-11" autoComplete="new-password" autoFocus value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} />
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose asChild><Button variant="outline" color="gray" size={{ initial: "4", sm: "2" }}>取消</Button></DialogClose>
            <Button
              variant="solid"
              color={confirm?.kind === "reset" ? "gray" : "red"}
              highContrast={confirm?.kind === "reset"}
              size={{ initial: "4", sm: "2" }}
              disabled={destructive.isPending || (confirm?.kind === "reset" && resetPassword === "")}
              onClick={() => { if (confirm !== null) destructive.mutate({ target: confirm, password: resetPassword }); }}
            >
              {destructive.isPending ? "处理中…" : confirm?.kind === "reset" ? "重置密码" : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CreateDialog({ kind, busy, onClose, onUser, onRole }: { kind: "user" | "role" | null; busy: boolean; onClose: () => void; onUser: (input: { username: string; displayName: string; password: string }) => void; onRole: (name: string) => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const submit = (event: FormEvent): void => { event.preventDefault(); if (kind === "user") onUser({ username, displayName, password }); else if (kind === "role") onRole(name); };

  return (
    <Dialog open={kind !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <form onSubmit={submit} className="contents" aria-busy={busy}>
          <DialogHeader>
            <DialogTitle>{kind === "user" ? "新建用户" : "新建角色"}</DialogTitle>
            <DialogDescription>{kind === "user" ? "新用户初始未分配角色，首次登录必须修改密码。" : "角色初始不包含任何权限，可在权限矩阵中授予权限。"}</DialogDescription>
          </DialogHeader>
          {kind === "user" ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Text as="label" htmlFor="new-username" size="2" weight="medium">用户名</Text>
                <TextField.Root id="new-username" size={{ initial: "3", sm: "2" }} className="min-w-0 w-full max-sm:min-h-11" autoFocus value={username} onChange={(event) => setUsername(event.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Text as="label" htmlFor="new-display-name" size="2" weight="medium">显示名</Text>
                <TextField.Root id="new-display-name" size={{ initial: "3", sm: "2" }} className="min-w-0 w-full max-sm:min-h-11" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="可留空" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Text as="label" htmlFor="new-password" size="2" weight="medium">临时密码</Text>
                <TextField.Root id="new-password" type="password" size={{ initial: "3", sm: "2" }} className="min-w-0 w-full max-sm:min-h-11" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Text as="label" htmlFor="new-role-name" size="2" weight="medium">角色名</Text>
              <TextField.Root id="new-role-name" size={{ initial: "3", sm: "2" }} className="min-w-0 w-full max-sm:min-h-11" autoFocus value={name} onChange={(event) => setName(event.target.value)} />
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="outline" color="gray" size={{ initial: "4", sm: "2" }}>取消</Button></DialogClose>
            <Button type="submit" variant="solid" highContrast size={{ initial: "4", sm: "2" }} disabled={busy || (kind === "user" ? username === "" || password === "" : name === "")}>{busy ? "创建中…" : "创建"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
