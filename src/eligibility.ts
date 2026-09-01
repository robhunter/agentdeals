import { gateFor } from "./ranking.js";
import type { Gate } from "./ranking.js";
import type { Offer } from "./types.js";

export const CONDITION_RECORDING_AN_UNREAD_PROGRAM = "Startup program — check vendor for eligibility details";

export function eligibilityGate(offer: Pick<Offer, "eligibility">): Gate | null {
  if (!offer.eligibility) return null;
  const gate = gateFor(offer as Offer, "");
  return gate && gate.code === "eligibility_restricted" ? gate : null;
}

export function publishableEligibilityConditions(offer: Pick<Offer, "eligibility">): string[] {
  return (offer.eligibility?.conditions ?? []).filter(
    (condition) => condition !== CONDITION_RECORDING_AN_UNREAD_PROGRAM,
  );
}
