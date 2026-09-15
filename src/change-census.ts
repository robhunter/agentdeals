import { isNoLongerInForce, theEventNeverHappened } from "./change-resolution.js";
import type { ChangeResolution } from "./types.js";

export const INDEX_SWEEP_STATE = "Removed from index";

export const TRACKED_CHANGE_RULE_ANCHOR = "what-counts";
export const TRACKED_CHANGE_RULE_PATH = `/changes#${TRACKED_CHANGE_RULE_ANCHOR}`;

export const TRACKED_CHANGE_NOUN = "tracked pricing changes";

export const TRACKED_CHANGE_RULE_SENTENCE =
  "A tracked pricing change is a change a vendor made to published terms, "
  + "which we recorded, still stands, and we have not withdrawn. "
  + "Most carry the date the terms took effect; the rest carry the date we read the page.";

export type CensusSubject = {
  current_state?: string;
  resolution?: ChangeResolution | null;
};

export function isIndexHousekeeping(change: CensusSubject): boolean {
  return change.current_state === INDEX_SWEEP_STATE;
}

export function isTrackedChange(change: CensusSubject): boolean {
  return !isNoLongerInForce(change) && !isIndexHousekeeping(change);
}

export function trackedChanges<T extends CensusSubject>(changes: readonly T[]): T[] {
  return changes.filter(isTrackedChange);
}

export type ChangeSliceId = "tracked" | "in_force" | "stood_behind" | "held";

export interface ChangeSlice {
  id: ChangeSliceId;
  noun: string;
  field: string;
  admits: string;
  of<T extends CensusSubject>(changes: readonly T[]): T[];
}

export const CHANGE_SLICES: ChangeSlice[] = [
  {
    id: "tracked",
    noun: TRACKED_CHANGE_NOUN,
    field: "tracked_pricing_changes",
    admits: TRACKED_CHANGE_RULE_SENTENCE,
    of: (changes) => changes.filter(isTrackedChange),
  },
  {
    id: "in_force",
    noun: "changes still in force",
    field: "changes_still_in_force",
    admits:
      "Adds our own index housekeeping — a source we dropped, written up as the vendor deprecating a product.",
    of: (changes) => changes.filter((c) => !isNoLongerInForce(c)),
  },
  {
    id: "stood_behind",
    noun: "records we stand behind",
    field: "records_we_stand_behind",
    admits: "Adds changes the vendor has since reversed. They happened; they no longer hold.",
    of: (changes) => changes.filter((c) => !theEventNeverHappened(c)),
  },
  {
    id: "held",
    noun: "records in the change log",
    field: "records_held",
    admits: "Adds records we withdrew as our own error. They describe events that did not happen.",
    of: (changes) => [...changes],
  },
];

export function sliceById(id: ChangeSliceId): ChangeSlice {
  const slice = CHANGE_SLICES.find((s) => s.id === id);
  if (!slice) throw new Error(`No change slice named ${id}`);
  return slice;
}

export function changeCensus<T extends CensusSubject>(changes: readonly T[]): Record<string, number> {
  return Object.fromEntries(CHANGE_SLICES.map((slice) => [slice.field, slice.of(changes).length]));
}

export function changeCountPhrase<T extends CensusSubject>(
  id: ChangeSliceId,
  changes: readonly T[],
): string {
  const slice = sliceById(id);
  return `${slice.of(changes).length.toLocaleString("en-US")} ${slice.noun}`;
}

export const CENSUS_NOTE =
  `Every total we publish is one of these four and names which. ${TRACKED_CHANGE_RULE_SENTENCE} `
  + `The rule is at ${TRACKED_CHANGE_RULE_PATH}.`;
