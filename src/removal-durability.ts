import type { DealChange } from "./types.js";
import { CHANGE_DIRECTION } from "./change-direction.js";
import { theEventNeverHappened } from "./change-resolution.js";

export const FREE_TIER_REMOVED = "free_tier_removed";

export type RemovalCandidate = Pick<DealChange, "vendor" | "change_type" | "date"> & {
  summary?: string;
  resolution?: DealChange["resolution"];
};

export type ReturnEvidence =
  | { basis: "resolution"; date: string; detail: string | null }
  | { basis: "later_record"; date: string; changeType: string; summary: string };

export interface ReturnedRemoval {
  removal: RemovalCandidate;
  evidence: ReturnEvidence;
}

export interface RemovalDurability {
  recorded: RemovalCandidate[];
  retracted: RemovalCandidate[];
  weStandBehind: RemovalCandidate[];
  cameBack: ReturnedRemoval[];
  stillInForce: RemovalCandidate[];
}

export function isAFreeTierRemoval(change: Pick<DealChange, "change_type">): boolean {
  return change.change_type === FREE_TIER_REMOVED;
}

function laterPositiveRecordForTheSameVendor<T extends RemovalCandidate>(
  removal: RemovalCandidate,
  log: readonly T[],
): T | null {
  return (
    log
      .filter(
        (c) =>
          c.vendor === removal.vendor &&
          c.date > removal.date &&
          CHANGE_DIRECTION[c.change_type as DealChange["change_type"]] === "positive",
      )
      .sort((a, b) => a.date.localeCompare(b.date))[0] ?? null
  );
}

export function theFreeTierCameBackAfter<T extends RemovalCandidate>(
  removal: RemovalCandidate,
  log: readonly T[],
): ReturnEvidence | null {
  if (theEventNeverHappened(removal)) return null;
  if (removal.resolution?.state === "reversed") {
    return { basis: "resolution", date: removal.resolution.date, detail: removal.resolution.detail ?? null };
  }
  const later = laterPositiveRecordForTheSameVendor(removal, log);
  if (!later) return null;
  return { basis: "later_record", date: later.date, changeType: later.change_type, summary: later.summary ?? "" };
}

export function removalDurability<T extends RemovalCandidate>(log: readonly T[]): RemovalDurability {
  const recorded = log.filter(isAFreeTierRemoval);
  const retracted = recorded.filter(theEventNeverHappened);
  const weStandBehind = recorded.filter((r) => !theEventNeverHappened(r));
  const cameBack: ReturnedRemoval[] = [];
  const stillInForce: RemovalCandidate[] = [];
  for (const removal of weStandBehind) {
    const evidence = theFreeTierCameBackAfter(removal, log);
    if (evidence) cameBack.push({ removal, evidence });
    else stillInForce.push(removal);
  }
  return { recorded, retracted, weStandBehind, cameBack, stillInForce };
}

export interface RemovalNamedAsLasting {
  vendor: string;
  route: string;
}

export const REMOVALS_PAGES_NAME_AS_LASTING: readonly RemovalNamedAsLasting[] = [
  { vendor: "Heroku", route: "/state-of-free-tiers" },
  { vendor: "PlanetScale", route: "/state-of-free-tiers" },
  { vendor: "SendGrid", route: "/state-of-free-tiers" },
  { vendor: "Brave Search API", route: "/state-of-free-tiers" },
  { vendor: "X API (Twitter)", route: "/state-of-free-tiers" },
  { vendor: "SendGrid", route: "/email-comparison-2026" },
];

export interface LastingRemovalExample {
  vendor: string;
  date: string;
  year: string;
}

export function removalsRecordedFor<T extends RemovalCandidate>(vendor: string, log: readonly T[]): T[] {
  return log
    .filter((c) => isAFreeTierRemoval(c) && c.vendor === vendor)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function removalNamedOn<T extends RemovalCandidate>(vendor: string, log: readonly T[]): T | null {
  return removalsRecordedFor(vendor, log)[0] ?? null;
}

export function removalStillLasting<T extends RemovalCandidate>(
  vendor: string,
  log: readonly T[],
): LastingRemovalExample | null {
  const removals = removalsRecordedFor(vendor, log);
  if (removals.length === 0) return null;
  const everyOneHeld = removals.every(
    (removal) => !theEventNeverHappened(removal) && !theFreeTierCameBackAfter(removal, log),
  );
  if (!everyOneHeld) return null;
  const first = removals[0]!;
  return { vendor: first.vendor, date: first.date, year: first.date.slice(0, 4) };
}

export function lastingRemovalExamplesFor<T extends RemovalCandidate>(
  route: string,
  log: readonly T[],
): LastingRemovalExample[] {
  return REMOVALS_PAGES_NAME_AS_LASTING.filter((named) => named.route === route)
    .map((named) => removalStillLasting(named.vendor, log))
    .filter((example): example is LastingRemovalExample => example !== null);
}

function namesInASentence(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function vendorsThatCameBack(durability: RemovalDurability): string {
  return namesInASentence([...new Set(durability.cameBack.map((r) => r.removal.vendor))].sort());
}

function retractionClause(durability: RemovalDurability): string {
  const retracted = durability.retracted.length;
  if (retracted === 0) return "";
  const subject = retracted === 1 ? "record we have retracted" : "records we have retracted";
  return ` The other ${retracted} of the ${durability.recorded.length} are ${subject} — removals we now say did not happen.`;
}

export function removalReturnRateSentence(durability: RemovalDurability): string {
  const standBehind = durability.weStandBehind.length;
  if (durability.cameBack.length === 0) {
    return `None of the ${standBehind} removals we stand behind has come back so far.${retractionClause(durability)}`;
  }
  return `${durability.cameBack.length} of the ${standBehind} removals we stand behind have since come back: ${vendorsThatCameBack(durability)}.${retractionClause(durability)}`;
}

function spanOfExamples(examples: readonly LastingRemovalExample[]): string {
  const years = examples.map((e) => e.year).sort();
  const first = years[0];
  const last = years[years.length - 1];
  return first === last ? `recorded in ${first}` : `recorded from ${first} to ${last}`;
}

export function removalDurabilityPattern(
  durability: RemovalDurability,
  examples: readonly LastingRemovalExample[],
): string {
  const held = durability.stillInForce.length;
  const standBehind = durability.weStandBehind.length;
  const named =
    examples.length > 0
      ? `, including ${namesInASentence(examples.map((e) => e.vendor))} — ${spanOfExamples(examples)}`
      : "";
  if (durability.cameBack.length === 0) {
    return `Removal has held on every one of the ${standBehind} removals we stand behind${named}.`;
  }
  return `Removal usually holds. ${held} of the ${standBehind} removals we stand behind are still in force${named}. It is a rate, not a rule — ${durability.cameBack.length} have come back: ${vendorsThatCameBack(durability)}.`;
}

const REMOVAL_PERMANENCE_ASSERTIONS = [
  /\bonce (?:a free tier is )?removed\b[^.]*\bnever\b/i,
  /\bnone (?:have|has) (?:ever )?returned\b/i,
  /\bnever comes? back\b/i,
  /\bnever (?:been )?(?:returned|reinstated|reversed|restored)\b/i,
  /\ball permanent\b/i,
  /\bremovals? (?:is|are) (?:always )?permanent\b/i,
  /\bno (?:removed )?free tier (?:has|have) (?:ever )?(?:returned|come back)\b/i,
];

export function prosePutsRemovalBeyondReturn(text: string | null | undefined): boolean {
  if (!text) return false;
  return REMOVAL_PERMANENCE_ASSERTIONS.some((pattern) => pattern.test(text));
}
