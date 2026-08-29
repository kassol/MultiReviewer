import { createHash } from "node:crypto";

import { verifyPassword } from "./password.ts";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const FREE_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const TRACKED_KEYS_MAX = 10_000;
const VERIFY_CONCURRENCY = 4;

// Generated once with the production parameters. Missing users still pay one full Argon2 verification.
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$gE9ipCxuLC2C2w7bPFI69Q$0P9fhlyAijlFKs3k+q8impmwalQb+HNnBYH37VPj9sc";

export type LoginOutcome =
  | { ok: true }
  | { ok: false; status: 401 }
  | { ok: false; status: 429; retryAfter: number };
export type LoginGateEvent = { account: string; ip: string; count: number };

export type PanelAuthOptions = {
  now?: () => number;
  onGate?: (event: LoginGateEvent) => void;
};

export type PanelAuth = {
  login(
    candidate: { username: string; passwordHash?: string },
    password: string,
    ip: string,
  ): Promise<LoginOutcome>;
};

/** Session ids are never persisted; all database lookups use this fixed-width SHA-256 digest. */
export function sessionHash(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

export function createPanelAuth(options: PanelAuthOptions = {}): PanelAuth {
  const { now = Date.now, onGate } = options;
  const failures = new Map<string, { count: number; nextAttemptAt: number }>();
  let activeVerifications = 0;
  const verificationQueue: (() => void)[] = [];

  async function verify(hash: string, password: string): Promise<boolean> {
    if (activeVerifications >= VERIFY_CONCURRENCY) {
      await new Promise<void>((resolve) => verificationQueue.push(resolve));
    }
    activeVerifications += 1;
    try {
      return await verifyPassword(hash, password);
    } finally {
      activeVerifications -= 1;
      verificationQueue.shift()?.();
    }
  }

  return {
    async login(candidate, password, ip) {
      const account = candidate.username;
      // 用户名字符集不含冒号,所以 account 与 bootstrap 两类键不可能相撞。
      const key = `account:${account}`;
      const record = failures.get(key);
      const checkedAt = now();
      if (record !== undefined && record.nextAttemptAt > checkedAt) {
        return {
          ok: false,
          status: 429,
          retryAfter: Math.max(1, Math.ceil((record.nextAttemptAt - checkedAt) / 1_000)),
        };
      }

      const valid = await verify(candidate.passwordHash ?? DUMMY_PASSWORD_HASH, password);
      if (valid && candidate.passwordHash !== undefined) {
        failures.delete(key);
        return { ok: true };
      }

      if (record === undefined && failures.size >= TRACKED_KEYS_MAX) {
        const evictionTime = now();
        for (const [tracked, value] of failures) {
          if (value.nextAttemptAt <= evictionTime) {
            failures.delete(tracked);
            break;
          }
        }
        if (failures.size >= TRACKED_KEYS_MAX) return { ok: false, status: 401 };
      }
      const count = (record?.count ?? 0) + 1;
      const nextAttemptAt =
        count <= FREE_ATTEMPTS
          ? 0
          : now() + Math.min(BACKOFF_BASE_MS * 2 ** (count - FREE_ATTEMPTS - 1), BACKOFF_MAX_MS);
      failures.set(key, { count, nextAttemptAt });
      if (nextAttemptAt > 0) onGate?.({ account, ip, count });
      return { ok: false, status: 401 };
    },
  };
}
