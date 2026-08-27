import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const PERTURBED_FIELDS = ["description", "tier", "notes", "limits"];
const INDEX_CITATION = /our (?:verified )?index of/i;
const VERIFICATION_CLAIM = /\b(?:verified|cross-referenced) against\b/i;
const NAMES_A_YEAR = /\b(?:19|20)\d{2}\b/;
const COMPILED_NOTICE = /Figures compiled (\d{4}-\d{2}-\d{2}), not re-checked since/;

type Registered = { path: string; tier: string; published: string; reads_index: boolean };

function registeredPages(): Registered[] {
  const raw = JSON.parse(readFileSync(path.join(REPO, "data", "page-reviews.json"), "utf-8"));
  return raw.pages.map((p: any) => ({
    path: p.path,
    tier: p.tier,
    published: p.published,
    reads_index: p.reads_index === true,
  }));
}

function perturbIndex(source: string, target: string): number {
  const data = JSON.parse(readFileSync(source, "utf-8"));
  let touched = 0;
  for (const offer of data.offers) {
    for (const field of PERTURBED_FIELDS) {
      if (typeof offer[field] !== "string") continue;
      offer[field] = `PMPERTURB ${offer[field].replace(/\d/g, "9")}`;
      touched += 1;
    }
  }
  writeFileSync(target, JSON.stringify(data));
  return touched;
}

function startServer(env: NodeJS.ProcessEnv): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost:3000", ...env },
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server startup timeout"));
    }, 30000);
    child.stderr!.on("data", (data: Buffer) => {
      const m = data.toString().match(/running on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timeout);
        resolve({ proc: child, port: parseInt(m[1], 10) });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function visibleSentences(html: string): string[] {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ");
  return text.split(/(?<!\b[a-z]{1,4})\.\s+(?=[A-Z"“])/).map((s) => s.trim()).filter(Boolean);
}

describe("a page may only name the source it actually reads", () => {
  let tmp: string;
  let real: { proc: ChildProcess; port: number };
  let perturbed: { proc: ChildProcess; port: number };
  const pages = registeredPages();
  const bodies = new Map<string, string>();
  const consumesIndex = new Map<string, boolean>();

  before(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "page-data-provenance-"));
    const perturbedIndex = path.join(tmp, "index.json");
    const touched = perturbIndex(path.join(REPO, "data", "index.json"), perturbedIndex);
    assert.ok(touched > 1000, `perturbed only ${touched} fields, so the comparison below proves nothing`);
    [real, perturbed] = await Promise.all([
      startServer({}),
      startServer({ AGENTDEALS_INDEX_PATH: perturbedIndex }),
    ]);
    for (const page of pages) {
      const [a, b] = await Promise.all([
        fetch(`http://localhost:${real.port}${page.path}`).then((r) => r.text()),
        fetch(`http://localhost:${perturbed.port}${page.path}`).then((r) => r.text()),
      ]);
      bodies.set(page.path, a);
      consumesIndex.set(page.path, a !== b);
    }
  });

  after(() => {
    real?.proc.kill();
    perturbed?.proc.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("measures readership by perturbing the catalogue, not by trusting the register", () => {
    const measured = pages.filter((p) => consumesIndex.get(p.path));
    assert.ok(measured.length > 5, `only ${measured.length} pages responded to the catalogue at all`);
    assert.ok(measured.length < pages.length, "every page responded, so the measurement cannot distinguish anything");
    const wrong = pages.filter((p) => p.reads_index !== consumesIndex.get(p.path));
    assert.deepStrictEqual(
      wrong.map((p) => `${p.path} register=${p.reads_index} measured=${consumesIndex.get(p.path)}`),
      []
    );
  });

  it("names our index as a source only on the pages that read it", () => {
    const offenders: string[] = [];
    for (const page of pages) {
      if (page.reads_index) continue;
      for (const sentence of visibleSentences(bodies.get(page.path)!)) {
        if (INDEX_CITATION.test(sentence)) offenders.push(`${page.path}: ${sentence}`);
      }
    }
    assert.deepStrictEqual(offenders, []);
  });

  it("still names the index on the pages that do read it, so the rule above is not vacuous", () => {
    const citing = pages.filter(
      (p) => p.reads_index && visibleSentences(bodies.get(p.path)!).some((s) => INDEX_CITATION.test(s))
    );
    assert.ok(citing.length >= 5, `only ${citing.length} pages cite the index, so the check has almost nothing to allow`);
  });

  it("dates every verification claim a page cannot support from a record", () => {
    const offenders: string[] = [];
    for (const page of pages) {
      if (page.reads_index) continue;
      for (const sentence of visibleSentences(bodies.get(page.path)!)) {
        if (VERIFICATION_CLAIM.test(sentence) && !NAMES_A_YEAR.test(sentence)) {
          offenders.push(`${page.path}: ${sentence}`);
        }
      }
    }
    assert.deepStrictEqual(offenders, []);
  });

  it("tells the reader when the figures were compiled on every page that reads no record", () => {
    const wrong: string[] = [];
    for (const page of pages) {
      if (page.reads_index || page.tier !== "A") continue;
      const found = bodies.get(page.path)!.match(COMPILED_NOTICE);
      if (!found) wrong.push(`${page.path}: no compiled notice`);
      else if (found[1] !== page.published) wrong.push(`${page.path}: notice says ${found[1]}, compiled ${page.published}`);
    }
    assert.deepStrictEqual(wrong, []);
  });

  it("does not put the compiled notice on a page that reads the catalogue", () => {
    const wrong = pages.filter((p) => p.reads_index && COMPILED_NOTICE.test(bodies.get(p.path)!));
    assert.deepStrictEqual(wrong.map((p) => p.path), []);
  });
});
