import type { DealChange, Offer } from "./types.js";

export type DeadlineStatedIn = "condition" | "description" | "record";

export interface DeadlineText {
  vendor: string;
  category: string;
  text: string;
  sourceUrl: string | null;
  statedIn: DeadlineStatedIn;
  record?: DealChange;
  listing?: Offer;
}

export interface StatedDeadline {
  vendor: string;
  category: string;
  date: string;
  sentence: string;
  sourceUrl: string | null;
  statedIn: DeadlineStatedIn;
  record?: DealChange;
  listing?: Offer;
}

export function quotesTheWholeDescription(deadline: StatedDeadline): deadline is StatedDeadline & { listing: Offer } {
  return deadline.statedIn === "description" && deadline.listing !== undefined && deadline.sentence === (deadline.listing.description ?? "").trim();
}

export const DEADLINE_WORDS = new RegExp(
  [
    "\\bshut(?:s|ting)?\\s?down\\b",
    "\\bretir(?:e|es|ed|ing|ement)\\b",
    "\\bdiscontinu(?:e|es|ed|ing|ation)\\b",
    "\\bend[\\s-]of[\\s-]life\\b",
    "\\bdeprecat(?:e|es|ed|ing|ion)\\b",
    "\\buntil\\b",
    "\\bthrough\\b",
    "\\bdeadline\\b",
    "\\bends?\\s+support\\b",
    "\\bdeleted\\b",
    "\\brenew(?:s|ed|al)?\\b",
    "\\bblocks?\\b",
    "\\bprice\\s+changes?\\b",
  ].join("|"),
  "i",
);

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const MONTH_NAMES = MONTHS.join("|");

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const MONTH_DAY_YEAR = new RegExp(`\\b(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi");
const DAY_MONTH_YEAR = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES}),?\\s+(\\d{4})\\b`, "gi");

const PREFERENCE: Record<DeadlineStatedIn, number> = { condition: 0, description: 1, record: 2 };

const A_DAY_IN_MS = 86400000;

function isoOf(year: number, month: number, day: number): string | null {
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
}

export function datesNamedIn(text: string): string[] {
  const found = new Set<string>();
  for (const [, year, month, day] of text.matchAll(ISO_DATE)) {
    const iso = isoOf(Number(year), Number(month), Number(day));
    if (iso) found.add(iso);
  }
  for (const [, month, day, year] of text.matchAll(MONTH_DAY_YEAR)) {
    const iso = isoOf(Number(year), MONTHS.indexOf(month.toLowerCase()) + 1, Number(day));
    if (iso) found.add(iso);
  }
  for (const [, day, month, year] of text.matchAll(DAY_MONTH_YEAR)) {
    const iso = isoOf(Number(year), MONTHS.indexOf(month.toLowerCase()) + 1, Number(day));
    if (iso) found.add(iso);
  }
  return [...found].sort();
}

export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
}

function daysBetween(a: string, b: string): number {
  return Math.round(Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / A_DAY_IN_MS);
}

function dayAfter(iso: string): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + A_DAY_IN_MS).toISOString().slice(0, 10);
}

export function deadlineTextsOf(offers: readonly Offer[], recordsBeforeToday: readonly DealChange[]): DeadlineText[] {
  const listingTexts = offers.flatMap((offer): DeadlineText[] => [
    { vendor: offer.vendor, category: offer.category, text: offer.description ?? "", sourceUrl: offer.url ?? null, statedIn: "description", listing: offer },
    ...(offer.conditions ?? []).map((condition): DeadlineText => ({
      vendor: offer.vendor,
      category: offer.category,
      text: condition.text ?? "",
      sourceUrl: condition.url ?? offer.url ?? null,
      statedIn: "condition",
      listing: offer,
    })),
  ]);
  const recordTexts = recordsBeforeToday.map((record): DeadlineText => ({
    vendor: record.vendor,
    category: record.category,
    text: record.summary ?? "",
    sourceUrl: record.source_url ?? null,
    statedIn: "record",
    record,
  }));
  return [...listingTexts, ...recordTexts];
}

export function statedDeadlines(
  texts: readonly DeadlineText[],
  listedRecords: readonly Pick<DealChange, "vendor" | "date">[],
  today: string,
): StatedDeadline[] {
  const byVendorAndDay = new Map<string, StatedDeadline>();
  for (const text of texts) {
    if (!DEADLINE_WORDS.test(text.text)) continue;
    for (const sentence of sentencesOf(text.text)) {
      for (const date of datesNamedIn(sentence).filter((day) => day > today)) {
        const key = `${text.vendor}\u0000${date}`;
        const held = byVendorAndDay.get(key);
        if (held && PREFERENCE[held.statedIn] <= PREFERENCE[text.statedIn]) continue;
        byVendorAndDay.set(key, {
          vendor: text.vendor,
          category: text.category,
          date,
          sentence,
          sourceUrl: text.sourceUrl,
          statedIn: text.statedIn,
          ...(text.record ? { record: text.record } : {}),
          ...(text.listing ? { listing: text.listing } : {}),
        });
      }
    }
  }
  const unlisted = [...byVendorAndDay.values()].filter((deadline) =>
    !listedRecords.some((record) => record.vendor === deadline.vendor && daysBetween(record.date, deadline.date) <= 1));
  const unlistedDays = new Set(unlisted.map((deadline) => `${deadline.vendor}\u0000${deadline.date}`));
  return unlisted
    .filter((deadline) => !unlistedDays.has(`${deadline.vendor}\u0000${dayAfter(deadline.date)}`))
    .sort((a, b) => a.date.localeCompare(b.date) || a.vendor.localeCompare(b.vendor));
}
