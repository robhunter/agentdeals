import { describe, it } from "node:test";
import assert from "node:assert";

const {
  PLATFORM_SECRET_ENV,
  PLATFORM_CREDENTIAL_REQUIRED,
  authorizedAsPlatform,
  platformSecretConfigured,
  platformSecretMatches,
  presentedBearerToken,
} = await import("../dist/platform-auth.js");

describe("platform credential", () => {
  describe("presentedBearerToken", () => {
    it("reads the token out of a Bearer authorization header", () => {
      assert.strictEqual(presentedBearerToken({ authorization: "Bearer s3cret" }), "s3cret");
    });

    it("accepts the scheme in any case", () => {
      assert.strictEqual(presentedBearerToken({ authorization: "bearer s3cret" }), "s3cret");
    });

    it("returns null when the header is absent", () => {
      assert.strictEqual(presentedBearerToken({}), null);
    });

    it("returns null for a non-Bearer scheme", () => {
      assert.strictEqual(presentedBearerToken({ authorization: "Basic s3cret" }), null);
    });

    it("returns null for a Bearer header with no token", () => {
      assert.strictEqual(presentedBearerToken({ authorization: "Bearer   " }), null);
    });

    it("reads the first value when the header arrives repeated", () => {
      assert.strictEqual(presentedBearerToken({ authorization: ["Bearer first", "Bearer second"] }), "first");
    });
  });

  describe("platformSecretMatches", () => {
    it("accepts the configured secret", () => {
      assert.strictEqual(platformSecretMatches("s3cret", "s3cret"), true);
    });

    it("rejects a different secret of the same length", () => {
      assert.strictEqual(platformSecretMatches("s3cres", "s3cret"), false);
    });

    it("rejects a different secret of a different length", () => {
      assert.strictEqual(platformSecretMatches("s3", "s3cret"), false);
    });

    it("rejects a prefix of the configured secret", () => {
      assert.strictEqual(platformSecretMatches("s3cre", "s3cret"), false);
    });

    it("rejects every presented value when no secret is configured", () => {
      assert.strictEqual(platformSecretMatches("anything", undefined), false);
      assert.strictEqual(platformSecretMatches("anything", ""), false);
      assert.strictEqual(platformSecretMatches("anything", "   "), false);
      assert.strictEqual(platformSecretMatches("", undefined), false);
      assert.strictEqual(platformSecretMatches(null, undefined), false);
    });

    it("rejects an absent credential against a configured secret", () => {
      assert.strictEqual(platformSecretMatches(null, "s3cret"), false);
    });

    it("ignores surrounding whitespace in the configured value", () => {
      assert.strictEqual(platformSecretMatches("s3cret", "  s3cret  "), true);
    });
  });

  describe("platformSecretConfigured", () => {
    it("is false for absent, empty and whitespace-only values", () => {
      assert.strictEqual(platformSecretConfigured(undefined), false);
      assert.strictEqual(platformSecretConfigured(""), false);
      assert.strictEqual(platformSecretConfigured(" \t "), false);
    });

    it("is true for a real value", () => {
      assert.strictEqual(platformSecretConfigured("s3cret"), true);
    });
  });

  describe("authorizedAsPlatform", () => {
    it("authorizes a request carrying the configured secret", () => {
      assert.strictEqual(authorizedAsPlatform({ authorization: "Bearer s3cret" }, "s3cret"), true);
    });

    it("refuses a request carrying an agent-shaped key", () => {
      assert.strictEqual(authorizedAsPlatform({ authorization: "Bearer agd_abc123" }, "s3cret"), false);
    });

    it("refuses every request when the environment has no secret", () => {
      assert.strictEqual(authorizedAsPlatform({ authorization: "Bearer s3cret" }, undefined), false);
      assert.strictEqual(authorizedAsPlatform({}, undefined), false);
    });

    it("falls back to the environment variable when no secret is passed", () => {
      const restore = process.env[PLATFORM_SECRET_ENV];
      try {
        process.env[PLATFORM_SECRET_ENV] = "from-env";
        assert.strictEqual(authorizedAsPlatform({ authorization: "Bearer from-env" }), true);
        assert.strictEqual(authorizedAsPlatform({ authorization: "Bearer other" }), false);
        delete process.env[PLATFORM_SECRET_ENV];
        assert.strictEqual(authorizedAsPlatform({ authorization: "Bearer from-env" }), false);
      } finally {
        if (restore === undefined) delete process.env[PLATFORM_SECRET_ENV];
        else process.env[PLATFORM_SECRET_ENV] = restore;
      }
    });
  });

  it("names the environment variable the deployment sets", () => {
    assert.strictEqual(PLATFORM_SECRET_ENV, "AGENTDEALS_PLATFORM_SECRET");
  });

  it("tells the caller which credential the endpoint wants", () => {
    assert.match(PLATFORM_CREDENTIAL_REQUIRED, /platform credential/);
    assert.match(PLATFORM_CREDENTIAL_REQUIRED, /not an agent API key/);
  });
});
