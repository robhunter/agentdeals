import { describe, it } from "node:test";
import assert from "node:assert";

const { clausesOf, clauseNaming, statedQuantities, quantitiesNotIn } = await import("../dist/quoted-figures.js");

describe("reading a clause back out of a record", () => {
  it("keeps a comma inside brackets with the clause it qualifies", () => {
    assert.deepStrictEqual(clausesOf("2 AMD VMs (1/8 OCPU, 1 GB each), 200 GB block volumes"), [
      "2 AMD VMs (1/8 OCPU, 1 GB each)",
      "200 GB block volumes",
    ]);
  });

  it("returns the clause naming the subject rather than the whole record", () => {
    const description = "Always Free includes 2 AMD VMs (1/8 OCPU, 1 GB each), Arm Ampere A1 at 2 OCPUs and 12 GB total across 1-2 VMs, 200 GB block volumes";
    assert.strictEqual(clauseNaming(description, "Ampere"), "Arm Ampere A1 at 2 OCPUs and 12 GB total across 1-2 VMs");
    assert.strictEqual(clauseNaming(description, "block volumes"), "200 GB block volumes");
  });

  it("says nothing when the record stopped naming the subject", () => {
    assert.strictEqual(clauseNaming("Always Free services, some limitations apply", "Ampere"), null);
  });
});

describe("reading the quantities a claim states", () => {
  it("reads the same quantity through the spellings a page uses", () => {
    assert.deepStrictEqual(statedQuantities("24GB"), statedQuantities("24 GB"));
    assert.deepStrictEqual(statedQuantities("4 OCPUs"), statedQuantities("4 OCPU"));
    assert.deepStrictEqual(statedQuantities("750h/mo"), statedQuantities("750 hours/month"));
  });

  it("reads a price as a quantity and a bare number as none", () => {
    assert.deepStrictEqual(statedQuantities("$7.60/mo"), ["$7.60"]);
    assert.deepStrictEqual(statedQuantities("shared-cpu-1x"), []);
  });

  it("reports the quantities a claim states that its backing does not", () => {
    const record = "Basic Droplets from $4/mo (1 vCPU, 512 MB RAM, 10 GB SSD)";
    assert.deepStrictEqual(quantitiesNotIn("Basic — 1 vCPU, 512 MB $4/mo", [record]), []);
    assert.deepStrictEqual(quantitiesNotIn("Basic — 2 vCPUs, 512 MB $4/mo", [record]), ["2vcpu"]);
    assert.deepStrictEqual(quantitiesNotIn("1 vCPU", []), ["1vcpu"]);
  });
});

describe("matching a claim's quantities against what we hold", () => {
  it("reads a quantity whose unit follows words describing it", () => {
    const listing = "Free web services spin down after 15 minutes, with 750 free instance hours per workspace a month.";
    assert.deepStrictEqual(quantitiesNotIn("Free (750h/mo)", [listing]), []);
  });

  it("checks a count the claim states through a describing word", () => {
    const record = "Arm Ampere A1 at 2 OCPUs and 12 GB total across 1-2 VMs";
    assert.deepStrictEqual(quantitiesNotIn("4 Arm VMs", [record]), ["4vm"]);
    assert.deepStrictEqual(quantitiesNotIn("2 Arm VMs", [record]), []);
  });

  it("stops reading at a word that starts a rate or a new phrase", () => {
    assert.deepStrictEqual(quantitiesNotIn("0.15 GB", ["$0.15 per GB of transfer"]), ["0.15gb"]);
    assert.deepStrictEqual(quantitiesNotIn("5 months", ["$5 free credit a month"]), ["5month"]);
  });

  it("reads every quantity the stricter reading finds", () => {
    const text = "Basic Droplets from $4/mo (1 vCPU, 512 MB RAM, 10 GB SSD), 500 build minutes";
    for (const quantity of statedQuantities(text)) {
      assert.deepStrictEqual(quantitiesNotIn(quantity.replace(/^(\d[\d.]*)(\D+)$/, "$1 $2"), [text]), [], quantity);
    }
  });
});
