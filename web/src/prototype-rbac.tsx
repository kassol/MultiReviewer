/**
 * 原型:面板门禁换成用户账号与自定义角色 RBAC 的三屏形状(issue #104)。
 *
 * 三个变体在同一条路由上,`?variant=A|B|C` 切换;另有一排「库状态」按钮切场景,
 * 因为这一票要看的有一半是空态与零权限视角,它们与变体是两个维度。
 *
 * 一次性代码,留在 prototype/rbac-panel 分支,不进主干:没有测试、没有错误处理、
 * 数据全在内存里,写请求一个都不发。
 */
import { useNavigate, useSearch } from "@tanstack/react-router";
import { KeyRound, LogOut, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";

import { Mark } from "@/components/mark";
import { PageHeader } from "@/components/page-header";
import { PrototypeSwitcher } from "@/components/prototype-switcher";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ---------------------------------------------------------------- 假数据

type Perm = {
  id: string;
  resource: string;
  action: string;
  hint: string;
};

/** 八格,取自 issue #97 的定稿。 */
const PERMS: readonly Perm[] = [
  { id: "repo:read", resource: "仓库", action: "读", hint: "仓库列表、hook 核对" },
  {
    id: "repo:write",
    resource: "仓库",
    action: "写",
    hint: "搜索、注册、移除、改组合、轮转 Key",
  },
  { id: "review:read", resource: "评审", action: "读", hint: "评审记录、处置率" },
  {
    id: "review:rerun",
    resource: "评审",
    action: "重跑",
    hint: "开一轮 Review Run:花钱,并在 PR 上发评论",
  },
  {
    id: "model:read",
    resource: "模型",
    action: "读",
    hint: "全局设置、模型目录、模型行、自定义 provider",
  },
  {
    id: "model:write",
    resource: "模型",
    action: "写",
    hint: "改组合、手填模型行、加删自定义 provider",
  },
  { id: "credential:read", resource: "凭据", action: "读", hint: "凭据列表,含 key 尾 4 位" },
  { id: "credential:write", resource: "凭据", action: "写", hint: "写入与删除模型凭据" },
];

const RESOURCES = ["仓库", "评审", "模型", "凭据"] as const;

type Role = { id: number; name: string; perms: string[] };
type User = {
  username: string;
  displayName: string | null;
  roleId: number | null;
  systemAdmin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
};

const ROLES: readonly Role[] = [
  { id: 1, name: "运维", perms: ["repo:read", "repo:write", "review:read"] },
  { id: 2, name: "只读", perms: ["repo:read", "review:read", "model:read"] },
  {
    id: 3,
    name: "模型管家",
    perms: ["review:read", "model:read", "model:write", "credential:read", "credential:write"],
  },
];

const USERS: readonly User[] = [
  {
    username: "kassol",
    displayName: "Kassol",
    roleId: null,
    systemAdmin: true,
    createdAt: "2026-08-19 09:12",
    lastLoginAt: "2026-08-19 11:40",
    mustChangePassword: false,
  },
  {
    username: "zhang.wei",
    displayName: "张伟",
    roleId: 1,
    systemAdmin: false,
    createdAt: "2026-08-19 09:30",
    lastLoginAt: "2026-08-19 10:05",
    mustChangePassword: false,
  },
  {
    username: "li.na",
    displayName: null,
    roleId: 3,
    systemAdmin: false,
    createdAt: "2026-08-19 09:31",
    lastLoginAt: "2026-08-19 09:58",
    mustChangePassword: false,
  },
  {
    username: "chen.yu",
    displayName: "陈宇",
    // 系统管理员不带角色(issue #100 的 CHECK 约束),所以这一行的角色是空的。
    roleId: null,
    systemAdmin: true,
    createdAt: "2026-08-19 09:33",
    lastLoginAt: null,
    mustChangePassword: true,
  },
  {
    username: "new.hire",
    displayName: "新同事",
    roleId: null,
    systemAdmin: false,
    createdAt: "2026-08-19 10:44",
    lastLoginAt: "2026-08-19 10:46",
    mustChangePassword: false,
  },
];

const REAL_NAV = [
  { to: "/repos", label: "仓库", perm: "repo:read" },
  { to: "/runs", label: "评审记录", perm: "review:read" },
  { to: "/stats", label: "处置率", perm: "review:read" },
  { to: "/credentials", label: "模型凭据", perm: "credential:read" },
  { to: "/settings", label: "全局设置", perm: "model:read" },
] as const;

type Scenario = "normal" | "zero-role" | "no-perm" | "bootstrap" | "login";

// ---------------------------------------------------------------- 共用小件

/** 假壳:导航项由变体决定,点了只切本地状态,不真跳路由。 */
function FakeShell({
  items,
  active,
  onPick,
  disabledNav,
  children,
}: {
  items: readonly { key: string; label: string; admin?: boolean; hint?: string }[];
  active: string;
  onPick: (key: string) => void;
  disabledNav?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-dvh flex-col sm:grid sm:grid-cols-[200px_1fr]">
      <aside className="flex shrink-0 flex-col border-border bg-chrome max-sm:flex-row max-sm:items-center max-sm:overflow-x-auto max-sm:border-b sm:border-r">
        <div className="flex shrink-0 items-center gap-2 border-border px-3 py-3.5 max-sm:py-2.5 sm:border-b">
          <Mark className="size-4" />
          <span className="font-semibold tracking-tight">MultiReviewer</span>
        </div>
        <nav aria-label="面板导航" className="flex shrink-0 gap-0.5 p-2 sm:flex-col">
          {items.map((item) => {
            const current = item.key === active;
            return (
              <button
                key={item.key}
                type="button"
                disabled={disabledNav === true && !current}
                // 置灰那一档要说清差哪一格,否则「点不动」没有下一步。
                title={disabledNav === true && !current ? item.hint : undefined}
                onClick={() => onPick(item.key)}
                aria-current={current ? "page" : undefined}
                className={
                  "flex h-10 items-center gap-1.5 rounded-md px-3 text-left whitespace-nowrap transition-colors sm:h-8 " +
                  (current
                    ? "bg-background font-medium text-foreground shadow-[0_0_0_1px_var(--border)]"
                    : "text-muted-foreground hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-40")
                }
              >
                {item.admin === true ? <ShieldCheck className="size-3.5 opacity-70" /> : null}
                {item.label}
              </button>
            );
          })}
        </nav>
        <button
          type="button"
          className="flex h-10 shrink-0 items-center gap-1.5 px-4 whitespace-nowrap text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground max-sm:ml-auto sm:mt-auto sm:mb-2 sm:h-9"
        >
          <LogOut className="size-3.5" />
          登出
        </button>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-auto pb-16">{children}</main>
    </div>
  );
}

function Pill({ tone, children }: { tone: "muted" | "warning" | "ink"; children: React.ReactNode }) {
  const cls =
    tone === "ink"
      ? "bg-primary text-primary-foreground"
      : tone === "warning"
        ? "bg-warning/12 text-warning"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${cls}`}>
      {children}
    </span>
  );
}

/** 「从未被任何角色勾过」的判据:常量集减去库里勾过的那些。纯派生,不存版本号。 */
function unclaimed(roles: readonly Role[]): string[] {
  const claimed = new Set(roles.flatMap((role) => role.perms));
  return PERMS.filter((perm) => !claimed.has(perm.id)).map((perm) => perm.id);
}

function UnclaimedBanner({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div className="rounded-md border border-warning/40 bg-warning/8 px-3 py-2 text-warning">
      有 <span className="font-mono tabular-nums">{count}</span> 格权限从未被任何角色勾过。
      除系统管理员外没人用得上它盖住的功能。
    </div>
  );
}

function useToggleMatrix(initial: readonly Role[]) {
  const [roles, setRoles] = useState<Role[]>(initial.map((role) => ({ ...role })));
  function toggle(roleId: number, perm: string): void {
    setRoles((previous) =>
      previous.map((role) =>
        role.id === roleId
          ? {
              ...role,
              perms: role.perms.includes(perm)
                ? role.perms.filter((item) => item !== perm)
                : [...role.perms, perm],
            }
          : role,
      ),
    );
  }
  return { roles, toggle };
}

function roleName(roles: readonly Role[], id: number | null): string {
  if (id === null) return "—";
  return roles.find((role) => role.id === id)?.name ?? "—";
}

// ---------------------------------------------------------------- 用户表(A / C 共用形状)

function UsersTable({
  roles,
  dense,
}: {
  roles: readonly Role[];
  dense?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <table className="w-full border-collapse text-left">
        <thead className="bg-muted/60 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">用户名</th>
            <th className="px-3 py-2 font-medium">角色</th>
            <th className="px-3 py-2 font-medium">创建</th>
            <th className="px-3 py-2 font-medium">最后登录</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {USERS.map((user) => (
            <tr key={user.username} className="border-t border-border">
              <td className={dense === true ? "px-3 py-1.5" : "px-3 py-2.5"}>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{user.username}</span>
                  {user.displayName === null ? null : (
                    <span className="text-muted-foreground">{user.displayName}</span>
                  )}
                  {user.systemAdmin ? <Pill tone="ink">系统管理员</Pill> : null}
                  {user.mustChangePassword ? <Pill tone="warning">待改密</Pill> : null}
                </div>
              </td>
              <td className="px-3 py-2">
                {user.systemAdmin ? (
                  // 系统管理员不带角色(CHECK 约束),这一格没有可选项。
                  <span className="text-muted-foreground">权限全开</span>
                ) : (
                  // 改角色是这一页最高频的动作,而它不破坏:行内下拉,选完当场生效。
                  <select
                    aria-label={`${user.username} 的角色`}
                    defaultValue={String(user.roleId ?? "")}
                    className={
                      "h-7 rounded-md border px-1.5 " +
                      (user.roleId === null
                        ? "border-warning/50 bg-warning/8 text-warning"
                        : "border-border bg-background")
                    }
                  >
                    <option value="">还没授角色</option>
                    {roles.map((role) => (
                      <option key={role.id} value={String(role.id)}>
                        {role.name}
                      </option>
                    ))}
                  </select>
                )}
              </td>
              <td className="px-3 py-2 font-mono text-xs tabular-nums text-muted-foreground">
                {user.createdAt}
              </td>
              <td className="px-3 py-2 font-mono text-xs tabular-nums text-muted-foreground">
                {user.lastLoginAt ?? "从未"}
              </td>
              <td className="px-3 py-2">
                {/* 破坏性的那两个照仓库页的既定做法走二次确认对话框。 */}
                <div className="flex items-center justify-end gap-1">
                  <Button variant="ghost" size="xs">
                    <KeyRound /> 重置密码
                  </Button>
                  <Button variant="ghost" size="xs" className="text-destructive">
                    <Trash2 /> 删号
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- 变体 A:两页并列

function VariantA({ scenario }: { scenario: Scenario }) {
  const seed = scenario === "zero-role" ? [] : ROLES;
  const { roles, toggle } = useToggleMatrix(seed);
  const [page, setPage] = useState(scenario === "zero-role" ? "roles" : "users");
  const missing = unclaimed(roles);

  const items = [
    ...REAL_NAV.map((item) => ({ key: item.to, label: item.label })),
    { key: "users", label: "用户", admin: true },
    { key: "roles", label: "角色与权限", admin: true },
  ];

  return (
    <FakeShell items={items} active={page} onPick={setPage}>
      {page === "users" ? (
        <>
          <PageHeader
            title="用户"
            description="谁能登进这个面板。建号、改角色、重置密码、删号都在这里,只有系统管理员看得到这一页。"
            actions={
              <Button>
                <Plus /> 建号
              </Button>
            }
          />
          <div className="flex flex-col gap-3 p-5">
            <UsersTable roles={roles} />
          </div>
        </>
      ) : (
        <>
          <PageHeader
            title="角色与权限"
            description="一个用户一个角色,角色决定它能碰哪几格。管人这件事不在这张表里——只有系统管理员能做。"
            actions={
              <Button>
                <Plus /> 新建角色
              </Button>
            }
          />
          <div className="flex flex-col gap-3 p-5">
            <UnclaimedBanner count={missing.length} />
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 opacity-70" />
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">系统管理员</span>
                不在这张表里:它权限全开、不可编辑,且可以有多个(
                <span className="font-mono tabular-nums">2</span> 人)。它与自定义角色不共用名字。
              </p>
            </div>
            {roles.length === 0 ? (
              <Card className="items-start gap-2 px-4 py-5">
                <p className="font-medium">还没有任何角色</p>
                <p className="text-muted-foreground">
                  一个角色都不预置。建一个角色就是在这张表上勾几个框——建好之后才能把人从「还没授角色」挪进来。
                </p>
                <Button className="mt-1">
                  <Plus /> 新建角色
                </Button>
              </Card>
            ) : (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="bg-muted/60 text-xs text-muted-foreground">
                      <th className="sticky left-0 z-10 bg-muted/60 px-3 py-2 font-medium">角色</th>
                      {RESOURCES.map((resource) => (
                        <th
                          key={resource}
                          colSpan={PERMS.filter((perm) => perm.resource === resource).length}
                          className="border-l border-border px-3 py-2 text-center font-medium"
                        >
                          {resource}
                        </th>
                      ))}
                      <th className="border-l border-border px-3 py-2 font-medium">成员</th>
                    </tr>
                    <tr className="bg-muted/30 text-xs text-muted-foreground">
                      <th className="sticky left-0 z-10 bg-muted/30 px-3 py-1.5" />
                      {PERMS.map((perm, index) => (
                        <th
                          key={perm.id}
                          title={`${perm.id} — ${perm.hint}`}
                          className={
                            "px-3 py-1.5 text-center font-normal " +
                            (index > 0 && PERMS[index - 1]?.resource !== perm.resource
                              ? "border-l border-border"
                              : "")
                          }
                        >
                          <span className={missing.includes(perm.id) ? "text-warning" : ""}>
                            {perm.action}
                          </span>
                          {missing.includes(perm.id) ? (
                            <span className="block text-warning">未启用</span>
                          ) : null}
                        </th>
                      ))}
                      <th className="border-l border-border px-3 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {roles.map((role) => (
                      <tr key={role.id} className="border-t border-border">
                        <td className="sticky left-0 z-10 bg-background px-3 py-2 font-medium whitespace-nowrap">
                          {role.name}
                        </td>
                        {PERMS.map((perm, index) => (
                          <td
                            key={perm.id}
                            className={
                              "px-3 py-2 text-center " +
                              (index > 0 && PERMS[index - 1]?.resource !== perm.resource
                                ? "border-l border-border"
                                : "")
                            }
                          >
                            <input
                              type="checkbox"
                              aria-label={`${role.name} ${perm.id}`}
                              checked={role.perms.includes(perm.id)}
                              onChange={() => toggle(role.id, perm.id)}
                              className="size-4 accent-[#1f2328]"
                            />
                          </td>
                        ))}
                        <td className="border-l border-border px-3 py-2 text-muted-foreground">
                          <span className="font-mono tabular-nums">
                            {USERS.filter((user) => user.roleId === role.id).length}
                          </span>{" "}
                          人
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button>保存</Button>
              <span className="text-muted-foreground">改完立刻生效,不用重新登录。</span>
            </div>
          </div>
        </>
      )}
    </FakeShell>
  );
}

// ---------------------------------------------------------------- 变体 B:一页两栏

function VariantB({ scenario }: { scenario: Scenario }) {
  const seed = scenario === "zero-role" ? [] : ROLES;
  const { roles, toggle } = useToggleMatrix(seed);
  const [sel, setSel] = useState<{ kind: "user" | "role"; id: string } | null>(
    scenario === "zero-role" ? null : { kind: "role", id: "1" },
  );

  const items = [
    ...REAL_NAV.map((item) => ({ key: item.to, label: item.label })),
    { key: "members", label: "成员与角色", admin: true },
  ];
  const missing = unclaimed(roles);
  const role =
    sel?.kind === "role" ? roles.find((item) => String(item.id) === sel.id) : undefined;
  const user =
    sel?.kind === "user" ? USERS.find((item) => item.username === sel.id) : undefined;

  return (
    <FakeShell items={items} active="members" onPick={() => undefined}>
      <PageHeader
        title="成员与角色"
        description="左边挑一个人或一个角色,右边改它。只有系统管理员看得到这一页。"
      />
      <div className="grid gap-4 p-5 lg:grid-cols-[320px_1fr]">
        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">用户</h2>
              <Button variant="outline" size="xs">
                <Plus /> 建号
              </Button>
            </div>
            <div className="overflow-hidden rounded-md border border-border">
              {USERS.map((item, index) => (
                <button
                  key={item.username}
                  type="button"
                  onClick={() => setSel({ kind: "user", id: item.username })}
                  className={
                    "flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors " +
                    (index > 0 ? "border-t border-border " : "") +
                    (sel?.kind === "user" && sel.id === item.username
                      ? "bg-muted"
                      : "hover:bg-muted/50")
                  }
                >
                  <span className="flex items-center gap-1.5">
                    <span className="font-medium">{item.username}</span>
                    {item.systemAdmin ? <Pill tone="ink">管理员</Pill> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {item.systemAdmin && item.roleId === null
                      ? "权限全开"
                      : item.roleId === null
                        ? "还没授角色"
                        : roleName(roles, item.roleId)}
                  </span>
                </button>
              ))}
            </div>
          </section>
          <section className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">角色</h2>
              <Button variant="outline" size="xs">
                <Plus /> 新建
              </Button>
            </div>
            {roles.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-4 text-muted-foreground">
                一个角色都没有。一个都不预置,先建一个再把人挪进来。
              </p>
            ) : (
              <div className="overflow-hidden rounded-md border border-border">
                {roles.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSel({ kind: "role", id: String(item.id) })}
                    className={
                      "flex w-full items-center justify-between px-3 py-2 text-left transition-colors " +
                      (index > 0 ? "border-t border-border " : "") +
                      (sel?.kind === "role" && sel.id === String(item.id)
                        ? "bg-muted"
                        : "hover:bg-muted/50")
                    }
                  >
                    <span className="font-medium">{item.name}</span>
                    <span className="text-xs text-muted-foreground">
                      <span className="font-mono tabular-nums">{item.perms.length}</span>/
                      <span className="font-mono tabular-nums">{PERMS.length}</span> 格 ·{" "}
                      <span className="font-mono tabular-nums">
                        {USERS.filter((u) => u.roleId === item.id).length}
                      </span>{" "}
                      人
                    </span>
                  </button>
                ))}
              </div>
            )}
            <p className="flex items-start gap-1.5 text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
              系统管理员不是角色:它权限全开、不可编辑,可以有多个,在上面那一列里标出来。
            </p>
          </section>
        </div>

        <div className="min-w-0">
          {role !== undefined ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">{role.name}</h2>
                <span className="text-muted-foreground">
                  <span className="font-mono tabular-nums">{role.perms.length}</span> 格 ·{" "}
                  <span className="font-mono tabular-nums">
                    {USERS.filter((u) => u.roleId === role.id).length}
                  </span>{" "}
                  人在用
                </span>
                <Button variant="ghost" size="xs" className="ml-auto text-destructive">
                  <Trash2 /> 删除角色
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {RESOURCES.map((resource) => (
                  <Card key={resource} className="gap-2 px-4 py-3">
                    <h3 className="text-base font-semibold">{resource}</h3>
                    {PERMS.filter((perm) => perm.resource === resource).map((perm) => (
                      <label
                        key={perm.id}
                        className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-muted/50"
                      >
                        <input
                          type="checkbox"
                          checked={role.perms.includes(perm.id)}
                          onChange={() => toggle(role.id, perm.id)}
                          className="mt-0.5 size-4 accent-[#1f2328]"
                        />
                        <span className="flex min-w-0 flex-col">
                          <span className="flex items-center gap-1.5">
                            <span className="font-medium">{perm.action}</span>
                            <span className="font-mono text-xs text-muted-foreground">
                              {perm.id}
                            </span>
                            {missing.includes(perm.id) ? (
                              <span className="text-xs text-warning">从未被任何角色勾过</span>
                            ) : null}
                          </span>
                          <span className="text-xs text-muted-foreground">{perm.hint}</span>
                        </span>
                      </label>
                    ))}
                  </Card>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Button>保存</Button>
                <span className="text-muted-foreground">改完立刻生效,不用重新登录。</span>
              </div>
            </div>
          ) : user !== undefined ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">{user.username}</h2>
                {user.systemAdmin ? <Pill tone="ink">系统管理员</Pill> : null}
                {user.mustChangePassword ? <Pill tone="warning">待改密</Pill> : null}
              </div>
              <Card className="gap-3 px-4 py-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <Label>显示名</Label>
                    <Input defaultValue={user.displayName ?? ""} placeholder="可留空" />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label>角色</Label>
                    <select
                      className="h-8 rounded-md border border-border bg-background px-2"
                      defaultValue={String(user.roleId ?? "")}
                    >
                      <option value="">还没授角色(零权限)</option>
                      {roles.map((item) => (
                        <option key={item.id} value={String(item.id)}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <p className="text-muted-foreground">
                  创建 <span className="font-mono tabular-nums">{user.createdAt}</span> · 最后登录{" "}
                  <span className="font-mono tabular-nums">{user.lastLoginAt ?? "从未"}</span>
                </p>
                <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                  <Button>保存</Button>
                  <Button variant="outline">
                    <KeyRound /> 重置密码
                  </Button>
                  <Button variant="destructive" className="ml-auto">
                    <Trash2 /> 删号
                  </Button>
                </div>
              </Card>
              <p className="text-muted-foreground">
                重置密码会踢掉他全部会话并要求下次登录改密;删号连他的会话一起删。两个动作都要二次确认。
              </p>
            </div>
          ) : (
            <Card className="items-start gap-2 px-4 py-5">
              <p className="font-medium">左边挑一个人或一个角色</p>
              <p className="text-muted-foreground">
                现在一个角色都没有——先建一个,再把人从「还没授角色」挪进来。
              </p>
            </Card>
          )}
        </div>
      </div>
    </FakeShell>
  );
}

// ---------------------------------------------------------------- 变体 C:一页,表在上矩阵在下

function VariantC({ scenario }: { scenario: Scenario }) {
  const seed = scenario === "zero-role" ? [] : ROLES;
  const { roles, toggle } = useToggleMatrix(seed);
  const missing = unclaimed(roles);
  const items = [
    ...REAL_NAV.map((item) => ({ key: item.to, label: item.label })),
    { key: "access", label: "访问控制", admin: true },
  ];

  return (
    <FakeShell items={items} active="access" onPick={() => undefined}>
      <PageHeader
        title="访问控制"
        description="上面是谁能登进来,下面是每个角色能碰哪几格。一屏看全,只有系统管理员看得到。"
        actions={
          <>
            <Button variant="outline">
              <Plus /> 新建角色
            </Button>
            <Button>
              <Plus /> 建号
            </Button>
          </>
        }
      />
      <div className="flex max-w-[1100px] flex-col gap-6 p-5">
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">
            用户 <span className="font-mono tabular-nums text-muted-foreground">{USERS.length}</span>
          </h2>
          <UsersTable roles={roles} dense />
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">权限</h2>
          {/* 系统管理员不进矩阵:它不是角色,画成一列会让下面那句「从未被任何角色勾过」读成假的。 */}
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 opacity-70" />
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">系统管理员</span>
              不在这张表里:它权限全开、不可编辑,且可以有多个(
              <span className="font-mono tabular-nums">2</span> 人)。下面这些格子只管自定义角色。
            </p>
          </div>
          <UnclaimedBanner count={missing.length} />
          {roles.length === 0 ? (
            <Card className="items-start gap-2 px-4 py-5">
              <p className="font-medium">还没有任何角色,所以这张表还没有一列</p>
              <p className="text-muted-foreground">
                一个角色都不预置。建一个角色,这里就多一列,勾几个框即可。在那之前除系统管理员外没人能碰任何东西。
              </p>
              <Button className="mt-1">
                <Plus /> 新建角色
              </Button>
            </Card>
          ) : (
            <>
              {/* 角色横着排,多了就横向滚;权限格那一列 sticky,滚到右边仍看得见在改哪一格。 */}
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="bg-muted/60 text-xs text-muted-foreground">
                      <th className="sticky left-0 z-10 min-w-[18rem] bg-muted/60 px-3 py-2 font-medium">
                        权限格
                      </th>
                      {roles.map((role) => (
                        <th
                          key={role.id}
                          className="border-l border-border px-3 py-2 text-center font-medium whitespace-nowrap"
                        >
                          {role.name}
                          <span className="block font-normal">
                            <span className="font-mono tabular-nums">
                              {USERS.filter((u) => u.roleId === role.id).length}
                            </span>{" "}
                            人
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {RESOURCES.flatMap((resource) => [
                      <tr key={`${resource}-head`} className="border-t border-border bg-muted/25">
                        <td
                          colSpan={roles.length + 1}
                          className="sticky left-0 px-3 py-1 text-xs font-medium text-muted-foreground"
                        >
                          {resource}
                        </td>
                      </tr>,
                      ...PERMS.filter((perm) => perm.resource === resource).map((perm) => (
                        <tr
                          key={perm.id}
                          className={
                            "border-t border-border " +
                            (missing.includes(perm.id) ? "bg-warning/8" : "")
                          }
                        >
                          <td
                            className={
                              "sticky left-0 z-10 px-3 py-2 " +
                              (missing.includes(perm.id) ? "bg-warning/8" : "bg-background")
                            }
                          >
                            <div className="flex items-baseline gap-2">
                              <span className="font-medium">{perm.action}</span>
                              <span className="font-mono text-xs text-muted-foreground">
                                {perm.id}
                              </span>
                              {missing.includes(perm.id) ? (
                                <span className="text-xs text-warning">未启用</span>
                              ) : null}
                            </div>
                            <p className="text-xs text-muted-foreground">{perm.hint}</p>
                          </td>
                          {roles.map((role) => (
                            <td key={role.id} className="border-l border-border px-3 py-2 text-center">
                              <input
                                type="checkbox"
                                aria-label={`${role.name} ${perm.id}`}
                                checked={role.perms.includes(perm.id)}
                                onChange={() => toggle(role.id, perm.id)}
                                className="size-4 accent-[#1f2328]"
                              />
                            </td>
                          ))}
                        </tr>
                      )),
                    ])}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-2">
                <Button>保存</Button>
                <span className="text-muted-foreground">改完立刻生效,不用重新登录。</span>
              </div>
            </>
          )}
        </section>
      </div>
    </FakeShell>
  );
}

// ---------------------------------------------------------------- 零权限视角(三个变体各一种处置)

function NoPermView({ variant }: { variant: "A" | "B" | "C" }) {
  const label = variant === "A" ? "藏起来" : variant === "B" ? "灰掉点不动" : "点进去再说";
  if (variant === "A") {
    return (
      <FakeShell items={[]} active="" onPick={() => undefined}>
        <div className="flex min-h-full items-center justify-center p-6">
          <Card className="w-[30rem] max-w-full items-start gap-2 px-5 py-5">
            <Pill tone="muted">零权限视角 · {label}</Pill>
            <p className="text-lg font-semibold">你的账号还没有被授予任何权限</p>
            <p className="text-muted-foreground">
              账号建好了,角色还没给。找系统管理员给你一个角色,刷新之后左边就会出现导航。
            </p>
            <p className="text-muted-foreground">
              管理员:<span className="font-medium text-foreground">kassol</span>、
              <span className="font-medium text-foreground">chen.yu</span>
            </p>
          </Card>
        </div>
      </FakeShell>
    );
  }
  if (variant === "B") {
    return (
      <FakeShell
        items={REAL_NAV.map((item) => ({
          key: item.to,
          label: item.label,
          hint: `需要 ${item.perm}`,
        }))}
        active=""
        onPick={() => undefined}
        disabledNav
      >
        <div className="flex min-h-full items-center justify-center p-6">
          <Card className="w-[30rem] max-w-full items-start gap-2 px-5 py-5">
            <Pill tone="muted">零权限视角 · {label}</Pill>
            <p className="text-lg font-semibold">五页都在,但一页都点不动</p>
            <p className="text-muted-foreground">
              导航留着、置灰,鼠标停上去写「需要 review:read」。人看得见这个面板有什么,也看得见自己差什么。
            </p>
          </Card>
        </div>
      </FakeShell>
    );
  }
  return (
    <FakeShell
      items={REAL_NAV.map((item) => ({ key: item.to, label: item.label }))}
      active="/runs"
      onPick={() => undefined}
    >
      <PageHeader title="评审记录" description="按天分组的 Review Run 时间流。" />
      <div className="p-5">
        <Card className="items-start gap-2 px-5 py-5">
          <Pill tone="muted">零权限视角 · {label}</Pill>
          <p className="text-lg font-semibold">这一页需要 review:read,你没有</p>
          <p className="text-muted-foreground">
            导航照常点得进来,每一页自己说明差哪一格。找系统管理员(kassol、chen.yu)给你一个角色。
          </p>
        </Card>
      </div>
    </FakeShell>
  );
}

// ---------------------------------------------------------------- 登录 / 注册一屏

function AuthScreen({ bootstrap }: { bootstrap: boolean }) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4 pb-20">
      <div className="flex w-[23rem] max-w-full flex-col gap-3">
        <div className="flex items-center gap-2">
          <Mark className="size-5 text-primary" />
          <h1 className="text-lg font-semibold tracking-tight">MultiReviewer</h1>
        </div>
        {bootstrap ? (
          <>
            <Card className="gap-3 px-4">
              <div className="flex flex-col gap-1">
                <h2 className="text-base font-semibold">建第一个管理员</h2>
                <p className="text-muted-foreground">
                  这个实例还没有用户。第一个注册的人就是系统管理员,注册入口随后自动关闭。
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="p-boot">bootstrap 口令</Label>
                <Input id="p-boot" type="password" autoFocus />
                <p className="text-xs text-muted-foreground">
                  在服务的启动日志里(<span className="font-mono">docker compose logs</span>)。重启会换一枚新的。
                </p>
                <Label htmlFor="p-user" className="mt-1">
                  用户名
                </Label>
                <Input id="p-user" placeholder="小写字母、数字、点、下划线、连字符,32 以内" />
                <Label htmlFor="p-pw" className="mt-1">
                  密码
                </Label>
                <Input id="p-pw" type="password" />
                <Label htmlFor="p-pw2" className="mt-1">
                  确认密码
                </Label>
                <Input id="p-pw2" type="password" />
                <Button className="mt-1 w-full">注册并登录</Button>
              </div>
            </Card>
            <p className="text-muted-foreground">
              打错口令算进按 IP 的退避。锁住了就重启一次服务:退避与口令一起换新。
            </p>
          </>
        ) : (
          <Card className="gap-3 px-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="l-user">用户名</Label>
              <Input id="l-user" autoFocus autoComplete="username" />
              <Label htmlFor="l-pw" className="mt-1">
                密码
              </Label>
              <Input id="l-pw" type="password" autoComplete="current-password" />
              <Button className="mt-1 w-full">登录</Button>
            </div>
            <p className="text-muted-foreground">忘了密码找系统管理员重置,没有邮件通道。</p>
          </Card>
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------- 路由组件

const VARIANTS = [
  { key: "A", name: "两页并列" },
  { key: "B", name: "一页两栏" },
  { key: "C", name: "一页上下" },
] as const;

const SCENARIOS = [
  { key: "normal", name: "正常" },
  { key: "zero-role", name: "零角色" },
  { key: "no-perm", name: "零权限视角" },
  { key: "bootstrap", name: "零用户" },
  { key: "login", name: "登录页" },
] as const;

/** 路由 id,`useSearch` / `useNavigate` 的 `from` 要它。 */
export const PROTOTYPE_PATH = "/prototype/rbac";

/** 认不出的取值一律回落,原型不做报错。 */
export function validatePrototypeSearch(input: Record<string, unknown>): {
  variant: "A" | "B" | "C";
  scenario: Scenario;
} {
  const variant = VARIANTS.some((item) => item.key === input["variant"])
    ? (input["variant"] as "A" | "B" | "C")
    : "A";
  const scenario = SCENARIOS.some((item) => item.key === input["scenario"])
    ? (input["scenario"] as Scenario)
    : "normal";
  return { variant, scenario };
}

/** 变体与场景都存 URL:刷新不丢、地址能直接发给别人。 */
export function PrototypeRbacPage() {
  const navigate = useNavigate({ from: PROTOTYPE_PATH });
  const search = useSearch({ from: PROTOTYPE_PATH });
  const variant = search.variant;
  const scenario = search.scenario;
  const setVariant = (key: "A" | "B" | "C"): void => {
    void navigate({ search: (previous) => ({ ...previous, variant: key }), replace: true });
  };
  const setScenario = (key: Scenario): void => {
    void navigate({ search: (previous) => ({ ...previous, scenario: key }), replace: true });
  };

  const body =
    scenario === "bootstrap" ? (
      <AuthScreen bootstrap />
    ) : scenario === "login" ? (
      <AuthScreen bootstrap={false} />
    ) : scenario === "no-perm" ? (
      <NoPermView variant={variant} />
    ) : variant === "A" ? (
      <VariantA key={scenario} scenario={scenario} />
    ) : variant === "B" ? (
      <VariantB key={scenario} scenario={scenario} />
    ) : (
      <VariantC key={scenario} scenario={scenario} />
    );

  return (
    <>
      {body}
      <PrototypeSwitcher
        variants={VARIANTS}
        current={variant}
        onChange={(key) => setVariant(key as "A" | "B" | "C")}
        scenarios={SCENARIOS}
        scenario={scenario}
        onScenario={(key) => setScenario(key as Scenario)}
      />

    </>
  );
}
