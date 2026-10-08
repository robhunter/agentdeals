const ARCHIVE_CAPTURE = /^https:\/\/web\.archive\.org\/web\/(\d{4})(\d{2})(\d{2})\d{6}\/(https?:\/\/.+)$/;

export function archiveCaptureDate(url: string): string | null {
  const match = url.match(ARCHIVE_CAPTURE);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export function archivedAddress(url: string): string | null {
  return url.match(ARCHIVE_CAPTURE)?.[4] ?? null;
}

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDay(value: unknown): boolean {
  if (typeof value !== "string" || !CALENDAR_DAY.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

export function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function isPageAddress(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\/[^\s]+$/.test(value);
}

export function textFieldProblems(record: unknown, fields: readonly string[], at: string): string[] {
  const values = (record ?? {}) as Record<string, unknown>;
  return fields.filter((field) => typeof values[field] !== "string").map((field) => `${at}.${field} is missing`);
}

export interface LinkedWord {
  text: string;
  url: string;
}

export interface LinkedWords {
  text: string;
  links: LinkedWord[];
}

export function linkedWordsProblems(value: unknown, at: string, needsALink: boolean): string[] {
  const { text, links } = (value ?? {}) as Partial<LinkedWords>;
  if (!isText(text)) return [`${at}.text is missing`];
  if (!Array.isArray(links)) return [`${at}.links is missing`];
  const problems: string[] = [];
  if (needsALink && links.length === 0) problems.push(`${at}.links is empty`);
  let from = 0;
  links.forEach((link, n) => {
    if (!isPageAddress(link?.url)) problems.push(`${at}.links[${n}].url is not an https address`);
    if (!isText(link?.text)) {
      problems.push(`${at}.links[${n}].text is missing`);
      return;
    }
    const found = text.indexOf(link.text, from);
    if (found > -1) from = found + link.text.length;
    else if (text.includes(link.text)) problems.push(`${at}.links[${n}].text does not come after the words linked before it in ${at}.text`);
    else problems.push(`${at}.links[${n}].text is not words of ${at}.text`);
  });
  return problems;
}
