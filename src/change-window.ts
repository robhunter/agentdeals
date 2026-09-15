export const DEFAULT_CHANGE_WINDOW_DAYS = 30;

export type ChangeWindowSource = "default" | "since_parameter" | "none";

export interface ChangeWindow {
  applied: boolean;
  from: string | null;
  source: ChangeWindowSource;
  field: "date";
  note: string;
}

export function servedWindowOpens(nowMs: number = Date.now()): string {
  return new Date(nowMs - DEFAULT_CHANGE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const FIELD_NOTE =
  "The filter compares against each record's date, which is the day the change took effect unless date_source is "
  + "\"discovered\", in which case it is the day we read the page.";

export const DECLARED_CHANGE_FILTERS = ["type", "vendor", "vendors", "categories"] as const;

export const SINCE_DEFAULT_SENTENCE =
  `Default: ${DEFAULT_CHANGE_WINDOW_DAYS} days ago, and only when no other filter is passed — a request carrying `
  + `${DECLARED_CHANGE_FILTERS.join(", ")} or category searches the whole change log unless since says otherwise. `
  + FIELD_NOTE
  + " Every response states the window it applied under date_window.";

export function windowFromSinceParameter(from: string): ChangeWindow {
  return {
    applied: true,
    from,
    source: "since_parameter",
    field: "date",
    note: `Records dated before ${from} are not in this response, because since=${from} was passed. ${FIELD_NOTE}`,
  };
}

export function defaultChangeWindow(nowMs: number = Date.now()): ChangeWindow {
  const from = servedWindowOpens(nowMs);
  return {
    applied: true,
    from,
    source: "default",
    field: "date",
    note:
      `Records dated before ${from} are not in this response. This is the default ${DEFAULT_CHANGE_WINDOW_DAYS}-day `
      + `window on the unfiltered feed. Pass since= to move it, or any of `
      + `${DECLARED_CHANGE_FILTERS.join(", ")} to search the whole change log. ${FIELD_NOTE}`,
  };
}

export function wholeChangeLog(): ChangeWindow {
  return {
    applied: false,
    from: null,
    source: "none",
    field: "date",
    note:
      "No date filter was applied, so these counts are over the whole change log: a request that names what it is "
      + "looking for is answered from every record we hold, however old. Pass since= to narrow by date.",
  };
}
