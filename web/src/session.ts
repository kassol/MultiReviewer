import { api, errorText } from "./api.ts";

export const PANEL_PERMISSIONS = [
  "repo:read",
  "repo:write",
  "review:read",
  "review:rerun",
  "review:create",
  "model:read",
  "model:write",
  "credential:read",
  "credential:write",
] as const;

export type PanelPermission = (typeof PANEL_PERMISSIONS)[number];

const IMPLIED_BY: Partial<Record<PanelPermission, PanelPermission>> = {
  "repo:read": "repo:write",
  "model:read": "model:write",
  "credential:read": "credential:write",
};

export function permissionImpliedBy(
  permission: PanelPermission,
): PanelPermission | undefined {
  return IMPLIED_BY[permission];
}

export function roleHasPermission(
  permissions: readonly PanelPermission[],
  permission: PanelPermission,
): boolean {
  const impliedBy = permissionImpliedBy(permission);
  return permissions.includes(permission) || (impliedBy !== undefined && permissions.includes(impliedBy));
}

export type PanelSession = {
  username: string;
  displayName: string | null;
  permissions: PanelPermission[];
  isSystemAdmin: boolean;
  mustChangePassword: boolean;
  systemAdmins: string[];
  /**
   * Forge 的 web 基址,没有配 Gitea 时是 null。处置 Finding 只发生在 Forge 的
   * pull request 上,面板给出的每一处「还有多少条没处置」都要能凭它点过去。
   */
  giteaUrl: string | null;
};

/** 某一轮审查对应的 pull request 地址。拿不到 Forge 基址时返回 null,调用方不渲染链接。 */
export function pullRequestUrl(
  session: Pick<PanelSession, "giteaUrl">,
  run: { owner: string; repo: string; pullNumber: number },
): string | null {
  if (session.giteaUrl === null) return null;
  return `${session.giteaUrl}/${run.owner}/${run.repo}/pulls/${run.pullNumber}`;
}

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
