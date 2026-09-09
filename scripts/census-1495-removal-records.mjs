import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { freePlanStatedOn, readablePartsOf } = await import(`${root}/dist/page-free-plan.js`);
const { isNoLongerInForce } = await import(`${root}/dist/change-resolution.js`);
const { REMOVAL_CLASS, aFreePlanOnThePageWouldRefuteIt, removalRecordsInTheServedWindow, removalRecordsStillInForce } =
  await import(`${root}/dist/removal-record.js`);

const TIMEOUT_MS = 30000;
const CONCURRENCY = 5;
const AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const changes = JSON.parse(readFileSync(`${root}/data/deal_changes.json`, "utf8")).changes;
const everywhere = process.argv.includes("--all");
const inTheClass = everywhere
  ? changes.filter((c) => REMOVAL_CLASS.has(c.change_type))
  : removalRecordsInTheServedWindow(changes, Date.now());
const inForce = removalRecordsStillInForce(inTheClass);
const population = inForce.filter((c) => aFreePlanOnThePageWouldRefuteIt(c.change_type));
const deprecations = inForce.length - population.length;

async function fetched(url) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: control.signal,
      headers: { "user-agent": AGENT, accept: "text/html,application/xhtml+xml" },
    });
    const body = await response.text();
    return { status: response.status, url: response.url, body };
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

const rows = await inBatches(population, CONCURRENCY, async (change) => {
  const url = change.source_url?.trim();
  if (!url) return { change, url: null, reached: false, stated: null };
  const page = await fetched(url);
  if (page.status < 200 || page.status >= 400 || page.body === "") {
    return { change, url, reached: false, status: page.status, error: page.error ?? null, stated: null };
  }
  const parts = readablePartsOf(page.body);
  return {
    change,
    url,
    landed: page.url,
    reached: true,
    status: page.status,
    bytes: page.body.length,
    stated: freePlanStatedOn(parts),
  };
});

const refuted = rows.filter((r) => r.stated);
const structuredOnly = refuted.filter((r) => r.stated.where === "structured");
const unreachable = rows.filter((r) => !r.reached);

console.log(`removal-class records ${everywhere ? "in the whole log" : "in the served window"}: ${inTheClass.length}`);
console.log(`  change types counted: ${[...REMOVAL_CLASS].join(", ")}`);
console.log(`  no longer in force, excluded: ${inTheClass.filter((c) => isNoLongerInForce(c)).length}`);
console.log(`  deprecations, excluded — a live plan table does not refute a product ending: ${deprecations}`);
console.log(`  read: ${population.length}`);
console.log(`  cited page reached: ${rows.length - unreachable.length}`);
console.log(`  cited page unreachable: ${unreachable.length}`);
console.log(`  cited page states a free plan today: ${refuted.length}`);
console.log(`    stated in visible text: ${refuted.length - structuredOnly.length}`);
console.log(`    stated only in structured markup: ${structuredOnly.length}`);
console.log("");

for (const row of refuted) {
  console.log(`${row.change.vendor} | ${row.change.change_type} | ${row.change.date} | ${row.stated.where}`);
  console.log(`  ${row.url}`);
  console.log(`  "${row.stated.sentence.slice(0, 240)}"`);
}

if (unreachable.length) {
  console.log("");
  console.log("unreachable:");
  for (const row of unreachable) {
    console.log(`  ${row.change.vendor} | ${row.url ?? "(no source_url)"} | status ${row.status ?? 0}${row.error ? ` | ${row.error}` : ""}`);
  }
}

const out = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;
if (out) {
  writeFileSync(
    out,
    JSON.stringify(
      {
        read: new Date().toISOString().slice(0, 10),
        population: population.length,
        reached: rows.length - unreachable.length,
        refuted: refuted.length,
        structured_only: structuredOnly.length,
        rows: rows.map((r) => ({
          vendor: r.change.vendor,
          change_type: r.change.change_type,
          date: r.change.date,
          url: r.url,
          landed: r.landed ?? null,
          reached: r.reached,
          status: r.status ?? 0,
          stated: r.stated,
        })),
      },
      null,
      2,
    ),
  );
}
