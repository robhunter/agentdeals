import { describe, it } from "node:test";
import assert from "node:assert";

const {
  REGISTRATION_LIMIT_DEFAULT,
  REGISTRATION_LIMIT_ENV,
  REGISTRATION_WINDOW_MS,
  createRateLimiter,
  createRegistrationLimiter,
  rateLimitHeaders,
  registrationLimitFrom,
} = await import("../dist/rate-limit.js");

describe("rate limiter", () => {
  it("allows exactly the configured number of calls in a window", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, maxKeys: 100 });
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(limiter.check("1.2.3.4", now).allowed, true, `call ${i + 1} should pass`);
    }
    assert.strictEqual(limiter.check("1.2.3.4", now).allowed, false);
  });

  it("counts each caller separately", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, maxKeys: 100 });
    const now = 1_000_000;
    limiter.check("1.2.3.4", now);
    limiter.check("1.2.3.4", now);
    assert.strictEqual(limiter.check("1.2.3.4", now).allowed, false);
    assert.strictEqual(limiter.check("5.6.7.8", now).allowed, true);
  });

  it("starts a fresh window once the old one has elapsed", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, maxKeys: 100 });
    const now = 1_000_000;
    limiter.check("1.2.3.4", now);
    limiter.check("1.2.3.4", now);
    assert.strictEqual(limiter.check("1.2.3.4", now).allowed, false);
    assert.strictEqual(limiter.check("1.2.3.4", now + 59_999).allowed, false);
    assert.strictEqual(limiter.check("1.2.3.4", now + 60_000).allowed, true);
  });

  it("counts down the remaining allowance and stops at zero", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, maxKeys: 100 });
    const now = 1_000_000;
    assert.strictEqual(limiter.check("1.2.3.4", now).remaining, 1);
    assert.strictEqual(limiter.check("1.2.3.4", now).remaining, 0);
    assert.strictEqual(limiter.check("1.2.3.4", now).remaining, 0);
  });

  it("reports the seconds left in the window", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 100 });
    const now = 1_000_000;
    assert.strictEqual(limiter.check("1.2.3.4", now).resetSeconds, 60);
    assert.strictEqual(limiter.check("1.2.3.4", now + 30_000).resetSeconds, 30);
    assert.strictEqual(limiter.check("1.2.3.4", now + 59_999).resetSeconds, 1);
  });

  it("bounds the key map so a spread of callers cannot grow it without limit", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 4 });
    const now = 1_000_000;
    for (let i = 0; i < 50; i++) limiter.check(`10.0.0.${i}`, now);
    assert.strictEqual(limiter.check("10.0.0.49", now).allowed, false, "the most recent caller is still counted");
    assert.strictEqual(limiter.check("10.0.0.0", now).allowed, true, "the oldest caller has been evicted");
  });

  it("keeps the most recently seen callers when evicting", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, maxKeys: 2 });
    const now = 1_000_000;
    limiter.check("a", now);
    limiter.check("b", now);
    limiter.check("a", now);
    limiter.check("c", now);
    assert.strictEqual(limiter.check("a", now).allowed, false, "a was refreshed and stays counted");
    assert.strictEqual(limiter.check("b", now).allowed, true, "b was the least recently used and was evicted");
  });

  it("forgets every caller on reset", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 100 });
    const now = 1_000_000;
    limiter.check("1.2.3.4", now);
    assert.strictEqual(limiter.check("1.2.3.4", now).allowed, false);
    limiter.reset();
    assert.strictEqual(limiter.check("1.2.3.4", now).allowed, true);
  });

  it("publishes its own limit", () => {
    assert.strictEqual(createRateLimiter({ limit: 7, windowMs: 1000, maxKeys: 10 }).limit, 7);
  });
});

describe("rateLimitHeaders", () => {
  it("renders the three headers as strings", () => {
    const headers = rateLimitHeaders({ allowed: true, limit: 5, remaining: 3, resetSeconds: 42 });
    assert.deepStrictEqual(headers, {
      "X-RateLimit-Limit": "5",
      "X-RateLimit-Remaining": "3",
      "X-RateLimit-Reset": "42",
    });
  });
});

describe("registration limiter", () => {
  it("names the environment variable that tunes it", () => {
    assert.strictEqual(REGISTRATION_LIMIT_ENV, "AGENTDEALS_REGISTER_LIMIT_PER_HOUR");
  });

  it("measures its window in one hour", () => {
    assert.strictEqual(REGISTRATION_WINDOW_MS, 3_600_000);
  });

  it("falls back to the default for anything that is not a positive whole number", () => {
    assert.strictEqual(registrationLimitFrom(undefined), REGISTRATION_LIMIT_DEFAULT);
    assert.strictEqual(registrationLimitFrom(""), REGISTRATION_LIMIT_DEFAULT);
    assert.strictEqual(registrationLimitFrom("many"), REGISTRATION_LIMIT_DEFAULT);
    assert.strictEqual(registrationLimitFrom("0"), REGISTRATION_LIMIT_DEFAULT);
    assert.strictEqual(registrationLimitFrom("-4"), REGISTRATION_LIMIT_DEFAULT);
    assert.strictEqual(registrationLimitFrom("2.5"), REGISTRATION_LIMIT_DEFAULT);
  });

  it("takes a positive whole number as the limit", () => {
    assert.strictEqual(registrationLimitFrom("12"), 12);
  });

  it("builds a limiter at the configured limit", () => {
    assert.strictEqual(createRegistrationLimiter("3").limit, 3);
    assert.strictEqual(createRegistrationLimiter(undefined).limit, REGISTRATION_LIMIT_DEFAULT);
  });

  it("defaults to a small number of identities per hour", () => {
    assert.ok(REGISTRATION_LIMIT_DEFAULT > 0 && REGISTRATION_LIMIT_DEFAULT <= 10);
  });
});
