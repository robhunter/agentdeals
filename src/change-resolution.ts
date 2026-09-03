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

export function summaryWithResolution(change: ResolvableChange): string {
  const detail = change.resolution?.detail;
  if (!detail) return change.summary;
  return change.summary.includes(detail) ? change.summary : `${change.summary} ${detail}`;
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
  const detail = change.resolution?.detail ?? "";
  const withoutDetail = (text: string | undefined) =>
    detail && text ? text.split(detail).join(" ") : text;
  const fields: Array<[string, string | undefined]> = [
    ["summary", withoutDetail(change.summary)],
    ["current_state", withoutDetail(change.current_state)],
  ];
  return fields.filter(([, text]) => prosePutsAResolutionIn(text)).map(([name]) => name);
}
