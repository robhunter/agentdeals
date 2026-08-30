import { createHash, timingSafeEqual } from "node:crypto";

export const PLATFORM_SECRET_ENV = "AGENTDEALS_PLATFORM_SECRET";

export const PLATFORM_CREDENTIAL_REQUIRED =
  "Authentication required. This endpoint records or settles commission paid to AgentDeals and takes the platform credential, not an agent API key.";

type RequestHeaders = Record<string, string | string[] | undefined>;

export function presentedBearerToken(headers: RequestHeaders): string | null {
  const header = headers["authorization"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return null;
  if (!/^bearer /i.test(value)) return null;
  const token = value.slice(7).trim();
  return token.length > 0 ? token : null;
}

function digestOf(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function platformSecretConfigured(configured: string | undefined): boolean {
  return typeof configured === "string" && configured.trim().length > 0;
}

export function platformSecretMatches(presented: string | null, configured: string | undefined): boolean {
  if (!platformSecretConfigured(configured)) return false;
  if (presented === null) return false;
  return timingSafeEqual(digestOf(presented), digestOf((configured as string).trim()));
}

export function authorizedAsPlatform(
  headers: RequestHeaders,
  configured: string | undefined = process.env[PLATFORM_SECRET_ENV],
): boolean {
  return platformSecretMatches(presentedBearerToken(headers), configured);
}
