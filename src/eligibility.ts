import { eligibilityGateFor } from "./ranking.js";
import type { Gate, GateCode } from "./ranking.js";
import { gateClauseList, gateDisclosureSentence } from "./gate-disclosure.js";
import type { Offer } from "./types.js";

export const CONDITION_RECORDING_AN_UNREAD_PROGRAM = "Startup program — check vendor for eligibility details";

export function eligibilityGate(offer: Pick<Offer, "eligibility">): Gate | null {
  return eligibilityGateFor(offer);
}

export function gatedCodes(gates: (Gate | null)[]): GateCode[] {
  return gates.filter((g): g is Gate => g !== null).map((g) => g.code);
}

function eligibilityAccountsForEveryOffer(codes: GateCode[], total: number): boolean {
  return codes.length >= total && codes.every((code) => code === "eligibility_restricted");
}

export function gatedShareLede(total: number, gates: (Gate | null)[]): string {
  const counted = `${total} verified free tiers and developer deals`;
  const codes = gatedCodes(gates);
  if (codes.length === 0) return `${counted}.`;
  if (eligibilityAccountsForEveryOffer(codes, total)) {
    return `${counted}, none of them generally available — each requires an application or qualification.`;
  }
  return `${counted}. ${gateDisclosureSentence("them", total, codes)}`;
}

export function gatedShareDescriptionClause(total: number, gates: (Gate | null)[]): string {
  const codes = gatedCodes(gates);
  if (codes.length === 0) return "";
  if (eligibilityAccountsForEveryOffer(codes, total)) return `All ${total} require an application or qualification.`;
  return `${gateClauseList(codes)}.`;
}

export function publishableEligibilityConditions(offer: Pick<Offer, "eligibility">): string[] {
  return (offer.eligibility?.conditions ?? []).filter(
    (condition) => condition !== CONDITION_RECORDING_AN_UNREAD_PROGRAM,
  );
}
