/**
 * 权限格只管写与动作。读评审记录、仓库与处置率登录即可,能读多少由仓库分配决定
 * (ADR 0018),`repo:read` 与 `review:read` 因此不再是权限格。
 */
export const PANEL_PERMISSIONS = [
  "repo:write",
  "review:rerun",
  "review:create",
  "finding:dispose",
  "rule:write",
  "model:read",
  "model:write",
  "credential:read",
  "credential:write",
] as const;

export type PanelPermission = (typeof PANEL_PERMISSIONS)[number];

const PANEL_PERMISSION_SET: Record<string, true> = Object.fromEntries(
  PANEL_PERMISSIONS.map((permission) => [permission, true]),
);

export function isPanelPermission(value: string): value is PanelPermission {
  return PANEL_PERMISSION_SET[value] === true;
}

const IMPLIED_PANEL_PERMISSIONS: Partial<Record<PanelPermission, PanelPermission>> = {
  "model:read": "model:write",
  "credential:read": "credential:write",
};

/** 把角色存储的权限格展开为请求鉴权与会话对外统一使用的有效权限。 */
export function effectivePanelPermissions(
  permissions: readonly PanelPermission[],
): PanelPermission[] {
  const granted = new Set(permissions);
  return PANEL_PERMISSIONS.filter((permission) => {
    const impliedBy = IMPLIED_PANEL_PERMISSIONS[permission];
    return granted.has(permission) || (impliedBy !== undefined && granted.has(impliedBy));
  });
}
