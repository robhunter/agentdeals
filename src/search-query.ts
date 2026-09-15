const DISALLOWED = /[^a-zA-Z0-9\s.\-+]/g;

export function sanitizeQuery(raw: string): string {
  return raw.replace(DISALLOWED, "").replace(/\s+/g, " ").trim();
}

export function recordedQueryForm(raw: string): string {
  return sanitizeQuery(raw).toLowerCase();
}
