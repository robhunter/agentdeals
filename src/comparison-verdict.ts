import { withheldLevelSentence, type LevelWithheldReason } from "./source-check.js";

export type StabilityRating = "stable" | "caution" | "risky";

export interface ComparisonSide {
  vendor: string;
  recordedChanges: number;
  rating: StabilityRating | null;
  ratingWithheldBecause: LevelWithheldReason | null;
  unconfirmableSince: string;
}

export function ratingIsWithheld(side: ComparisonSide): boolean {
  return side.rating === null;
}

export function recordedChangesPhrase(count: number): string {
  return `${count} recorded change${count === 1 ? "" : "s"}`;
}

export function moreStableSide(a: ComparisonSide, b: ComparisonSide): ComparisonSide | null {
  if (ratingIsWithheld(a) || ratingIsWithheld(b)) return null;
  if (a.rating === b.rating) return null;
  const stabler = a.rating === "stable" ? a : b.rating === "stable" ? b : null;
  if (!stabler) return null;
  const other = stabler === a ? b : a;
  return stabler.recordedChanges < other.recordedChanges ? stabler : null;
}

function whyWithheld(side: ComparisonSide): string {
  return side.ratingWithheldBecause
    ? withheldLevelSentence(side.ratingWithheldBecause, side.vendor, side.unconfirmableSince)
    : `We are not publishing a stability rating for ${side.vendor}.`;
}

export function stabilitySentences(a: ComparisonSide, b: ComparisonSide): string[] {
  const withheld = [a, b].filter(ratingIsWithheld);
  if (withheld.length > 0) {
    return [...withheld.map(whyWithheld), "We are not comparing the two pricing histories."];
  }
  const stabler = moreStableSide(a, b);
  if (!stabler) return [];
  const other = stabler === a ? b : a;
  return [`${stabler.vendor} has a more stable pricing history (${recordedChangesPhrase(stabler.recordedChanges)} vs ${other.recordedChanges}).`];
}

export function stabilityVerdictClause(a: ComparisonSide, b: ComparisonSide): string {
  return stabilitySentences(a, b).join(" ");
}

export type SideFreeTier =
  | { states: "offered"; tier: string }
  | { states: "ended" }
  | { states: "unconfirmed"; why: string };

export interface FreeTierSide {
  vendor: string;
  free: SideFreeTier;
}

function offeredTier(side: FreeTierSide): string {
  return side.free.states === "offered" ? side.free.tier : "";
}

function bothOfferSentence(a: FreeTierSide, b: FreeTierSide, forFaq: boolean): string {
  return forFaq
    ? `Both offer free tiers. ${a.vendor} provides "${offeredTier(a)}" and ${b.vendor} offers "${offeredTier(b)}". Compare the specific limits above to determine which fits your usage.`
    : `Both ${a.vendor} and ${b.vendor} offer free tiers. ${a.vendor} provides "${offeredTier(a)}" while ${b.vendor} offers "${offeredTier(b)}".`;
}

function oneOffersSentence(offering: FreeTierSide, ended: FreeTierSide, forFaq: boolean): string {
  const tail = forFaq ? `${ended.vendor} does not` : `${ended.vendor} does not currently have a free tier`;
  return `${offering.vendor} offers a free tier ("${offeredTier(offering)}") while ${tail}.`;
}

function neitherOffersSentence(a: FreeTierSide, b: FreeTierSide, forFaq: boolean): string {
  return forFaq
    ? `Neither currently offers a free tier.`
    : `Neither ${a.vendor} nor ${b.vendor} currently offers a free tier.`;
}

function settledSideOpening(side: FreeTierSide): string {
  return side.free.states === "offered"
    ? `${side.vendor} offers a free tier ("${side.free.tier}").`
    : `${side.vendor} does not currently have a free tier.`;
}

function whyUnconfirmed(side: FreeTierSide): string {
  return side.free.states === "unconfirmed" ? side.free.why : "";
}

function freeTierSentences(a: FreeTierSide, b: FreeTierSide, forFaq: boolean): string[] {
  const aUnconfirmed = a.free.states === "unconfirmed";
  const bUnconfirmed = b.free.states === "unconfirmed";

  if (aUnconfirmed && bUnconfirmed) {
    return [
      `We are not publishing a free-tier verdict for either ${a.vendor} or ${b.vendor}.`,
      whyUnconfirmed(a),
      whyUnconfirmed(b),
    ];
  }
  if (aUnconfirmed || bUnconfirmed) {
    const unsettled = aUnconfirmed ? a : b;
    const settled = aUnconfirmed ? b : a;
    return [
      settledSideOpening(settled),
      `We are not publishing a free-tier verdict for ${unsettled.vendor}.`,
      whyUnconfirmed(unsettled),
    ];
  }
  if (a.free.states === "offered" && b.free.states === "offered") return [bothOfferSentence(a, b, forFaq)];
  if (a.free.states === "offered") return [oneOffersSentence(a, b, forFaq)];
  if (b.free.states === "offered") return [oneOffersSentence(b, a, forFaq)];
  return [neitherOffersSentence(a, b, forFaq)];
}

function joinOnce(sentences: string[]): string {
  const said = new Set<string>();
  const kept: string[] = [];
  for (const sentence of sentences) {
    if (sentence === "" || said.has(sentence)) continue;
    said.add(sentence);
    kept.push(sentence);
  }
  return kept.join(" ");
}

export function freeTierVerdictSentence(a: FreeTierSide, b: FreeTierSide): string {
  return joinOnce(freeTierSentences(a, b, false));
}

export function freeTierFaqAnswer(a: FreeTierSide, b: FreeTierSide): string {
  return joinOnce(freeTierSentences(a, b, true));
}

export function comparisonVerdictText(
  freeA: FreeTierSide,
  freeB: FreeTierSide,
  stabilityA: ComparisonSide,
  stabilityB: ComparisonSide,
): string {
  return joinOnce([
    ...freeTierSentences(freeA, freeB, false),
    ...stabilitySentences(stabilityA, stabilityB),
  ]);
}

export function stabilityFaqAnswer(a: ComparisonSide, b: ComparisonSide): string {
  const stated = (side: ComparisonSide) =>
    `${side.vendor} has ${recordedChangesPhrase(side.recordedChanges)}${side.rating ? ` and is rated ${side.rating}` : ""}.`;
  const clause = stabilityVerdictClause(a, b);
  return `${stated(a)} ${stated(b)}${clause ? ` ${clause}` : ""}`;
}
