import { describe, it } from "node:test";
import assert from "node:assert";
import {
  CATEGORY_ALIASES,
  CATEGORY_SCOPES,
  EXAMPLE_MEMBER_COUNT,
  PROGRAMME_TIERS,
  buildCategoryDirectory,
  categoryHolds,
  categoryState,
  familySiblings,
  publishedScopeFor,
  resolveCategoryName,
  scopeFor,
} from "../dist/category-scope.js";
import { getCategories, loadOffers } from "../dist/data.js";
import { toSlug } from "../dist/slug.js";
import { offerEnded } from "../dist/retirement.js";

const categories = getCategories();
const offers = loadOffers();
const directory = buildCategoryDirectory(categories, offers, toSlug);

describe("every published category says what it holds", () => {
  it("gives a scope statement to every name /api/categories publishes", () => {
    const silent = directory.filter((entry) => entry.scope.length === 0);
    assert.deepStrictEqual(
      silent.map((entry) => entry.name),
      [],
      `these category names publish a count and no scope statement: ${silent.map((e) => e.name).join(", ")}`,
    );
  });

  it("declares no scope for a name no offer is filed under", () => {
    const live = new Set(categories.map((c) => c.name));
    const orphans = Object.keys(CATEGORY_SCOPES).filter((name) => categoryState(name, live) === "absent");
    assert.deepStrictEqual(orphans, [], `scope declared for names holding nothing: ${orphans.join(", ")}`);
  });

  it("publishes no scope statement for a name it has retired", () => {
    const live = new Set(categories.map((c) => c.name));
    const speaking = Object.keys(CATEGORY_SCOPES)
      .filter((name) => categoryState(name, live) === "retired")
      .filter((name) => publishedScopeFor(name, live) !== null);
    assert.deepStrictEqual(speaking, [], `retired names still publishing a scope statement: ${speaking.join(", ")}`);
  });

  it("names three members for every category holding three unended offers", () => {
    const short = directory.filter((entry) => entry.count >= EXAMPLE_MEMBER_COUNT && entry.example_members.length < EXAMPLE_MEMBER_COUNT);
    assert.deepStrictEqual(short.map((e) => e.name), []);
  });

  it("draws every example member from the category it illustrates", () => {
    for (const entry of directory) {
      for (const member of entry.example_members) {
        const filedUnder = offers.filter((o) => o.vendor === member).map((o) => o.category);
        assert.ok(
          filedUnder.includes(entry.name),
          `${member} illustrates ${entry.name} and is filed under ${filedUnder.join(", ")}`,
        );
      }
    }
  });
});

describe("no two names answer one question without saying how they differ", () => {
  it("gives every category in a family a scope statement of its own", () => {
    const seen = new Map<string, string>();
    for (const [name, scope] of Object.entries(CATEGORY_SCOPES)) {
      const duplicate = seen.get(scope.scope);
      assert.strictEqual(duplicate, undefined, `${name} and ${duplicate} publish the same scope statement`);
      seen.set(scope.scope, name);
    }
  });

  it("has every member of a family point at every other", () => {
    for (const entry of directory) {
      for (const sibling of entry.also_answering) {
        const back = directory.find((e) => e.name === sibling.name);
        assert.ok(back, `${entry.name} points at ${sibling.name}, which is not published`);
        assert.ok(
          back.also_answering.some((s) => s.name === entry.name),
          `${entry.name} names ${sibling.name} as answering alongside it and ${sibling.name} does not name ${entry.name}`,
        );
      }
    }
  });

  it("publishes a count beside every name it sends a caller to", () => {
    const counts = new Map(categories.map((c) => [c.name, c.count]));
    for (const entry of directory) {
      for (const sibling of entry.also_answering) {
        assert.strictEqual(sibling.count, counts.get(sibling.name));
        assert.strictEqual(sibling.slug, toSlug(sibling.name));
      }
    }
  });

  it("files every vendor a scope statement names where the statement says it is", () => {
    for (const [name, scope] of Object.entries(CATEGORY_SCOPES)) {
      for (const [vendor, claimed] of Object.entries(scope.names ?? {})) {
        assert.ok(scope.scope.includes(vendor), `${name} claims ${vendor} and does not name it`);
        const filedUnder = offers.filter((o) => o.vendor === vendor).map((o) => o.category);
        assert.ok(filedUnder.length > 0, `${name}'s scope statement names ${vendor}, which the catalogue does not hold`);
        assert.ok(
          filedUnder.includes(claimed),
          `${name}'s scope statement puts ${vendor} under ${claimed} and it is under ${filedUnder.join(", ")}`,
        );
      }
    }
  });

  it("sends a caller only to a name that holds something", () => {
    for (const entry of directory) {
      for (const sibling of entry.also_answering) {
        assert.ok(sibling.count > 0, `${entry.name} sends a caller to ${sibling.name}, which holds nothing`);
      }
    }
  });
});

describe("the storage pair a caller cannot currently tell apart", () => {
  const storage = directory.find((e) => e.name === "Storage")!;
  const cloudStorage = directory.find((e) => e.name === "Cloud Storage")!;

  it("answers 'free object storage for my app' under one name", () => {
    assert.ok(storage.scope.includes("Object storage"));
    assert.strictEqual(storage.audience, "developer");
    assert.ok(storage.also_answering.some((s) => s.name === "Cloud Storage"));
  });

  it("answers 'free personal file sync' under the other", () => {
    assert.ok(cloudStorage.scope.includes("file-sync"));
    assert.strictEqual(cloudStorage.audience, "personal");
    assert.ok(cloudStorage.also_answering.some((s) => s.name === "Storage"));
  });

  it("tells the two apart from the directory alone", () => {
    assert.notStrictEqual(storage.audience, cloudStorage.audience);
    assert.notStrictEqual(storage.scope, cloudStorage.scope);
  });
});

describe("a tier that names a programme is not filed as a product", () => {
  it("keeps every qualified-access record out of a product category", () => {
    const misfiled = offers
      .filter((o) => PROGRAMME_TIERS.includes(o.tier))
      .filter((o) => categoryHolds(o.category) === "products")
      .map((o) => `${o.vendor} (${o.category}, ${o.tier})`);
    assert.deepStrictEqual(misfiled, [], `records whose tier says programme and whose category says product: ${misfiled.join("; ")}`);
  });

  it("holds nothing but qualified-access offers in a programme category", () => {
    const programmeCategories = Object.entries(CATEGORY_SCOPES)
      .filter(([, scope]) => scope.holds === "programmes")
      .map(([name]) => name);
    assert.ok(programmeCategories.length > 0);
    for (const name of programmeCategories) {
      const members = offers.filter((o) => o.category === name);
      const openToAnyone = members.filter((o) => !o.eligibility && !offerEnded(o) && !/startup|founder|accelerator|partner|perks|portfolio|deal|scholarship|sponsor|hatch|banking|offers/i.test(o.tier));
      assert.deepStrictEqual(openToAnyone.map((o) => `${o.vendor} (${o.tier})`), []);
    }
  });
});

describe("a name that stops being published keeps answering", () => {
  it("maps every retired name to a name that is published", () => {
    const live = new Set(categories.map((c) => c.name));
    for (const [retired, replacement] of Object.entries(CATEGORY_ALIASES)) {
      assert.ok(!live.has(retired), `${retired} is listed as retired and still holds offers`);
      assert.ok(live.has(replacement), `${retired} points at ${replacement}, which holds nothing`);
    }
  });

  it("resolves a retired name to the category that replaced it", () => {
    for (const [retired, replacement] of Object.entries(CATEGORY_ALIASES)) {
      assert.strictEqual(resolveCategoryName(retired), replacement);
      assert.strictEqual(scopeFor(retired)?.scope, CATEGORY_SCOPES[replacement].scope);
    }
  });

  it("leaves a live name alone", () => {
    for (const category of categories) {
      assert.strictEqual(resolveCategoryName(category.name), category.name);
    }
  });

  it("reports no family for a name whose family is gone", () => {
    assert.deepStrictEqual(familySiblings("Startup Perks"), []);
  });
});
