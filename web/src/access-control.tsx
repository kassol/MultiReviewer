import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircledIcon, Cross2Icon, CrossCircledIcon, ExclamationTriangleIcon, LockClosedIcon, PlusIcon, ResetIcon, TrashIcon } from "@radix-ui/react-icons";
import { AlertDialog, Badge, Callout, Checkbox, Dialog, Flex, IconButton, Select, Skeleton, Table, Text, TextField, Tooltip } from "@radix-ui/themes";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import { EmptyState } from "@/components/empty-state";
import { HelpTooltip } from "@/components/help-tooltip";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
import { useDialogReturnFocus } from "@/components/use-dialog-return-focus";
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
  const confirmFallbackId = useRef<"create-user-trigger" | "create-role-trigger">("create-user-trigger");
  const confirmFocus = useDialogReturnFocus(() =>
    document.getElementById(confirmFallbackId.current)
      ?? document.getElementById("create-user-trigger")
      ?? document.getElementById("create-role-trigger"),
  );

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

  const openCreateDialog = (kind: "user" | "role"): void => {
    createUser.reset();
    createRole.reset();
    setFeedback(null);
    setCreateKind(kind);
  };

  const closeCreateDialog = (): void => {
    setCreateKind(null);
    createUser.reset();
    createRole.reset();
    setFeedback(null);
  };

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
      if (target.kind === "reset") {
        refresh();
      } else {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: ["users"] }),
          queryClient.invalidateQueries({ queryKey: ["roles"] }),
        ]).then(() => confirmFocus.restoreFocus());
      }
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
      <PageBody width="form" className="gap-4 pb-5 sm:pb-5">
        <PageHeader
          title="访问控制"
        />
        {feedback === null ? null : (
          <Callout.Root role={feedback.error ? "alert" : "status"} color={feedback.error ? "red" : "green"} size="1">
            <Callout.Icon>
              {feedback.error ? <CrossCircledIcon aria-hidden /> : <CheckCircledIcon aria-hidden />}
            </Callout.Icon>
            <Callout.Text>{feedback.text}</Callout.Text>
          </Callout.Root>
        )}
        {loadError === null ? null : (
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>{(loadError as Error).message}</Callout.Text>
          </Callout.Root>
        )}
        {pending ? (
          <div className="flex flex-col gap-5" role="status" aria-label="正在加载访问控制" aria-busy="true">
            <Skeleton aria-hidden className="h-56" />
            <Skeleton aria-hidden className="h-80" />
          </div>
        ) : (
          <>
            <section
              className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-card-line bg-surface shadow-card sm:rounded-lg"
              aria-labelledby="users-heading"
            >
              <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-[11px] sm:px-5">
                <h2 id="users-heading" className="flex items-baseline gap-2 text-2xl font-bold tracking-[-0.015em]">
                  用户 <span className="font-mono text-xs font-normal text-text-muted">{users.length}</span>
                </h2>
                <CreateDialog
                  kind="user"
                  open={createKind === "user"}
                  busy={createUser.isPending}
                  trigger={<Button id="create-user-trigger" variant="solid" size={{ initial: "4", sm: "2" }}><PlusIcon />新建用户</Button>}
                  onOpen={() => openCreateDialog("user")}
                  onClose={closeCreateDialog}
                  onUser={(input) => { setFeedback(null); createUser.mutate(input); }}
                  onRole={(name) => { setFeedback(null); createRole.mutate(name); }}
                />
              </div>
              <div className="contain-inline-size min-w-0 max-w-full overflow-x-auto overscroll-x-contain border-t border-line">
                <Table.Root size="2" className="w-full min-w-max">
                  <caption className="sr-only">用户、角色和账号状态</caption>
                  <Table.Header className="bg-sunken text-sm font-bold text-text-muted">
                    <Table.Row>
                      <Table.ColumnHeaderCell className="sticky left-0 z-20 bg-sunken">用户名</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell>显示名</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell>角色</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell>创建</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell>最后登录</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell><span className="sr-only">操作</span></Table.ColumnHeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {users.map((user) => (
                      <Table.Row key={user.username} align="start" className="group hover:bg-sunken">
                        <Table.RowHeaderCell className="sticky left-0 z-10 bg-surface font-semibold group-hover:bg-sunken">
                          <div className="flex max-w-64 flex-wrap items-center gap-[9px]">
                            <span
                              aria-hidden
                              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                                user.isSystemAdmin ? "bg-[image:var(--v8-avatar-gradient)] text-white" : "bg-fill text-text-secondary"
                              }`}
                            >
                              {user.username.slice(0, 1).toUpperCase()}
                            </span>
                            <Tooltip content={user.username}>
                              <span
                                tabIndex={0}
                                className="max-w-56 truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                              >
                                {user.username}
                              </span>
                            </Tooltip>
                            {user.isSystemAdmin ? <Badge color="gray" variant="soft">系统管理员</Badge> : null}
                            {user.mustChangePassword ? <StatusBadge tone="warning">待改密</StatusBadge> : null}
                          </div>
                        </Table.RowHeaderCell>
                        <Table.Cell className="max-w-48 text-text-muted">
                          {user.displayName === null ? "—" : (
                            <Tooltip content={user.displayName}>
                              <span
                                tabIndex={0}
                                className="block max-w-48 truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                              >
                                {user.displayName}
                              </span>
                            </Tooltip>
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          {user.isSystemAdmin ? (
                            <span className="text-text-muted">全部权限</span>
                          ) : (
                            <Select.Root
                              size={{ initial: "3", sm: "2" }}
                              value={user.roleId === null ? "unassigned" : String(user.roleId)}
                              disabled={updateUser.isPending}
                              onValueChange={(value) => updateUser.mutate({
                                user,
                                roleId: value === "unassigned" ? null : Number(value),
                              })}
                            >
                              <Select.Trigger
                                aria-label={`${user.username} 的角色`}
                                color={user.roleId === null ? "amber" : "gray"}
                                className="max-w-44 max-sm:min-h-11"
                              />
                              <Select.Content position="popper" color="gray">
                                <Select.Item value="unassigned">未分配角色</Select.Item>
                                {roles.map((role) => (
                                  <Select.Item key={role.id} value={String(role.id)}>{role.name}</Select.Item>
                                ))}
                              </Select.Content>
                            </Select.Root>
                          )}
                        </Table.Cell>
                        <Table.Cell className="font-mono text-xs whitespace-nowrap text-text-muted">{localMinute(user.createdAt)}</Table.Cell>
                        <Table.Cell className="text-xs whitespace-nowrap text-text-muted">{user.lastLoginAt === null ? "从未" : <span className="font-mono">{localMinute(user.lastLoginAt)}</span>}</Table.Cell>
                        <Table.Cell>
                          <div className="flex justify-end gap-1 whitespace-nowrap">
                            <Button variant="ghost" color="gray" size={{ initial: "4", sm: "1" }} onClick={(event) => { confirmFallbackId.current = "create-user-trigger"; confirmFocus.captureTrigger(event); setConfirm({ kind: "reset", id: user.username, label: user.username }); }}><ResetIcon />重置密码</Button>
                            <Button variant="ghost" color="red" size={{ initial: "4", sm: "1" }} onClick={(event) => { confirmFallbackId.current = "create-user-trigger"; confirmFocus.captureTrigger(event); setConfirm({ kind: "delete-user", id: user.username, label: user.username }); }}><TrashIcon />删除用户</Button>
                          </div>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </div>
            </section>

            <section
              className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-card-line bg-surface shadow-card sm:rounded-lg"
              aria-labelledby="permissions-heading"
            >
              <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-[11px] sm:px-5">
                <h2 id="permissions-heading" className="text-2xl font-bold tracking-[-0.015em]">权限矩阵</h2>
                <CreateDialog
                  kind="role"
                  open={createKind === "role"}
                  busy={createRole.isPending}
                  trigger={<Button id="create-role-trigger" variant="soft" color="gray" size={{ initial: "4", sm: "2" }}><PlusIcon />新建角色</Button>}
                  onOpen={() => openCreateDialog("role")}
                  onClose={closeCreateDialog}
                  onUser={(input) => { setFeedback(null); createUser.mutate(input); }}
                  onRole={(name) => { setFeedback(null); createRole.mutate(name); }}
                />
              </div>
              <div className="flex flex-col gap-3 border-t border-line px-4 py-3 sm:px-5">
                <div className="flex items-start gap-2 rounded-lg bg-sunken px-3 py-2">
                  <LockClosedIcon className="mt-0.5 size-4 shrink-0" />
                  <p className="min-w-0 flex-1 text-text-muted"><span className="font-medium text-text">系统管理员</span>不参与矩阵，始终拥有全部权限（当前 <span className="font-mono">{adminCount}</span> 位）。下方仅管理自定义角色。</p>
                </div>
                {unclaimed.size === 0 || roles.length === 0 ? null : (
                  <Callout.Root color="amber" size="1">
                    <Callout.Icon><ExclamationTriangleIcon aria-hidden /></Callout.Icon>
                    <Callout.Text>
                      有 <span className="font-mono">{unclaimed.size}</span> 项权限尚未授予任何角色。除系统管理员外，相关功能当前无人可用。
                    </Callout.Text>
                  </Callout.Root>
                )}
              </div>
              {roles.length === 0 ? (
                <div className="border-t border-line px-4 pb-4 sm:px-5">
                  <EmptyState
                    title="还没有角色"
                    action={<Button variant="solid" size={{ initial: "4", sm: "2" }} onClick={() => openCreateDialog("role")}><PlusIcon />新建角色</Button>}
                  />
                </div>
              ) : (
                <div className="contain-inline-size min-w-0 max-w-full overflow-x-auto overscroll-x-contain border-t border-line">
                  <Table.Root size="1" className="w-full min-w-max">
                    <caption className="sr-only">自定义角色权限矩阵</caption>
                    <Table.Header>
                      <Table.Row className="bg-sunken text-sm font-bold text-text-muted">
                        <Table.ColumnHeaderCell className="sticky left-0 z-20 min-w-56 bg-sunken sm:min-w-72">权限</Table.ColumnHeaderCell>
                        {roles.map((role) => (
                          <Table.ColumnHeaderCell key={role.id} className="w-36 min-w-36 max-w-36 border-l border-line text-center">
                            <span className="block break-words text-text">{role.name}</span>
                            <span className="block font-normal"><span className="font-mono">{users.filter((user) => user.roleId === role.id).length}</span> 人</span>
                            <Button variant="ghost" color="red" size={{ initial: "4", sm: "1" }} className="mt-1" onClick={(event) => { confirmFallbackId.current = "create-role-trigger"; confirmFocus.captureTrigger(event); setConfirm({ kind: "delete-role", id: String(role.id), label: role.name }); }}><TrashIcon />删除</Button>
                          </Table.ColumnHeaderCell>
                        ))}
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {RESOURCES.flatMap((resource) => [
                        <Table.Row key={`${resource}-heading`} className="bg-sunken">
                          <Table.Cell colSpan={roles.length + 1} className="sticky left-0 text-xs font-medium text-text-muted">{resource}</Table.Cell>
                        </Table.Row>,
                        ...PERMISSION_INFO.filter((permission) => permission.resource === resource).map((permission) => {
                          const missing = unclaimed.has(permission.id);
                          return (
                            <Table.Row key={permission.id} className={missing ? "bg-warning-tint" : undefined}>
                              <Table.RowHeaderCell className={`sticky left-0 z-10 min-w-56 sm:min-w-72 ${missing ? "bg-[color-mix(in_oklab,var(--v8-warning-icon)_10%,var(--v8-surface))]" : "bg-surface"}`}>
                                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                  <span className="font-medium">{permission.action}</span>
                                  <HelpTooltip label={`${permission.resource}${permission.action}权限说明`} content={permission.hint} />
                                  {missing ? <span className="text-xs text-warning">尚未授予</span> : null}
                                </div>
                              </Table.RowHeaderCell>
                              {roles.map((role) => {
                                const impliedBy = permissionImpliedBy(permission.id);
                                const implied =
                                  impliedBy !== undefined && role.permissions.includes(impliedBy);
                                return (
                                  <Table.Cell key={role.id} className="border-l border-line text-center">
                                    <Text as="label" size="2" className="inline-flex min-h-8 cursor-pointer flex-col items-center justify-center rounded-sm px-1 max-sm:min-h-11 max-sm:min-w-11 hover:bg-sunken focus-within:ring-2 focus-within:ring-ring/25 focus-within:ring-offset-1 focus-within:ring-offset-background has-disabled:cursor-not-allowed has-disabled:opacity-70">
                                      <Checkbox
                                        size="2"
                                        aria-label={`${role.name}的${permission.resource}${permission.action}权限${implied ? "，已随管理权限授予" : ""}`}
                                        checked={roleHasPermission(role.permissions, permission.id)}
                                        disabled={updateRole.isPending || implied}
                                        onCheckedChange={() => updateRole.mutate({ role, permission: permission.id })}
                                      />
                                      {implied ? <span className="text-xs text-text-muted">随管理权限生效</span> : null}
                                    </Text>
                                  </Table.Cell>
                                );
                              })}
                            </Table.Row>
                          );
                        }),
                      ])}
                    </Table.Body>
                  </Table.Root>
                </div>
              )}
            </section>
          </>
        )}
      </PageBody>
      <AlertDialog.Root open={confirm !== null} onOpenChange={(open) => { if (!open) { setConfirm(null); setResetPassword(""); } }}>
        <AlertDialog.Content onCloseAutoFocus={confirmFocus.onCloseAutoFocus} maxWidth="440px" maxHeight="calc(100dvh - 2rem)" size={{ initial: "2", sm: "3" }}>
          <AlertDialog.Title size="4" mb="2">{confirm?.kind === "reset" ? "重置密码" : "确认删除"}</AlertDialog.Title>
          <AlertDialog.Description size="2" color="gray" className="break-words">
            {confirm?.kind === "reset"
              ? `为 ${confirm.label} 设置一枚临时密码。现有会话会全部作废，下次登录必须改密码。`
              : confirm?.kind === "delete-role"
                ? `删除角色 ${confirm.label}？仍有人使用时服务会拒绝删除。`
                : `删除用户 ${confirm?.label}？其现有会话会一起作废，且无法撤销。`}
          </AlertDialog.Description>
          {confirm?.kind === "reset" ? (
            <div className="mt-4 flex flex-col gap-1.5">
              <Text as="label" htmlFor="reset-password" size="2" weight="medium">临时密码</Text>
              <TextField.Root id="reset-password" type="password" size={{ initial: "3", sm: "2" }} className="min-w-0 w-full max-sm:min-h-11" autoComplete="new-password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} />
            </div>
          ) : null}
          <Flex gap="3" mt="4" justify="end" direction={{ initial: "column-reverse", sm: "row" }}>
            <AlertDialog.Cancel><Button variant="outline" color="gray" size={{ initial: "4", sm: "2" }}>取消</Button></AlertDialog.Cancel>
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
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}

function CreateDialog({ kind, open, busy, trigger, onOpen, onClose, onUser, onRole }: { kind: "user" | "role"; open: boolean; busy: boolean; trigger: ReactNode; onOpen: () => void; onClose: () => void; onUser: (input: { username: string; displayName: string; password: string }) => void; onRole: (name: string) => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const submit = (event: FormEvent): void => { event.preventDefault(); if (kind === "user") onUser({ username, displayName, password }); else if (kind === "role") onRole(name); };
  useEffect(() => {
    if (open) return;
    setUsername("");
    setDisplayName("");
    setPassword("");
    setName("");
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (nextOpen) onOpen(); else onClose(); }}>
      <Dialog.Trigger>{trigger}</Dialog.Trigger>
      <Dialog.Content maxWidth="440px" maxHeight="calc(100dvh - 2rem)" size={{ initial: "2", sm: "3" }}>
        <form onSubmit={submit} className="flex flex-col gap-4" aria-busy={busy}>
          <div className="pr-9">
            <Dialog.Title size="4" mb="2">{kind === "user" ? "新建用户" : "新建角色"}</Dialog.Title>
            <Dialog.Description size="2" color="gray">{kind === "user" ? "新用户初始未分配角色，首次登录必须修改密码。" : "角色初始不包含任何权限，可在权限矩阵中授予权限。"}</Dialog.Description>
          </div>
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
          <Flex gap="3" justify="end" direction={{ initial: "column-reverse", sm: "row" }}>
            <Dialog.Close><Button type="button" variant="outline" color="gray" size={{ initial: "4", sm: "2" }}>取消</Button></Dialog.Close>
            <Button type="submit" variant="solid" size={{ initial: "4", sm: "2" }} disabled={busy || (kind === "user" ? username === "" || password === "" : name === "")}>{busy ? "创建中…" : "创建"}</Button>
          </Flex>
        </form>
        <div className="absolute top-3 right-3">
          <Tooltip content="关闭新建窗口">
            <Dialog.Close>
              <IconButton
                variant="ghost"
                color="gray"
                size={{ initial: "3", sm: "1" }}
                className="max-sm:min-h-11 max-sm:min-w-11"
                aria-label="关闭新建窗口"
              >
                <Cross2Icon aria-hidden />
              </IconButton>
            </Dialog.Close>
          </Tooltip>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
