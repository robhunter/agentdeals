import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { figuresWorthReporting, statedFiguresClause } from "./vendor-naming.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = path.join(REPO, "data", "index.json");

export const REPORTED_FIGURES = /^(?<named>.*?) and states (?<figures>"[^"]*"(?: and "[^"]*")*)$/;

const QUOTED = /"([^"]*)"/g;

export function reportedFigures(detail) {
  const shape = REPORTED_FIGURES.exec(detail ?? "");
  if (!shape) return null;
  return {
    named: shape.groups.named,
    figures: [...shape.groups.figures.matchAll(QUOTED)].map((quoted) => quoted[1]),
  };
}

export function detailWithoutFiguresWeDoNotPublish(detail, terms) {
  const reported = reportedFigures(detail);
  if (!reported) return detail;
  const keep = figuresWorthReporting(reported.figures, terms);
  if (keep.length === reported.figures.length && keep.every((figure, at) => figure === reported.figures[at])) {
    return detail;
  }
  if (keep.length === 0) return reported.named.replace(/,$/, "");
  return `${reported.named} and ${statedFiguresClause(keep)}`;
}

function run({ write }) {
  const data = JSON.parse(fs.readFileSync(INDEX, "utf-8"));
  const counts = { checked: 0, reporting: 0, unchanged: 0, narrowed: 0, withdrawn: 0 };
  const withdrawn = [];
  for (const offer of data.offers) {
    if (offer.source_check?.outcome !== "ok") continue;
    counts.checked++;
    const detail = offer.source_check.detail ?? "";
    if (!reportedFigures(detail)) continue;
    counts.reporting++;
    const settled = detailWithoutFiguresWeDoNotPublish(detail, offer.description);
    if (settled === detail) {
      counts.unchanged++;
      continue;
    }
    if (reportedFigures(settled)) counts.narrowed++;
    else {
      counts.withdrawn++;
      withdrawn.push(`${offer.vendor}: ${reportedFigures(detail).figures.join(" and ")}`);
    }
    offer.source_check.detail = settled;
  }
  console.log(`Records passing the source check: ${counts.checked}`);
  console.log(`Reporting a figure the page states: ${counts.reporting}`);
  console.log(`Reporting a figure we publish, left alone: ${counts.unchanged}`);
  console.log(`Narrowed to the figures we publish: ${counts.narrowed}`);
  console.log(`Figure withdrawn, naming kept: ${counts.withdrawn}`);
  for (const line of withdrawn.slice(0, 15)) console.log(`  ${line}`);
  if (write) {
    fs.writeFileSync(INDEX, `${JSON.stringify(data, null, 2)}\n`);
    console.log(`Wrote ${INDEX}`);
  } else {
    console.log("Dry run. Pass --write to save.");
  }
  return counts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run({ write: process.argv.includes("--write") });
}
