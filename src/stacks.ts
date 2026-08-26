import { searchOffers, loadDealChanges, vendorRiskLevel, classifyStability } from "./data.js";
import { rankOffers, utcDate, CRITERIA_PATH, DEMOTE_ONLY_POLICY, NOT_MODELLED_NOTICE } from "./ranking.js";
import type { Demerit, Disclosure, TieBreak } from "./ranking.js";
import type { Offer, StabilityClass, DealChange } from "./types.js";
import { partitionRoleCandidates, MEMBERSHIP_GATE_RULES } from "./product-role.js";

/**
 * plan_stack no longer answers "what should I use".
 *
 * It used to: a hand-written TEMPLATES table listed preferred vendors per role
 * and `findBestOffer()` returned the first one present in the catalog, so
 * Supabase won every database slot in every template because someone typed it
 * first. The fallback when no preferred vendor matched was `publicOffers[0]` —
 * index order in the JSON file.
 *
 * Deleting the preference list on its own made the answer worse, not better:
 * scored purely on offer terms, a Next.js SaaS app got Chroma (a vector store)
 * as its database and Integrately (an automation tool) as its hosting. The
 * templates were carrying real technical fit that our category taxonomy cannot
 * express, and no amount of ranking recovers it.
 *
 * So the question changed instead. Our caller is a language model that already
 * knows Chroma is a vector store; that knowledge is free and abundant and we
 * add nothing by supplying it. What it cannot get anywhere else is that a given
 * free tier was withdrawn in March, or that nobody has been able to confirm
 * this one for 142 days. This tool now answers: *of the things that can fill
 * this role, which ones have terms we can stand behind today, and what exactly
 * is wrong with the rest.* The caller applies fit; we apply terms.
 */

export interface StackCandidate {
  vendor: string;
  tier: string;
  description: string;
  url: string;
  verified_date: string;
  risk_level: "stable" | "caution" | "risky";
  stability: StabilityClass;
  /** Empty for a candidate we hold nothing against. */
  demerits: Demerit[];
  /** Recorded facts shown wherever the offer appears; they never move rank. */
  disclosures: Disclosure[];
}

export interface StackRole {
  role: string;
  category: string;
  /** The rotated tied set, capped. Deliberately not a single pick. */
  candidates: StackCandidate[];
  /** How many offers tie at zero demerits — the size of the band we drew from. */
  tie_count: number;
  eligible_count: number;
  demoted_count: number;
  excluded_count: number;
  /** Why these, in words, with the numbers behind it. */
  reason: string;
  tie_break: TieBreak;
}

export interface StackRecommendation {
  use_case: string;
  stack: StackRole[];
  total_monthly_cost: string;
  limitations: string[];
  upgrade_path: string;
  risk_warnings: string[];
  method: {
    policy: string;
    not_modelled: string;
    criteria_url: string;
  };
}

/** How many of a tied band to return per role. A page size, not a ranking. */
const CANDIDATES_PER_ROLE = 8;

interface StackTemplate {
  keywords: string[];
  roles: { role: string; category: string }[];
  upgrade_path: string;
}

/**
 * Templates define roles and the category each role draws from. They no longer
 * name winners: `preferredVendors` is deleted rather than repointed, because
 * retyping the fiat is not the fix. The upgrade-path strings lost their vendor
 * names for the same reason — they were naming the same hardcoded winners in
 * prose.
 */
const TEMPLATES: StackTemplate[] = [
  {
    keywords: ["saas", "web app", "webapp", "next.js", "nextjs", "react app", "full-stack", "fullstack"],
    roles: [
      { role: "Hosting", category: "Cloud Hosting" },
      { role: "Database", category: "Databases" },
      { role: "Auth", category: "Auth" },
      { role: "Email", category: "Email" },
    ],
    upgrade_path: "Paid hosting and a managed database typically start around $20-25/mo each for production workloads",
  },
  {
    keywords: ["api", "backend", "server", "express", "fastapi", "python api", "node api", "rest api"],
    roles: [
      { role: "Hosting", category: "Cloud Hosting" },
      { role: "Database", category: "Databases" },
      { role: "Monitoring", category: "Monitoring" },
      { role: "Logging", category: "Logging" },
    ],
    upgrade_path: "Expect roughly $5-20/mo for hosting plus a managed database once you outgrow a free tier",
  },
  {
    keywords: ["static", "blog", "landing page", "portfolio", "docs", "documentation", "jamstack"],
    roles: [
      { role: "Hosting", category: "CDN" },
      { role: "DNS", category: "DNS & Domain Management" },
      { role: "CI/CD", category: "CI/CD" },
    ],
    upgrade_path: "Most static hosting free tiers are generous enough for production",
  },
  {
    keywords: ["mobile", "ios", "android", "react native", "flutter", "mobile app"],
    roles: [
      { role: "Backend", category: "Cloud Hosting" },
      { role: "Database", category: "Databases" },
      { role: "Auth", category: "Auth" },
      { role: "Push Notifications", category: "Communication" },
    ],
    upgrade_path: "Backend-as-a-service paid tiers generally start around $25/mo for production",
  },
  {
    keywords: ["ai", "ml", "machine learning", "llm", "chatbot", "ai app", "ai agent"],
    roles: [
      { role: "AI/ML", category: "AI / ML" },
      { role: "Hosting", category: "Cloud Hosting" },
      { role: "Database", category: "Databases" },
    ],
    upgrade_path: "AI API costs scale with usage; budget $20-50/mo for moderate LLM traffic",
  },
  {
    keywords: ["ecommerce", "e-commerce", "store", "shop", "marketplace"],
    roles: [
      { role: "Hosting", category: "Cloud Hosting" },
      { role: "Database", category: "Databases" },
      { role: "Payments", category: "Payments" },
      { role: "Auth", category: "Auth" },
      { role: "Email", category: "Email" },
    ],
    upgrade_path: "Payment processing is per-transaction; hosting and a database run about $45/mo for production",
  },
  {
    keywords: ["devops", "infrastructure", "platform", "internal tool"],
    roles: [
      { role: "CI/CD", category: "CI/CD" },
      { role: "Container Registry", category: "Container Registry" },
      { role: "Monitoring", category: "Monitoring" },
      { role: "Error Tracking", category: "Error Tracking" },
    ],
    upgrade_path: "Per-seat pricing dominates here once a team grows past the free seat count",
  },
];

const ROLE_TO_CATEGORY: Record<string, string> = {
  hosting: "Cloud Hosting",
  database: "Databases",
  db: "Databases",
  auth: "Auth",
  authentication: "Auth",
  email: "Email",
  cdn: "CDN",
  "ci/cd": "CI/CD",
  cicd: "CI/CD",
  ci: "CI/CD",
  monitoring: "Monitoring",
  logging: "Logging",
  search: "Search",
  storage: "Storage",
  analytics: "Analytics",
  payments: "Payments",
  "error tracking": "Error Tracking",
  security: "Security",
  "feature flags": "Feature Flags",
  testing: "Testing",
  "ai/ml": "AI / ML",
  ai: "AI / ML",
  ml: "AI / ML",
  dns: "DNS & Domain Management",
  cms: "Headless CMS",
  messaging: "Messaging",
  push: "Communication",
};

function matchTemplate(useCase: string): StackTemplate | null {
  const lower = useCase.toLowerCase();
  let bestMatch: StackTemplate | null = null;
  let bestScore = 0;

  for (const template of TEMPLATES) {
    let score = 0;
    for (const keyword of template.keywords) {
      if (lower.includes(keyword)) {
        score += keyword.length; // Longer keyword matches are more specific
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = template;
    }
  }

  return bestMatch;
}

function buildLimitations(roles: StackRole[]): string[] {
  const limitations = new Set<string>();
  for (const role of roles) {
    for (const c of role.candidates) {
      const desc = c.description.toLowerCase();
      if (desc.includes("hobby") || desc.includes("non-commercial")) {
        limitations.add(`${c.vendor} free tier may restrict commercial use`);
      }
      if (desc.includes("pause") || desc.includes("sleep") || desc.includes("inactive")) {
        limitations.add(`${c.vendor} may pause after inactivity`);
      }
    }
  }
  if (limitations.size === 0) {
    limitations.add("Free tiers have usage limits — check vendor pricing pages for details");
  }
  return [...limitations];
}

/**
 * Warnings describe the candidates we are actually showing, and each cites the
 * recorded fact behind it rather than a derived risk bucket.
 */
function buildRiskWarnings(roles: StackRole[]): string[] {
  const warnings: string[] = [];
  for (const role of roles) {
    for (const c of role.candidates) {
      for (const d of c.demerits) {
        warnings.push(`${c.vendor} (${role.role}): ${d.reason}`);
      }
      for (const disclosure of c.disclosures) {
        warnings.push(`${c.vendor} (${role.role}): ${disclosure.date} — ${disclosure.summary} (recorded; does not affect rank)`);
      }
    }
  }
  return warnings;
}

function toCandidate(
  offer: Offer,
  demerits: Demerit[],
  disclosures: Disclosure[],
  vendorChanges: DealChange[],
): StackCandidate {
  return {
    vendor: offer.vendor,
    tier: offer.tier,
    description: offer.description.length > 200 ? offer.description.slice(0, 197) + "..." : offer.description,
    url: offer.url,
    verified_date: offer.verifiedDate,
    risk_level: vendorRiskLevel(vendorChanges),
    stability: classifyStability(vendorChanges),
    demerits,
    disclosures,
  };
}

export function getStackRecommendation(
  useCase: string,
  requirements?: string[],
  date: string = utcDate(),
): StackRecommendation {
  let roleSpecs: { role: string; category: string }[];
  let upgradePath: string;

  if (requirements && requirements.length > 0) {
    // User-specified requirements override the template
    roleSpecs = requirements.map((req) => {
      const lower = req.toLowerCase();
      const category = ROLE_TO_CATEGORY[lower] ?? req;
      return { role: req.charAt(0).toUpperCase() + req.slice(1), category };
    });
    upgradePath = "Check individual vendor pricing pages for upgrade options";
  } else {
    const template = matchTemplate(useCase);
    if (template) {
      roleSpecs = template.roles;
      upgradePath = template.upgrade_path;
    } else {
      // Fallback: common categories
      roleSpecs = [
        { role: "Hosting", category: "Cloud Hosting" },
        { role: "Database", category: "Databases" },
        { role: "Auth", category: "Auth" },
        { role: "CI/CD", category: "CI/CD" },
      ];
      upgradePath = "Check individual vendor pricing pages for upgrade options";
    }
  }

  const allChanges = loadDealChanges();
  const changesByVendor = new Map<string, DealChange[]>();
  for (const c of allChanges) {
    const key = c.vendor.toLowerCase();
    const list = changesByVendor.get(key) ?? [];
    list.push(c);
    changesByVendor.set(key, list);
  }

  const stack: StackRole[] = [];
  for (const { role, category } of roleSpecs) {
    const roleMembership = partitionRoleCandidates(searchOffers(undefined, category));
    const categoryOffers = roleMembership.kept;
    if (categoryOffers.length === 0) continue;

    const ranking = rankOffers(categoryOffers, {
      queryKey: `stack:${useCase}:${role}`,
      changes: allChanges,
      date,
    });

    // Draw from the best band available. If nothing is unblemished we still
    // answer, with the demerits attached rather than hidden.
    const shown = ranking.ranked.slice(0, CANDIDATES_PER_ROLE);
    if (shown.length === 0) continue;

    const candidates = shown.map((e) =>
      toCandidate(e.offer, e.demerits, e.disclosures, changesByVendor.get(e.offer.vendor.toLowerCase()) ?? []),
    );

    const tieCount = ranking.qualified.length;
    const roleMembershipNote = roleMembership.removed.length > 0
      ? ` ${roleMembership.removed.map((r) => `${r.offer.vendor} (${MEMBERSHIP_GATE_RULES[r.gate].label.toLowerCase()})`).join(", ")} ${roleMembership.removed.length === 1 ? "is" : "are"} listed in ${category} but cannot fill this role, so ${roleMembership.removed.length === 1 ? "it is" : "they are"} not a candidate here.`
      : "";
    const reason = (tieCount > 0
      ? `${tieCount} of ${ranking.ranked.length} ${category} offers carry no recorded demerit and are indistinguishable under every signal we hold; ${candidates.length} shown, in an order seeded on ${date} and the query key. ${ranking.demoted.length} demoted with a named reason, ${ranking.excluded.length} excluded by the gates.`
      : `No ${category} offer is free of recorded demerits today. Showing the least demoted, each with its reason attached. ${ranking.excluded.length} excluded by the gates.`) + roleMembershipNote;

    stack.push({
      role,
      category,
      candidates,
      tie_count: tieCount,
      eligible_count: ranking.ranked.length,
      demoted_count: ranking.demoted.length,
      excluded_count: ranking.excluded.length,
      reason,
      tie_break: ranking.tie_break,
    });
  }

  return {
    use_case: useCase,
    stack,
    total_monthly_cost: "$0",
    limitations: buildLimitations(stack),
    upgrade_path: upgradePath,
    risk_warnings: buildRiskWarnings(stack),
    method: {
      policy: DEMOTE_ONLY_POLICY,
      not_modelled: NOT_MODELLED_NOTICE,
      criteria_url: CRITERIA_PATH,
    },
  };
}
