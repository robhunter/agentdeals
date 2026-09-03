import type { ChangeResolution, ChangeResolutionState } from "./types.js";

export interface ResolvableChange {
  summary: string;
  current_state?: string;
  resolution?: ChangeResolution | null;
}

export const RESOLUTION_STATES: ChangeResolutionState[] = ["reversed", "retracted"];

export function isNoLongerInForce(change: { resolution?: ChangeResolution | null }): boolean {
  return Boolean(change.resolution);
}

export function theEventNeverHappened(change: { resolution?: ChangeResolution | null }): boolean {
  return change.resolution?.state === "retracted";
}

export const EVENT_CANCELLED = "https://schema.org/EventCancelled";

export function eventResolutionFields(change: {
  resolution?: ChangeResolution | null;
}): { eventStatus: string } | { endDate: string } | Record<string, never> {
  if (!change.resolution) return {};
  if (theEventNeverHappened(change)) return { eventStatus: EVENT_CANCELLED };
  return change.resolution.date ? { endDate: change.resolution.date } : {};
}

export function resolvingRecord<T extends { vendor: string; date: string; change_type: string }>(
  change: { resolution?: ChangeResolution | null },
  log: readonly T[],
): T | null {
  const ref = change.resolution?.resolved_by;
  if (!ref) return null;
  return (
    log.find((c) => c.vendor === ref.vendor && c.date === ref.date && c.change_type === ref.change_type) ?? null
  );
}

const RESOLUTION_TAGS: Record<ChangeResolutionState, (date: string) => string> = {
  reversed: (date) => `No longer in force (${date}).`,
  retracted: (date) => `Retracted — this record was our error (${date}).`,
};

export function resolutionTag(resolution: ChangeResolution): string {
  return RESOLUTION_TAGS[resolution.state](resolution.date);
}

export function summaryWithResolution(change: ResolvableChange): string {
  const resolution = change.resolution;
  if (!resolution) return change.summary;
  const tag = resolutionTag(resolution);
  const detail = resolution.detail;
  const tagged = change.summary.startsWith(tag) ? change.summary : `${tag} ${change.summary}`;
  if (!detail || tagged.includes(detail)) return tagged;
  return `${tagged} ${detail}`;
}

export function withResolutionInSummary<T extends ResolvableChange>(change: T): T {
  if (!change.resolution) return change;
  return { ...change, summary: summaryWithResolution(change) };
}

const RESOLUTION_ASSERTIONS = [
  /\breversed\b/i,
  /\bretracted\b/i,
  /\brescinded\b/i,
  /\bno longer in force\b/i,
  /(?:^|[.;—-]\s)resolved\b/i,
  /\bthis (?:row|record) (?:is|was) our error\b/i,
];

export function prosePutsAResolutionIn(text: string | undefined | null): boolean {
  if (!text) return false;
  return RESOLUTION_ASSERTIONS.some((pattern) => pattern.test(text));
}

export function fieldsAssertingAResolution(change: ResolvableChange): string[] {
  const written = change.resolution
    ? [resolutionTag(change.resolution), change.resolution.detail ?? ""].filter(Boolean)
    : [];
  const withoutWhatTheFieldItselfWrote = (text: string | undefined) =>
    text ? written.reduce((rest, piece) => rest.split(piece).join(" "), text) : text;
  const fields: Array<[string, string | undefined]> = [
    ["summary", withoutWhatTheFieldItselfWrote(change.summary)],
    ["current_state", withoutWhatTheFieldItselfWrote(change.current_state)],
  ];
  return fields.filter(([, text]) => prosePutsAResolutionIn(text)).map(([name]) => name);
}
