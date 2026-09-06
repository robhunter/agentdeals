const DAY_MS = 24 * 60 * 60 * 1000;

export function verificationAgeDays(verifiedDate: string, nowMs: number): number {
  return Math.floor((nowMs - Date.parse(verifiedDate)) / DAY_MS);
}

export function medianVerificationAgeDays(verifiedDates: string[], nowMs: number): number {
  const ages = verifiedDates
    .map(d => verificationAgeDays(d, nowMs))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (ages.length === 0) return 0;
  const mid = Math.floor(ages.length / 2);
  return ages.length % 2 === 0
    ? Math.round((ages[mid - 1] + ages[mid]) / 2)
    : ages[mid];
}

export function reverificationIntervalDays(verifiedDates: string[], nowMs: number): number {
  return Math.max(1, 2 * medianVerificationAgeDays(verifiedDates, nowMs));
}

export function readingIsBehindTheLoop(
  verifiedDate: string,
  intervalDays: number,
  nowMs: number,
): boolean {
  return verificationAgeDays(verifiedDate, nowMs) > intervalDays;
}
