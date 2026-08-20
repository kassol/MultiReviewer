export const PANEL_PERMISSIONS = [
  "repo:read",
  "repo:write",
  "review:read",
  "review:rerun",
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
  "repo:read": "repo:write",
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
