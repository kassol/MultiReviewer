import { api, errorText } from "./api.ts";

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

export type PanelSession = {
  username: string;
  displayName: string | null;
  permissions: PanelPermission[];
  isSystemAdmin: boolean;
  mustChangePassword: boolean;
  systemAdmins: string[];
};

let cached: PanelSession | null | undefined;
let pending: Promise<PanelSession | null> | undefined;
let bootstrapNeeded = false;

/** 同一次页面生命周期只探测一次；路由门禁与导航共用这一份身份。 */
export function loadPanelSession(): Promise<PanelSession | null> {
  if (cached !== undefined) return Promise.resolve(cached);
  if (pending !== undefined) return pending;
  pending = api("/session")
    .then(async (response) => {
      if (response.status === 401) {
        const body = (await response.json().catch(() => null)) as { bootstrap?: boolean } | null;
        bootstrapNeeded = body?.bootstrap === true;
        return null;
      }
      if (!response.ok) throw new Error(await errorText(response));
      bootstrapNeeded = false;
      return (await response.json()) as PanelSession;
    })
    .then((session) => {
      cached = session;
      return session;
    })
    .finally(() => {
      pending = undefined;
    });
  return pending;
}
export function panelNeedsBootstrap(): boolean {
  return bootstrapNeeded;
}


export function cachePanelSession(session: PanelSession): void {
  cached = session;
  pending = undefined;
  bootstrapNeeded = false;
}

export function clearPanelSession(): void {
  cached = undefined;
  pending = undefined;
  bootstrapNeeded = false;
}

export function hasPermission(session: PanelSession, permission: PanelPermission): boolean {
  return session.isSystemAdmin || session.permissions.includes(permission);
}
