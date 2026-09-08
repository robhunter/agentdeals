import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const SERVE = "src/serve.ts";
const INVENTORY = "src/api-inventory.ts";
const INDEX = "data/index.json";
const CHANGES = "data/deal_changes.json";

const MUTANTS = [
  {
    name: "a printed example names a vendor the catalogue does not hold",
    file: INVENTORY,
    from: '{ method: "GET", path: "/api/vendor-risk/:vendor", desc: "Check vendor pricing risk", params: "", group: "product", request: "/api/vendor-risk/{vendor}" }',
    to: '{ method: "GET", path: "/api/vendor-risk/:vendor", desc: "Check vendor pricing risk", params: "", group: "product", request: "/api/vendor-risk/Heroku" }',
  },
  {
    name: "the endpoint count is written as a literal again",
    file: SERVE,
    from: "Every one of the ${apiRequestsWePublish().length} read endpoints is listed below",
    to: "Every one of the 18 read endpoints is listed below",
  },
  {
    name: "the block prints fewer endpoints than the inventory publishes",
    file: INVENTORY,
    from: "export function readableRequestLines(groups: readonly ApiGroup[], subjects: ExampleSubjects): string[] {\n  return readableEndpoints(groups)",
    to: "export function readableRequestLines(groups: readonly ApiGroup[], subjects: ExampleSubjects): string[] {\n  return readableEndpoints(groups).slice(0, 17)",
  },
  {
    name: "a served route joins neither the inventory nor the unpublished register",
    file: SERVE,
    from: '  } else if (url.pathname === "/api/stats" && isGetOrHead) {',
    to: '  } else if (url.pathname === "/api/not-in-any-inventory" && isGetOrHead) {\n    res.end();\n  } else if (url.pathname === "/api/stats" && isGetOrHead) {',
  },
  {
    name: "the credit ceiling is hardcoded in the problem statement",
    file: SERVE,
    from: "<strong>${escHtmlServer(acceleratorCreditClause(acceleratorCreditCeiling()))}</strong>",
    to: "<strong>your accelerator batch gets up to $100K in AWS credits</strong>",
  },
  {
    name: "the record states a ceiling its own check contradicts",
    file: INDEX,
    from: "Portfolio: up to $200,000 credits (VC/accelerator-backed)",
    to: "Portfolio: up to $100,000 credits (VC/accelerator-backed)",
  },
  {
    name: "a change card names a vendor without linking it",
    file: SERVE,
    from: '          <span class="change-vendor">${homepageVendorLink(c.vendor)}</span>\n          <span class="change-date">',
    to: '          <span class="change-vendor">${escHtmlServer(c.vendor)}</span>\n          <span class="change-date">',
  },
  {
    name: "the App Mesh record cites the page that omits the date",
    file: CHANGES,
    from: '"finding": "the page carries an End of support notice reading \\"On September 30, 2026, AWS will discontinue support for AWS App Mesh\\""',
    to: '"finding": "the page describes AWS App Mesh"',
  },
];

const only = process.argv[2] ? Number(process.argv[2]) : null;

for (const [i, mutant] of MUTANTS.entries()) {
  if (only !== null && only !== i) continue;
  const original = readFileSync(mutant.file, "utf8");
  if (!original.includes(mutant.from)) {
    console.log(`SKIP  ${i} ${mutant.name} — anchor not found in ${mutant.file}`);
    continue;
  }
  writeFileSync(mutant.file, original.replace(mutant.from, mutant.to));
  let killed = false;
  let output = "";
  try {
    execSync("npx tsc", { stdio: "pipe" });
    output = execSync("node --test --test-concurrency 1 test/homepage-cites-what-it-serves.test.ts", { stdio: "pipe" }).toString();
  } catch (e) {
    killed = true;
    output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  } finally {
    writeFileSync(mutant.file, original);
    execSync("npx tsc", { stdio: "pipe" });
  }
  const failing = [...output.matchAll(/^ {2}✖ (.+?) \(/gm)].map(([, name]) => name);
  console.log(`${killed ? "KILLED" : "SURVIVED"}  ${i} ${mutant.name}`);
  if (killed) console.log(`        by: ${failing.join("; ") || "(build or startup)"}`);
}
