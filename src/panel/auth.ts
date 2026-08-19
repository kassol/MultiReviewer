import { createHash } from "node:crypto";

import { verifyPassword } from "./password.ts";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const FREE_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const TRACKED_ACCOUNTS_MAX = 10_000;

// Generated once with the production parameters. Missing users still pay one full Argon2 verification.
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$gE9ipCxuLC2C2w7bPFI69Q$0P9fhlyAijlFKs3k+q8impmwalQb+HNnBYH37VPj9sc";

export type LoginOutcome = { ok: true } | { ok: false; status: 401 | 429 };

export type PanelAuth = {
  login(
    candidate: { username: string; passwordHash: string } | undefined,
    password: string,
    ip: string,
  ): Promise<LoginOutcome>;
};

/** Session ids are never persisted; all database lookups use this fixed-width SHA-256 digest. */
export function sessionHash(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

export function createPanelAuth(now: () => number = Date.now): PanelAuth {
  const failures = new Map<string, { count: number; lockedUntil: number }>();

  return {
    async login(candidate, password, ip) {
      const key = `${candidate?.username ?? "missing"}\u0000${ip}`;
      const record = failures.get(key);
      if (record !== undefined && record.lockedUntil > now()) {
        return { ok: false, status: 429 };
      }

      const valid = await verifyPassword(candidate?.passwordHash ?? DUMMY_PASSWORD_HASH, password);
      if (!valid || candidate === undefined) {
        if (record === undefined && failures.size >= TRACKED_ACCOUNTS_MAX) {
          for (const [tracked, value] of failures) {
            if (value.lockedUntil <= now()) {
              failures.delete(tracked);
              break;
            }
          }
          if (failures.size >= TRACKED_ACCOUNTS_MAX) return { ok: false, status: 401 };
        }
        const count = (record?.count ?? 0) + 1;
        const lockedUntil =
          count <= FREE_ATTEMPTS
            ? 0
            : now() +
              Math.min(BACKOFF_BASE_MS * 2 ** (count - FREE_ATTEMPTS - 1), BACKOFF_MAX_MS);
        failures.set(key, { count, lockedUntil });
        return { ok: false, status: 401 };
      }

      failures.delete(key);
      return { ok: true };
    },
  };
}
