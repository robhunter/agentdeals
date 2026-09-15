import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoversPopulation, assertPopulationFloor, vendorsInTheCatalogue } from "./population-floor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { resolveVendorName } = await import("../dist/vendor-substitution.js");
const { resolveVendorSlug, vendorSlugMap, retiredVendorSlugMap, endedVendorSlugs, namedVendorSlug, servedVendorSlugForName, slugsWhoseEveryRecordEnded } =
  await import("../dist/vendor-slug.js");
const { findVendor, loadOffers, checkVendorRisk, compareServices, auditStack } = await import("../dist/data.js");
const { offerRetired, noLiveRecordUnderThatNameSentence } = await import("../dist/retirement.js");
const { isSubSlug, toSlug } = await import("../dist/slug.js");

const offers = loadOffers();

function universeOf(
  slugs: string[],
  ended: string[] = [],
  renames: Record<string, string> = {},
) {
  return {
    known: (slug: string) => slugs.includes(slug),
    all: () => slugs,
    renamedTo: (slug: string) => renames[slug] ?? null,
    hasEnded: (slug: string) => ended.includes(slug),
  };
}

function shortNamesTheCatalogueInvites(): string[] {
  const held = new Set(offers.map(o => o.vendor.toLowerCase()));
  const found = new Set<string>();
  for (const offer of offers) {
    const tokens = offer.vendor.split(/\s+/).filter(Boolean);
    for (let n = 1; n < tokens.length; n++) {
      const prefix = tokens.slice(0, n).join(" ");
      if (held.has(prefix.toLowerCase())) continue;
      found.add(prefix);
    }
  }
  return [...found];
}

function vendorNamedBy(slug: string): string | undefined {
  return vendorSlugMap.get(slug);
}

function recordsNamed(vendor: string) {
  return offers.filter(o => o.vendor.toLowerCase() === vendor.toLowerCase());
}

describe("the substitution rule, on a universe it does not have to read from disk", () => {
  it("answers a name we hold exactly, even where that offer has ended", () => {
    const resolution = resolveVendorName("heroku", universeOf(["heroku"], ["heroku"]));
    assert.deepStrictEqual(resolution, { type: "exact", slug: "heroku" });
  });

  it("completes a name to the one longer record that carries it", () => {
    const resolution = resolveVendorName("hugging", universeOf(["hugging-face", "vercel"]));
    assert.deepStrictEqual(resolution, { type: "redirect", slug: "hugging-face" });
  });

  it("refuses to complete a name to a record whose offer has ended", () => {
    const resolution = resolveVendorName(
      "heroku",
      universeOf(["heroku-for-startups-program"], ["heroku-for-startups-program"]),
    );
    assert.deepStrictEqual(resolution, { type: "onlyMatchHasEnded", slugs: ["heroku-for-startups-program"] });
  });

  it("names every ended record it refused, so the door can say what we do hold", () => {
    const resolution = resolveVendorName(
      "drift",
      universeOf(["drift-for-startups", "drift-for-teams"], ["drift-for-startups", "drift-for-teams"]),
    );
    assert.deepStrictEqual(resolution, {
      type: "onlyMatchHasEnded",
      slugs: ["drift-for-startups", "drift-for-teams"],
    });
  });

  it("resolves to the one live candidate rather than listing a dead one beside it", () => {
    const resolution = resolveVendorName(
      "ibm",
      universeOf(["ibm-cloud", "startup-with-ibm"], ["startup-with-ibm"]),
    );
    assert.deepStrictEqual(resolution, { type: "redirect", slug: "ibm-cloud" });
  });

  it("keeps disambiguating over the candidates that are still offered", () => {
    const resolution = resolveVendorName(
      "code",
      universeOf(["code-time", "claude-code", "augment-code"], ["augment-code"]),
    );
    assert.deepStrictEqual(resolution, { type: "disambiguate", slugs: ["claude-code", "code-time"] });
  });

  it("forwards a rename to its survivor whatever the tier says, because the two names are one record", () => {
    const resolution = resolveVendorName(
      "old-name",
      universeOf(["new-name"], ["new-name"], { "old-name": "new-name" }),
    );
    assert.deepStrictEqual(resolution, { type: "redirect", slug: "new-name" });
  });

  it("refuses a generalisation whose only record has ended", () => {
    const resolution = resolveVendorName(
      "augment-code-free-tier",
      universeOf(["augment-code"], ["augment-code"]),
    );
    assert.deepStrictEqual(resolution, { type: "onlyMatchHasEnded", slugs: ["augment-code"] });
  });

  it("does not widen to a shorter live name when the specific completion has ended", () => {
    const resolution = resolveVendorName(
      "twilio-startups",
      universeOf(["twilio", "twilio-startups-program"], ["twilio-startups-program"]),
    );
    assert.deepStrictEqual(resolution, { type: "onlyMatchHasEnded", slugs: ["twilio-startups-program"] });
  });

  it("holds nothing back where nothing has ended", () => {
    const slugs = ["hugging-face", "mistral-ai", "oracle-cloud", "appwrite-cloud"];
    for (const [asked, expected] of [
      ["hugging", "hugging-face"],
      ["mistral", "mistral-ai"],
      ["oracle", "oracle-cloud"],
      ["appwrite", "appwrite-cloud"],
    ]) {
      assert.deepStrictEqual(resolveVendorName(asked!, universeOf(slugs)), { type: "redirect", slug: expected });
    }
  });
});

describe("which slugs count as ended", () => {
  it("counts a vendor whose every record has ended", () => {
    const ended = slugsWhoseEveryRecordEnded([
      { vendor: "Heroku for Startups Program", tier: "Retired" },
      { vendor: "Google Content API for Shopping", tier: "Free (Deprecated)" },
    ]);
    assert.deepStrictEqual([...ended].sort(), ["google-content-api-for-shopping", "heroku-for-startups-program"]);
  });

  it("does not count a vendor that still has one record on offer", () => {
    const ended = slugsWhoseEveryRecordEnded([
      { vendor: "Twilio", tier: "Retired" },
      { vendor: "Twilio", tier: "Free" },
    ]);
    assert.deepStrictEqual([...ended], []);
  });

  it("does not count a vendor whose records are all still on offer", () => {
    assert.deepStrictEqual([...slugsWhoseEveryRecordEnded([{ vendor: "Vercel", tier: "Free" }])], []);
  });
});

describe("every declared rename, on the catalogue we ship", () => {
  const renames = [...retiredVendorSlugMap.entries()];

  it("reads a population of declared renames", () => {
    assertPopulationFloor(renames.length, 4, "slugs the merge registry points at another slug");
  });

  it("forwards each one to the slug the registry names", () => {
    const forwarded = renames.map(([from, to]) => [from, resolveVendorSlug(from), to] as const);
    assert.deepStrictEqual(
      forwarded.filter(([, resolution, to]) => !(resolution.type === "redirect" && resolution.slug === to))
        .map(([from, resolution]) => `${from} -> ${resolution.type}`),
      [],
    );
  });
});

describe("a name carrying extra words, where the record it names has ended", () => {
  const endedVendors = [...new Set(
    offers.filter(o => recordsNamed(o.vendor).every(offerRetired)).map(o => o.vendor),
  )];

  it("reads a population of vendors whose every record has ended", () => {
    assertPopulationFloor(endedVendors.length, 12, "vendors whose every record has ended");
  });

  it("answers only about a record whose own name the caller typed", () => {
    const substituted: string[] = [];
    for (const vendor of endedVendors) {
      for (const qualifier of ["free tier", "pricing", "credits"]) {
        const asked = `${vendor} ${qualifier}`;
        const match = findVendor(offers, asked);
        if (match.type === "none") continue;
        if (!isSubSlug(toSlug(match.offer.vendor), toSlug(asked))) {
          substituted.push(`${asked} -> ${match.offer.vendor}`);
        }
      }
    }
    assert.deepStrictEqual(substituted, []);
  });

  it("answers the qualified form with the dated end of the offer, not a denial that we hold it", () => {
    const match = findVendor(offers, "Augment Code free tier");
    assert.strictEqual(match.type, "inferred");
    assert.strictEqual(match.offer.vendor, "Augment Code");

    const answer = checkVendorRisk("Augment Code free tier") as {
      result?: { gate?: { code?: string }; risk_cause?: { change_type?: string; date?: string } };
      error?: string;
    };
    assert.strictEqual(answer.error, undefined);
    assert.strictEqual(answer.result?.gate?.code, "offer_retired");
    assert.strictEqual(answer.result?.risk_cause?.change_type, "free_tier_removed");
  });

  it("still resolves a qualified name whose record is one we still offer", () => {
    const match = findVendor(offers, "AWS Lambda Free");
    assert.strictEqual(match.type, "inferred");
    assert.strictEqual(match.offer.vendor, "AWS");
  });
});

describe("the catalogue's own short names, at every door that resolves one", () => {
  const shortNames = shortNamesTheCatalogueInvites();

  it("reads a population of short names to sweep", () => {
    assertPopulationFloor(shortNames.length, 240, "short names the catalogue's own multi-word records invite");
  });

  it("sweeps every vendor the catalogue holds", () => {
    const swept = new Set(offers.map(o => o.vendor.trim().toLowerCase()));
    assertCoversPopulation(swept.size, vendorsInTheCatalogue(), "vendors reached by the short-name sweep");
  });

  it("substitutes no ended record for a name we were not asked about", () => {
    const substituted: string[] = [];
    for (const name of shortNames) {
      const resolution = resolveVendorSlug(toSlug(name));
      if (resolution.type !== "redirect") continue;
      const vendor = vendorNamedBy(resolution.slug);
      if (!vendor) continue;
      if (recordsNamed(vendor).every(offerRetired)) substituted.push(`${name} -> ${vendor}`);
    }
    assert.deepStrictEqual(substituted, [], "the slug door still answers with a record we publish as ended");
  });

  it("offers no ended record as a candidate to pick from either", () => {
    const listed: string[] = [];
    for (const name of shortNames) {
      const resolution = resolveVendorSlug(toSlug(name));
      if (resolution.type !== "disambiguate") continue;
      for (const slug of resolution.slugs) {
        const vendor = vendorNamedBy(slug);
        if (vendor && recordsNamed(vendor).every(offerRetired)) listed.push(`${name} -> ${vendor}`);
      }
    }
    assert.deepStrictEqual(listed, []);
  });

  it("substitutes no ended record at the vendor-risk door either", () => {
    const substituted: string[] = [];
    for (const name of shortNames) {
      const match = findVendor(offers, name);
      if (match.type !== "inferred") continue;
      if (offerRetired(match.offer)) substituted.push(`${name} -> ${match.offer.vendor}`);
    }
    assert.deepStrictEqual(substituted, []);
  });

  it("names what we hold when it refuses, rather than refusing silently", () => {
    const refused = shortNames.filter(n => resolveVendorSlug(toSlug(n)).type === "onlyMatchHasEnded");
    assertPopulationFloor(refused.length, 15, "short names whose only match is a record we publish as ended");
    for (const name of refused) {
      const resolution = resolveVendorSlug(toSlug(name));
      assert.ok(resolution.type === "onlyMatchHasEnded");
      assert.ok(resolution.slugs.length > 0, `${name} refused without naming what we hold`);
      for (const slug of resolution.slugs) {
        assert.ok(vendorNamedBy(slug), `${name} named ${slug}, which is not a record we serve`);
      }
    }
  });

  it("still resolves the short names whose longer record is one we still offer", () => {
    const resolved = shortNames.filter(n => resolveVendorSlug(toSlug(n)).type === "redirect");
    assertPopulationFloor(resolved.length, 200, "short names that still resolve to a record we still offer");
  });

  it("keeps every ended record reachable under the name it is filed as", () => {
    for (const slug of endedVendorSlugs) {
      assert.deepStrictEqual(
        resolveVendorSlug(slug),
        { type: "exact", slug },
        `${slug} is no longer reachable under its own name`,
      );
    }
    assertPopulationFloor(endedVendorSlugs.size, 12, "vendor names whose every record has ended");
  });
});

describe("no page links a name to a record we would not substitute for it", () => {
  it("stops naming a vendor slug for a short name whose only record has ended", () => {
    for (const name of shortNamesTheCatalogueInvites()) {
      const resolution = resolveVendorSlug(toSlug(name));
      if (resolution.type !== "onlyMatchHasEnded") continue;
      assert.strictEqual(namedVendorSlug(name), null, `${name} still links to a page about another record`);
      assert.strictEqual(servedVendorSlugForName(name), null, `${name} still serves a page about another record`);
    }
  });
});

describe("the sentence a refusing door publishes", () => {
  it("names the record and says the offer ended", () => {
    assert.strictEqual(
      noLiveRecordUnderThatNameSentence("heroku", ["Heroku for Startups Program"]),
      'We have no record under "heroku". The closest name we hold is Heroku for Startups Program, and that offer has ended.',
    );
  });

  it("reads as a list where more than one record has ended", () => {
    assert.strictEqual(
      noLiveRecordUnderThatNameSentence("drift", ["Drift One", "Drift Two"]),
      'We have no record under "drift". The closest names we hold are Drift One and Drift Two, and those offers have ended.',
    );
  });
});

describe("the doors agree about a name whose only record has ended", () => {
  const HEROKU = "Heroku";

  it("refuses at the vendor-risk door and names the record", () => {
    const result = checkVendorRisk(HEROKU);
    assert.ok("error" in result);
    assert.deepStrictEqual(result.suggestions, ["Heroku for Startups Program"]);
  });

  it("refuses at the compare door and names the record", () => {
    const result = compareServices(HEROKU, "Render");
    assert.ok("error" in result);
    assert.deepStrictEqual(result.suggestions_a, ["Heroku for Startups Program"]);
  });

  it("refuses at the slug door and names the same record", () => {
    const resolution = resolveVendorSlug(toSlug(HEROKU));
    assert.deepStrictEqual(resolution, { type: "onlyMatchHasEnded", slugs: ["heroku-for-startups-program"] });
  });

  it("does not count it as a service the stack audit analysed", () => {
    const audit = auditStack([HEROKU]);
    assert.strictEqual(audit.services[0].status, "not_found");
    assert.strictEqual(audit.services[0].vendor, HEROKU);
    assert.deepStrictEqual(audit.services[0].suggestions, ["Heroku for Startups Program"]);
  });

  it("still answers about the programme when that is the name asked for", () => {
    const result = checkVendorRisk("Heroku for Startups Program");
    assert.ok(!("error" in result));
    assert.strictEqual(result.result.vendor_match.type, "exact");
  });
});

describe("over HTTP, on the surface that took the traffic", () => {
  let proc: ChildProcess | null = null;
  let port = 0;

  before(async () => {
    proc = await new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn("node", [path.join(__dirname, "..", "dist", "serve.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0", BASE_URL: "http://localhost" },
      });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Server startup timeout"));
      }, 15000);
      child.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          port = parseInt(match[1]!, 10);
          clearTimeout(timeout);
          resolve(child);
        }
      });
      child.on("error", err => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });

  after(() => {
    proc?.kill();
    proc = null;
  });

  it("no longer redirects a company name onto a programme that ended", async () => {
    const response = await fetch(`http://localhost:${port}/vendor/heroku`, { redirect: "manual" });
    assert.strictEqual(response.status, 404);
    assert.strictEqual(response.headers.get("location"), null);
    const html = await response.text();
    assert.ok(html.includes("Heroku for Startups Program"), "the 404 does not name what we hold");
    assert.ok(html.includes("/vendor/heroku-for-startups-program"), "the 404 does not link what we hold");
  });

  it("refuses the same name on the alternatives door", async () => {
    const response = await fetch(`http://localhost:${port}/alternative-to/heroku`, { redirect: "manual" });
    assert.strictEqual(response.status, 404);
    assert.ok((await response.text()).includes("Heroku for Startups Program"));
  });

  it("refuses the same name on the details door, where it used to answer 200", async () => {
    const response = await fetch(`http://localhost:${port}/api/details/Heroku`);
    assert.strictEqual(response.status, 404);
    const body = await response.json() as { error: string; suggestions: string[] };
    assert.deepStrictEqual(body.suggestions, ["Heroku for Startups Program"]);
  });

  it("keeps refusing at the door that was already right", async () => {
    const response = await fetch(`http://localhost:${port}/api/vendor-risk/Heroku`);
    assert.strictEqual(response.status, 404);
    const body = await response.json() as { suggestions: string[] };
    assert.deepStrictEqual(body.suggestions, ["Heroku for Startups Program"]);
  });

  it("still serves the programme under the name it is filed as", async () => {
    const response = await fetch(`http://localhost:${port}/vendor/heroku-for-startups-program`, { redirect: "manual" });
    assert.strictEqual(response.status, 200);
  });

  it("still completes a short name whose longer record is one we still offer", async () => {
    for (const [asked, served] of [
      ["hugging", "hugging-face"],
      ["mistral", "mistral-ai"],
      ["appwrite", "appwrite-cloud"],
    ]) {
      const response = await fetch(`http://localhost:${port}/vendor/${asked}`, { redirect: "manual" });
      assert.strictEqual(response.status, 301, asked);
      assert.strictEqual(response.headers.get("location"), `/vendor/${served}`, asked);
    }
  });
});
