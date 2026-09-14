#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGES_PATH =
  process.env.AGENTDEALS_CHANGES_PATH || resolve(__dirname, "..", "data", "deal_changes.json");

const RETRACTED_ON = "2026-09-14";

export const RETRACTIONS = [
  {
    vendor: "Plausible Analytics",
    date: "2026-08-28",
    change_type: "free_tier_removed",
    source_url: "https://github.com/plausible/analytics",
    detail:
      `Retracted ${RETRACTED_ON}: plausible/analytics is AGPL-3.0 and was pushed to on 2026-09-12, so the ` +
      `self-hosted edition this offer describes is free to run today. The page this record cites, ` +
      `plausible.io, is the marketing homepage: it advertises the hosted plans from $9/mo and states ` +
      `nothing about the licence in either direction. This record's own previous_state reads "Free OSS ` +
      `(AGPLv3) ... Self-hosted with no limits. Cloud plans start at $9/mo", so the paid hosting it ` +
      `reports as new was already what we held. A page that sells hosting cannot say a licence ended.`,
  },
  {
    vendor: "Circum Icons",
    date: "2026-08-28",
    change_type: "free_tier_removed",
    source_url: "https://github.com/Klarr-Agency/Circum-Icons",
    detail:
      `Retracted ${RETRACTED_ON}: Klarr-Agency/Circum-Icons is MPL-2.0, which grants free use of the icon ` +
      `set and has not been changed. circumicons.com, the page this record cites, prices a $9 bundle of ` +
      `1600+ icons; a price for a bundle is not the withdrawal of a licence. The repository was last ` +
      `pushed on 2024-04-20, so the project is unmaintained — that is a different thing to report and a ` +
      `different record, not this one.`,
  },
  {
    vendor: "Rybbit",
    date: "2026-08-28",
    change_type: "free_tier_removed",
    source_url: "https://github.com/rybbit-io/rybbit",
    detail:
      `Retracted ${RETRACTED_ON}: rybbit-io/rybbit is AGPL-3.0 and was pushed to on 2026-09-14, so the ` +
      `self-hosted edition is free to run today and this record's claim that "the free tier no longer ` +
      `exists" is wrong as written. rybbit.com states what the hosted plans cost, which is evidence ` +
      `about a plan and not about a licence. Whether the hosted 3,000-events-a-month plan named in our ` +
      `stored description has gone is a separate question this record does not settle, and a record that ` +
      `answers it must say it is the hosted plan that ended.`,
  },
];

export function applyRetractions(changes, retractions = RETRACTIONS) {
  const applied = [];
  const missing = [];
  for (const retraction of retractions) {
    const record = changes.find(
      (c) =>
        c.vendor === retraction.vendor &&
        c.date === retraction.date &&
        c.change_type === retraction.change_type
    );
    if (!record) {
      missing.push(retraction);
      continue;
    }
    record.resolution = {
      state: "retracted",
      date: RETRACTED_ON,
      detail: retraction.detail,
      source_url: retraction.source_url,
    };
    applied.push({ vendor: record.vendor, date: record.date, source_url: retraction.source_url });
  }
  return { applied, missing };
}

function main() {
  const apply = process.argv.includes("--apply");
  const log = JSON.parse(readFileSync(CHANGES_PATH, "utf8"));
  const { applied, missing } = applyRetractions(log.changes);
  process.stdout.write(`${JSON.stringify({ applied, missing }, null, 2)}\n`);
  if (missing.length > 0) process.exitCode = 1;
  if (apply && missing.length === 0) {
    writeFileSync(CHANGES_PATH, `${JSON.stringify(log, null, 2)}\n`);
    process.stdout.write(`wrote ${CHANGES_PATH}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
