import { citationLabel } from "./change-citation.js";
import { offerRetired, RETIRED_TIER } from "./retirement.js";
import type { Escaper } from "./source-citation.js";
import { supersedingChange } from "./superseded-description.js";
import type { DealChange, ListingCondition, Offer, UseAVendorRulesOut } from "./types.js";
import { closingTerms } from "./vendor-verdict.js";

export const USES_A_VENDOR_CAN_RULE_OUT: readonly UseAVendorRulesOut[] = ["production", "commercial use"];

export const LISTING_CONDITIONS_CLASS = "listing-conditions";

export const VENDOR_CONDITIONS_ROW_CLASS = "vendor-conditions-row";

export function conditionsOf(offer: Pick<Offer, "conditions">): readonly ListingCondition[] {
  return Array.isArray(offer.conditions) ? offer.conditions : [];
}

export function conditionsBesideStoredTerms(offer: Pick<Offer, "vendor" | "description" | "tier" | "conditions">, vendorChanges: readonly DealChange[]): readonly ListingCondition[] {
  return offerRetired(offer) || supersedingChange(offer, vendorChanges) ? [] : conditionsOf(offer);
}

export function conditionsBesidePublishedTerms(item: Pick<Offer, "tier" | "conditions"> & { terms_superseded?: unknown }): readonly ListingCondition[] {
  return offerRetired(item) || item.terms_superseded ? [] : conditionsOf(item);
}

function rulesOut(condition: ListingCondition, use: UseAVendorRulesOut): boolean {
  return (condition.rules_out ?? []).includes(use);
}

export function conditionRulingOut(conditions: readonly ListingCondition[], use: UseAVendorRulesOut): ListingCondition | null {
  return conditions.find(condition => rulesOut(condition, use)) ?? null;
}

export function conditionsHtml(conditions: readonly ListingCondition[], esc: Escaper): string {
  if (conditions.length === 0) return "";
  const items = conditions.map(condition =>
    `<li>${esc(condition.text)} (From <a href="${esc(condition.url)}" rel="nofollow noopener">${esc(citationLabel(condition.url))}</a>, read ${esc(condition.read_on)}.)</li>`);
  return `\n    <ul class="${LISTING_CONDITIONS_CLASS}" style="margin:.6rem 0 0 1.1rem;padding:0;font-size:.9rem;color:var(--text-muted);line-height:1.7">${items.join("")}</ul>`;
}

export function rowSpanningTheTableHtml(conditionsList: string, columns: number): string {
  return conditionsList === "" ? "" : `\n      <tr class="${VENDOR_CONDITIONS_ROW_CLASS}"><td colspan="${columns}">${conditionsList}</td></tr>`;
}

export function conditionsInPlainText(conditions: readonly ListingCondition[]): string {
  return conditions.map(condition => `${condition.text} (From ${condition.url}, read ${condition.read_on}.)`).join(" ");
}

export function withConditionsAfter(terms: string, conditions: readonly ListingCondition[]): string {
  return conditions.length === 0 ? terms : `${closingTerms(terms)} ${conditionsInPlainText(conditions)}`;
}

export interface TheVendorsRule {
  use: UseAVendorRulesOut;
  alsoRulesOutCommercialUse: boolean;
  condition: ListingCondition;
}

export function theVendorsRuleOnProduction(conditions: readonly ListingCondition[]): TheVendorsRule | null {
  const production = conditionRulingOut(conditions, "production");
  if (production) return { use: "production", alsoRulesOutCommercialUse: rulesOut(production, "commercial use"), condition: production };
  const commercialUse = conditionRulingOut(conditions, "commercial use");
  if (commercialUse) return { use: "commercial use", alsoRulesOutCommercialUse: true, condition: commercialUse };
  return null;
}

function theVendorsOwnWords(condition: ListingCondition): string {
  return `"${condition.quote}" (From ${citationLabel(condition.url)}, read ${condition.read_on}.)`;
}

export function productionAnswerOpening(vendorName: string, rule: TheVendorsRule): string {
  const terms = `by ${vendorName}'s own terms: ${theVendorsOwnWords(rule.condition)}`;
  if (rule.use === "production") {
    const uses = rule.alsoRulesOutCommercialUse ? "production or commercial use" : "production use";
    return `No. ${vendorName}'s free tier is not for ${uses}, ${terms}`;
  }
  return `${vendorName}'s free tier is not for commercial use, ${terms} Personal, non-commercial use of the free tier is still allowed.`;
}

export function trialProductionAnswer(condition: ListingCondition): string {
  return `No. ${condition.text} (From ${citationLabel(condition.url)}, read ${condition.read_on}.) The trial also expires.`;
}

export function alternativesUnderTheVendorsRule(rule: TheVendorsRule, category: string): string {
  return rule.use === "production"
    ? `Consider free alternatives in ${category}.`
    : `For commercial use, consider free alternatives in ${category}.`;
}

export function stableRatingBesideTheVendorsRule(vendorName: string): string {
  return `We rate ${vendorName}'s pricing stable. This rating is about how its terms have changed, not what they allow.`;
}

export function levelBesideTheVendorsRule(vendorName: string, level: string, because: string | null): string {
  return `We also rate ${vendorName}'s pricing ${level}${because ? `, ${because}` : ""}.`;
}

function markupEscaped(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function conditionsHtmlBesidePublishedTerms(item: Pick<Offer, "tier" | "conditions"> & { terms_superseded?: unknown }): string {
  return conditionsHtml(conditionsBesidePublishedTerms(item), markupEscaped);
}

export function conditionsForTheBrowser(): string {
  return [
    `var LISTING_CONDITIONS_CLASS = ${JSON.stringify(LISTING_CONDITIONS_CLASS)};`,
    `var RETIRED_TIER = ${RETIRED_TIER};`,
    ...[citationLabel, offerRetired, conditionsOf, conditionsBesidePublishedTerms, conditionsHtml, markupEscaped, conditionsHtmlBesidePublishedTerms].map(String),
  ].join("\n");
}
