const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const ASCTIME = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

export type HeaderValue = string | string[] | null | undefined;

export interface ConditionalRequest {
  method?: string;
  ifModifiedSince?: HeaderValue;
  ifNoneMatch?: HeaderValue;
}

export function parseHttpDate(value: HeaderValue): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (IMF_FIXDATE.test(trimmed)) {
    const at = Date.parse(trimmed);
    return Number.isNaN(at) ? null : at;
  }
  const asctime = ASCTIME.exec(trimmed);
  if (!asctime) return null;
  const [, month, day, hour, minute, second, year] = asctime;
  const at = Date.UTC(Number(year), MONTHS.indexOf(month!), Number(day), Number(hour), Number(minute), Number(second));
  return Number.isNaN(at) ? null : at;
}

export function isRevalidation(request: ConditionalRequest): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (request.ifNoneMatch !== undefined) return false;
  return parseHttpDate(request.ifModifiedSince) !== null;
}

export function isNotModified(request: ConditionalRequest, lastModified: HeaderValue): boolean {
  if (!isRevalidation(request)) return false;
  const asked = parseHttpDate(request.ifModifiedSince);
  const served = parseHttpDate(lastModified);
  if (asked === null || served === null) return false;
  return served <= asked;
}

export function revalidationHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (/^content-(type|length)$/i.test(name)) continue;
    kept[name] = value;
  }
  return kept;
}

export function datedUrl(pathname: string, search: string): string | null {
  if (search) return null;
  if (pathname === "/") return pathname;
  return pathname.replace(/\/$/, "") || "/";
}
