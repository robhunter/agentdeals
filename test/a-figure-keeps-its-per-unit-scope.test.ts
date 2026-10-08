import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { figuresWeAlsoPublish, readQuantities } from "../scripts/change-gate.js";
import { reportedFigures } from "../scripts/withdraw-figures-we-do-not-publish.js";
import { assertPopulationFloor } from "./population-floor.ts";

type Offer = import("../src/types.ts").Offer;

function scopesIn(text: string) {
  return readQuantities(text).map((quantity: { scope: string | null }) => quantity.scope);
}

describe("the unit a figure is counted per", () => {
  it("reads it from per and from a slash", () => {
    assert.deepStrictEqual(scopesIn("5 GB per user"), ["user"]);
    assert.deepStrictEqual(scopesIn("5 GB/user"), ["user"]);
    assert.deepStrictEqual(scopesIn("1 cluster per user"), ["user"]);
    assert.deepStrictEqual(scopesIn("$0.10/GB"), ["gb"]);
  });

  it("reads it from a rate that names it beside its period", () => {
    assert.deepStrictEqual(scopesIn("$5/user/month"), ["user"]);
    assert.deepStrictEqual(scopesIn("$5 per month per seat"), ["seat"]);
    assert.deepStrictEqual(scopesIn("10 GB/user/mo"), ["user"]);
  });

  it("reads none from a period alone", () => {
    assert.deepStrictEqual(scopesIn("10,000 requests per day"), [null]);
    assert.deepStrictEqual(scopesIn("5 GB/mo"), [null]);
    assert.deepStrictEqual(scopesIn("100 req/s"), [null]);
    assert.deepStrictEqual(scopesIn("500 builds per week"), [null]);
    assert.deepStrictEqual(scopesIn("2 GB/hr"), [null]);
  });

  it("reads none past the next figure or the end of the clause", () => {
    assert.deepStrictEqual(scopesIn("5 GB total 5 GB/user"), [null, "user"]);
    assert.deepStrictEqual(scopesIn("5 GB, unlimited per user"), [null]);
  });

  it("reads none from a per that names no unit", () => {
    assert.deepStrictEqual(scopesIn("5 GB as per the terms"), [null]);
  });
});

describe("a figure counts as one we publish only if our terms carry its scope", () => {
  it("does not read storage per user as the total we publish", () => {
    assert.deepStrictEqual(
      figuresWeAlsoPublish(
        ["5 GB per user", "5 GB total 5 GB/user", "5 GB/user"],
        "The free plan includes 10,000 messages of search history and File storage up to 5 GB.",
      ),
      [],
    );
  });

  it("does not match a figure per user to a total of ours because another figure of ours is per user", () => {
    assert.deepStrictEqual(
      figuresWeAlsoPublish(["5 GB per user"], "5 GB of storage in total, and 10 GB per user of bandwidth."),
      [],
    );
  });

  it("does not read a count per user as the count we publish", () => {
    assert.deepStrictEqual(figuresWeAlsoPublish(["1 cluster per user"], "Free tier with 1 cluster and 1 GB memory."), []);
    assert.deepStrictEqual(
      figuresWeAlsoPublish(["25 uptime monitoring per user"], "Up to 25 servers and 25 uptime monitoring instances."),
      [],
    );
  });

  it("does not take a figure of ours run together with one scoped per request", () => {
    assert.deepStrictEqual(
      figuresWeAlsoPublish(["0.25 vCPUs 1 thread/request", "1k requests per day"], "Free tier includes 1k requests per day and 0.25 vCPUs."),
      ["1k requests per day"],
    );
  });

  it("takes a figure scoped as ours is", () => {
    assert.deepStrictEqual(
      figuresWeAlsoPublish(["$20/user/month"], "Standard is $20/user/month or $200/user/year."),
      ["$20/user/month"],
    );
    assert.deepStrictEqual(figuresWeAlsoPublish(["10 GB per project"], "Each project gets 10 GB per project."), [
      "10 GB per project",
    ]);
  });

  it("takes a figure the page states with no scope beside one of ours that carries one", () => {
    assert.deepStrictEqual(figuresWeAlsoPublish(["$20", "$200"], "Standard is $20/user/month or $200/user/year."), [
      "$20",
      "$200",
    ]);
  });
});

describe("no record we publish reports a figure carrying a scope its own terms do not carry", () => {
  const offers: Offer[] = JSON.parse(
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "index.json"), "utf-8"),
  ).offers;
  const reporting = offers.filter(
    offer => offer.source_check?.outcome === "ok" && reportedFigures(offer.source_check.detail ?? "") !== null,
  );

  it("reads a population of reported figures large enough for the sweep to mean something", () => {
    assertPopulationFloor(reporting.length, 180, "records reporting a figure the page states");
  });

  it("finds every scope a reported figure carries among the scopes of the terms the record holds", () => {
    const foreign: string[] = [];
    for (const offer of reporting) {
      const ours = new Set(readQuantities(offer.description).map((quantity: { scope: string | null }) => quantity.scope));
      for (const figure of reportedFigures(offer.source_check!.detail ?? "")!.figures) {
        const scopes = scopesIn(figure).filter((scope): scope is string => scope !== null && !ours.has(scope));
        if (scopes.length > 0) foreign.push(`${offer.vendor}: "${figure}" per ${scopes.join(", ")}`);
      }
    }
    assert.deepStrictEqual(foreign, []);
  });
});
