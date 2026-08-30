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
  amount: number;
  correlation_id: string;
}

import { randomBytes } from "node:crypto";

export function generateCorrelationId(): string {
  return `payout_${randomBytes(16).toString("hex")}`;
}

export function validateX402Address(address: string): { valid: boolean; error?: string } {
  if (!address || typeof address !== "string") {
    return { valid: false, error: "Address is required" };
  }

  const trimmed = address.trim();

  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return { valid: true };
  }

  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) {
    return { valid: true };
  }

  return { valid: false, error: "Invalid address format. Expected Ethereum (0x...) or Solana base58 address." };
}

async function defaultTransferFn(req: TransferRequest): Promise<TransferResult> {
  return {
    success: false,
    error: "x402 transfer not yet configured. Set X402_CDP_API_KEY environment variable to enable.",
    correlation_id: req.correlation_id,
  };
}

let transferFn: (req: TransferRequest) => Promise<TransferResult> = defaultTransferFn;

export const PAYOUTS_UNAVAILABLE_REASON =
  "Payouts are not enabled: no transfer provider is configured, so confirmed credit cannot be withdrawn yet. Credit continues to accrue and check_balance reports it.";

export function payoutsAvailable(): boolean {
  return transferFn !== defaultTransferFn;
}

export function setTransferFn(fn: (req: TransferRequest) => Promise<TransferResult>): void {
  transferFn = fn;
}

export function resetTransferFn(): void {
  transferFn = defaultTransferFn;
}

export async function executeTransfer(req: TransferRequest): Promise<TransferResult> {
  return transferFn(req);
}
