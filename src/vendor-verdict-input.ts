import type { DealChange, Offer } from "./types.js";
import { enrichOffers, publishedRisk } from "./data.js";

type EnrichedOfferRow = ReturnType<typeof enrichOffers>[number];
import { gateFor, type Gate } from "./ranking.js";
import { offerEnded } from "./retirement.js";
import { levelWithheldReason, levelWithheldSince, type LevelWithheldReason } from "./source-check.js";
import type { RefusedRead } from "./change-refusal.js";
import type { VendorVerdictInput } from "./vendor-verdict.js";

export interface VendorVerdictContext {
  vendorOffers: Offer[];
  primary: Offer;
  enriched: EnrichedOfferRow;
  vendorChanges: DealChange[];
  gate: Gate | null;
  levelWithheld: LevelWithheldReason | null;
  unconfirmableSince: string;
  input: VendorVerdictInput;
}

export interface VendorVerdictEvidence {
  vendor: string;
  vendorOffers: Offer[];
  vendorChanges: DealChange[];
  refusedReads: readonly RefusedRead[];
  servedOn: string;
}

export function vendorVerdictContextFrom(evidence: VendorVerdictEvidence): VendorVerdictContext | null {
  const { vendor, vendorOffers, vendorChanges, refusedReads, servedOn } = evidence;
  if (vendorOffers.length === 0) return null;

  const primary = vendorOffers[0];
  const enriched = enrichOffers([primary])[0];
  const linkUnreachable = enriched.link_unreachable;
  const levelWithheld = levelWithheldReason(primary, linkUnreachable);
  const unconfirmableSince = levelWithheldSince(primary, linkUnreachable);
  const gate = gateFor(primary, servedOn);

  return {
    vendorOffers,
    primary,
    enriched,
    vendorChanges,
    gate,
    levelWithheld,
    unconfirmableSince,
    input: {
      vendor,
      tier: primary.tier,
      level: enriched.risk_level ?? null,
      historyLevel: publishedRisk(primary, vendorChanges, servedOn).history_level,
      cause: enriched.risk_cause,
      changes: vendorChanges,
      levelWithheld,
      unconfirmableSince,
      ratingWithheld: enriched.rating_withheld,
      offerEnded: offerEnded(primary),
      gate: gate?.code ?? null,
      linkUnreachable: Boolean(linkUnreachable),
      sourceCheck: primary.source_check?.outcome ?? null,
      termsConfirmedOn: primary.verifiedDate,
      refusedReads,
    },
  };
}
