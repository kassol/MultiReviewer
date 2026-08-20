import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

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
  { id: "repo:read", resource: "仓库", action: "读", hint: "仓库列表、hook 核对；写权限包含此项" },
  { id: "repo:write", resource: "仓库", action: "写", hint: "搜索、注册、移除、改组合、轮转 Key" },
  { id: "review:read", resource: "评审", action: "读", hint: "评审记录、处置率" },
  { id: "review:rerun", resource: "评审", action: "重跑", hint: "开一轮 Review Run：会产生费用并在 PR 上发评论" },
  { id: "model:read", resource: "模型", action: "读", hint: "全局设置、模型目录、模型行、自定义 provider；写权限包含此项" },
  { id: "model:write", resource: "模型", action: "写", hint: "改组合、手填模型行、加删自定义 provider" },
  { id: "credential:read", resource: "凭据", action: "读", hint: "凭据列表，含 key 尾 4 位；写权限包含此项" },
  { id: "credential:write", resource: "凭据", action: "写", hint: "写入与删除模型凭据" },
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
      setFeedback({ text: `${username} 已建号；首次登录必须改密码。`, error: false });
      refresh();
    },
    onError: (error: Error) => setFeedback({ text: error.message, error: true }),
  });

  const createRole = useMutation({
    mutationFn: async (name: string) =>
      responseJson<Role>(await api("/roles", { method: "POST", body: JSON.stringify({ name, permissions: [] }) })),
    onSuccess: ({ name }) => {
      setCreateKind(null);
      setFeedback({ text: `${name} 已创建，从全空权限开始。`, error: false });
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
      setFeedback({ text: "角色已生效，不用重新登录。", error: false });
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
      setFeedback({ text: "权限已生效，不用重新登录。", error: false });
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
        description="上面是谁能登进来，下面是每个角色能碰哪几格。一屏看全，只有系统管理员看得到。"
        actions={
          <>
            <Button variant="outline" onClick={() => setCreateKind("role")}><Plus />新建角色</Button>
            <Button onClick={() => setCreateKind("user")}><Plus />建号</Button>
          </>
        }
      />
      <div className="flex max-w-[1100px] flex-col gap-5 p-4 sm:p-5">
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
            <section className="flex flex-col gap-3" aria-labelledby="users-heading">
              <h2 id="users-heading" className="flex items-baseline gap-2 text-base font-semibold">
                用户 <span className="font-mono text-xs font-normal text-muted-foreground">{users.length}</span>
              </h2>
              <div className="overflow-x-auto overscroll-x-contain rounded-md border border-border">
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
                            {user.isSystemAdmin ? <Badge>系统管理员</Badge> : null}
                            {user.mustChangePassword ? <Badge className="bg-warning/10 text-warning">待改密</Badge> : null}
                          </div>
                        </td>
                        <td className="max-w-48 truncate px-3 py-2.5 text-muted-foreground" title={user.displayName ?? undefined}>{user.displayName ?? "—"}</td>
                        <td className="px-3 py-2.5">
                          {user.isSystemAdmin ? (
                            <span className="text-muted-foreground">权限全开</span>
                          ) : (
                            <select
                              aria-label={`${user.username} 的角色`}
                              value={user.roleId ?? ""}
                              disabled={updateUser.isPending}
                              onChange={(event) => updateUser.mutate({ user, roleId: event.target.value === "" ? null : Number(event.target.value) })}
                              className={`h-7 max-w-44 rounded-md border px-1.5 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 ${user.roleId === null ? "border-warning/50 bg-warning/10 text-warning" : "border-border bg-background"}`}
                            >
                              <option value="">还没授角色</option>
                              {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                            </select>
                          )}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs whitespace-nowrap text-muted-foreground">{localMinute(user.createdAt)}</td>
                        <td className="px-3 py-2.5 text-xs whitespace-nowrap text-muted-foreground">{user.lastLoginAt === null ? "从未" : <span className="font-mono">{localMinute(user.lastLoginAt)}</span>}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex justify-end gap-1 whitespace-nowrap">
                            <Button variant="ghost" size="xs" onClick={() => setConfirm({ kind: "reset", id: user.username, label: user.username })}><KeyRound />重置密码</Button>
                            <Button variant="ghost" size="xs" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setConfirm({ kind: "delete-user", id: user.username, label: user.username })}><Trash2 />删号</Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="flex flex-col gap-3" aria-labelledby="permissions-heading">
              <h2 id="permissions-heading" className="text-base font-semibold">权限</h2>
              <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                <p className="text-muted-foreground"><span className="font-medium text-foreground">系统管理员</span>不在矩阵里：权限全开、不可编辑，而且可以有多个（<span className="font-mono">{adminCount}</span> 人）。下面这些格子只管自定义角色。</p>
              </div>
              {unclaimed.size === 0 || roles.length === 0 ? null : (
                <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-warning">
                  有 <span className="font-mono">{unclaimed.size}</span> 格权限从未被任何角色勾过。除系统管理员外，没人能使用它盖住的功能。
                </div>
              )}
              {roles.length === 0 ? (
                <Card className="items-start gap-2 px-4 py-5">
                  <p className="font-medium">还没有任何角色，所以矩阵还没有一列</p>
                  <p className="text-muted-foreground">角色不预置。新建角色会从全空开始；在那之前，除系统管理员外没人能使用任何页面。</p>
                  <Button className="mt-1" onClick={() => setCreateKind("role")}><Plus />新建角色</Button>
                </Card>
              ) : (
                <div className="overflow-x-auto overscroll-x-contain rounded-md border border-border">
                  <table className="w-full min-w-max border-collapse text-left">
                    <thead>
                      <tr className="bg-muted text-xs text-muted-foreground">
                        <th scope="col" className="sticky left-0 z-10 min-w-56 bg-muted px-3 py-2 font-medium sm:min-w-72">权限格</th>
                        {roles.map((role) => (
                          <th key={role.id} scope="col" className="w-36 min-w-36 max-w-36 border-l border-border px-3 py-2 text-center font-medium">
                            <span className="block break-words text-foreground" title={role.name}>{role.name}</span>
                            <span className="block font-normal"><span className="font-mono">{users.filter((user) => user.roleId === role.id).length}</span> 人</span>
                            <Button variant="ghost" size="xs" className="mt-1 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setConfirm({ kind: "delete-role", id: String(role.id), label: role.name })}><Trash2 />删除</Button>
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
                                  <span className="font-mono text-xs text-muted-foreground">{permission.id}</span>
                                  {missing ? <span className="text-xs text-warning">未启用</span> : null}
                                </div>
                                <p className="text-xs text-muted-foreground">{permission.hint}</p>
                              </td>
                              {roles.map((role) => {
                                const impliedBy = permissionImpliedBy(permission.id);
                                const implied =
                                  impliedBy !== undefined && role.permissions.includes(impliedBy);
                                return (
                                  <td key={role.id} className="border-l border-border px-3 py-1.5 text-center">
                                    <label className="inline-flex min-h-8 cursor-pointer flex-col items-center justify-center rounded-md px-1 hover:bg-muted focus-within:ring-3 focus-within:ring-ring/50 has-disabled:cursor-not-allowed has-disabled:opacity-70">
                                      <input
                                        type="checkbox"
                                        aria-label={`${role.name} ${permission.id}${implied ? `，由 ${impliedBy} 包含` : ""}`}
                                        checked={roleHasPermission(role.permissions, permission.id)}
                                        disabled={updateRole.isPending || implied}
                                        onChange={() => updateRole.mutate({ role, permission: permission.id })}
                                        className="size-4 accent-primary outline-none"
                                      />
                                      {implied ? <span className="text-[10px] text-muted-foreground">随写生效</span> : null}
                                    </label>
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
      </div>
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
                  : `删除账号 ${confirm?.label}？它的现有会话会一起作废，且无法撤销。`}
            </DialogDescription>
          </DialogHeader>
          {confirm?.kind === "reset" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reset-password">临时密码</Label>
              <Input id="reset-password" type="password" autoComplete="new-password" autoFocus value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} />
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">取消</Button></DialogClose>
            <Button
              variant={confirm?.kind === "reset" ? "default" : "destructive"}
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
            <DialogTitle>{kind === "user" ? "建号" : "新建角色"}</DialogTitle>
            <DialogDescription>{kind === "user" ? "新账号先没有角色，首次登录必须改密码。" : "角色从全空权限开始，建好后在矩阵里逐格勾选。"}</DialogDescription>
          </DialogHeader>
          {kind === "user" ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-username">用户名</Label>
                <Input id="new-username" autoFocus value={username} onChange={(event) => setUsername(event.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-display-name">显示名</Label>
                <Input id="new-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="可留空" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-password">临时密码</Label>
                <Input id="new-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-role-name">角色名</Label>
              <Input id="new-role-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} />
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="outline">取消</Button></DialogClose>
            <Button type="submit" disabled={busy || (kind === "user" ? username === "" || password === "" : name === "")}>{busy ? "创建中…" : "创建"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
