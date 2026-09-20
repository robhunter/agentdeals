import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { freePlanStatedOn, readablePartsOf } = await import(`${root}/dist/page-free-plan.js`);
const { ladderNamesIn, readingsOf } = await import(`${root}/dist/page-priced-plans.js`);

const A_PRICE_FIELD_OF_NOTHING = /"[A-Za-z_]*(?:price|cost|amount)[A-Za-z_]*"\s*:\s*0(?![\d.])/gi;
const { aFreePlanOnThePageWouldRefuteIt, REMOVAL_CLASS, removalRecordsStillInForce } = await import(
  `${root}/dist/removal-record.js`
);

const TIMEOUT_MS = 30000;
const CONCURRENCY = 4;
const AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const changes = JSON.parse(readFileSync(`${root}/data/deal_changes.json`, "utf8")).changes;
const inClass = changes.filter((c) => REMOVAL_CLASS.has(c.change_type));
const inForce = removalRecordsStillInForce(inClass).filter((c) =>
  aFreePlanOnThePageWouldRefuteIt(c.change_type),
);
const citable = inForce.filter((c) => c.source_url?.trim());
const uncitable = inForce.filter((c) => !c.source_url?.trim());

async function fetched(url) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: control.signal,
      headers: { "user-agent": AGENT, accept: "text/html,application/xhtml+xml" },
    });
    return { status: response.status, url: response.url, body: await response.text() };
  } catch (error) {
    return { status: 0, url, body: "", error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

async function inBatches(items, size, run) {
  const out = [];
  for (let at = 0; at < items.length; at += size) {
    out.push(...(await Promise.all(items.slice(at, at + size).map(run))));
  }
  return out;
}

function withoutThePlans(parts) {
  return { visible: parts.visible, structured: parts.structured, plans: [] };
}

const rows = await inBatches(citable, CONCURRENCY, async (change) => {
  const url = change.source_url.trim();
  const page = await fetched(url);
  if (page.status < 200 || page.status >= 400 || page.body === "") {
    return { change, url, reached: false, status: page.status, error: page.error ?? null };
  }
  const parts = readablePartsOf(page.body);
  const readings = new Set(parts.plans.map((plan) => plan.reading));
  const zeroFields = readingsOf(page.body).flatMap((reading) => [
    ...new Set([...reading.matchAll(A_PRICE_FIELD_OF_NOTHING)].map((m) => m[0])),
  ]);
  return {
    zeroFields: [...new Set(zeroFields)],
    change,
    url,
    landed: page.url,
    reached: true,
    status: page.status,
    bytes: page.body.length,
    before: freePlanStatedOn(withoutThePlans(parts)),
    after: freePlanStatedOn(parts),
    plans: parts.plans,
    names: ladderNamesIn(parts.plans),
    groups: readings.size,
  };
});

const reached = rows.filter((r) => r.reached);
const unreachable = rows.filter((r) => !r.reached);
const newlyRefuted = reached.filter((r) => !r.before && r.after);
const alreadyRefuted = reached.filter((r) => r.before);
const multiLadder = reached.filter((r) => r.groups > 1);
const zeroPriced = reached.filter((r) => r.plans?.some((p) => p.amount === 0));

console.log(`free_tier_removed records in the whole change log: ${inClass.filter((c) => c.change_type === "free_tier_removed").length}`);
console.log(`  still in force: ${inForce.length}`);
console.log(`  citing nothing, so unreadable: ${uncitable.length}`);
console.log(`  read this run: ${citable.length}`);
console.log(`    cited page reached: ${reached.length}`);
console.log(`    cited page unreachable: ${unreachable.length}`);
console.log("");
console.log(`already refuted by the reader we shipped: ${alreadyRefuted.length}`);
console.log(`AC-5 — refuted only once a numeric price field is read: ${newlyRefuted.length}`);
console.log(`  pages pricing at least one plan at zero in a numeric field: ${zeroPriced.length}`);
console.log(`AC-6 — pages carrying more than one plan ladder: ${multiLadder.length}`);
console.log("");
const withAZeroField = reached.filter((r) => r.zeroFields.length > 0);
const missedByTheParser = withAZeroField.filter((r) => !r.plans.some((p) => p.amount === 0));
console.log(`superset, pages carrying a price-shaped field set to zero anywhere: ${withAZeroField.length}`);
console.log(`  of those, the plan reader harvested no zero-priced plan: ${missedByTheParser.length}`);
for (const row of missedByTheParser) {
  console.log(`    ${row.change.vendor} | ${row.url} | ${row.zeroFields.slice(0, 6).join(" ")}`);
}
console.log("");

console.log("AC-5, one line per record:");
for (const row of newlyRefuted) {
  console.log(`  ${row.change.vendor} | ${row.change.date} | ${row.url}`);
  console.log(`    ${row.after.sentence}`);
  console.log(`    ladder: ${row.names.join(" / ")}`);
}

console.log("");
console.log("AC-6, one line per record:");
for (const row of multiLadder) {
  const byReading = new Map();
  for (const plan of row.plans) {
    const held = byReading.get(plan.reading) ?? [];
    held.push(`${plan.name} ${plan.amount}`);
    byReading.set(plan.reading, held);
  }
  console.log(`  ${row.change.vendor} | ${row.url} | ${row.groups} groups`);
  for (const [, held] of byReading) console.log(`    ${[...new Set(held)].join(" / ")}`);
}

if (unreachable.length) {
  console.log("");
  console.log("unreachable:");
  for (const row of unreachable) {
    console.log(`  ${row.change.vendor} | ${row.url} | status ${row.status}${row.error ? ` | ${row.error}` : ""}`);
  }
}

console.log("");
console.log("every record read, with the ladder we found:");
for (const row of reached) {
  console.log(
    `  ${row.change.vendor} | ${row.before ? row.before.where : "-"} -> ${row.after ? row.after.where : "-"} | groups ${row.groups} | ${row.names.length ? row.names.join(" / ") : "(no priced plans)"}`,
  );
}

const out = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;
if (out) {
  writeFileSync(
    out,
    JSON.stringify(
      {
        read: new Date().toISOString().slice(0, 10),
        in_force: inForce.length,
        uncitable: uncitable.length,
        read_this_run: citable.length,
        reached: reached.length,
        already_refuted: alreadyRefuted.length,
        newly_refuted: newlyRefuted.length,
        multi_ladder: multiLadder.length,
        rows: rows.map((r) => ({
          vendor: r.change.vendor,
          date: r.change.date,
          url: r.url,
          reached: r.reached,
          status: r.status ?? 0,
          before: r.before ?? null,
          after: r.after ?? null,
          groups: r.groups ?? 0,
          names: r.names ?? [],
        })),
      },
      null,
      2,
    ),
  );
}
