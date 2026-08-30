import { getAllPlatformCodes, getPlatformCodeForVendor, referrerCompensationOf, restrictionsOf } from "./platform-codes.js";
import type { ReferrerCompensation } from "./platform-codes.js";
import { toSlug } from "./vendor-slug.js";
import type { Offer } from "./types.js";

export type OurReferralLinkSource = "platform_code" | "offer_referral";

export interface OurReferralLink {
  vendor: string;
  url: string;
  refereeBenefit: string;
  restrictions: string[];
  compensation: ReferrerCompensation | null;
  termsUrl: string | null;
  source: OurReferralLinkSource;
}

const REFEREE_BENEFIT_FALLBACK = "Referral link available";

export const REFERRAL_CONDITIONS_HEADING = "What you have to do to get it";

export function ourReferralLinkFor(vendorName: string, offer?: Offer | null): OurReferralLink | null {
  const platformCode = getPlatformCodeForVendor(vendorName);
  const offerReferral = offer?.referral ?? null;

  if (platformCode) {
    return {
      vendor: platformCode.vendor,
      url: platformCode.referral_url,
      refereeBenefit: platformCode.referee_benefit,
      restrictions: restrictionsOf(platformCode),
      compensation: referrerCompensationOf(platformCode),
      termsUrl: offerReferral?.terms_url ?? null,
      source: "platform_code",
    };
  }

  if (offerReferral && offer) {
    return {
      vendor: offer.vendor,
      url: offerReferral.url,
      refereeBenefit: offerReferral.referee_value ?? REFEREE_BENEFIT_FALLBACK,
      restrictions: restrictionsOf(offerReferral),
      compensation: referrerCompensationOf(offerReferral),
      termsUrl: offerReferral.terms_url ?? null,
      source: "offer_referral",
    };
  }

  return null;
}

export function referrerDisclosureSentence(compensation: ReferrerCompensation | null): string {
  if (compensation === "commission") return "We may earn a commission if you sign up through this link.";
  if (compensation === "credit") return "We are paid in vendor credit, not cash, if you sign up through this link.";
  if (compensation === "none") return "We are paid nothing if you sign up through this link.";
  return "This is a referral link of ours. We have not recorded what it pays us.";
}

export function referralLinkCountClause(count: number): string {
  return count === 1
    ? "only 1 currently has a referral link of ours"
    : `only ${count} currently have a referral link of ours`;
}

export function hasOurReferralLink(vendorName: string, offer?: Offer | null): boolean {
  return ourReferralLinkFor(vendorName, offer) !== null;
}

export function documentsVendorReferralProgram(offer?: Offer | null): boolean {
  return offer?.referral_program?.available === true;
}

export function hasAnyReferralSurface(vendorName: string, offer?: Offer | null): boolean {
  return hasOurReferralLink(vendorName, offer) || documentsVendorReferralProgram(offer);
}

export function heldReferralLinkForVendor(offers: Offer[], vendorName: string): OurReferralLink | null {
  const slug = toSlug(vendorName);
  if (!slug) return null;
  return allOurReferralLinks(offers).find(link => toSlug(link.vendor) === slug) ?? null;
}

export function allOurReferralLinks(offers: Offer[]): OurReferralLink[] {
  const offerBySlug = new Map<string, Offer>();
  for (const offer of offers) {
    const slug = toSlug(offer.vendor);
    if (!slug) continue;
    const held = offerBySlug.get(slug);
    if (!held || (!held.referral && offer.referral)) offerBySlug.set(slug, offer);
  }

  const vendorNameBySlug = new Map<string, string>();
  for (const code of getAllPlatformCodes()) {
    const slug = toSlug(code.vendor);
    if (slug && !vendorNameBySlug.has(slug)) vendorNameBySlug.set(slug, code.vendor);
  }
  for (const offer of offers) {
    if (!offer.referral) continue;
    const slug = toSlug(offer.vendor);
    if (slug && !vendorNameBySlug.has(slug)) vendorNameBySlug.set(slug, offer.vendor);
  }

  const links: OurReferralLink[] = [];
  for (const [slug, vendorName] of vendorNameBySlug) {
    const link = ourReferralLinkFor(vendorName, offerBySlug.get(slug) ?? null);
    if (link) links.push(link);
  }
  return links;
}
