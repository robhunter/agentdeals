import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(__dirname, "..", "scripts");

const {
  fetchPageText,
  withMinimumLength,
  MIN_PAGE_TEXT_LENGTH,
  PAGE_TOO_SHORT_ERROR,
} = await import("../scripts/verify-freshness.js");
const { priceSignals } = await import("../scripts/change-gate.js");
const { classifySource } = await import("../scripts/vendor-naming.js");
const { classifyFetchError, FAILURE_EMPTY_PAGE } = await import("../scripts/verification-state.js");

const PREVIOUS_FLOOR = 50;

const SHORTEST_CONFIRMED_PAGES = [
  { host: "cdnjs.com", chars: 694 },
  { host: "formlets.com", chars: 825 },
  { host: "groq.com/pricing", chars: 950 },
];

const ABSENCE_CLAIMS_UNDER_THE_NEW_FLOOR = 63;
const CONFIRMED_RECORDS_UNDER_THE_NEW_FLOOR = 0;

const OFFER = {
  vendor: "Widgetson",
  category: "Monitoring",
  tier: "Free",
  description: "Free for up to 5 hosts",
  url: "https://widgetson.example/pricing",
};

function pageOfExactly(chars: number, opening: string) {
  const filler = " We help teams ship software they can operate.";
  let inner = opening;
  assert.ok(inner.length <= chars, `the opening is longer than the ${chars}-character fixture`);
  while (inner.length + filler.length <= chars) inner += filler;
  const short = chars - inner.length;
  if (short > 0) inner += ` ${"o".repeat(short - 1)}`;
  return `<html><body><p>${inner}</p></body></html>`;
}

const STATES_ITS_TERMS = `${OFFER.vendor} pricing. Free plan: $0 per month for up to 5 hosts.`;
const STATES_NO_TERMS = `${OFFER.vendor} pricing. Talk to our team about what you need.`;

async function readWith(body: string) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
  try {
    return await fetchPageText(OFFER.url);
  } finally {
    globalThis.fetch = original;
  }
}

function outcomeFor(page: { ok: boolean; text?: string }) {
  const signals = page.ok ? priceSignals(page.text as string).length : 0;
  return classifySource(OFFER, page, signals).outcome;
}

describe("a page shorter than the floor is one we did not read", () => {
  it("refuses a page of 60 characters that names the vendor and states no price", async () => {
    const page = await readWith(pageOfExactly(60, STATES_NO_TERMS));
    assert.strictEqual(page.ok, false);
    assert.strictEqual(page.error, PAGE_TOO_SHORT_ERROR);
    assert.strictEqual(outcomeFor(page), "unreadable");
  });

  it("would have called that same page one that states no terms, at the previous floor", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(pageOfExactly(60, STATES_NO_TERMS), { status: 200 })) as typeof fetch;
    let text: string;
    try {
      const raw = await fetchPageText(OFFER.url);
      text = raw.text ?? "";
    } finally {
      globalThis.fetch = original;
    }
    assert.strictEqual(text, "", "the reader must return no text below the floor");
    const asPreviouslyRead = withMinimumLength(
      { ok: true, text: pageOfExactly(60, STATES_NO_TERMS).replace(/<[^>]+>/g, "").trim() },
      PREVIOUS_FLOOR
    );
    assert.strictEqual(outcomeFor(asPreviouslyRead), "states_no_terms");
  });

  it("reports the length it measured, so the refusal can be sized", async () => {
    const page = await readWith(pageOfExactly(53, `${OFFER.vendor} pricing.`));
    assert.strictEqual(page.chars, 53);
  });

  it("refuses a page that states its terms but renders too little of them to read", async () => {
    const page = await readWith(pageOfExactly(120, STATES_ITS_TERMS));
    assert.strictEqual(page.ok, false);
    assert.strictEqual(outcomeFor(page), "unreadable");
  });

  it("keeps the refusal in the empty-page failure class", () => {
    assert.strictEqual(classifyFetchError(PAGE_TOO_SHORT_ERROR), FAILURE_EMPTY_PAGE);
  });
});

describe("the floor sits above every confirmed page in the catalog", () => {
  for (const { host, chars } of SHORTEST_CONFIRMED_PAGES) {
    it(`reads a ${chars}-character page, the length ${host} strips to`, async () => {
      const page = await readWith(pageOfExactly(chars, STATES_ITS_TERMS));
      assert.strictEqual(page.ok, true);
      assert.strictEqual(page.text.length, chars);
      assert.strictEqual(outcomeFor(page), "ok");
    });
  }

  it("leaves the shortest confirmed page room above the floor", () => {
    const shortest = Math.min(...SHORTEST_CONFIRMED_PAGES.map((p) => p.chars));
    assert.ok(
      MIN_PAGE_TEXT_LENGTH < shortest,
      `a floor of ${MIN_PAGE_TEXT_LENGTH} takes ${shortest}-character pages that read their terms today`
    );
  });

  it("sits above the previous floor by enough to reach the cohort piled on it", () => {
    assert.ok(MIN_PAGE_TEXT_LENGTH > PREVIOUS_FLOOR);
    assert.strictEqual(CONFIRMED_RECORDS_UNDER_THE_NEW_FLOOR, 0);
    assert.ok(ABSENCE_CLAIMS_UNDER_THE_NEW_FLOOR > 0);
  });
});

describe("the floor is a boundary, not a range", () => {
  it("accepts a page of exactly the floor", async () => {
    const page = await readWith(pageOfExactly(MIN_PAGE_TEXT_LENGTH, STATES_ITS_TERMS));
    assert.strictEqual(page.ok, true);
    assert.strictEqual(page.text.length, MIN_PAGE_TEXT_LENGTH);
  });

  it("refuses a page one character below it", async () => {
    const page = await readWith(pageOfExactly(MIN_PAGE_TEXT_LENGTH - 1, STATES_ITS_TERMS));
    assert.strictEqual(page.ok, false);
    assert.strictEqual(page.chars, MIN_PAGE_TEXT_LENGTH - 1);
  });
});

describe("withMinimumLength", () => {
  it("passes a fetch that never produced a body through unchanged", () => {
    const failed = { ok: false, error: "HTTP 429" };
    assert.strictEqual(withMinimumLength(failed), failed);
  });

  it("applies the shared floor when given none", () => {
    const text = "a".repeat(MIN_PAGE_TEXT_LENGTH - 1);
    assert.strictEqual(withMinimumLength({ ok: true, text }).ok, false);
    assert.strictEqual(withMinimumLength({ ok: true, text: `${text}a` }).ok, true);
  });

  it("keeps every field of a page it accepts", () => {
    const page = { ok: true, text: "a".repeat(MIN_PAGE_TEXT_LENGTH), truncated: false, finalUrl: OFFER.url };
    assert.deepStrictEqual(withMinimumLength(page), page);
  });
});

describe("one floor, named once", () => {
  it("is the only place a fetched page is measured for length", () => {
    const files = readdirSync(SCRIPTS).filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));
    const naming = files.filter((f) =>
      readFileSync(path.join(SCRIPTS, f), "utf-8").includes(PAGE_TOO_SHORT_ERROR)
    );
    assert.deepStrictEqual(naming, ["verify-freshness.js"]);
  });

  it("applies inside the function that fetches the page", () => {
    const source = readFileSync(path.join(SCRIPTS, "verify-freshness.js"), "utf-8");
    const from = source.indexOf("export async function fetchPageText");
    const to = source.indexOf("export function createVerifierClient", from);
    assert.ok(from !== -1 && to > from);
    assert.match(source.slice(from, to), /withMinimumLength\(/);
  });
});
