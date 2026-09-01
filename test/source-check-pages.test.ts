import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const SOURCED_FROM_A_MARKETPLACE = {
  vendor: "Fixturecorp",
  category: "Databases",
  description: "30% off for 3 months. Access via: First deal free",
  tier: "Startup Program",
  url: "https://dealmarket.example/offers",
  tags: ["databases"],
  verifiedDate: "2026-08-11",
  product_subtypes: {
    taxonomy: "Databases",
    labels: [{ subtype: "relational", source_url: "https://dealmarket.example/offers", source_quote: "managed Postgres" }],
    reviewed: "2026-08-28",
  },
  source_check: {
    checked: "2026-08-28",
    outcome: "does_not_name_vendor",
    detail: "the page never names Fixturecorp and is not served from its domain",
  },
};

const SOURCED_FROM_ITS_OWN_PAGE = {
  ...SOURCED_FROM_A_MARKETPLACE,
  vendor: "Controlcorp",
  url: "https://controlcorp.example/pricing",
  source_check: { checked: "2026-08-28", outcome: "ok", detail: "text" },
};

const SOURCED_FROM_A_PAGE_WE_COULD_NOT_READ = {
  ...SOURCED_FROM_A_MARKETPLACE,
  vendor: "Shellcorp",
  url: "https://shellcorp.example/pricing",
  source_check: {
    checked: "2026-08-28",
    outcome: "unreadable",
    detail: "page content too short (likely JS-rendered SPA)",
  },
};

const SOURCED_FROM_A_PAGE_STATING_NO_FIGURES = {
  ...SOURCED_FROM_A_MARKETPLACE,
  vendor: "Prosecorp",
  url: "https://prosecorp.example/pricing",
  source_check: {
    checked: "2026-08-28",
    outcome: "states_no_terms",
    detail: "no amount, tier or rate",
  },
};

let fixtureDir = "";
let serverPort = 0;
let proc: ChildProcess | null = null;

function startServer(indexPath: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", AGENTDEALS_INDEX_PATH: indexPath },
    });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 20000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) { serverPort = parseInt(m[1], 10); clearTimeout(timeout); resolve(child); }
    });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

const get = async (p: string) => {
  const res = await fetch(`http://localhost:${serverPort}${p}`);
  return { status: res.status, body: await res.text() };
};

function faqAnswers(body: string): string[] {
  const page = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
    .find((json) => json && json["@type"] === "FAQPage");
  assert.ok(page, "the page must ship FAQPage structured data for the assertion to mean anything");
  return page.mainEntity.map((entry: { acceptedAnswer: { text: string } }) => entry.acceptedAnswer.text);
}

function aboutThisVendor({ body }: { body: string }): string {
  const verdict = body.match(/<div class="quick-verdict">[\s\S]*?<\/div>/)?.[0];
  const history = body.match(/<p class="no-changes">[\s\S]*?<\/p>/)?.[0];
  const answers = body.match(/<div class="faq-a">[\s\S]*?<\/div>/g) ?? [];
  assert.ok(verdict, "the page must open with a verdict for the assertion to mean anything");
  assert.ok(history, "the page must carry a change-history paragraph");
  assert.ok(answers.length >= 3, "the page must carry its own answers");
  return [verdict, history, ...answers].join("\n");
}

before(async () => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "source-check-"));
  const indexPath = path.join(fixtureDir, "index.json");
  writeFileSync(
    indexPath,
    JSON.stringify(
      {
        offers: [
          SOURCED_FROM_A_MARKETPLACE,
          SOURCED_FROM_ITS_OWN_PAGE,
          SOURCED_FROM_A_PAGE_WE_COULD_NOT_READ,
          SOURCED_FROM_A_PAGE_STATING_NO_FIGURES,
        ],
      },
      null,
      2
    )
  );
  proc = await startServer(indexPath);
});

after(() => {
  if (proc) proc.kill();
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

describe("a vendor page whose cited source names somebody else", () => {
  it("renders, so the assertions below are about a real page", async () => {
    const res = await get("/vendor/fixturecorp");
    assert.equal(res.status, 200);
  });

  it("does not read its empty change history as good news", async () => {
    const { body } = await get("/vendor/fixturecorp");
    assert.doesNotMatch(body, /This is a good sign — stable pricing/);
    assert.match(body, /does not name it/);
  });

  it("does not open with a stability verdict it cannot back", async () => {
    const { body } = await get("/vendor/fixturecorp");
    assert.doesNotMatch(body, /It's stable — zero pricing changes recorded/);
    assert.match(body, /we cannot confirm these terms today/);
  });

  it("shows no stability value in the comparison table", async () => {
    const { body } = await get("/vendor/fixturecorp");
    const row = body.match(/<tr class="current-vendor-row">[\s\S]*?<\/tr>/)?.[0] ?? "";
    assert.ok(row.includes("Fixturecorp"), "the row under test must be the vendor's own");
    assert.match(row, /source unconfirmed/);
    assert.doesNotMatch(row, /stability-dot/);
  });

  it("answers the reliability question with what it cannot say", async () => {
    const { body } = await get("/vendor/fixturecorp");
    assert.doesNotMatch(body, /free tier is considered stable/);
    assert.doesNotMatch(body, /This is a positive stability signal/);
  });

  it("still reads an empty history as good news where the source does name the vendor", async () => {
    const { body } = await get("/vendor/controlcorp");
    assert.match(body, /This is a good sign — stable pricing/);
  });

  it("publishes no risk level for it through the API", async () => {
    const { body } = await get("/api/offers?q=fixturecorp");
    const offer = JSON.parse(body).offers[0];
    assert.strictEqual(offer.risk_level, null);
    assert.strictEqual(offer.source_check.outcome, "does_not_name_vendor");
  });

  it("publishes a stable level for the control", async () => {
    const { body } = await get("/api/offers?q=controlcorp");
    assert.strictEqual(JSON.parse(body).offers[0].risk_level, "stable");
  });
});

describe("a vendor page whose cited source we could not read at all", () => {
  it("renders, so the assertions below are about a real page", async () => {
    const res = await get("/vendor/shellcorp");
    assert.equal(res.status, 200);
  });

  it("does not read its empty change history as good news", async () => {
    const { body } = await get("/vendor/shellcorp");
    assert.doesNotMatch(body, /This is a good sign — stable pricing/);
    assert.doesNotMatch(body, /This is a positive stability signal/);
  });

  it("does not open with a stability verdict it cannot back", async () => {
    const { body } = await get("/vendor/shellcorp");
    assert.doesNotMatch(body, /It's stable — zero pricing changes recorded/);
    assert.match(body, /we cannot confirm these terms today/);
  });

  it("shows no stability value in the comparison table", async () => {
    const { body } = await get("/vendor/shellcorp");
    const row = body.match(/<tr class="current-vendor-row">[\s\S]*?<\/tr>/)?.[0] ?? "";
    assert.ok(row.includes("Shellcorp"), "the row under test must be the vendor's own");
    assert.match(row, /source unconfirmed/);
    assert.doesNotMatch(row, /stability-dot/);
  });

  it("says we could not read the page rather than that it names somebody else", async () => {
    const own = aboutThisVendor(await get("/vendor/shellcorp"));
    assert.match(own, /could not read the page we cite/);
    assert.doesNotMatch(own, /does not name it/);
  });

  it("publishes no risk level for it through the API", async () => {
    const { body } = await get("/api/offers?q=shellcorp");
    const offer = JSON.parse(body).offers[0];
    assert.strictEqual(offer.risk_level, null);
    assert.strictEqual(offer.source_check.outcome, "unreadable");
  });
});

describe("the two withheld reasons read differently to somebody deciding whether to trust us", () => {
  it("keeps the unread-page wording off the page whose source names somebody else", async () => {
    const own = aboutThisVendor(await get("/vendor/fixturecorp"));
    assert.match(own, /does not name it/);
    assert.doesNotMatch(own, /could not read the page we cite/);
  });
});

describe("a vendor page whose cited source names it but states no terms we can read", () => {
  it("publishes no stability judgement", async () => {
    const { body } = await get("/vendor/prosecorp");
    assert.doesNotMatch(body, /This is a good sign — stable pricing/);
    assert.doesNotMatch(body, /It's stable — zero pricing changes recorded/);
    const row = body.match(/<tr class="current-vendor-row">[\s\S]*?<\/tr>/)?.[0] ?? "";
    assert.ok(row.includes("Prosecorp"), "the row under test must be the vendor's own");
    assert.match(row, /source unconfirmed/);
    assert.doesNotMatch(row, /stability-dot/);
  });

  it("publishes no level through the API", async () => {
    const { body } = await get("/api/offers?q=prosecorp");
    const offer = JSON.parse(body).offers[0];
    assert.strictEqual(offer.risk_level, null);
    assert.strictEqual(offer.source_check.outcome, "states_no_terms");
  });

  it("says the page states no terms rather than that we could not read it", async () => {
    const own = aboutThisVendor(await get("/vendor/prosecorp"));
    assert.match(own, /states no terms we can read/);
    assert.doesNotMatch(own, /could not read the page we cite/);
    assert.doesNotMatch(own, /does not name it/);
  });
});

describe("the question an answer engine quotes first", () => {
  const q1 = (body: string) => faqAnswers(body)[0];
  const q2 = (body: string) => faqAnswers(body)[1];

  it("answers a bare Yes only where the source confirms the terms", async () => {
    const { body } = await get("/vendor/controlcorp");
    assert.match(q1(body), /^Yes, Controlcorp offers a free tier/);
    assert.match(q2(body), /^Controlcorp's free tier is called/);
  });

  for (const [slug, vendor, reason] of [
    ["fixturecorp", "Fixturecorp", /does not name it/],
    ["shellcorp", "Shellcorp", /could not read the page we cite/],
    ["prosecorp", "Prosecorp", /states no terms we can read/],
  ] as const) {
    it(`does not answer Yes for ${vendor}, and carries the reason in the answer itself`, async () => {
      const { body } = await get(`/vendor/${slug}`);
      for (const answer of [q1(body), q2(body)]) {
        assert.doesNotMatch(answer, /^Yes, /);
        assert.match(answer, reason);
        assert.match(answer, /treat them as unverified/);
      }
    });

    it(`still shows the stored terms for ${vendor} rather than dropping them`, async () => {
      const { body } = await get(`/vendor/${slug}`);
      assert.match(q1(body), /30% off for 3 months/);
    });
  }
});

describe("an alternatives page for a vendor whose source we cannot vouch for", () => {
  it("publishes a stable risk level only where the source confirms the terms", async () => {
    const { body } = await get("/alternative-to/controlcorp");
    assert.match(body, /Risk Level:[\s\S]{0,220}>stable</);
    assert.match(faqAnswers(body)[1], /^Yes, Controlcorp currently offers a free tier/);
  });

  for (const [slug, vendor, reason] of [
    ["fixturecorp", "Fixturecorp", /does not name it/],
    ["shellcorp", "Shellcorp", /could not read the page we cite/],
    ["prosecorp", "Prosecorp", /states no terms we can read/],
  ] as const) {
    it(`does not re-assert a stable risk level for ${vendor}`, async () => {
      const { body } = await get(`/alternative-to/${slug}`);
      const riskRow = body.match(/Risk Level:[\s\S]{0,300}?<\/div>/)?.[0] ?? "";
      assert.ok(riskRow.length > 0, "the page must carry a risk row for the assertion to mean anything");
      assert.doesNotMatch(riskRow, />stable</);
      assert.match(riskRow, /source unconfirmed/);
      assert.match(body, reason);
    });

    it(`does not read an empty change history for ${vendor} as stable pricing`, async () => {
      const { body } = await get(`/alternative-to/${slug}`);
      assert.doesNotMatch(body, /This indicates stable pricing/);
      const stillAvailable = faqAnswers(body)[1];
      assert.doesNotMatch(stillAvailable, /^Yes, /);
      assert.match(stillAvailable, reason);
    });
  }
});
