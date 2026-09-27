import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { enrichOffers, loadDealChanges } from "../dist/data.js";
import { functionMembers, type ProductFunction } from "../dist/product-function.js";
import { rankOffers } from "../dist/ranking.js";
import { readBestOfPublished, serializeBestOfPublished } from "../dist/best-of-publication.js";
import { verificationLedger } from "../dist/verification-state.js";
import type { Offer } from "../dist/types.js";

export const EXPIRED_ON = "2026-01-31";

export function picksOf<T extends Offer>(offers: readonly T[], fn: ProductFunction, date: string): T[] {
  const members = functionMembers(offers, fn);
  const enriched = enrichOffers(members);
  const memberBehind = new Map<unknown, T>(enriched.map((row, at) => [row, members[at]]));
  return rankOffers(enriched, {
    queryKey: `best-of:${fn.categories[0] ?? fn.subtypes[0]}`,
    changes: loadDealChanges(),
    date,
    verificationLedger: verificationLedger(),
  }).qualified.map(entry => {
    const member = memberBehind.get(entry.offer);
    if (!member) throw new Error(`a pick on /best/free-${fn.slug} is not one of the records passed in`);
    return member;
  });
}

export interface OnePickLeft {
  subject: ProductFunction;
  offers: Offer[];
  kept: Offer;
  expired: Offer[];
  publishedBefore: ReadonlySet<string>;
  env: { AGENTDEALS_INDEX_PATH: string; AGENTDEALS_BEST_OF_PUBLISHED_PATH: string };
  remove(): void;
}

export interface PicksExpiring {
  offers: Offer[];
  kept: Offer;
  expired: Offer[];
}

export function expireEveryPickButOne(offers: readonly Offer[], subject: ProductFunction, date: string): PicksExpiring {
  const [kept, ...others] = picksOf(offers, subject, date);
  if (!kept || others.length === 0) {
    throw new Error(`/best/free-${subject.slug} publishes ${kept ? 1 : 0} picks on ${date}, so there is no pick to take away`);
  }
  const expiring = new Set<Offer>(others);
  const expired: Offer[] = [];
  const scratchOffers = offers.map(o => {
    if (!expiring.has(o)) return o;
    const lapsed = { ...o, expires_date: EXPIRED_ON };
    expired.push(lapsed);
    return lapsed;
  });
  return { offers: scratchOffers, kept, expired };
}

export function leaveOnePick(offers: readonly Offer[], subject: ProductFunction, date: string): OnePickLeft {
  const { offers: scratchOffers, kept, expired } = expireEveryPickButOne(offers, subject, date);
  const ledger = readBestOfPublished();
  const publishedBefore = new Set(ledger.slugs.filter(slug => slug !== `free-${subject.slug}`));

  const dir = mkdtempSync(path.join(tmpdir(), `one-pick-left-${subject.slug}-`));
  const indexPath = path.join(dir, "index.json");
  const ledgerPath = path.join(dir, "best-of-published.json");
  writeFileSync(indexPath, JSON.stringify({ offers: scratchOffers }));
  writeFileSync(ledgerPath, serializeBestOfPublished({ version: 1, generated: ledger.generated, slugs: [...publishedBefore] }));

  return {
    subject,
    offers: scratchOffers,
    kept,
    expired,
    publishedBefore,
    env: { AGENTDEALS_INDEX_PATH: indexPath, AGENTDEALS_BEST_OF_PUBLISHED_PATH: ledgerPath },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
