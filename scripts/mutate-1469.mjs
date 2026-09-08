import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/change-row-citation.test.ts",
  "test/documented-route-citation.test.ts",
];

const MUTANTS = [
  ["the-generator-renders-the-summary-and-drops-the-citation", "src/change-citation.ts",
    "  return `${esc(shown)} ${changeCitationHtml(change, esc)}`;",
    "  return esc(shown);"],
  ["the-generator-stops-stating-that-we-hold-no-source", "src/change-citation.ts",
    "export function changeCitationHtml(change: CitableChangeRow, esc: (text: string) => string): string {\n  return changeCitesASource(change)\n    ? changeSourceLinkHtml(change, esc)\n    : uncitedChangeNoticeHtml(change.vendor, esc);",
    "export function changeCitationHtml(change: CitableChangeRow, esc: (text: string) => string): string {\n  return changeCitesASource(change)\n    ? changeSourceLinkHtml(change, esc)\n    : \"\";"],
  ["a-compact-claim-keeps-its-label-and-loses-its-source", "src/change-citation.ts",
    "    ? `<a href=\"${esc(change.source_url!.trim())}\" target=\"_blank\" rel=\"${CITATION_REL}\"` +\n        ` class=\"${CITATION_CLASS}\" style=\"${style}\" title=\"${tip}\">${esc(label)}</a>`",
    "    ? `<span style=\"${style}\" title=\"${esc(change.summary)}\">${esc(label)}</span>`"],
  ["the-stability-cell-tooltip-quotes-a-record-with-no-source", "src/serve.ts",
    "    : ` title=\"${escHtmlServer(`${changeDateLabel(cause)} — ${changeSummaryText(cause)}`)}\"`;",
    "    : ` title=\"${escHtmlServer(`${changeDateLabel(cause)} — ${cause.summary}`)}\"`;"],
  ["the-provenance-walker-counts-a-projected-cause-as-its-own-record", "src/provenance.ts",
    "const PROJECTED_ONTO_ITS_OWNER: readonly string[] = [\"risk_cause\"];",
    "const PROJECTED_ONTO_ITS_OWNER: readonly string[] = [];"],
  ["the-expiring-page-renders-a-bare-summary-again", "src/serve.ts",
    "          <div class=\"exp-summary\">${changeSummaryHtml(c, escHtmlServer)}</div>",
    "          <div class=\"exp-summary\">${escHtmlServer(c.summary)}</div>"],
  ["the-comparison-page-change-tables-render-a-bare-summary-again", "src/serve.ts",
    "      <td style=\"font-size:.85rem\">${changeSummaryHtml(c, escHtmlServer)}</td>\n      <td><span style=\"color:${changeImpactColor(c.impact)};font-size:.8rem;font-weight:600\">${escHtmlServer(changeImpactLabel(c.impact))}</span></td>",
    "      <td style=\"font-size:.85rem\">${escHtmlServer(c.summary)}</td>\n      <td><span style=\"color:${changeImpactColor(c.impact)};font-size:.8rem;font-weight:600\">${escHtmlServer(changeImpactLabel(c.impact))}</span></td>"],
  ["the-risk-cause-projection-drops-the-source-it-was-read-from", "src/data.ts",
    "    source_url: cause.source_url?.trim() ? cause.source_url.trim() : null,",
    "    source_url: null,"],
  ["the-vendor-history-sentence-quotes-a-record-without-its-source", "src/vendor-history.ts",
    "    return `${vendor} warrants caution — ${changeDateClause(cause)}: ${changeSummaryText(cause)} Monitor for further changes.`;",
    "    return `${vendor} warrants caution — ${changeDateClause(cause)}: ${cause.summary} Monitor for further changes.`;"],
  ["the-per-change-feed-stops-carrying-the-source-of-an-entry", "src/serve.ts",
    "${feedEntrySourceXml(c, escXml, ns)}\n    <summary>${escXml(fields.summary)}</summary>",
    "    <summary>${escXml(fields.summary)}</summary>"],
  ["the-feed-omits-the-element-instead-of-saying-we-hold-no-source", "src/change-feed.ts",
    "    : `${indent}<${ns}:${NO_SOURCE_HELD_ELEMENT}>${NO_SOURCE_HELD_VALUE}</${ns}:${NO_SOURCE_HELD_ELEMENT}>`;",
    "    : \"\";"],
  ["the-weekly-digest-lists-one-source-and-calls-it-the-set", "src/change-feed.ts",
    "  return sources.map((url) => `${indent}<link href=\"${esc(url)}\" rel=\"${VIA_LINK_REL}\"/>`).join(\"\\n\");",
    "  return `${indent}<link href=\"${esc(sources[0])}\" rel=\"${VIA_LINK_REL}\"/>`;"],
  ["the-digest-html-lists-a-change-with-no-link-to-its-page", "src/data.ts",
    "    return `<li><strong>${escHtml(c.vendor)}</strong> (${escHtml(c.category)}): ${changeSummaryHtml(c, escHtml)}</li>`;",
    "    return `<li><strong>${escHtml(c.vendor)}</strong> (${escHtml(c.category)}): ${escHtml(c.summary)}</li>`;"],
  ["the-compiled-card-says-what-our-record-says-and-not-where", "src/compiled-figures.ts",
    "    ? `Our own pricing change record, ${options.esc(recordDateClause(ending))}, says: ` +\n      changeSummaryHtml(ending, options.esc)",
    "    ? `Our own pricing change record, ${options.esc(recordDateClause(ending))}, says: ${options.esc(ending.summary)}`"],
  ["the-changed-since-badge-quotes-a-record-with-no-source", "src/compiled-figures.ts",
    "    `after this table was compiled on ${options.compiledOn}. The most recent, ${recordDateClause(latest)}: ` +\n    changeSummaryText(latest);",
    "    `after this table was compiled on ${options.compiledOn}. The most recent, ${recordDateClause(latest)}: ${latest.summary}`;"],
  ["a-withdrawal-demerit-states-the-record-without-its-source", "src/ranking.ts",
    "      reason: `Recorded ${withdrawal.label} on ${withdrawal.change.date}: ${changeSummaryText(withdrawal.change)}`,",
    "      reason: `Recorded ${withdrawal.label} on ${withdrawal.change.date}: ${withdrawal.change.summary}`,"],
  ["the-superseded-terms-answer-quotes-the-record-bare", "src/superseded-description.ts",
    "  return `${opening} What our record says changed: ${changeSummaryText({ ...change, vendor })}`;",
    "  return `${opening} What our record says changed: ${change.summary}`;"],
  ["the-erosion-cards-restate-a-record-with-no-link-to-it", "src/serve.ts",
    "${escHtmlServer(e.detail)} ${recordBehindEntryCitation(e)}</p>",
    "${escHtmlServer(e.detail)}</p>"],
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
