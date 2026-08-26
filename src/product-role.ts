import type { Offer, ProductRole } from "./types.js";

export type RoleCarrier = { product_role?: ProductRole };

export type MembershipGate = "local_dev_only" | "addon";

export const MEMBERSHIP_GATE_ORDER: MembershipGate[] = ["local_dev_only", "addon"];

export const MEMBERSHIP_GATE_RULES: Record<MembershipGate, { label: string; rule: string }> = {
  local_dev_only: {
    label: "Runs only on a developer machine",
    rule: "The product is a local stand-in for a service you would otherwise run in production. It is not an alternative to the hosted service it stands in for.",
  },
  addon: {
    label: "Extends another product",
    rule: "The product adds a capability to another product rather than replacing it. It is not an alternative to the thing it augments.",
  },
};

export const MEMBERSHIP_GATE_SYMMETRY =
  "A gate removes an offer from an alternatives list only when the vendor the list is about does not carry the same gate. One local emulator is still an alternative to another; one add-on is still an alternative to another.";

export const MEMBERSHIP_GATE_SCOPE =
  "These gates decide membership of alternatives, related-vendor, risk and role-recommendation lists. They are not scores, they never change the order of anything, and they never filter a category page, a best-of page or a search result — those are inventory, and the caller asked for the category.";

export const MEMBERSHIP_GATE_CORRECTIONS =
  "Every gated offer publishes the URL on the vendor's own site that the classification was read from, and the sentence it was read from. A vendor who believes we have read it wrong can point at the same page.";

export function membershipGatesFor(offer: RoleCarrier): Set<MembershipGate> {
  const gates = new Set<MembershipGate>();
  const role = offer.product_role;
  if (!role) return gates;
  if (role.deployment_model === "local_dev_only") gates.add("local_dev_only");
  if (role.is_addon) gates.add("addon");
  return gates;
}

function gateAgainst(candidate: RoleCarrier, subjectGates: Set<MembershipGate>): MembershipGate | null {
  const candidateGates = membershipGatesFor(candidate);
  for (const gate of MEMBERSHIP_GATE_ORDER) {
    if (candidateGates.has(gate) && !subjectGates.has(gate)) return gate;
  }
  return null;
}

export function alternativeMembershipGate(candidate: RoleCarrier, subject: RoleCarrier): MembershipGate | null {
  return gateAgainst(candidate, membershipGatesFor(subject));
}

export function membershipGatesAcross(subjects: RoleCarrier[]): Set<MembershipGate> {
  const union = new Set<MembershipGate>();
  for (const subject of subjects) {
    for (const gate of membershipGatesFor(subject)) union.add(gate);
  }
  return union;
}

export function roleMembershipGate(candidate: RoleCarrier): MembershipGate | null {
  const gates = membershipGatesFor(candidate);
  for (const gate of MEMBERSHIP_GATE_ORDER) {
    if (gates.has(gate)) return gate;
  }
  return null;
}

export interface AlternativesPartition<T extends RoleCarrier> {
  kept: T[];
  removed: Array<{ offer: T; gate: MembershipGate }>;
}

export function partitionAlternativesAcross<T extends RoleCarrier>(candidates: T[], subjects: RoleCarrier[]): AlternativesPartition<T> {
  const subjectGates = membershipGatesAcross(subjects);
  const kept: T[] = [];
  const removed: Array<{ offer: T; gate: MembershipGate }> = [];
  for (const candidate of candidates) {
    const gate = gateAgainst(candidate, subjectGates);
    if (gate) removed.push({ offer: candidate, gate });
    else kept.push(candidate);
  }
  return { kept, removed };
}

export function partitionAlternatives<T extends RoleCarrier>(candidates: T[], subject: RoleCarrier): AlternativesPartition<T> {
  return partitionAlternativesAcross(candidates, [subject]);
}

export function filterAlternatives<T extends RoleCarrier>(candidates: T[], subject: RoleCarrier): T[] {
  return partitionAlternatives(candidates, subject).kept;
}

export function partitionRoleCandidates<T extends RoleCarrier>(candidates: T[]): AlternativesPartition<T> {
  const kept: T[] = [];
  const removed: Array<{ offer: T; gate: MembershipGate }> = [];
  for (const candidate of candidates) {
    const gate = roleMembershipGate(candidate);
    if (gate) removed.push({ offer: candidate, gate });
    else kept.push(candidate);
  }
  return { kept, removed };
}

export function deploymentModelLabel(role: ProductRole): string {
  if (role.deployment_model === "local_dev_only") return "Runs only on a developer machine";
  if (role.deployment_model === "self_hosted") return "Self-hosted";
  return "Hosted service";
}

export function productRoleSentence(offer: Offer): string | null {
  const role = offer.product_role;
  if (!role) return null;
  const parts = [deploymentModelLabel(role)];
  if (role.is_addon) {
    parts.push(role.augments ? `extends ${role.augments} rather than replacing one` : "extends another product rather than replacing it");
  }
  const gated = membershipGatesFor(offer).size > 0;
  const consequence = gated
    ? `${offer.vendor} is listed in ${offer.category} and searchable there, and is left out of alternatives lists for vendors it cannot stand in for.`
    : `${offer.vendor} is listed everywhere a ${offer.category} offer is listed.`;
  return `${parts.join(", ")}. ${consequence}`;
}
