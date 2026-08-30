import { loadOffers } from "./data.js";
import { rotateListing } from "./ranking.js";
import { toSlug } from "./vendor-slug.js";

export const CURATED_COMPARISON_PAIRS: [string, string][] = [
  ["Netlify", "Vercel"],
  ["Railway", "Render"],
  ["Cloudflare Pages", "Vercel"],
  ["Netlify", "Render"],
  ["Cloudflare Pages", "Netlify"],
  ["Firebase", "Supabase"],
  ["Neon", "Supabase"],
  ["CockroachDB", "Neon"],
  ["MongoDB", "Supabase"],
  ["CockroachDB", "MongoDB"],
  ["Datadog", "Grafana Cloud"],
  ["Bugsnag", "Sentry"],
  ["Grafana Cloud", "Sentry"],
  ["GitHub Actions", "GitLab CI"],
  ["CircleCI", "GitHub Actions"],
  ["CircleCI", "GitLab CI"],
  ["Auth0", "Clerk"],
  ["Cursor", "GitHub Copilot"],
  ["Cursor", "Windsurf"],
  ["Amazon Q Developer", "GitHub Copilot"],
  ["Cline", "Aider"],
  ["Claude Code", "Cursor"],
  ["Cursor", "Devin"],
  ["GitHub Copilot", "Windsurf"],
  ["Augment Code", "Cursor"],
  ["Bolt.new", "Lovable"],
  ["Claude Code", "OpenAI Codex"],
  ["Firebase", "Vercel"],
  ["Railway", "Supabase"],
  ["Netlify", "Railway"],
  ["Render", "Vercel"],
  ["Cloudflare Pages", "Render"],
];

export function comparisonSlug(a: string, b: string): string {
  return `${toSlug(a)}-vs-${toSlug(b)}`;
}

export function generateCategoryPairs(): [string, string][] {
  const offers = loadOffers();
  const catVendors = new Map<string, string[]>();
  for (const o of offers) {
    if (!catVendors.has(o.category)) catVendors.set(o.category, []);
    const arr = catVendors.get(o.category)!;
    if (!arr.includes(o.vendor)) arr.push(o.vendor);
  }

  const pairs: [string, string][] = [];
  for (const [category, vendors] of catVendors) {
    if (vendors.length < 3) continue;
    const topN = rotateListing(vendors, `compare-pairs:${category}`).slice(0, 4);
    let catPairCount = 0;
    for (let i = 0; i < topN.length && catPairCount < 5; i++) {
      for (let j = i + 1; j < topN.length && catPairCount < 5; j++) {
        const [a, b] = [topN[i], topN[j]].sort() as [string, string];
        pairs.push([a, b]);
        catPairCount++;
      }
    }
  }
  return pairs;
}

export function buildComparisonMap(): Map<string, [string, string]> {
  const offers = loadOffers();
  const map = new Map<string, [string, string]>();
  for (const [a, b] of CURATED_COMPARISON_PAIRS) {
    const offerA = offers.find(o => o.vendor === a);
    const offerB = offers.find(o => o.vendor === b);
    if (offerA && offerB) {
      map.set(comparisonSlug(a, b), [a, b]);
    }
  }
  for (const [a, b] of generateCategoryPairs()) {
    const slug = comparisonSlug(a, b);
    if (!map.has(slug)) {
      map.set(slug, [a, b]);
    }
  }
  return map;
}
