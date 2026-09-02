import type { Gate, GateCode } from "./ranking.js";

const GATE_CLAUSES: { code: GateCode; one: string; many: (n: number) => string }[] = [
  {
    code: "eligibility_restricted",
    one: "1 requires an application or qualification",
    many: (n) => `${n} require an application or qualification`,
  },
  {
    code: "not_a_free_offer",
    one: "1 is not a free offer",
    many: (n) => `${n} are not free offers`,
  },
  {
    code: "offer_expired",
    one: "1 has expired",
    many: (n) => `${n} have expired`,
  },
  {
    code: "offer_retired",
    one: "1 has ended",
    many: (n) => `${n} have ended`,
  },
  {
    code: "verification_lapsed",
    one: "1 has not been re-confirmed recently enough",
    many: (n) => `${n} have not been re-confirmed recently enough`,
  },
];

export function gateClauseList(codes: GateCode[]): string {
  const clauses: string[] = [];
  for (const clause of GATE_CLAUSES) {
    const n = codes.filter((c) => c === clause.code).length;
    if (n === 0) continue;
    clauses.push(n === 1 ? clause.one : clause.many(n));
  }
  return clauses.join(", ");
}

export function gateDisclosureSentence(subject: string, total: number, codes: GateCode[]): string {
  const gated = codes.length;
  if (gated === 0 || total === 0) return "";
  const clauses = gateClauseList(codes);
  if (gated >= total && total > 1) return `None of ${subject} are on our ranked list — ${clauses}.`;
  if (gated === 1) return `One of ${subject} is not on our ranked list — ${clauses}.`;
  return `${gated} of ${subject} are not on our ranked list — ${clauses}.`;
}

export function matchingSubject(noun: string, total: number): string {
  return `the ${total} ${noun}${total === 1 ? "" : "s"} matching this query`;
}

export interface GateDisclosure {
  gated: number;
  gate_summary?: string;
}

export function gateDisclosureFor(noun: string, gates: (Gate | null)[]): GateDisclosure {
  const codes = gates.filter((g): g is Gate => g !== null).map((g) => g.code);
  const summary = gateDisclosureSentence(matchingSubject(noun, gates.length), gates.length, codes);
  return { gated: codes.length, ...(summary ? { gate_summary: summary } : {}) };
}
