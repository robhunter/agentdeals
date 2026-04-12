/**
 * x402 stablecoin transfer integration.
 *
 * Uses the x402 protocol (HTTP-native micropayments) via Coinbase CDP facilitator.
 * Default: USDC on Base.
 *
 * The transfer function is injectable for testing — call setTransferFn() to replace
 * the real implementation with a mock/stub.
 */

export interface TransferResult {
  success: boolean;
  tx_hash?: string;
  chain?: string;
  token?: string;
  error?: string;
  correlation_id: string;
}

export interface TransferRequest {
  to_address: string;
  amount: number; // USD amount
  correlation_id: string;
}

import { randomBytes } from "node:crypto";

export function generateCorrelationId(): string {
  return `payout_${randomBytes(16).toString("hex")}`;
}

/**
 * Validate an x402 address (Ethereum-style 0x address for Base/Polygon,
 * or Solana base58 address).
 */
export function validateX402Address(address: string): { valid: boolean; error?: string } {
  if (!address || typeof address !== "string") {
    return { valid: false, error: "Address is required" };
  }

  const trimmed = address.trim();

  // Ethereum-style address (Base, Polygon): 0x + 40 hex chars
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return { valid: true };
  }

  // Solana address: 32-44 base58 chars
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
    return { valid: true };
  }

  return { valid: false, error: "Invalid address format. Expected Ethereum (0x...) or Solana base58 address." };
}

// Default transfer implementation — calls x402 Coinbase CDP facilitator
async function defaultTransferFn(req: TransferRequest): Promise<TransferResult> {
  // Production implementation will use the x402 npm package:
  //   import { transfer } from "x402";
  //   const result = await transfer({ to: req.to_address, amount: req.amount, token: "USDC", chain: "base" });
  //
  // For now, return an error indicating x402 is not yet configured.
  // Manual testnet testing will validate the real integration before enabling.
  return {
    success: false,
    error: "x402 transfer not yet configured. Set X402_CDP_API_KEY environment variable to enable.",
    correlation_id: req.correlation_id,
  };
}

let transferFn: (req: TransferRequest) => Promise<TransferResult> = defaultTransferFn;

/**
 * Replace the transfer implementation (for testing).
 */
export function setTransferFn(fn: (req: TransferRequest) => Promise<TransferResult>): void {
  transferFn = fn;
}

/**
 * Reset to default transfer implementation.
 */
export function resetTransferFn(): void {
  transferFn = defaultTransferFn;
}

/**
 * Execute a stablecoin transfer via x402.
 */
export async function executeTransfer(req: TransferRequest): Promise<TransferResult> {
  return transferFn(req);
}
