import { readFileSync, writeFileSync } from "node:fs";
import {
  describesChange,
  readQuantities,
  quantifiedAttributes,
  quantities,
  measuredWord,
} from "./change-gate.js";

const published = JSON.parse(readFileSync("data/deal_changes.json", "utf8")).changes ?? [];
const refused = JSON.parse(readFileSync("data/change_refusals.json", "utf8")).refusals ?? [];

const corpus = [
  ...published.map((record, i) => ({ record, origin: `published:${i}` })),
  ...refused.map((record, i) => ({ record, origin: `refused:${i}` })),
];

const verdicts = [];
for (const { record, origin } of corpus) {
  let verdict;
  try {
    const out = describesChange(record);
    verdict = out.ok
      ? `ok${out.reclassifyAs ? `:${out.reclassifyAs}` : ""}`
      : `refused:${out.reason}`;
  } catch (error) {
    verdict = `threw:${error.message}`;
  }
  verdicts.push({
    origin,
    vendor: record.vendor,
    date: record.date,
    change_type: record.change_type,
    verdict,
  });
}

const states = [];
for (const { record, origin } of corpus) {
  for (const field of ["previous_state", "current_state", "summary"]) {
    const text = record[field];
    if (typeof text !== "string" || text.length === 0) continue;
    states.push({
      origin,
      field,
      vendor: record.vendor,
      text,
      read: readQuantities(text).map((q) => ({
        value: q.value,
        words: q.words,
        unit: q.unit,
        scale: q.scale,
        period: q.period ? `${q.period.count ?? ""}${q.period.unit}` : null,
        measured: measuredWord(q),
        spellsAPeriod: q.spellsAPeriod,
      })),
      kept: quantifiedAttributes(text).length,
      bare: quantities(text),
    });
  }
}

const out = { verdicts, states };
const target = process.argv[2] ?? "/tmp/census-1634-reader.json";
writeFileSync(target, JSON.stringify(out));

const tally = new Map();
for (const { verdict } of verdicts) tally.set(verdict, (tally.get(verdict) ?? 0) + 1);
const lines = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${String(n).padStart(5)}  ${k}`);
process.stderr.write(`${corpus.length} records, ${states.length} state texts\n${lines.join("\n")}\n`);
