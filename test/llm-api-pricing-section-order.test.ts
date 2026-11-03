import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORDER = ["pricing-table", "free-tiers", "recommendations", "faq", "hidden-costs", "categories", "upcoming-changes", "changes"];

describe("the LLM pricing guide puts recommendations before provider details", () => {
  let child: ChildProcess;
  let html: string;
  let sections: string[];

  before(async () => {
    child = spawn(process.execPath, [path.join(ROOT, "dist/serve.js")], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC", AGENTDEALS_REFERRAL_HEALTH: "off" },
    });
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      child.stderr!.on("data", (chunk: Buffer) => {
        const match = chunk.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://localhost:${match[1]}`); }
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); });
    });
    const response = await fetch(base + "/llm-api-pricing", { redirect: "error" });
    assert.equal(response.status, 200);
    html = await response.text();
    sections = [...html.matchAll(/<h2\b[^>]*\bid="([^"]+)"[^>]*>/g)].map(match => match[1]);
  });

  after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  });

  it("prints the comparison, free tiers, recommendations, FAQ, gotchas, providers and dated changes in order", () => {
    assert.deepEqual(sections, ORDER.filter(id => id !== "upcoming-changes" || sections.includes(id)));
  });

  for (const id of ["recommendations", "faq"]) {
    it(`prints ${id} in the body before the provider breakdown`, () => {
      assert.ok(sections.includes(id));
      assert.ok(sections.includes("categories"));
      assert.ok(sections.indexOf(id) < sections.indexOf("categories"));
    });
  }

  it("keeps jump links in the same order as their sections", () => {
    const toc = html.match(/<div class="toc">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(toc);
    const links = [...toc.matchAll(/href="#([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(links, sections);
  });
});
