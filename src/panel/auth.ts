/**
 * 面板认证:单一静态 admin token 换 session,登录失败按 IP 退避与锁定。
 *
 * 只有判定逻辑,不碰 HTTP——cookie 的读写与响应格式留在 `webhook/server.ts` 的路由层,
 * 这里的输入输出都是纯值,时间经注入的时钟进来,测试不必等真实的锁定窗口。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** session 有效期。面板是低频运维界面,到期重新登录即可。 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 头几次失败免罚:人也会敲错。 */
const FREE_ATTEMPTS = 3;
/** 之后每多错一次,锁定窗口翻倍…… */
const BACKOFF_BASE_MS = 1_000;
/** ……封顶 15 分钟,即事实上的 IP 锁定。 */
const BACKOFF_MAX_MS = 15 * 60_000;

/** 追踪失败的 IP 数上限。键是未认证方的来源地址,不设限会被写满内存。 */
const TRACKED_IPS_MAX = 10_000;

export type LoginOutcome =
  /** 成功。`sessionId` 由路由层放进 cookie。 */
  | { ok: true; sessionId: string }
  /** 401 是「token 不对」,429 是「锁定中,先别猜」——锁定期内对的 token 也不放行。 */
  | { ok: false; status: 401 | 429 };

export type PanelAuth = {
  login(token: string, ip: string): LoginOutcome;
  /** cookie 里带来的 session id 是否有效。 */
  authenticate(sessionId: string | undefined): boolean;
};

/** 定长摘要后比较:timingSafeEqual 要求等长,而输入长度本身也不该泄露。 */
function tokenMatches(expected: string, provided: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

export function createPanelAuth(
  adminToken: string,
  now: () => number = Date.now,
): PanelAuth {
  /** session id → 过期时刻。只有持 token 的登录才写入,规模天然有界。 */
  const sessions = new Map<string, number>();
  const failures = new Map<string, { count: number; lockedUntil: number }>();

  return {
    login(token, ip) {
      const record = failures.get(ip);
      if (record !== undefined && record.lockedUntil > now()) {
        return { ok: false, status: 429 };
      }
      if (!tokenMatches(adminToken, token)) {
        if (record === undefined && failures.size >= TRACKED_IPS_MAX) {
          // 满了腾掉一个「不在锁定期」的最旧条目:能被一万个伪造源地址挤出去的锁
          // 不是锁。全都在锁定期时不腾也不记——新 IP 本来就还在免罚区,先放它一马,
          // 好过为记它而解开别人的锁。
          for (const [trackedIp, tracked] of failures) {
            if (tracked.lockedUntil <= now()) {
              failures.delete(trackedIp);
              break;
            }
          }
          if (failures.size >= TRACKED_IPS_MAX) return { ok: false, status: 401 };
        }
        const count = (record?.count ?? 0) + 1;
        const lockedUntil =
          count <= FREE_ATTEMPTS
            ? 0
            : now() +
              Math.min(BACKOFF_BASE_MS * 2 ** (count - FREE_ATTEMPTS - 1), BACKOFF_MAX_MS);
        failures.set(ip, { count, lockedUntil });
        return { ok: false, status: 401 };
      }
      failures.delete(ip);
      const sessionId = randomBytes(32).toString("hex");
      sessions.set(sessionId, now() + SESSION_TTL_MS);
      return { ok: true, sessionId };
    },

    authenticate(sessionId) {
      if (sessionId === undefined) return false;
      const expiry = sessions.get(sessionId);
      if (expiry === undefined) return false;
      if (expiry <= now()) {
        sessions.delete(sessionId);
        return false;
      }
      return true;
    },
  };
}
