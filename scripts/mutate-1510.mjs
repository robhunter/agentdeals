import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const READ_DATE = "src/read-date.ts";
const STATE = "scripts/verification-state.js";
const SERVE = "src/serve.ts";
const DATA = "src/data.ts";

const SUITE = ["test/read-date.test.ts", "test/published-read-date.test.ts"];

const MUTANTS = [
  ["the-read-date-is-just-the-verification-date-again", READ_DATE,
    `  const dates = candidates.filter((d): d is string => Boolean(d)).sort();\n  return dates.length > 0 ? dates[dates.length - 1] : verified;`,
    `  return verified;`],

  ["a-read-that-failed-counts-as-a-read", READ_DATE,
    `  if (outcomeReadThePage(record?.last_outcome)) candidates.push(record?.last_attempt_at ?? null);`,
    `  candidates.push(record?.last_attempt_at ?? null);`],

  ["a-read-that-reached-no-verdict-counts-as-a-read", READ_DATE,
    `  "states_no_price",\n] as const;`,
    `  "states_no_price",\n  "unclear",\n] as const;`],

  ["a-page-that-states-no-price-was-never-read", READ_DATE,
    `  "states_no_price",\n] as const;`,
    `] as const;`],

  ["the-persisted-read-date-is-ignored", READ_DATE,
    `  const candidates = [verified, record?.last_read_at ?? null];`,
    `  const candidates = [verified, null];`],

  ["the-cell-drops-the-verification-date", READ_DATE,
    `  return readAfterVerified ? \`\${read} / \${verified}\` : read;`,
    `  return read;`],

  ["the-note-says-both-dates-are-one-day", READ_DATE,
    `  return readAfterVerified\n    ? \`The day we last read the vendor's page. The terms we publish were last confirmed on \${verified}.\`\n    : "The day we last read the vendor's page, and the day we last confirmed the terms we publish.";`,
    `  return "The day we last read the vendor's page, and the day we last confirmed the terms we publish.";`],

  ["the-state-stamps-a-read-date-whatever-happened", STATE,
    `    last_read_at: answered ? attempt.date : (base.last_read_at ?? null),`,
    `    last_read_at: attempt.date,`],

  ["the-state-stamps-no-read-date-at-all", STATE,
    `    last_read_at: answered ? attempt.date : (base.last_read_at ?? null),`,
    `    last_read_at: null,`],

  ["the-state-forgets-the-read-date-on-the-next-failure", STATE,
    `    last_read_at: answered ? attempt.date : (base.last_read_at ?? null),`,
    `    last_read_at: answered ? attempt.date : null,`],

  ["the-vendor-page-drops-the-read-date-card", SERVE,
    `    <div class="detail-card">
      <div class="detail-label">\${LAST_READ_LABEL}</div>`,
    `    <div class="detail-card" hidden>
      <div class="detail-label">\${""}</div>`],

  ["the-page-dates-its-last-update-from-the-verification-again", SERVE,
    `  const lastUpdated = lastPricingChange && lastPricingChange > primaryLastRead ? lastPricingChange : primaryLastRead;`,
    `  const lastUpdated = lastPricingChange && lastPricingChange > primary.verifiedDate ? lastPricingChange : primary.verifiedDate;`],

  ["the-category-table-publishes-the-verification-date-only", SERVE,
    `<td style="font-family:var(--mono);color:var(--text-dim);white-space:nowrap">\${escHtmlServer(verificationDatesCell(o))}</td>`,
    `<td style="font-family:var(--mono);color:var(--text-dim);white-space:nowrap">\${escHtmlServer(o.verifiedDate)}</td>`],

  ["the-api-answers-without-a-read-date", DATA,
    `    const last_read_date = lastReadDate(offer);`,
    `    const last_read_date = undefined as unknown as string;`],

  ["the-api-answers-with-the-verification-date-as-the-read-date", DATA,
    `    const last_read_date = lastReadDate(offer);`,
    `    const last_read_date = offer.verifiedDate;`],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

const survivors = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP      ${name} — the line it mutates is not in ${file}`);
    survivors.push(`${name} (not applied)`);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npx", ["tsc"]);
  const green = built && run("npx", ["tsx", "--test", ...SUITE]);
  writeFileSync(file, original);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "killed by tsc"}  ${name}`);
  if (green) survivors.push(name);
}
run("npx", ["tsc"]);
console.log(`\n${MUTANTS.length - survivors.length}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
