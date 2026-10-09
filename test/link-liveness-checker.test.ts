import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkLiveness,
  citedOnlyAsAProgram,
  collectUrls,
  delistingQueue,
  nextRecord,
  programPagesWithdrawn,
  recordsToKeep,
} from "../scripts/check-liveness.js";
import { reverifyBatch } from "../scripts/reverify.js";

let server: http.Server;
let base = "";

before(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/head-404-get-200") {
      res.writeHead(req.method === "HEAD" ? 404 : 200).end();
      return;
    }
    if (path === "/head-502-get-200") {
      res.writeHead(req.method === "HEAD" ? 502 : 200).end();
      return;
    }
    if (path === "/gone") {
      res.writeHead(410).end();
      return;
    }
    if (path === "/missing") {
      res.writeHead(404).end();
      return;
    }
    if (path === "/refused") {
      res.writeHead(403).end();
      return;
    }
    if (path === "/rate-limited") {
      res.writeHead(429).end();
      return;
    }
    if (path === "/moved") {
      res.writeHead(302, { Location: "/elsewhere" }).end();
      return;
    }
    if (path === "/slash") {
      res.writeHead(301, { Location: "/slash/" }).end();
      return;
    }
    res.writeHead(200).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("#1046 a non-2xx HEAD is not evidence until GET has been asked", () => {
  it("calls a host that answers HEAD with 404 and GET with 200 reachable", async () => {
    const result = await checkLiveness(`${base}/head-404-get-200`);
    assert.equal(result.outcome, "reachable");
    assert.equal(result.detail, "GET 200");
  });

  it("calls a host that answers HEAD with 502 and GET with 200 reachable", async () => {
    const result = await checkLiveness(`${base}/head-502-get-200`);
    assert.equal(result.outcome, "reachable");
  });

  it("reaches the same verdict through the re-verifier, which shares the fallback", async () => {
    const entries = [
      { index: 0, offer: { vendor: "Head404", url: `${base}/head-404-get-200`, category: "Test" } },
      { index: 1, offer: { vendor: "Missing", url: `${base}/missing`, category: "Test" } },
    ];
    const results = await reverifyBatch(entries);
    assert.deepEqual(results.verified.map((v: { vendor: string }) => v.vendor), ["Head404"]);
    assert.deepEqual(results.flagged.map((f: { vendor: string }) => f.vendor), ["Missing"]);
  });

  it("confirms a 404 with GET before calling it unreachable", async () => {
    const result = await checkLiveness(`${base}/missing`);
    assert.equal(result.outcome, "unreachable");
    assert.equal(result.detail, "GET 404");
    assert.equal(result.terminal, false);
  });

  it("marks a 410 terminal", async () => {
    const result = await checkLiveness(`${base}/gone`);
    assert.equal(result.outcome, "unreachable");
    assert.equal(result.terminal, true);
  });

  it("records being refused as unknown, not as a dead link", async () => {
    assert.equal((await checkLiveness(`${base}/refused`)).outcome, "unknown");
    assert.equal((await checkLiveness(`${base}/rate-limited`)).outcome, "unknown");
  });

  it("records a hostname that does not resolve as unreachable", async () => {
    const result = await checkLiveness("https://this-name-does-not-resolve.invalid/pricing");
    assert.equal(result.outcome, "unreachable");
    assert.match(result.detail, /ENOTFOUND/);
  });
});

describe("#1046 how a check updates a link's history", () => {
  const target = { url: "https://example.test/pricing", latestVerified: "2026-05-23", vendors: ["Example"] };

  it("seeds last reachable from the record's verification date when no earlier run has checked the link", () => {
    const next = nextRecord(target, undefined, { outcome: "unreachable", detail: "GET 404", terminal: false }, "2026-08-25");
    assert.equal(next.last_reachable, "2026-05-23");
    assert.equal(next.consecutive_unreachable, 1);
  });

  it("dates last reachable to the last run that reached the link the first time it fails, not to the record's verification date", () => {
    const next = nextRecord(target, undefined, { outcome: "unreachable", detail: "GET ENOTFOUND", terminal: false }, "2026-09-29", "2026-09-28");
    assert.equal(next.last_reachable, "2026-09-28");
    assert.equal(next.consecutive_unreachable, 1);
  });

  it("takes a verification read newer than the last run as the last day the page answered", () => {
    const readToday = { ...target, latestVerified: "2026-09-29" };
    const next = nextRecord(readToday, undefined, { outcome: "unreachable", detail: "GET 404", terminal: false }, "2026-09-29", "2026-09-28");
    assert.equal(next.last_reachable, "2026-09-29");
  });

  it("dates a link we were refused on its first check to the last run that reached it", () => {
    const next = nextRecord(target, undefined, { outcome: "unknown", detail: "GET 403", terminal: false }, "2026-09-29", "2026-09-28");
    assert.equal(next.last_reachable, "2026-09-28");
    assert.equal(next.consecutive_unreachable, 0);
  });

  it("keeps the last reachable date of a link that was already failing, whatever day the last run was", () => {
    const previous = { url: target.url, checked: "2026-10-08", outcome: "unreachable" as const, detail: "GET 404", terminal: false, last_reachable: "2026-08-06", consecutive_unreachable: 40 };
    const next = nextRecord(target, previous, { outcome: "unreachable", detail: "GET 404", terminal: false }, "2026-10-09", "2026-10-08");
    assert.equal(next.last_reachable, "2026-08-06");
    assert.equal(next.consecutive_unreachable, 41);
  });

  it("advances last reachable to today whenever the link answers", () => {
    const next = nextRecord(target, undefined, { outcome: "reachable", detail: "HEAD 200", terminal: false }, "2026-08-25");
    assert.equal(next.last_reachable, "2026-08-25");
    assert.equal(next.consecutive_unreachable, 0);
  });

  it("clears a failure streak as soon as the link answers again", () => {
    const previous = { url: target.url, checked: "2026-08-24", outcome: "unreachable" as const, detail: "GET 404", terminal: false, last_reachable: "2026-05-23", consecutive_unreachable: 9 };
    const next = nextRecord(target, previous, { outcome: "reachable", detail: "GET 200", terminal: false }, "2026-08-25");
    assert.equal(next.consecutive_unreachable, 0);
    assert.equal(next.last_reachable, "2026-08-25");
  });

  it("leaves the history untouched when we could not check, so being refused never ages a link toward delisting", () => {
    const previous = { url: target.url, checked: "2026-08-24", outcome: "unreachable" as const, detail: "GET 404", terminal: false, last_reachable: "2026-05-23", consecutive_unreachable: 3 };
    const next = nextRecord(target, previous, { outcome: "unknown", detail: "GET 403", terminal: false }, "2026-08-25");
    assert.equal(next.outcome, "unknown");
    assert.equal(next.consecutive_unreachable, 3);
    assert.equal(next.last_reachable, "2026-05-23");
  });

  it("does not let a refusal reset a link that a server has already said is gone", () => {
    const previous = { url: target.url, checked: "2026-08-24", outcome: "unreachable" as const, detail: "GET 410", terminal: true, last_reachable: "2026-05-23", consecutive_unreachable: 3 };
    const next = nextRecord(target, previous, { outcome: "unknown", detail: "GET 429", terminal: false }, "2026-08-25");
    assert.equal(next.terminal, true);
  });
});

const CATALOGUE = [
  { vendor: "Listed", url: "https://listed.example/pricing", verifiedDate: "2026-05-01" },
  {
    vendor: "Runs A Program",
    url: "https://program-vendor.example/pricing",
    verifiedDate: "2026-05-02",
    referral_program: { available: true, program_url: "https://program-vendor.example/refer", read_on: "2026-09-01" },
  },
  {
    vendor: "Shares Its Page",
    url: "https://shared.example/",
    verifiedDate: "2026-05-03",
    referral_program: { available: false, program_url: "https://shared.example/", read_on: "2026-09-02" },
  },
];

const targetAt = (url: string) => collectUrls(CATALOGUE).find((t: { url: string }) => t.url === url);

describe("#1152 the checker reads every referral program's page with the catalogue's links", () => {
  it("adds a program's page to the URLs it checks and names the program, not a listing", () => {
    const program = targetAt("https://program-vendor.example/refer");
    assert.ok(program, "the program page should be one of the URLs checked");
    assert.deepEqual(program.vendors, []);
    assert.deepEqual(program.programs, ["Runs A Program"]);
    assert.equal(citedOnlyAsAProgram(program), true);
  });

  it("reads a program's page whether or not the program is published", () => {
    assert.deepEqual(targetAt("https://shared.example/").programs, ["Shares Its Page"]);
  });

  it("checks a page that a listing and its program both cite once, as the listing's", () => {
    const shared = collectUrls(CATALOGUE).filter((t: { url: string }) => t.url === "https://shared.example/");
    assert.equal(shared.length, 1);
    assert.deepEqual(shared[0].vendors, ["Shares Its Page"]);
    assert.equal(citedOnlyAsAProgram(shared[0]), false);
  });

  it("dates a program page's last known answer from the day we read its terms", () => {
    assert.equal(targetAt("https://program-vendor.example/refer").latestVerified, "2026-09-01");
  });

  it("keeps the listing's verification date on a page the listing shares with its program", () => {
    assert.equal(targetAt("https://shared.example/").latestVerified, "2026-05-03");
  });

  it("leaves the listings' own links as they were", () => {
    const listed = targetAt("https://listed.example/pricing");
    assert.deepEqual(listed.vendors, ["Listed"]);
    assert.deepEqual(listed.programs, []);
    assert.equal(listed.latestVerified, "2026-05-01");
  });
});

describe("#1152 a program page reached only by redirecting to another page is recorded where it landed", () => {
  it("records the page a program's link redirected to", async () => {
    const target = { url: `${base}/moved`, latestVerified: null, vendors: [], programs: ["Moved Program"] };
    const result = await checkLiveness(target.url);
    assert.equal(result.outcome, "reachable");
    const record = nextRecord(target, undefined, result, "2026-10-08");
    assert.equal(record.redirected_to, `${base}/elsewhere`);
  });

  it("counts a redirect that only adds a trailing slash as the same page", async () => {
    const target = { url: `${base}/slash`, latestVerified: null, vendors: [], programs: ["Slash Program"] };
    const record = nextRecord(target, undefined, await checkLiveness(target.url), "2026-10-08");
    assert.equal(record.outcome, "reachable");
    assert.equal(record.redirected_to, undefined);
  });

  it("never records a redirect on a listing's own link", async () => {
    const target = { url: `${base}/moved`, latestVerified: null, vendors: ["Moved Listing"], programs: [] };
    const record = nextRecord(target, undefined, await checkLiveness(target.url), "2026-10-08");
    assert.equal(record.outcome, "reachable");
    assert.equal(record.redirected_to, undefined);
  });

  it("keeps a redirected program page in the file although it answered, and drops a page that answered where we cite it", () => {
    const answered = { url: "https://a.example/", checked: "2026-10-08", outcome: "reachable", detail: "HEAD 200", terminal: false, last_reachable: "2026-10-08", consecutive_unreachable: 0 };
    const redirected = { ...answered, url: "https://b.example/refer", redirected_to: "https://b.example/" };
    const refused = { ...answered, url: "https://c.example/refer", outcome: "unknown", detail: "GET 403" };
    assert.deepEqual(recordsToKeep([answered, redirected, refused]).map((r: { url: string }) => r.url), [
      "https://b.example/refer",
      "https://c.example/refer",
    ]);
  });
});

describe("#1152 a dead program page never queues the listing for delisting", () => {
  const dead = (url: string) => ({ url, checked: "2026-10-01", outcome: "unreachable", detail: "GET 410", terminal: true, last_reachable: "2026-09-01", consecutive_unreachable: 3 });
  const programOnly = new Set(collectUrls(CATALOGUE).filter(citedOnlyAsAProgram).map((t: { url: string }) => t.url));

  it("leaves a page only a program cites out of the delisting queue", () => {
    const queue = delistingQueue([dead("https://listed.example/pricing"), dead("https://program-vendor.example/refer")], "2026-10-08", programOnly);
    assert.deepEqual(queue.map((r: { url: string }) => r.url), ["https://listed.example/pricing"]);
  });

  it("still queues a page a listing cites when its program cites it too", () => {
    const queue = delistingQueue([dead("https://shared.example/")], "2026-10-08", programOnly);
    assert.deepEqual(queue.map((r: { url: string }) => r.url), ["https://shared.example/"]);
  });

  it("names the dead or redirected program pages, so the report can say their programs are not published", () => {
    const answered = { url: "https://listed.example/pricing", checked: "2026-10-01", outcome: "reachable", detail: "HEAD 200", terminal: false, last_reachable: "2026-10-01", consecutive_unreachable: 0 };
    const redirected = { ...answered, url: "https://shared.example/", redirected_to: "https://shared.example/home" };
    const programUrls = new Set(["https://program-vendor.example/refer", "https://shared.example/"]);
    const records = [answered, dead("https://gone-listing.example/pricing"), dead("https://program-vendor.example/refer"), redirected];
    const withdrawn = programPagesWithdrawn(records, programUrls);
    assert.deepEqual(withdrawn.map((r: { url: string }) => r.url), ["https://program-vendor.example/refer", "https://shared.example/"]);
  });
});

describe("a run dates a link's first failure from the run before it", () => {
  it("records the previous run's day as the last reachable day of a link that answered then and fails now", async () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "check-liveness.js");
    const dir = mkdtempSync(join(tmpdir(), "liveness-run-"));
    const indexPath = join(dir, "index.json");
    const healthPath = join(dir, "link_health.json");
    writeFileSync(indexPath, JSON.stringify({ offers: [
      { vendor: "Missing Example", url: `${base}/missing`, verifiedDate: "2026-05-23" },
      { vendor: "Answering Example", url: `${base}/answering`, verifiedDate: "2026-05-23" },
    ] }));
    writeFileSync(healthPath, JSON.stringify({ generated_at: "2026-09-28", links: [] }));
    try {
      const status = await new Promise<number | null>((resolve, reject) => {
        const child = spawn("node", [script], {
          env: { ...process.env, AGENTDEALS_INDEX_PATH: indexPath, AGENTDEALS_LINK_HEALTH_PATH: healthPath },
          stdio: "ignore",
        });
        child.on("error", reject);
        child.on("close", resolve);
      });
      assert.equal(status, 0);
      const written = JSON.parse(readFileSync(healthPath, "utf8"));
      assert.deepEqual(
        written.links.map((r: { url: string; outcome: string; last_reachable: string; consecutive_unreachable: number }) =>
          [r.url, r.outcome, r.last_reachable, r.consecutive_unreachable]),
        [[`${base}/missing`, "unreachable", "2026-09-28", 1]],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
