import { createHash, randomBytes } from "node:crypto";

const UNPERSISTED_PER_PROCESS_KEY_SALT = randomBytes(16).toString("hex");

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export interface RateLimiter {
  limit: number;
  check(address: string, now?: number): RateLimitDecision;
  reset(): void;
}

interface CountedWindow {
  count: number;
  startedAt: number;
}

export function createRateLimiter(opts: { limit: number; windowMs: number; maxKeys: number }): RateLimiter {
  const windows = new Map<string, CountedWindow>();

  function keyFor(address: string): string {
    return createHash("sha256").update(UNPERSISTED_PER_PROCESS_KEY_SALT).update(address).digest("hex").slice(0, 16);
  }

  return {
    limit: opts.limit,

    check(address: string, now: number = Date.now()): RateLimitDecision {
      const key = keyFor(address);
      const held = windows.get(key);
      let window: CountedWindow;
      if (!held || now - held.startedAt >= opts.windowMs) {
        window = { count: 0, startedAt: now };
      } else {
        window = held;
        windows.delete(key);
      }
      window.count++;
      windows.set(key, window);

      while (windows.size > opts.maxKeys) {
        const oldest = windows.keys().next();
        if (oldest.done) break;
        windows.delete(oldest.value);
      }

      return {
        allowed: window.count <= opts.limit,
        limit: opts.limit,
        remaining: Math.max(0, opts.limit - window.count),
        resetSeconds: Math.ceil((window.startedAt + opts.windowMs - now) / 1000),
      };
    },

    reset(): void {
      windows.clear();
    },
  };
}

export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(decision.limit),
    "X-RateLimit-Remaining": String(decision.remaining),
    "X-RateLimit-Reset": String(decision.resetSeconds),
  };
}

export const REGISTRATION_LIMIT_ENV = "AGENTDEALS_REGISTER_LIMIT_PER_HOUR";
export const REGISTRATION_LIMIT_DEFAULT = 5;
export const REGISTRATION_WINDOW_MS = 3_600_000;
const REGISTRATION_KEYS_MAX = 5000;

export function registrationLimitFrom(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : REGISTRATION_LIMIT_DEFAULT;
}

export function createRegistrationLimiter(
  raw: string | undefined = process.env[REGISTRATION_LIMIT_ENV],
): RateLimiter {
  return createRateLimiter({
    limit: registrationLimitFrom(raw),
    windowMs: REGISTRATION_WINDOW_MS,
    maxKeys: REGISTRATION_KEYS_MAX,
  });
}
