import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("stack recommendation logic", () => {
  it("returns stack for SaaS use case", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("Next.js SaaS app");
    assert.strictEqual(result.use_case, "Next.js SaaS app");
    assert.ok(result.stack.length >= 3, "SaaS stack should have at least 3 components");
    assert.strictEqual(result.total_monthly_cost, "$0");
    assert.ok(Array.isArray(result.limitations));
    assert.ok(typeof result.upgrade_path === "string");

    // Check roles and their candidates have required fields
    for (const role of result.stack) {
      assert.ok(role.role, "Should have role");
      assert.ok(role.candidates.length > 0, "Should have candidates");
      for (const c of role.candidates) {
        assert.ok(c.vendor, "Should have vendor");
        assert.ok(c.tier, "Should have tier");
        assert.ok(c.description, "Should have description");
        assert.ok(c.url, "Should have url");
      }
    }

    // Should include hosting and database roles
    const roles = result.stack.map((c: any) => c.role);
    assert.ok(roles.includes("Hosting"), "SaaS stack should include Hosting");
    assert.ok(roles.includes("Database"), "SaaS stack should include Database");
  });

  it("returns stack for API backend use case", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("Python API backend");
    assert.ok(result.stack.length >= 3);
    const roles = result.stack.map((c: any) => c.role);
    assert.ok(roles.includes("Hosting"));
    assert.ok(roles.includes("Database"));
  });

  it("returns stack for static site use case", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("static blog");
    assert.ok(result.stack.length >= 2);
  });

  it("returns stack for mobile app use case", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("React Native mobile app");
    assert.ok(result.stack.length >= 3);
  });

  it("returns stack for AI/ML use case", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("AI chatbot");
    assert.ok(result.stack.length >= 2);
    const roles = result.stack.map((c: any) => c.role);
    assert.ok(roles.includes("AI/ML"), "AI stack should include AI/ML role");
  });

  it("requirements override template defaults", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("my project", ["database", "monitoring", "search"]);
    assert.strictEqual(result.stack.length, 3);
    const roles = result.stack.map((c: any) => c.role.toLowerCase());
    assert.ok(roles.includes("database"));
    assert.ok(roles.includes("monitoring"));
    assert.ok(roles.includes("search"));
  });

  it("falls back gracefully for unknown use case", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("quantum teleporter management system");
    // Should return fallback stack with common categories
    assert.ok(result.stack.length >= 3);
    assert.strictEqual(result.total_monthly_cost, "$0");
  });

  it("description is capped at 200 characters", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("Next.js SaaS app");
    for (const role of result.stack) {
      for (const c of role.candidates) {
        assert.ok(c.description.length <= 200, `Description for ${c.vendor} exceeds 200 chars`);
      }
    }
  });

  it("candidates include risk_level and stability fields", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("Next.js SaaS app");
    assert.ok(result.stack.length > 0);
    for (const role of result.stack) {
      for (const c of role.candidates) {
        assert.ok(
          ["stable", "caution", "risky"].includes(c.risk_level),
          `${c.vendor} risk_level should be stable|caution|risky, got ${c.risk_level}`
        );
        assert.ok(
          ["stable", "watch", "volatile", "improving"].includes(c.stability),
          `${c.vendor} stability should be stable|watch|volatile|improving, got ${c.stability}`
        );
      }
    }
  });

  it("stack includes risk_warnings array", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("Next.js SaaS app");
    assert.ok(Array.isArray(result.risk_warnings));
    // Each warning should name the vendor and role
    for (const w of result.risk_warnings) {
      assert.ok(typeof w === "string");
      assert.ok(w.length > 0);
    }
  });

  it("every risk warning names a candidate we are actually showing", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("Next.js SaaS app");
    const shown = new Set(result.stack.flatMap((r: any) => r.candidates.map((c: any) => `${c.vendor} (${r.role})`)));
    for (const w of result.risk_warnings) {
      const prefix = w.slice(0, w.indexOf("):") + 1);
      assert.ok(shown.has(prefix), `warning references ${prefix}, which is not in the returned candidate set`);
    }
  });
});

// #1025: plan_stack stops naming one winner per role. The old behaviour put
// Supabase in every database slot of every template because it was typed first
// in `preferredVendors`; the fallback was `publicOffers[0]`, index order in the
// JSON file. Both are gone.
describe("plan_stack does not name a winner", () => {
  it("returns a candidate set per role, not a single vendor", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("Next.js SaaS app");
    for (const role of result.stack) {
      assert.ok(Array.isArray(role.candidates), `${role.role} must return candidates`);
      assert.ok(role.candidates.length > 1, `${role.role} returned ${role.candidates.length} candidate — that is a pick, not a set`);
      assert.strictEqual((role as any).vendor, undefined, "a role must not carry a single winning vendor");
    }
  });

  it("no vendor occupies the same slot across every template", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const firsts = ["Next.js SaaS app", "AI agent backend", "side project with database"].map((useCase) => {
      const db = getStackRecommendation(useCase).stack.find((r: any) => r.role === "Database");
      return db?.candidates[0]?.vendor;
    });
    assert.ok(firsts.every(Boolean), "each use case should return a database role");
    assert.notStrictEqual(new Set(firsts).size, 1, `the same vendor led every template: ${firsts[0]}`);
  });

  it("discloses the size of the tie it drew from, and the seed", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("Next.js SaaS app");
    for (const role of result.stack) {
      assert.ok(role.tie_count >= role.candidates.length || role.tie_count === 0, `${role.role} shows more candidates than tie_count claims`);
      assert.match(role.tie_break.seed, /^[0-9a-f]{64}$/);
      assert.strictEqual(role.tie_break.query_key, `stack:Next.js SaaS app:${role.role}`);
      assert.ok(role.reason.length > 40, `${role.role} must explain itself`);
    }
  });

  it("states plainly that we do not model technical fit", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const result = getStackRecommendation("Next.js SaaS app");
    assert.match(result.method.not_modelled, /do NOT model technical fit/i);
    assert.match(result.method.policy, /nothing to add/);
    assert.strictEqual(result.method.criteria_url, "/criteria");
  });

  it("the tier gate replaces the hand-typed allowlist — Always Free is reachable again", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const seen = new Set<string>();
    for (const useCase of ["Next.js SaaS app", "AI agent backend", "static blog", "devops platform", "ecommerce store"]) {
      for (const role of getStackRecommendation(useCase).stack) {
        for (const c of role.candidates) seen.add(c.tier);
      }
    }
    // `findBestOffer()` gated on {Free, Hobby, Open Source, Free Credits}, so no
    // offer outside that set could ever appear. Any tier outside it proves the
    // allowlist is gone.
    const outsideOldAllowlist = [...seen].filter((t) => !["Free", "Hobby", "Open Source", "Free Credits"].includes(t));
    assert.ok(outsideOldAllowlist.length > 0, "no tier outside the old allowlist appeared — the gate may not have changed");
  });

  it("rotates day to day but is stable within a day", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    const a = getStackRecommendation("Next.js SaaS app", undefined, "2026-08-25");
    const b = getStackRecommendation("Next.js SaaS app", undefined, "2026-08-25");
    const c = getStackRecommendation("Next.js SaaS app", undefined, "2026-08-26");
    const names = (r: any) => r.stack.map((role: any) => role.candidates.map((x: any) => x.vendor).join(","));
    assert.deepStrictEqual(names(a), names(b));
    assert.notDeepStrictEqual(names(a), names(c));
  });

  it("a demoted candidate is never shown above one with no demerits", async () => {
    const { getStackRecommendation } = await import("../dist/stacks.js");
    for (const useCase of ["Next.js SaaS app", "AI chatbot", "ecommerce store"]) {
      for (const role of getStackRecommendation(useCase).stack) {
        const totals = role.candidates.map((c: any) => c.demerits.reduce((s: number, d: any) => s + d.points, 0));
        assert.deepStrictEqual(totals, [...totals].sort((x, y) => x - y), `${useCase}/${role.role} is out of band order`);
      }
    }
  });
});

describe("stack REST endpoint", () => {
  let serverPort = 0;
  let proc: ChildProcess | null = null;

  function startHttpServer(): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const serverPath = path.join(__dirname, "..", "dist", "serve.js");
      const p = spawn("node", [serverPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PORT: "0" },
      });
      const timeout = setTimeout(() => { p.kill(); reject(new Error("Server startup timeout")); }, 10000);
      p.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) { serverPort = parseInt(match[1], 10); clearTimeout(timeout); resolve(p); }
      });
      p.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  afterEach(() => {
    if (proc) { proc.kill(); proc = null; }
  });

  it("GET /api/stack returns stack recommendation", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/stack?use_case=SaaS+web+app`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");
    const body = await response.json() as any;
    assert.ok(Array.isArray(body.stack));
    assert.ok(body.stack.length >= 3);
    assert.strictEqual(body.total_monthly_cost, "$0");
    assert.ok(Array.isArray(body.limitations));
    assert.ok(typeof body.upgrade_path === "string");
    assert.ok(Array.isArray(body.stack[0].candidates));
    assert.strictEqual(body.method.criteria_url, "/criteria");
  });

  it("GET /api/stack returns 400 without use_case", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/stack`);
    assert.strictEqual(response.status, 400);
    const body = await response.json() as any;
    assert.ok(body.error.includes("use_case"));
  });

  it("GET /api/stack accepts requirements parameter", async () => {
    proc = await startHttpServer();
    const response = await fetch(`http://localhost:${serverPort}/api/stack?use_case=my+app&requirements=database,auth,monitoring`);
    assert.strictEqual(response.status, 200);
    const body = await response.json() as any;
    assert.strictEqual(body.stack.length, 3);
  });
});
