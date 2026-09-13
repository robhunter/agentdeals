import { writeSync, readFileSync } from "node:fs";
import { measuredValue, measuredWord, periodSeconds, quantifiedAttributes, readQuantities } from "./change-gate.js";
import { narrowsTheStoredTerms } from "../dist/change-direction.js";

const say = (line) => writeSync(2, `${line}\n`);

const BYTE_SCALE = new Map([["kb", 1e3], ["mb", 1e6], ["gb", 1e9], ["tb", 1e12], ["pb", 1e15],
  ["kib", 1024], ["mib", 1024 ** 2], ["gib", 1024 ** 3], ["tib", 1024 ** 4], ["pib", 1024 ** 5]]);

const measuresAnAmount = (a) => !(a?.words ?? []).includes("price");

export function statedQuantity(attribute) {
  const word = measuredWord(attribute);
  if (!word) return null;
  const value = measuredValue(attribute);
  if (value === null) return null;
  const bytes = attribute.unit ? BYTE_SCALE.get(attribute.unit.toLowerCase()) : null;
  const scaled = bytes ? value * bytes : value;
  const seconds = periodSeconds(attribute.period);
  const rate = seconds === null ? scaled : scaled / seconds;
  return `${word}|${bytes ? "bytes" : (attribute.unit ?? "")}|${seconds === null ? "flat" : "rate"}|${rate}`;
}

export function statedQuantities(text) {
  return quantifiedAttributes(text).filter(measuresAnAmount).map(statedQuantity).filter(Boolean);
}

export function figuresWeCouldNotRead(text) {
  const seen = readQuantities(text).filter(a => !a.spellsAPeriod).filter(measuresAnAmount);
  return seen.filter(a => statedQuantity(a) === null).length;
}

export function restatesTheStoredQuantities(entry) {
  const previous = statedQuantities(entry?.previous_state);
  const current = statedQuantities(entry?.current_state);
  if (current.length === 0 || previous.length === 0) return null;
  if (figuresWeCouldNotRead(entry.current_state) > 0) return null;
  const pool = [...previous];
  for (const key of current) {
    const at = pool.indexOf(key);
    if (at === -1) return null;
    pool.splice(at, 1);
  }
  //VARIANT
  return { restated: current.length, dropped: pool.length, droppedKeys: pool };
}

const changes = JSON.parse(readFileSync("data/deal_changes.json", "utf-8")).changes;
const extra = process.argv[2] ? [JSON.parse(readFileSync(process.argv[2], "utf-8"))] : [];
const all = [...changes, ...extra];

const narrowing = all.filter(
  c => (narrowsTheStoredTerms(c.change_type) || c.tier_direction === "narrowed")
    && typeof c.previous_state === "string" && typeof c.current_state === "string",
);
say(`narrowing records holding both states: ${narrowing.length} of ${all.length}`);

const flagged = narrowing.filter(restatesTheStoredQuantities);
say(`records whose current state restates the stored quantities and drops others: ${flagged.length}`);
say("");
for (const c of flagged) {
  const { restated, dropped } = restatesTheStoredQuantities(c);
  say(`${c.vendor} | ${c.date} | ${c.change_type} | ${c.tier_direction ?? "-"} | restates ${restated}, drops ${dropped}`);
  say(`    before: ${c.previous_state.slice(0, 190)}`);
  say(`    after:  ${c.current_state.slice(0, 190)}`);
}

const NAMED_BY_1634 = ["Scalr", "Terrateam", "TeleportHQ", "Figma", "Microsoft Founders Hub",
  "Thunder Client", "Infisical", "OneSignal", "Brex", "Activepieces", "Cloudflare Workers"];
const NEGATIVE = ["Servervana", "OpenAI", "Expose", "Docs", "Zoho Docs"];
const hit = new Set(flagged.map(c => c.vendor.toLowerCase()));
say("");
say(`of the 11 the issue names, flagged: ${NAMED_BY_1634.filter(v => hit.has(v.toLowerCase())).join(", ") || "none"}`);
say(`  missed: ${NAMED_BY_1634.filter(v => !hit.has(v.toLowerCase())).join(", ") || "none"}`);
say(`of the 5 the issue rejected, flagged: ${NEGATIVE.filter(v => hit.has(v.toLowerCase())).join(", ") || "none"}`);
