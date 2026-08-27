import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const TODAY = new Date().toISOString().slice(0, 10);
const dayOffset = (days: number) =>
  new Date(Date.parse(TODAY) + days * 86400000).toISOString().slice(0, 10);

const SUBJECT = "Xata";
const CONTROL = "Hyperping";
const CONTROL_DATE = dayOffset(-10);
const DIGEST_SURFACES = ["/feed.xml", "/api/feed", "/this-week", "/api/digest"];

function change(vendor: string, date: string, dateSource: string) {
  return {
    vendor,
    change_type: "limits_reduced",
    date,
    date_source: dateSource,
    summary: `${vendor} free allowance cut.`,
    previous_state: "15 GB storage",
    current_state: "5 GB storage",
    impact: "high",
    source_url: `https://example.com/${vendor.toLowerCase()}/pricing`,
    category: "Databases",
    alternatives: [],
    recorded_date: TODAY,
    ...(dateSource === "discovered" ? { detected_by: "reverify-ai" } : {}),
  };
}

const EXEMPT: Array<{ name: string; allows: (before: string, body: string) => boolean }> = [
  {
    name: "an identifier built from the vendor and the date, which names an entry rather than dating one",
    allows: (before) => /(?:\bid="[a-z0-9-]*|href="[^"]*#[a-z0-9-]*)-$|<id>[^<]*$/.test(before),
  },
  {
    name: "an Atom timestamp, which records when we last touched the entry",
    allows: (before) => /<updated>$/.test(before),
  },
  {
    name: "a page or dataset modification date",
    allows: (before) => /"dateModified":"$/.test(before),
  },
  {
    name: "a machine payload that hands over the provenance beside the date",
    allows: (before, body) => /"date":"$/.test(before) && body.includes('"date_source"'),
  },
];

function unlabelledDates(body: string, date: string): string[] {
  const found: string[] = [];
  let idx = body.indexOf(date);
  while (idx !== -1) {
    const before = body.slice(Math.max(0, idx - 80), idx);
    if (!/discovered[ >"]*$/i.test(before) && !EXEMPT.some((e) => e.allows(before, body))) {
      found.push(before.slice(-60).replace(/\s+/g, " "));
    }
    idx = body.indexOf(date, idx + 1);
  }
  return found;
}

function addedBy(withEntry: string[], without: string[]): string[] {
  const remaining = [...without];
  const added: string[] = [];
  for (const hit of withEntry) {
    const i = remaining.indexOf(hit);
    if (i === -1) added.push(hit);
    else remaining.splice(i, 1);
  }
  return added;
}

function startServer(changesPath: string): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: "0",
        BASE_URL: "http://localhost:3000",
        AGENTDEALS_CHANGES_PATH: changesPath,
      },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolve({ proc: child, port: parseInt(m[1], 10) });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe("no published surface presents a discovery date as the date a vendor changed something", () => {
  let tmp: string;
  const servers: ChildProcess[] = [];
  let routes: string[] = [];
  let ENTRY_DATE = "";
  const rendered = new Map<string, { discovered: string; dated: string; absent: string }>();

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "discovery-date-surfaces-"));
    const write = (name: string, changes: unknown[]) => {
      const p = path.join(tmp, name);
      writeFileSync(p, JSON.stringify({ changes }));
      return p;
    };
    const control = change(CONTROL, CONTROL_DATE, "vendor_page");
    const absent = await startServer(write("absent.json", [control]));
    servers.push(absent.proc);

    const reportingPeriods = new Set<string>();
    for (const route of DIGEST_SURFACES) {
      const body = await (await fetch(`http://localhost:${absent.port}${route}`)).text();
      for (const m of body.matchAll(/\d{4}-\d{2}-\d{2}/g)) reportingPeriods.add(m[0]);
    }
    ENTRY_DATE = [0, -1, -2, -3, -4, -5, -6]
      .map(dayOffset)
      .find((d) => !reportingPeriods.has(d)) ?? "";
    assert.ok(ENTRY_DATE, "every candidate date is already a reporting period boundary");

    const discovered = await startServer(
      write("discovered.json", [control, change(SUBJECT, ENTRY_DATE, "discovered")])
    );
    const dated = await startServer(
      write("dated.json", [control, change(SUBJECT, ENTRY_DATE, "vendor_page")])
    );
    servers.push(discovered.proc, dated.proc);

    const index = await (await fetch(`http://localhost:${discovered.port}/sitemap.xml`)).text();
    const locs: string[] = [];
    for (const m of index.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const childPath = new URL(m[1]).pathname;
      const xml = await (await fetch(`http://localhost:${discovered.port}${childPath}`)).text();
      for (const inner of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) locs.push(new URL(inner[1]).pathname);
    }
    routes = [
      ...new Set([
        ...locs,
        "/pricing-changes/feed.xml",
        "/feed.xml",
        "/api/feed",
        "/api/changes",
        "/api/digest",
        "/api/digest/weekly",
        `/vendor/${SUBJECT.toLowerCase()}`,
      ]),
    ];

    const queue = [...routes];
    async function worker() {
      for (;;) {
        const route = queue.shift();
        if (!route) return;
        try {
          const [a, b, c] = await Promise.all([
            fetch(`http://localhost:${discovered.port}${route}`),
            fetch(`http://localhost:${dated.port}${route}`),
            fetch(`http://localhost:${absent.port}${route}`),
          ]);
          if (a.status !== 200 || b.status !== 200 || c.status !== 200) continue;
          const bodies = { discovered: await a.text(), dated: await b.text(), absent: await c.text() };
          if (bodies.discovered.includes(SUBJECT)) rendered.set(route, bodies);
        } catch {
          continue;
        }
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
  });

  after(() => {
    for (const proc of servers) proc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("reaches enough of the site for the sweep below to mean something", () => {
    assert.ok(routes.length > 1000, `only enumerated ${routes.length} routes from the sitemap`);
    assert.ok(rendered.size > 40, `only ${rendered.size} routes rendered the entry at all`);
  });

  it("would see the date if the same entry carried an effective date", () => {
    const seen = [...rendered].filter(
      ([, b]) => addedBy(unlabelledDates(b.dated, ENTRY_DATE), unlabelledDates(b.absent, ENTRY_DATE)).length > 0
    );
    assert.ok(
      seen.length > 10,
      `the sweep attributed a bare date to the entry on only ${seen.length} routes when it was dated, so finding none for a discovery proves nothing`
    );
  });

  it("labels every rendering of a date we only know because we looked", () => {
    const offenders: string[] = [];
    for (const [route, b] of rendered) {
      for (const hit of addedBy(unlabelledDates(b.discovered, ENTRY_DATE), unlabelledDates(b.absent, ENTRY_DATE))) {
        offenders.push(`${route}: ...${hit}`);
      }
    }
    assert.deepStrictEqual(offenders, []);
  });

  it("does not call an effective date a discovery when the same entry carries one", () => {
    const mislabelled = [...rendered]
      .filter(([, b]) => b.dated.includes(`discovered ${ENTRY_DATE}`))
      .map(([route]) => route);
    assert.deepStrictEqual(mislabelled, []);
  });

  it("says discovered somewhere when the entry has no effective date", () => {
    const labelled = [...rendered].filter(([, b]) => b.discovered.includes(`discovered ${ENTRY_DATE}`));
    assert.ok(
      labelled.length > 3,
      `only ${labelled.length} routes labelled the discovery, so the mislabelling check above proves nothing`
    );
  });

  it("keeps every declared exemption in use", () => {
    const fires = (e: (typeof EXEMPT)[number]) =>
      [...rendered.values()].some((b) => {
        let idx = b.discovered.indexOf(ENTRY_DATE);
        while (idx !== -1) {
          if (e.allows(b.discovered.slice(Math.max(0, idx - 80), idx), b.discovered)) return true;
          idx = b.discovered.indexOf(ENTRY_DATE, idx + 1);
        }
        return false;
      });
    assert.deepStrictEqual(EXEMPT.filter((e) => !fires(e)).map((e) => e.name), []);
  });
});
