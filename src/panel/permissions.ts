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
