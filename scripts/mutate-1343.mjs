import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/page-lede.test.ts",
];

const MUTANTS = [
  ["no-page-is-given-a-lede", "src/page-lede.ts",
    `  const headAt = html.indexOf(PAGE_HEAD_OPEN);
  if (headAt === -1) return html;`,
    `  const headAt = html.indexOf(PAGE_HEAD_OPEN);
  if (headAt === -1 || headAt !== -1) return html;`],
  ["lede-is-placed-after-the-menu", "src/page-lede.ts",
    `  return html.slice(0, insertAt)
    + PAGE_CLAIM_OPEN + description + PAGE_CLAIM_CLOSE
    + html.slice(insertAt);`,
    `  const closeAt = html.indexOf("</div>", insertAt);
  return html.slice(0, closeAt)
    + PAGE_CLAIM_OPEN + description + PAGE_CLAIM_CLOSE
    + html.slice(closeAt);`],
  ["lede-is-read-from-the-title", "src/page-lede.ts",
    `  return html.match(/<meta name="description" content="([^"]*)"/i)?.[1] ?? "";`,
    `  return html.match(/<title>([^<]*)<\\/title>/i)?.[1] ?? "";`],
  ["lede-is-read-from-any-tag-that-has-content", "src/page-lede.ts",
    `  return html.match(/<meta name="description" content="([^"]*)"/i)?.[1] ?? "";`,
    `  return html.match(/content="([^"]*)"/i)?.[1] ?? "";`],
  ["lede-is-clipped-to-the-width-of-a-search-result", "src/page-lede.ts",
    `    + PAGE_CLAIM_OPEN + description + PAGE_CLAIM_CLOSE`,
    `    + PAGE_CLAIM_OPEN + description.slice(0, 80) + PAGE_CLAIM_CLOSE`],
  ["lede-is-escaped-a-second-time", "src/page-lede.ts",
    `    + PAGE_CLAIM_OPEN + description + PAGE_CLAIM_CLOSE`,
    `    + PAGE_CLAIM_OPEN + description.replace(/&/g, "&amp;") + PAGE_CLAIM_CLOSE`],
  ["a-page-that-already-states-its-claim-is-given-a-second-one", "src/page-lede.ts",
    `  if (html.startsWith(PAGE_CLAIM_OPEN, insertAt)) return html;`,
    ``],
  ["a-page-with-no-description-states-an-empty-claim", "src/page-lede.ts",
    `  if (!description.trim()) return html;`,
    ``],
  ["the-menu-is-not-wrapped-for-a-lede", "src/serve.ts",
    `  return PAGE_HEAD_OPEN + nav + '</div>' + '<script>' + globalNavJs() + '</script>';`,
    `  return nav + '<script>' + globalNavJs() + '</script>';`],
  ["html-responses-are-served-without-a-lede", "src/serve.ts",
    `    if (typeof args[0] === "string" && /^text\\/html/.test(servedContentType)) {`,
    `    if (typeof args[0] === "string" && /^application\\/json/.test(servedContentType)) {`],
  ["the-served-content-type-is-never-recorded", "src/serve.ts",
    `    servedContentType = String(
      headers?.["Content-Type"] ?? headers?.["content-type"] ?? res.getHeader("Content-Type") ?? "",
    );`,
    `    servedContentType = String(
      headers?.["Content-Type"] ?? headers?.["content-type"] ?? "",
    );
    servedContentType = "";`],
];

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

const survivors = [];
const uncompiled = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    continue;
  }
  writeFileSync(file, original.replace(from, to));
  const built = run("npm", ["run", "build"]);
  const green = built && run("node", ["--test", "--test-concurrency", "1", ...SUITE]);
  writeFileSync(file, original);
  if (!built) uncompiled.push(name);
  console.log(`${green ? "SURVIVED" : built ? "killed  " : "DID NOT COMPILE"}  ${name}`);
  if (green) survivors.push(name);
}
run("npm", ["run", "build"]);
console.log(`\n${MUTANTS.length - survivors.length - uncompiled.length}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
