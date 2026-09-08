import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SUITE = [
  "test/marketplace-promise-removed.test.ts",
  "test/vendor-marketplace-solicitation.test.ts",
  "test/marketplace-dashboard.test.ts",
];

const SOLICITATION_BLOCK = '  <div class="section marketplace-solicitation"><p>Submit a referral code via the <a href="/marketplace">Agent Marketplace</a> and earn revenue when agents use it (60% commission, paid via x402).</p></div>\\n';

const MUTANTS = [
  ["the-vendor-pages-solicit-a-code-again", "src/serve.ts",
    "${watchlistCtaHtml}\n${internalLinksHtml}",
    "${watchlistCtaHtml}\n" + SOLICITATION_BLOCK + "${internalLinksHtml}"],
  ["the-vendor-referral-program-section-invites-a-submission-again", "src/serve.ts",
    '<a href="${escHtmlServer(primary.referral_program.program_url)}" rel="noopener" target="_blank">View program details &rarr;</a>\n',
    '<a href="${escHtmlServer(primary.referral_program.program_url)}" rel="noopener" target="_blank">View program details &rarr;</a><a href="/marketplace">Submit your referral code</a>\n'],
  ["the-global-nav-carries-a-marketplace-entry-again", "src/serve.ts",
    '      { href: "/developers", label: "API", section: "developers" },\n      { href: "/badges", label: "Badges", section: "badges" },',
    '      { href: "/developers", label: "API", section: "developers" },\n      { href: "/marketplace", label: "Marketplace", section: "marketplace" },\n      { href: "/badges", label: "Badges", section: "badges" },'],
  ["the-retired-route-answers-404-instead-of-redirecting", "src/serve.ts",
    '  if (url.pathname === "/marketplace" && isGetOrHead) {\n    res.writeHead(301, { Location: "/disclosure" });',
    '  if (url.pathname === "/marketplace" && false) {\n    res.writeHead(301, { Location: "/disclosure" });'],
  ["the-retired-route-redirects-to-a-page-that-does-not-exist", "src/serve.ts",
    '  if (url.pathname === "/marketplace" && isGetOrHead) {\n    res.writeHead(301, { Location: "/disclosure" });',
    '  if (url.pathname === "/marketplace" && isGetOrHead) {\n    res.writeHead(301, { Location: "/marketplace-archive" });'],
  ["the-redirect-answers-only-a-get-and-not-a-head", "src/serve.ts",
    '  if (url.pathname === "/marketplace" && isGetOrHead) {\n    res.writeHead(301, { Location: "/disclosure" });',
    '  if (url.pathname === "/marketplace" && req.method === "GET") {\n    res.writeHead(301, { Location: "/disclosure" });'],
  ["the-sitemap-advertises-the-retired-route-again", "src/serve.ts",
    "      + '  <url>\\n    <loc>' + BASE_URL + '/press</loc>",
    "      + '  <url>\\n    <loc>' + BASE_URL + '/marketplace</loc>\\n    <lastmod>2026-04-12</lastmod>\\n    <changefreq>weekly</changefreq>\\n    <priority>0.7</priority>\\n  </url>\\n'\n      + '  <url>\\n    <loc>' + BASE_URL + '/press</loc>"],
  ["the-referral-programs-table-offers-to-take-a-code-again", "src/serve.ts",
    '      : `<span class="status-badge status-none">&mdash;</span>`;',
    '      : `<a href="/marketplace" class="status-badge status-none">Submit a code</a>`;'],
  ["the-referral-programs-faq-answers-that-agents-can-earn-again", "src/serve.ts",
    '      <h3>How do I earn money from developer tool referrals?</h3>\n      <p>Sign up for a vendor\'s referral program, get your referral link, and share it. When someone signs up through your link, you earn the referrer benefit (credits, cash, or commission).</p>\n    </div>',
    '      <h3>How do I earn money from developer tool referrals?</h3>\n      <p>Sign up for a vendor\'s referral program, get your referral link, and share it. When someone signs up through your link, you earn the referrer benefit (credits, cash, or commission).</p>\n    </div>\n    <div class="faq-item">\n      <h3>Can AI agents participate in referral programs?</h3>\n      <p>Yes. Register your AI agent on our <a href="/marketplace">marketplace</a> and earn revenue share when your codes convert.</p>\n    </div>'],
  ["the-dashboard-sends-its-actions-back-to-the-retired-route", "src/serve.ts",
    '${!agent.x402_address ? \'    <a href="/developers" class="action-btn primary">Set x402 Address</a>\' : ""}',
    '${!agent.x402_address ? \'    <a href="/marketplace#getting-started" class="action-btn primary">Set x402 Address</a>\' : ""}'],
  ["the-api-documentation-links-the-retired-route-again", "src/serve.ts",
    '+ "    <p><strong>Platform codes</strong> (ours) take priority over <strong>agent-submitted codes</strong> (community) in every response. The <a href=\\"/disclosure\\">affiliate disclosure</a> lists the codes we hold;',
    '+ "    <p><strong>Platform codes</strong> (ours) take priority over <strong>agent-submitted codes</strong> (community) in every response. The <a href=\\"/marketplace\\">marketplace page</a> lists the codes we hold;'],
  ["the-code-listing-cites-the-retired-route-again", "src/serve.ts",
    'const REFERRAL_CODE_LISTING_PAGE = "/disclosure";',
    'const REFERRAL_CODE_LISTING_PAGE = "/marketplace";'],
  ["the-referral-link-we-earn-on-stops-rendering", "src/serve.ts",
    "  const ourLink = ourReferralLinkFor(vendorName, primary);",
    "  const ourLink = null as ReturnType<typeof ourReferralLinkFor>;"],
  ["the-vendors-own-referral-program-section-stops-rendering", "src/serve.ts",
    "  const referralProgramHtml = primary.referral_program?.available ? `",
    "  const referralProgramHtml = primary.referral_program?.available && vendorName.length < 0 ? `"],
  ["the-code-we-earn-on-stops-resolving", "src/platform-codes.ts",
    "export function getPlatformCodeForVendor(vendorName: string): PlatformCode | null {\n  const codes = loadPlatformCodes();",
    "export function getPlatformCodeForVendor(vendorName: string): PlatformCode | null {\n  const codes = loadPlatformCodes().filter(() => false);"],
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
