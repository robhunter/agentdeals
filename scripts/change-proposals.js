#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANGES_PATH, changeKey, isoDay, readChangeLog, selectNewChanges } from "./change-log.js";
import {
  applyRestatements,
  figuresTheReadingDrops,
  indexPath,
  readRestatements,
  releaseHeldReadingsBehind,
  releaseLines,
  termsTheWriteDidPublish,
  writeRestatements,
} from "./restate-superseded-terms.js";
import { dealChangesAsPublished } from "../dist/data.js";
import { restatementRulings } from "../dist/restatement.js";
import { toSlug } from "../dist/vendor-slug.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROPOSALS_FILE = "data/change_proposals.json";

export const DROPPED_KEPT_DAYS = 180;

export const READING_DROPS_A_FIGURE_OUR_SOURCE_CHECK_FOUND = "reading_drops_a_figure_our_source_check_found";

export function proposalsPath() {
  return process.env.AGENTDEALS_PROPOSALS_PATH || resolve(__dirname, "..", PROPOSALS_FILE);
}

export function emptyProposals() {
  return { proposals: [], dropped: [] };
}

export function readProposals(path = proposalsPath()) {
  if (!existsSync(path)) return emptyProposals();
  const store = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(store?.proposals) || !Array.isArray(store?.dropped)) {
    throw new Error(`${path} has no proposals and dropped arrays`);
  }
  return store;
}

export function writeProposals(store, path = proposalsPath()) {
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n");
}

export function proposalId(record, taken = new Set()) {
  const base = `${record.recorded_date}/${toSlug(record.vendor)}/${record.change_type}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export function recordAsWritten(entry) {
  const {
    proposal_id: _id,
    proposed_on: _proposedOn,
    restatement: _restatement,
    dropped_on: _droppedOn,
    drop_reason: _dropReason,
    ...record
  } = entry;
  return record;
}

export function whatTheWindowCounts(store) {
  return [...store.proposals, ...store.dropped].map(({ vendor, change_type, recorded_date }) => ({
    vendor,
    change_type,
    recorded_date,
  }));
}

function daysFrom(day, today) {
  return Math.round((Date.parse(today) - Date.parse(day)) / 86400000);
}

export function droppedStillKept(dropped, today) {
  return dropped.filter((entry) => daysFrom(entry.dropped_on, today) <= DROPPED_KEPT_DAYS);
}

function vendorNamesOf(offers) {
  return new Set(offers.map((offer) => offer.vendor.trim().toLowerCase()));
}

export function restatementRulingsFor(record, offers, published, today) {
  const view = dealChangesAsPublished([...published, record], vendorNamesOf(offers));
  const proposed = view[view.length - 1];
  const vendor = proposed.vendor.toLowerCase();
  const listings = offers.filter((offer) => offer.vendor.toLowerCase() === vendor);
  const vendorChanges = view.filter((change) => change.vendor.toLowerCase() === vendor);
  return restatementRulings(listings, () => vendorChanges, today).filter((ruling) => ruling.change === proposed);
}

export function restatementPreview(rulings) {
  return rulings.map((ruling) => {
    if (ruling.refusal) return { url: ruling.offer.url, refused: ruling.refusal };
    const figures = figuresTheReadingDrops(ruling);
    if (figures.length > 0) {
      return { url: ruling.offer.url, refused: READING_DROPS_A_FIGURE_OUR_SOURCE_CHECK_FOUND, figures };
    }
    return { url: ruling.offer.url, description: ruling.description };
  });
}

export function proposalsBeside(changesPath) {
  return join(dirname(changesPath), basename(PROPOSALS_FILE));
}

export function proposeChangeEntries(candidates, options = {}) {
  const published = readChangeLog(options.changesPath ?? CHANGES_PATH).changes;
  const path = options.path ?? (options.changesPath ? proposalsBeside(options.changesPath) : proposalsPath());
  const store = readProposals(path);
  const today = isoDay(options.now ?? new Date());
  const { fresh, suppressed } = selectNewChanges([...published, ...whatTheWindowCounts(store)], candidates, options);
  const taken = new Set([...store.proposals, ...store.dropped].map((entry) => entry.proposal_id));
  const proposed = fresh.map((record) => {
    const id = proposalId(record, taken);
    taken.add(id);
    return {
      proposal_id: id,
      proposed_on: today,
      ...record,
      restatement: restatementPreview(restatementRulingsFor(record, options.offers ?? [], published, today)),
    };
  });
  const dropped = droppedStillKept(store.dropped, today);
  if (!options.dryRun && (proposed.length > 0 || dropped.length < store.dropped.length)) {
    writeProposals({ proposals: [...store.proposals, ...proposed], dropped }, path);
  }
  return { proposed, suppressed, total: store.proposals.length + proposed.length };
}

export function proposalLine(proposal) {
  return `  proposed ${proposal.proposal_id}: ${proposal.vendor}, ${proposal.change_type}, ${proposal.impact} impact, ${proposal.source_url}`;
}

export function restatementPreviewLines(proposal) {
  if ((proposal.restatement ?? []).length === 0) return ["      restates no listing"];
  return proposal.restatement.map((outcome) =>
    outcome.refused
      ? `      would not restate ${outcome.url}: ${outcome.refused}${outcome.figures ? ` (${outcome.figures.join(", ")})` : ""}`
      : `      would restate ${outcome.url} to read: ${outcome.description}`,
  );
}

function idsNotPending(ids, store) {
  const pending = new Set(store.proposals.map((proposal) => proposal.proposal_id));
  return ids.filter((id) => !pending.has(id));
}

export function confirmProposals(ids, documents, today) {
  const { store, log, index } = documents;
  const unknown = idsNotPending(ids, store);
  if (unknown.length > 0) return { confirmed: [], unknown, duplicates: [] };
  const confirmed = [];
  const duplicates = [];
  for (const id of ids) {
    const at = store.proposals.findIndex((proposal) => proposal.proposal_id === id);
    const record = recordAsWritten(store.proposals[at]);
    if (log.changes.some((change) => changeKey(change) === changeKey(record))) {
      duplicates.push(id);
      continue;
    }
    const rulings = restatementRulingsFor(record, index.offers ?? [], log.changes, today);
    store.proposals.splice(at, 1);
    log.changes.push(record);
    const restated = applyRestatements(index, rulings, today);
    confirmed.push({ id, record, restated, outcomes: restatementPreview(rulings) });
  }
  return { confirmed, unknown, duplicates };
}

export function dropProposals(ids, store, today, reason = null) {
  const unknown = idsNotPending(ids, store);
  if (unknown.length > 0) return { dropped: [], unknown };
  const dropped = [];
  for (const id of ids) {
    const at = store.proposals.findIndex((proposal) => proposal.proposal_id === id);
    const [proposal] = store.proposals.splice(at, 1);
    const entry = { ...proposal, dropped_on: today, ...(reason ? { drop_reason: reason } : {}) };
    store.dropped.push(entry);
    dropped.push(entry);
  }
  store.dropped = droppedStillKept(store.dropped, today);
  return { dropped, unknown };
}

export function unknownIdLines(unknown, store) {
  const dropped = new Map(store.dropped.map((entry) => [entry.proposal_id, entry]));
  return unknown.map((id) =>
    dropped.has(id)
      ? `${id} was dropped on ${dropped.get(id).dropped_on}, so it is not pending.`
      : `${id} is not a pending proposal in ${PROPOSALS_FILE}.`,
  );
}

export function confirmedLines(confirmed) {
  const lines = [];
  for (const { id, record, restated, outcomes } of confirmed) {
    lines.push(`Confirmed ${id}: ${record.vendor} (${record.change_type}) is in data/deal_changes.json, recorded ${record.recorded_date}.`);
    for (const entry of restated) {
      lines.push(`  ✎ ${entry.vendor} restated from ${entry.source_url} as read on ${entry.reading_date}`);
      lines.push(`      was: ${entry.previous_description}`);
      lines.push(`      now: ${entry.description}`);
    }
    for (const outcome of outcomes.filter((one) => one.refused)) {
      lines.push(`  ⇥ ${outcome.url} not restated: ${outcome.refused}${outcome.figures ? ` (${outcome.figures.join(", ")})` : ""}`);
    }
    if (outcomes.length === 0) lines.push("  ⇥ restates no listing");
  }
  return lines;
}

export function droppedLines(dropped) {
  return dropped.map(
    (entry) =>
      `Dropped ${entry.proposal_id}: ${entry.vendor} (${entry.change_type}), kept under dropped for ${DROPPED_KEPT_DAYS} days` +
      (entry.drop_reason ? ` with the reason: ${entry.drop_reason}` : "."),
  );
}

const USAGE = `Usage:
  node scripts/change-proposals.js confirm <proposal_id>...
  node scripts/change-proposals.js drop <proposal_id>... [--reason "<text>"]

confirm moves each proposal from ${PROPOSALS_FILE} into data/deal_changes.json as it stands in the file,
with its recorded_date unchanged, and applies the restatement it makes to its vendor's listings.
drop keeps the whole proposal under dropped with the day and the reason, for ${DROPPED_KEPT_DAYS} days.`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "confirm" && command !== "drop") return null;
  const ids = [];
  let reason = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--reason" && command === "drop") {
      reason = rest[i + 1] ?? "";
      i++;
    } else {
      ids.push(rest[i]);
    }
  }
  if (ids.length === 0 || reason === "") return null;
  return { command, ids, reason };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(USAGE);
    process.exit(2);
  }
  const today = isoDay(new Date());
  const path = proposalsPath();
  const store = readProposals(path);

  if (args.command === "drop") {
    const { dropped, unknown } = dropProposals(args.ids, store, today, args.reason);
    if (unknown.length > 0) {
      for (const line of unknownIdLines(unknown, store)) console.error(line);
      process.exit(2);
    }
    writeProposals(store, path);
    for (const line of droppedLines(dropped)) console.log(line);
    process.exit(0);
  }

  const log = readChangeLog(CHANGES_PATH);
  const index = JSON.parse(readFileSync(indexPath(), "utf-8"));
  const { confirmed, unknown, duplicates } = confirmProposals(args.ids, { store, log, index }, today);
  if (unknown.length > 0) {
    for (const line of unknownIdLines(unknown, store)) console.error(line);
    process.exit(2);
  }
  for (const id of duplicates) console.error(`${id} is already in data/deal_changes.json, so it was not added again.`);
  const restated = confirmed.flatMap((one) => one.restated);
  writeFileSync(CHANGES_PATH, JSON.stringify(log, null, 2) + "\n");
  writeProposals(store, path);
  if (restated.length > 0) {
    writeFileSync(indexPath(), JSON.stringify(index, null, 2) + "\n");
    writeRestatements([...readRestatements(), ...restated]);
  }
  const released = releaseHeldReadingsBehind(termsTheWriteDidPublish(restated));
  for (const line of confirmedLines(confirmed)) console.log(line);
  for (const line of releaseLines(released.resolutions)) console.log(line);
  process.exit(duplicates.length > 0 ? 1 : 0);
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) main();
