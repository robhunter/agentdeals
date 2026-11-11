import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadOffers, changesByVendor, refusalsForVendor } from "../dist/data.js";
import { vendorVerdictContextFrom } from "../dist/vendor-verdict-input.js";
import { vendorBadge, endingStatedInPlaceOfARating, endingShutsTheProductDown } from "../dist/vendor-verdict.js";
import { toSlug } from "../dist/vendor-slug.js";

const { createDocument } = createRequire(import.meta.url)("@mixmark-io/domino");
const servedOn = new Date().toISOString().slice(0, 10);
let child: ChildProcess;
let port = 0;
const pages = new Map<string, string>();

async function get(route: string): Promise<string> {
  const response = await fetch(`http://localhost:${port}${route}`, { redirect: "error" });
  assert.equal(response.status, 200, route);
  return response.text();
}

before(async () => {
  await new Promise<void>((resolve, reject) => {
    child = spawn(process.execPath, [fileURLToPath(new URL("../dist/serve.js", import.meta.url))], {
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Server startup timeout")); }, 60000);
    child.stderr!.on("data", data => {
      const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (match) { port = Number(match[1]); clearTimeout(timer); resolve(); }
    });
    child.on("error", error => { clearTimeout(timer); reject(error); });
  });
  const routes = new Set<string>();
  const maps = ["/sitemap.xml"];
  const seen = new Set<string>();
  for (const sitemap of maps) {
    if (seen.has(sitemap)) continue;
    seen.add(sitemap);
    for (const match of (await get(sitemap)).matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const route = new URL(match[1]).pathname;
      if (route.endsWith(".xml")) maps.push(route);
      else routes.add(route);
    }
  }
  assert.ok(routes.has("/vendor/netlify"));
  assert.ok(routes.has("/"));
  for (const route of routes) pages.set(route, await get(route));
});
after(() => child?.kill());

describe("vendor ratings follow the heading", () => {
  it("keeps every sitemap heading free of rating, status and badge elements", () => {
    const wrong: string[] = [];
    for (const [route, html] of pages) {
      const document = createDocument(html);
      for (const heading of Array.from(document.querySelectorAll("h1")) as any[]) {
        if (heading.querySelector('[class*="badge"], [class*="status"], [role="status"]')) wrong.push(route);
      }
    }
    assert.deepEqual(wrong, []);
  });

  it("preserves each vendor badge's label and colour immediately after its heading", () => {
    const offers = loadOffers();
    const changes = changesByVendor();
    const vendors = new Set(offers.map(offer => offer.vendor));
    for (const vendor of vendors) {
      const route = `/vendor/${toSlug(vendor)}`;
      const html = pages.get(route);
      if (!html) continue;
      const document = createDocument(html);
      const heading = document.querySelector("h1");
      assert.ok(heading, route);
      const context = vendorVerdictContextFrom({ vendor, vendorOffers: offers.filter(offer => offer.vendor === vendor), vendorChanges: changes.get(vendor.toLowerCase()) ?? [], refusedReads: refusalsForVendor(vendor), servedOn });
      assert.ok(context, route);
      const ending = endingStatedInPlaceOfARating(context.input);
      const rating = vendorBadge(context.input);
      const label = ending ? (endingShutsTheProductDown(ending) ? "deprecated" : "free tier removed")
        : rating.kind === "ended" ? "retired" : rating.kind === "rating" ? rating.word : null;
      const colours: Record<string, string> = { stable: "#3fb950", caution: "#d29922", risky: "#f85149" };
      const expected = label ? { label, color: ending ? "#f85149" : rating.kind === "ended" ? "#8b949e" : colours[label] } : null;
      const badge = heading.nextElementSibling;
      if (!expected) {
        assert.ok(!badge?.classList.contains("risk-badge"), route);
        continue;
      }
      assert.ok(badge?.classList.contains("risk-badge"), route);
      assert.equal(badge.textContent, expected.label, route);
      assert.equal(badge.getAttribute("style"), `background:${expected.color}20;color:${expected.color};border:1px solid ${expected.color}40`, route);
      assert.equal(document.querySelectorAll(".risk-badge").length, 1, route);
      assert.match(html, /h1 \+ \.risk-badge\{font-size:\.75rem;font-weight:600;padding:\.2rem \.6rem;border-radius:12px;vertical-align:middle;margin-left:\.5rem\}/, route);
    }
  });
});
