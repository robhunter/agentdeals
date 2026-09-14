const BASE = process.env.CENSUS_BASE_URL || "http://127.0.0.1:3457";
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 30);

const IMPOSSIBLE = ["2026-02-30", "2026-13-99", "2026-00-10", "2026-04-31"];
const MALFORMED = ["not-a-date", "2026-9-1", ""];
const TIMESTAMP_SUFFIXES = ["T00:00:00Z", "T23:59:59Z", "T12:00:00.000Z", "T00:00:00+00:00"];

const DECLARED_FILTERS = [
  { param: "type", recognised: "limits_reduced", unrecognised: "nonsense_type" },
  { param: "vendor", recognised: "Vercel", unrecognised: "a-vendor-we-do-not-hold" },
  { param: "vendors", recognised: "Vercel,Supabase", unrecognised: "no-such,also-none" },
  { param: "category", recognised: "Database", unrecognised: "not-a-category" },
  { param: "categories", recognised: "Database,Design", unrecognised: "not-a-category" },
];

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.text();
  let json = null;
  try { json = JSON.parse(body); } catch { json = null; }
  return { status: res.status, json, headers: res.headers, bytes: Buffer.byteLength(body) };
}

function totalOf(json) {
  if (!json) return null;
  if (typeof json.total === "number") return json.total;
  return null;
}

function earliestOf(json, field) {
  const rows = json?.changes ?? json?.deals ?? [];
  const dates = rows.map((r) => r[field]).filter(Boolean).sort();
  return dates[0] ?? null;
}

function daysBack(n) {
  const out = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    out.push(new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10));
  }
  return out.reverse();
}

async function boundaryTable(route, dateField) {
  const rows = [];
  for (const day of daysBack(WINDOW_DAYS)) {
    const bare = await getJson(`${route}?limit=1000&since=${day}`);
    if (bare.status !== 200) { rows.push({ day, bare: `HTTP ${bare.status}` }); continue; }
    const bareTotal = totalOf(bare.json);
    const onThatDay = (bare.json?.changes ?? bare.json?.deals ?? [])
      .filter((r) => String(r[dateField] ?? "").slice(0, 10) === day).length;
    const variants = {};
    for (const suffix of TIMESTAMP_SUFFIXES) {
      const iso = await getJson(`${route}?limit=1000&since=${encodeURIComponent(day + suffix)}`);
      variants[suffix] = iso.status === 200 ? totalOf(iso.json) : `HTTP ${iso.status}`;
    }
    rows.push({
      day,
      bare: bareTotal,
      variants,
      onThatDay,
      earliestBare: earliestOf(bare.json, dateField),
    });
  }
  return rows;
}

function printBoundary(route, rows) {
  console.log(`\n=== ${route} — bare date against the same instant in ISO-8601 ===`);
  console.log("day        | bare | " + TIMESTAMP_SUFFIXES.map((s) => s.padEnd(14)).join("| ") + "| dated that day | agree");
  let disagreements = 0;
  let lost = 0;
  for (const row of rows) {
    if (typeof row.bare !== "number") { console.log(`${row.day} | ${row.bare}`); continue; }
    const values = TIMESTAMP_SUFFIXES.map((s) => row.variants[s]);
    const agree = values.every((v) => v === row.bare);
    if (!agree) {
      disagreements++;
      for (const v of values) if (typeof v === "number") lost = Math.max(lost, row.bare - v);
    }
    console.log(
      `${row.day} | ${String(row.bare).padStart(4)} | `
      + values.map((v) => String(v).padEnd(14)).join("| ")
      + `| ${String(row.onThatDay).padStart(14)} | ${agree ? "yes" : "NO"}`,
    );
  }
  const withRecords = rows.filter((r) => typeof r.bare === "number").length;
  console.log(`days walked: ${withRecords}   days where a timestamp disagrees with its own date: ${disagreements}`);
  return disagreements;
}

async function impossibleDates(route) {
  console.log(`\n=== ${route} — dates that cannot exist, and malformed input ===`);
  let accepted = 0;
  for (const value of [...IMPOSSIBLE, ...MALFORMED]) {
    const res = await getJson(`${route}?limit=1000&since=${encodeURIComponent(value)}`);
    const total = totalOf(res.json);
    const verdict = res.status === 400 ? "400 refused" : `${res.status} answered total=${total}`;
    if (res.status !== 400) accepted++;
    console.log(`  since=${JSON.stringify(value).padEnd(16)} -> ${verdict}`);
  }
  return accepted;
}

async function conditional(path) {
  const first = await fetch(`${BASE}${path}`);
  const lastModified = first.headers.get("last-modified");
  const etag = first.headers.get("etag");
  const cacheControl = first.headers.get("cache-control");
  let revalidated = null;
  if (etag) {
    const res = await fetch(`${BASE}${path}`, { headers: { "If-None-Match": etag } });
    revalidated = { how: "If-None-Match", status: res.status, bytes: (await res.text()).length };
  } else if (lastModified) {
    const res = await fetch(`${BASE}${path}`, { headers: { "If-Modified-Since": lastModified } });
    revalidated = { how: "If-Modified-Since", status: res.status, bytes: (await res.text()).length };
  }
  return { path, lastModified, etag, cacheControl, revalidated };
}

async function stability(path, tries = 3) {
  const tags = new Set();
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${BASE}${path}`);
    const body = await res.text();
    tags.add(res.headers.get("etag") ?? `body:${body.length}:${body.slice(0, 80)}`);
  }
  return tags.size;
}

async function negativeControl(route) {
  console.log(`\n=== ${route} — declared filters still narrow, and an unknown value returns nothing ===`);
  const unfiltered = totalOf((await getJson(`${route}?limit=1000`)).json);
  let broken = 0;
  for (const { param, recognised, unrecognised } of DECLARED_FILTERS) {
    const hit = totalOf((await getJson(`${route}?limit=1000&${param}=${encodeURIComponent(recognised)}`)).json);
    const miss = totalOf((await getJson(`${route}?limit=1000&${param}=${encodeURIComponent(unrecognised)}`)).json);
    const ok = typeof hit === "number" && hit < unfiltered && miss === 0;
    if (!ok) broken++;
    console.log(`  ${param.padEnd(11)} recognised=${String(hit).padStart(4)} of ${unfiltered}   unrecognised=${String(miss).padStart(4)}   ${ok ? "ok" : "BROKEN"}`);
  }
  const paged = await getJson(`${route}?limit=2`);
  const offsetted = await getJson(`${route}?limit=2&offset=2`);
  console.log(`  limit/offset returned=${paged.json?.returned} then ${offsetted.json?.returned}`);
  return broken;
}

const changesRows = await boundaryTable("/api/changes", "date");
const changesDisagree = printBoundary("/api/changes", changesRows);
const newestRows = await boundaryTable("/api/newest", "verifiedDate");
const newestDisagree = printBoundary("/api/newest", newestRows);

const changesAccepted = await impossibleDates("/api/changes");
const newestAccepted = await impossibleDates("/api/newest");

console.log("\n=== conditional requests ===");
for (const path of ["/vendor/vercel", "/api/changes", "/api/newest", "/api/offers", "/api/categories"]) {
  const row = await conditional(path);
  console.log(
    `  ${path.padEnd(18)} Last-Modified=${row.lastModified ?? "-"}  ETag=${row.etag ?? "-"}  Cache-Control=${row.cacheControl ?? "-"}`,
  );
  console.log(`  ${" ".padEnd(18)} revalidated: ${row.revalidated ? `${row.revalidated.how} -> ${row.revalidated.status}, ${row.revalidated.bytes} bytes` : "no validator to send"}`);
}

console.log("\n=== byte stability of a repeated identical request ===");
for (const path of ["/api/changes?limit=5", "/api/newest?limit=5", "/api/offers?limit=5", "/api/categories"]) {
  console.log(`  ${path.padEnd(26)} distinct responses over 3 calls: ${await stability(path)}`);
}

const changesBroken = await negativeControl("/api/changes");

console.log("\n=== summary ===");
console.log(`/api/changes days where an ISO-8601 timestamp disagrees with its own date: ${changesDisagree}`);
console.log(`/api/newest  days where an ISO-8601 timestamp disagrees with its own date: ${newestDisagree}`);
console.log(`/api/changes inputs that are not a real date and were not refused: ${changesAccepted} of ${IMPOSSIBLE.length + MALFORMED.length}`);
console.log(`/api/newest  inputs that are not a real date and were not refused: ${newestAccepted} of ${IMPOSSIBLE.length + MALFORMED.length}`);
console.log(`/api/changes declared filters broken: ${changesBroken} of ${DECLARED_FILTERS.length}`);
