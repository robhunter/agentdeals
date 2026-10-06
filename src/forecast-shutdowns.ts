import type { DealChange } from "./types.js";
import { changeCitesASource } from "./change-citation.js";
import { changeIsUnconfirmed } from "./change-confirmation.js";
import { isNoLongerInForce } from "./change-resolution.js";
import { PRODUCT_DEPRECATED, discontinuationDate } from "./product-deprecation.js";
import { servedVendorSlug, servedVendorSlugForName } from "./vendor-slug.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface RecordACardCovers {
  vendor: string;
  deadline: string;
}

export interface HandTypedShutdown {
  vendorSlug: string;
  deadline: string;
  covers?: readonly RecordACardCovers[];
}

export interface ForecastShutdown {
  record: DealChange;
  vendorPage: string | null;
  deadline: string;
}

export function shutdownDateOf(record: DealChange): string {
  const stated = typeof record.discontinued_date === "string" && ISO_DATE.test(record.discontinued_date)
    ? record.discontinued_date
    : null;
  return stated ?? discontinuationDate(record) ?? record.date;
}

export function whatEnds(record: DealChange): string | null {
  return typeof record.what_ends === "string" && record.what_ends.trim() !== "" ? record.what_ends.trim() : null;
}

export function recordedBeforeItHappened(record: DealChange): boolean {
  return typeof record.recorded_date === "string" && shutdownDateOf(record) > record.recorded_date;
}

function ratingWouldBeWithheld(record: DealChange): boolean {
  return !changeCitesASource(record) || changeIsUnconfirmed(record);
}

function aCardAlreadyStates(shutdown: ForecastShutdown, cards: readonly HandTypedShutdown[]): boolean {
  return cards.some((card) =>
    (shutdown.vendorPage !== null && servedVendorSlug(card.vendorSlug) === shutdown.vendorPage && card.deadline === shutdown.deadline)
    || (card.covers ?? []).some((covered) => covered.vendor === shutdown.record.vendor && covered.deadline === shutdown.deadline));
}

function sameShutdown(a: ForecastShutdown, b: ForecastShutdown): boolean {
  return a.deadline === b.deadline && (a.vendorPage ?? a.record.vendor) === (b.vendorPage ?? b.record.vendor);
}

function latestRecordedFirst(a: ForecastShutdown, b: ForecastShutdown): number {
  return (b.record.recorded_date ?? "").localeCompare(a.record.recorded_date ?? "");
}

export function forecastShutdownsWithoutACard(
  changes: readonly DealChange[],
  cards: readonly HandTypedShutdown[],
): ForecastShutdown[] {
  const forecast = changes
    .filter((record) => record.change_type === PRODUCT_DEPRECATED)
    .filter((record) => !isNoLongerInForce(record) && !ratingWouldBeWithheld(record))
    .filter(recordedBeforeItHappened)
    .map((record) => ({ record, vendorPage: servedVendorSlugForName(record.vendor), deadline: shutdownDateOf(record) }))
    .filter((shutdown) => !aCardAlreadyStates(shutdown, cards))
    .sort(latestRecordedFirst);
  return forecast.filter((shutdown, i) => forecast.findIndex((other) => sameShutdown(other, shutdown)) === i);
}
