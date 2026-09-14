const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export const SINCE_ACCEPTS =
  "Accepts a calendar date (YYYY-MM-DD) or an ISO-8601 timestamp, which is narrowed to the date it names — "
  + "the whole of that day is returned either way. A date that does not exist answers 400.";

export const SINCE_REJECTED =
  "Invalid 'since' parameter. Expected a date that exists, written as YYYY-MM-DD or as an ISO-8601 timestamp.";

function daysIn(year: number, month: number): number {
  if (month !== 2) return DAYS_IN_MONTH[month - 1]!;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return leap ? 29 : 28;
}

function dayExists(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  return day <= daysIn(year, month);
}

export function dayNamedBySince(raw: string): string | null {
  const named = CALENDAR_DAY.exec(raw) ?? INSTANT.exec(raw);
  if (!named) return null;
  const [, year, month, day] = named as unknown as [string, string, string, string];
  if (!dayExists(Number(year), Number(month), Number(day))) return null;
  return `${year}-${month}-${day}`;
}

export function sinceFilterDay(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return dayNamedBySince(raw) ?? raw;
}
