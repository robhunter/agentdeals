import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = ["test/conditional-request.test.ts", "test/page-lastmod.test.ts"];
const VALIDATOR = "src/conditional-request.ts";
const SERVER = "src/serve.ts";

const MUTANTS = [
  ["the-tag-fingerprints-the-route-rather-than-the-body", VALIDATOR,
    "  return `\"${createHash(\"sha256\").update(body).digest(\"hex\").slice(0, 16)}\"`;",
    "  return `\"${createHash(\"sha256\").update(body.slice(0, 64)).digest(\"hex\").slice(0, 16)}\"`;"],

  ["the-tag-is-a-constant", VALIDATOR,
    "  return `\"${createHash(\"sha256\").update(body).digest(\"hex\").slice(0, 16)}\"`;",
    "  return `\"0123456789abcdef\"`;"],

  ["the-tag-is-served-unquoted", VALIDATOR,
    "  return `\"${createHash(\"sha256\").update(body).digest(\"hex\").slice(0, 16)}\"`;",
    "  return createHash(\"sha256\").update(body).digest(\"hex\").slice(0, 16);"],

  ["a-weakened-tag-is-compared-verbatim", VALIDATOR,
    "  return tag.startsWith(\"W/\") ? tag.slice(2) : tag;",
    "  return tag;"],

  ["only-the-first-tag-a-client-offers-is-read", VALIDATOR,
    "  return value.split(\",\").map(tag => tag.trim()).filter(tag => tag.length > 0);",
    "  return [value.trim()].filter(tag => tag.length > 0);"],

  ["a-header-sent-twice-is-read-as-a-tag", VALIDATOR,
    "  if (typeof value !== \"string\") return [];",
    "  if (Array.isArray(value)) return value;\n  if (typeof value !== \"string\") return [];"],

  ["a-write-revalidates", VALIDATOR,
    "  if (request.method !== \"GET\" && request.method !== \"HEAD\") return false;\n  if (!served) return false;",
    "  if (!served) return false;"],

  ["a-page-with-no-tag-answers-not-modified", VALIDATOR,
    "  if (!served) return false;\n  const asked = parseEntityTags(request.ifNoneMatch);",
    "  if (!served) return true;\n  const asked = parseEntityTags(request.ifNoneMatch);"],

  ["a-client-asking-nothing-answers-not-modified", VALIDATOR,
    "  if (asked.length === 0) return false;",
    "  if (asked.length === 0) return true;"],

  ["the-wildcard-is-read-as-an-ordinary-tag", VALIDATOR,
    "  if (asked.includes(\"*\")) return true;\n",
    ""],

  ["any-tag-a-client-offers-matches", VALIDATOR,
    "  return asked.some(tag => withoutWeakness(tag) === withoutWeakness(served));",
    "  return asked.length > 0;"],

  ["only-a-tag-offered-first-matches", VALIDATOR,
    "  return asked.some(tag => withoutWeakness(tag) === withoutWeakness(served));",
    "  return withoutWeakness(asked[0]!) === withoutWeakness(served);"],

  ["no-page-is-tagged", SERVER,
    "    if (status === 200 && !headOfServedBody && /^text\\/html/.test(servedContentType)) {",
    "    if (false && status === 200 && !headOfServedBody && /^text\\/html/.test(servedContentType)) {"],

  ["every-response-is-tagged-including-the-ones-that-are-not-pages", SERVER,
    "    if (status === 200 && !headOfServedBody && /^text\\/html/.test(servedContentType)) {",
    "    if (status === 200 && !headOfServedBody) {"],

  ["the-tag-is-taken-before-the-page-is-finished", SERVER,
    "    if (typeof args[0] === \"string\" && /^text\\/html/.test(servedContentType)) {\n      args[0] = withLedeBeforeNav(withPageFreshness(args[0], url.pathname));\n    }\n    if (headOfServedBody) {\n      const head = headOfServedBody;\n      headOfServedBody = null;\n      const tag = typeof args[0] === \"string\" ? entityTag(args[0]) : null;",
    "    const beforeTheTransform = args[0];\n    if (typeof args[0] === \"string\" && /^text\\/html/.test(servedContentType)) {\n      args[0] = withLedeBeforeNav(withPageFreshness(args[0], url.pathname));\n    }\n    if (headOfServedBody) {\n      const head = headOfServedBody;\n      headOfServedBody = null;\n      const tag = typeof beforeTheTransform === \"string\" ? entityTag(beforeTheTransform) : null;"],

  ["the-tag-is-never-compared-so-nothing-revalidates", SERVER,
    "      if (tag && matchesEntityTag(revalidation, tag)) {",
    "      if (false && tag && matchesEntityTag(revalidation, tag)) {"],

  ["the-tag-is-never-sent-so-nothing-can-hold-it", SERVER,
    "      if (tag) res.setHeader(\"ETag\", tag);",
    "      if (tag) res.removeHeader(\"ETag\");"],

  ["the-revalidation-drops-the-validator-the-client-must-keep", SERVER,
    "        rawWriteHead(304 as never, { ...revalidationHeaders(head.headers), ETag: tag } as never);",
    "        rawWriteHead(304 as never, revalidationHeaders(head.headers) as never);"],

  ["the-revalidation-is-answered-with-an-empty-200", SERVER,
    "        rawWriteHead(304 as never, { ...revalidationHeaders(head.headers), ETag: tag } as never);",
    "        rawWriteHead(200 as never, { ...revalidationHeaders(head.headers), ETag: tag } as never);"],

  ["a-day-a-page-never-read-off-its-body-revalidates-it", SERVER,
    "    if (status === 200 && isNotModified(revalidation, revalidationDayHeader(url.pathname, url.search))) {",
    "    if (status === 200 && isNotModified(revalidation, pageLastmodHeader(url.pathname, url.search))) {"],
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
const skipped = [];
for (const [name, file, from, to] of MUTANTS) {
  const original = readFileSync(file, "utf-8");
  if (!original.includes(from)) {
    console.log(`SKIP  ${name} — the line it mutates is not in ${file}`);
    skipped.push(name);
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
const killed = MUTANTS.length - survivors.length - uncompiled.length - skipped.length;
console.log(`\n${killed}/${MUTANTS.length} killed`);
if (survivors.length > 0) console.log("survivors:", survivors.join(", "));
if (uncompiled.length > 0) console.log("did not compile:", uncompiled.join(", "));
if (skipped.length > 0) console.log("skipped — target string moved, so these scored nothing:", skipped.join(", "));
