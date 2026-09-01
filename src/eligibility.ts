import { eligibilityGateFor } from "./ranking.js";
import type { Gate } from "./ranking.js";
import type { Offer } from "./types.js";

export const CONDITION_RECORDING_AN_UNREAD_PROGRAM = "Startup program — check vendor for eligibility details";

export function eligibilityGate(offer: Pick<Offer, "eligibility">): Gate | null {
  return eligibilityGateFor(offer);
}

export function gatedShareLede(total: number, gated: number): string {
  const counted = `${total} verified free tiers and developer deals`;
  if (gated === 0) return `${counted}.`;
  if (gated >= total) return `${counted}, none of them generally available — each requires an application or qualification.`;
  if (gated === 1) return `${counted}. 1 of them is not generally available — it requires an application or qualification.`;
  return `${counted}. ${gated} of them are not generally available — each requires an application or qualification.`;
}

export function gatedShareDescriptionClause(total: number, gated: number): string {
  if (gated === 0) return "";
  if (gated >= total) return `All ${total} require an application or qualification.`;
  if (gated === 1) return "1 requires an application or qualification.";
  return `${gated} require an application or qualification.`;
}

export function publishableEligibilityConditions(offer: Pick<Offer, "eligibility">): string[] {
  return (offer.eligibility?.conditions ?? []).filter(
    (condition) => condition !== CONDITION_RECORDING_AN_UNREAD_PROGRAM,
  );
}
