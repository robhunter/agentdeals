import { describe, it, afterEach } from "node:test";
import assert from "node:assert";

describe("x402 utilities", () => {
  describe("generateCorrelationId", () => {
    it("returns a string starting with payout_", async () => {
      const { generateCorrelationId } = await import("../dist/x402.js");
      const id = generateCorrelationId();
      assert.ok(id.startsWith("payout_"));
    });

    it("generates unique IDs", async () => {
      const { generateCorrelationId } = await import("../dist/x402.js");
      const ids = new Set(Array.from({ length: 50 }, () => generateCorrelationId()));
      assert.strictEqual(ids.size, 50);
    });

    it("returns 39-char string (payout_ + 32 hex)", async () => {
      const { generateCorrelationId } = await import("../dist/x402.js");
      const id = generateCorrelationId();
      assert.strictEqual(id.length, 7 + 32);
      assert.match(id, /^payout_[0-9a-f]{32}$/);
    });
  });

  describe("validateX402Address", () => {
    it("accepts valid Ethereum address", async () => {
      const { validateX402Address } = await import("../dist/x402.js");
      const result = validateX402Address("0x1234567890abcdef1234567890abcdef12345678");
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.error, undefined);
    });

    it("accepts valid Ethereum address with mixed case", async () => {
      const { validateX402Address } = await import("../dist/x402.js");
      const result = validateX402Address("0xAbCdEf1234567890AbCdEf1234567890AbCdEf12");
      assert.strictEqual(result.valid, true);
    });

    it("accepts valid Solana address", async () => {
      const { validateX402Address } = await import("../dist/x402.js");
      const result = validateX402Address("7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs");
      assert.strictEqual(result.valid, true);
    });

    it("rejects empty string", async () => {
      const { validateX402Address } = await import("../dist/x402.js");
      const result = validateX402Address("");
      assert.strictEqual(result.valid, false);
      assert.ok(result.error);
    });

    it("rejects null-like input", async () => {
      const { validateX402Address } = await import("../dist/x402.js");
      const result = validateX402Address(null as unknown as string);
      assert.strictEqual(result.valid, false);
    });

    it("rejects Ethereum address with wrong length", async () => {
      const { validateX402Address } = await import("../dist/x402.js");
      const result = validateX402Address("0x1234");
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("Invalid address"));
    });

    it("rejects address with invalid characters", async () => {
      const { validateX402Address } = await import("../dist/x402.js");
      const result = validateX402Address("0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG");
      assert.strictEqual(result.valid, false);
    });

    it("trims whitespace from address", async () => {
      const { validateX402Address } = await import("../dist/x402.js");
      const result = validateX402Address("  0x1234567890abcdef1234567890abcdef12345678  ");
      assert.strictEqual(result.valid, true);
    });
  });

  describe("executeTransfer", () => {
    afterEach(async () => {
      const { resetTransferFn } = await import("../dist/x402.js");
      resetTransferFn();
    });

    it("default implementation returns not-configured error", async () => {
      const { executeTransfer, generateCorrelationId } = await import("../dist/x402.js");
      const result = await executeTransfer({
        to_address: "0x1234567890abcdef1234567890abcdef12345678",
        amount: 10,
        correlation_id: generateCorrelationId(),
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes("not yet configured"));
    });

    it("uses injected transfer function", async () => {
      const { executeTransfer, setTransferFn } = await import("../dist/x402.js");
      setTransferFn(async (req) => ({
        success: true,
        tx_hash: "0xfake",
        chain: "base",
        token: "USDC",
        correlation_id: req.correlation_id,
      }));
      const result = await executeTransfer({
        to_address: "0xabc",
        amount: 5,
        correlation_id: "test_123",
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.tx_hash, "0xfake");
      assert.strictEqual(result.correlation_id, "test_123");
    });

    it("resetTransferFn restores default behavior", async () => {
      const { executeTransfer, setTransferFn, resetTransferFn } = await import("../dist/x402.js");
      setTransferFn(async (req) => ({
        success: true,
        tx_hash: "0xfake",
        correlation_id: req.correlation_id,
      }));
      resetTransferFn();
      const result = await executeTransfer({
        to_address: "0xabc",
        amount: 5,
        correlation_id: "test_456",
      });
      assert.strictEqual(result.success, false);
    });
  });
});
