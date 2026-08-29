import { describe, it } from "node:test";
import assert from "node:assert";
import {
  deprecationEndsTheListedProduct,
  discontinuationDate,
  discontinuedOnOrBefore,
  productNamedApartFromVendor,
  readDeprecation,
} from "../dist/product-deprecation.js";
import { loadDealChanges } from "../dist/data.js";
import type { DealChange } from "../dist/types.js";

function record(over: Partial<DealChange> = {}): DealChange {
  return {
    vendor: "Vendor A",
    date: "2026-08-01",
    date_source: "vendor_page",
    change_type: "product_deprecated",
    summary: "",
    previous_state: "",
    current_state: "",
    impact: "high",
    source_url: "",
    category: "Databases",
    alternatives: [],
    ...over,
  } as DealChange;
}

function storedRecords(vendor: string): DealChange[] {
  return loadDealChanges().filter(
    c => c.vendor.toLowerCase() === vendor.toLowerCase() && c.change_type === "product_deprecated",
  );
}

function onlyRecord(vendor: string): DealChange {
  const held = storedRecords(vendor);
  assert.strictEqual(held.length, 1, `expected exactly one deprecation record for ${vendor}, found ${held.length}`);
  return held[0];
}

describe("#1147 — a deprecation demotes when the thing deprecated is the thing we list", () => {
  it("reads the product we list as the subject of its own shutdown", () => {
    for (const vendor of ["Hypertune", "smartlook.com", "lost-pixel.com"]) {
      const held = onlyRecord(vendor);
      assert.ok(
        deprecationEndsTheListedProduct(held),
        `${vendor}: ${held.summary}`,
      );
    }
  });

  it("leaves a vendor alone when the record names one of its other products", () => {
    const controls = ["Google Gemini API", "MiniMax", "AWS", "Firebase", "OpenAI"];
    for (const vendor of controls) {
      const held = storedRecords(vendor);
      assert.ok(held.length > 0, `${vendor} holds no deprecation record to control on`);
      for (const c of held) {
        assert.ok(
          !deprecationEndsTheListedProduct(c),
          `${vendor} would be demoted for: ${c.summary}`,
        );
      }
    }
  });

  it("decides on the record alone — the same sentence flips when the vendor changes", () => {
    const summary = "Firebase Studio (formerly Project IDX) shut down March 19, 2026.";
    assert.ok(!deprecationEndsTheListedProduct(record({ vendor: "Firebase", summary })));
    assert.ok(deprecationEndsTheListedProduct(record({ vendor: "Firebase Studio", summary })));
  });

  it("matches a vendor recorded as a domain against the name its prose uses", () => {
    assert.deepStrictEqual(productNamedApartFromVendor("Lost Pixel", "lost-pixel.com"), []);
    assert.deepStrictEqual(productNamedApartFromVendor("Smartlook", "smartlook.com"), []);
    assert.deepStrictEqual(productNamedApartFromVendor("Smartlook Analytics", "smartlook.com"), ["analytics"]);
  });

  it("reads a generic subject as the product itself", () => {
    assert.ok(deprecationEndsTheListedProduct(record({ vendor: "Xata Lite", summary: "Service has been discontinued." })));
    assert.ok(deprecationEndsTheListedProduct(record({ vendor: "Anyone", summary: "The free plan is being sunset." })));
  });

  it("reads a summary that opens on the predicate as the product itself, successor and all", () => {
    const brackets = onlyRecord("Brackets");
    assert.strictEqual(readDeprecation(brackets.summary)?.subject, "");
    assert.ok(deprecationEndsTheListedProduct(brackets), brackets.summary);
  });

  it("does not let an unrelated preamble stand in for the subject", () => {
    const summary = "Several discrepancies were found. Acme Cloud is shutting down.";
    assert.strictEqual(readDeprecation(summary)?.subject, "Acme Cloud");
    assert.ok(deprecationEndsTheListedProduct(record({ vendor: "Acme Cloud", summary })));
    assert.ok(!deprecationEndsTheListedProduct(record({ vendor: "Acme", summary: "Several discrepancies were found. Acme Cloud is shutting down." })));
  });

  it("reads nothing into a record of another type", () => {
    const summary = "Hypertune is shutting down and no longer accepting new sign ups.";
    assert.ok(!deprecationEndsTheListedProduct(record({ vendor: "Hypertune", change_type: "limits_reduced", summary })));
    assert.ok(!deprecationEndsTheListedProduct(record({ vendor: "Hypertune", change_type: "record_corrected", summary })));
  });

  it("reads no deprecation out of a summary that states none", () => {
    assert.strictEqual(readDeprecation("Free tier limits raised from 1 GB to 10 GB."), null);
    assert.ok(!deprecationEndsTheListedProduct(record({ vendor: "Acme", summary: "Free tier limits raised from 1 GB to 10 GB." })));
  });
});

describe("#1147 — the date the service stops", () => {
  it("takes the date the record attaches to the discontinuation", () => {
    assert.strictEqual(discontinuationDate(onlyRecord("Hypertune")), "2026-08-10");
  });

  it("ignores a date that sits before the predicate rather than after it", () => {
    const earlierSentence = record({ vendor: "Acme", summary: "On April 2, 2026 Acme announced a price rise. Acme is shutting down." });
    assert.strictEqual(discontinuationDate(earlierSentence), null);
    const sameSentence = record({ vendor: "Acme", summary: "Announced on April 2, 2026, Acme is shutting down." });
    assert.strictEqual(discontinuationDate(sameSentence), null, "the day it was announced is not the day it stops");
  });

  it("reads a day-first date as well as a month-first one", () => {
    const monthFirst = record({ vendor: "Acme", summary: "Acme will be discontinued on August 10, 2026." });
    const dayFirst = record({ vendor: "Acme", summary: "Acme will be discontinued on 10th August 2026." });
    assert.strictEqual(discontinuationDate(monthFirst), "2026-08-10");
    assert.strictEqual(discontinuationDate(dayFirst), "2026-08-10");
  });

  it("reads past a wind-down date stated ahead of the clause that ends the service", () => {
    const c = record({
      vendor: "Acme",
      summary: "Acme is shutting down.",
      current_state: "Read-only access runs to December 31, 2027, and the service is discontinued on June 30, 2026.",
    });
    assert.strictEqual(discontinuationDate(c), "2026-06-30");
  });

  it("takes the last date when a record states several", () => {
    const c = record({
      vendor: "Acme",
      summary: "Acme is being sunset from March 1, 2026.",
      current_state: "Acme is discontinued on September 30, 2027.",
    });
    assert.strictEqual(discontinuationDate(c), "2027-09-30");
  });

  it("gives no date for a vendor whose record names none", () => {
    assert.strictEqual(discontinuationDate(onlyRecord("lost-pixel.com")), null);
  });

  it("reports a discontinuation only once its date has passed", () => {
    const held = [onlyRecord("Hypertune")];
    assert.strictEqual(discontinuedOnOrBefore(held, "2026-08-29"), "2026-08-10");
    assert.strictEqual(discontinuedOnOrBefore(held, "2026-08-09"), null);
  });

  it("does not report a vendor whose free plan outlives the announcement", () => {
    const held = storedRecords("smartlook.com");
    assert.strictEqual(discontinuedOnOrBefore(held, "2026-08-29"), null);
  });

  it("gives no date for a record that does not end the product we list", () => {
    const c = record({ vendor: "AWS", summary: "AWS Proton end of support on October 7, 2026." });
    assert.ok(!deprecationEndsTheListedProduct(c));
    assert.strictEqual(discontinuationDate(c), null);
  });
});
