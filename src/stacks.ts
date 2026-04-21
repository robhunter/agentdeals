import { searchOffers, loadDealChanges, vendorRiskLevel, classifyStability } from "./data.js";
import type { Offer, StabilityClass, DealChange } from "./types.js";

export interface StackComponent {
  role: string;
  vendor: string;
  tier: string;
  description: string;
  url: string;
  risk_level: "stable" | "caution" | "risky";
  stability: StabilityClass;
}

export interface StackRecommendation {
  use_case: string;
  stack: StackComponent[];
  total_monthly_cost: string;
  limitations: string[];
  upgrade_path: string;
  risk_warnings: string[];
}

interface StackTemplate {
  keywords: string[];
  roles: { role: string; category: string; preferredVendors?: string[] }[];
  upgrade_path: string;
}

const TEMPLATES: StackTemplate[] = [
  {
    keywords: ["saas", "web app", "webapp", "next.js", "nextjs", "react app", "full-stack", "fullstack"],
    roles: [
      { role: "Hosting", category: "Cloud Hosting", preferredVendors: ["Vercel", "Netlify", "Railway"] },
      { role: "Database", category: "Databases", preferredVendors: ["Supabase", "Neon", "PlanetScale"] },
      { role: "Auth", category: "Auth", preferredVendors: ["Clerk", "Auth0", "Supabase"] },
      { role: "Email", category: "Email", preferredVendors: ["Resend", "SendGrid", "Mailgun"] },
    ],
    upgrade_path: "Vercel Pro ($20/mo) + Supabase Pro ($25/mo) for production workloads",
  },
  {
    keywords: ["api", "backend", "server", "express", "fastapi", "python api", "node api", "rest api"],
    roles: [
      { role: "Hosting", category: "Cloud Hosting", preferredVendors: ["Railway", "Render", "Fly.io"] },
      { role: "Database", category: "Databases", preferredVendors: ["Supabase", "Neon", "CockroachDB"] },
      { role: "Monitoring", category: "Monitoring", preferredVendors: ["Grafana Cloud", "Betterstack", "Checkly"] },
      { role: "Logging", category: "Logging", preferredVendors: ["Betterstack", "Logflare", "Axiom"] },
    ],
    upgrade_path: "Railway Starter ($5/mo) + managed database for production traffic",
  },
  {
    keywords: ["static", "blog", "landing page", "portfolio", "docs", "documentation", "jamstack"],
    roles: [
      { role: "Hosting", category: "CDN", preferredVendors: ["Cloudflare Pages", "Netlify", "Vercel"] },
      { role: "DNS", category: "DNS & Domain Management", preferredVendors: ["Cloudflare", "Namecheap"] },
      { role: "CI/CD", category: "CI/CD", preferredVendors: ["GitHub Actions", "Cloudflare Pages", "Netlify"] },
    ],
    upgrade_path: "Most static hosting free tiers are generous enough for production",
  },
  {
    keywords: ["mobile", "ios", "android", "react native", "flutter", "mobile app"],
    roles: [
      { role: "Backend", category: "Cloud Hosting", preferredVendors: ["Supabase", "Firebase", "Railway"] },
      { role: "Database", category: "Databases", preferredVendors: ["Supabase", "Firebase", "MongoDB Atlas"] },
      { role: "Auth", category: "Auth", preferredVendors: ["Firebase", "Supabase", "Auth0"] },
      { role: "Push Notifications", category: "Communication", preferredVendors: ["Firebase", "OneSignal"] },
    ],
    upgrade_path: "Firebase Blaze (pay-as-you-go) or Supabase Pro ($25/mo) for production",
  },
  {
    keywords: ["ai", "ml", "machine learning", "llm", "chatbot", "ai app", "ai agent"],
    roles: [
      { role: "AI/ML", category: "AI / ML", preferredVendors: ["OpenAI", "Google Gemini API", "Anthropic", "Groq"] },
      { role: "Hosting", category: "Cloud Hosting", preferredVendors: ["Railway", "Render", "Fly.io"] },
      { role: "Database", category: "Databases", preferredVendors: ["Supabase", "Neon", "Upstash"] },
    ],
    upgrade_path: "AI API costs scale with usage; budget $20-50/mo for moderate LLM traffic",
  },
  {
    keywords: ["ecommerce", "e-commerce", "store", "shop", "marketplace"],
    roles: [
      { role: "Hosting", category: "Cloud Hosting", preferredVendors: ["Vercel", "Netlify", "Railway"] },
      { role: "Database", category: "Databases", preferredVendors: ["Supabase", "PlanetScale", "Neon"] },
      { role: "Payments", category: "Payments", preferredVendors: ["Stripe", "LemonSqueezy"] },
      { role: "Auth", category: "Auth", preferredVendors: ["Clerk", "Auth0", "Supabase"] },
      { role: "Email", category: "Email", preferredVendors: ["Resend", "SendGrid"] },
    ],
    upgrade_path: "Stripe fees are per-transaction (2.9% + $0.30); hosting/DB ~$45/mo for production",
  },
  {
    keywords: ["devops", "infrastructure", "platform", "internal tool"],
    roles: [
      { role: "CI/CD", category: "CI/CD", preferredVendors: ["GitHub Actions", "GitLab CI", "CircleCI"] },
      { role: "Container Registry", category: "Container Registry", preferredVendors: ["GitHub Container Registry", "Docker Hub"] },
      { role: "Monitoring", category: "Monitoring", preferredVendors: ["Grafana Cloud", "Betterstack", "UptimeRobot"] },
      { role: "Error Tracking", category: "Error Tracking", preferredVendors: ["Sentry", "GlitchTip"] },
    ],
    upgrade_path: "GitHub Team ($4/user/mo) + Grafana Cloud Pro for larger teams",
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

function findBestOffer(category: string, preferredVendors?: string[]): Offer | null {
  const offers = searchOffers(undefined, category);
  // Only consider public/free offers
  const publicOffers = offers.filter(
    (o) => o.tier === "Free" || o.tier === "Hobby" || o.tier === "Open Source" || o.tier === "Free Credits"
  );
  if (publicOffers.length === 0) return offers[0] ?? null;

  // Try preferred vendors first
  if (preferredVendors) {
    for (const vendor of preferredVendors) {
      const match = publicOffers.find(
        (o) => o.vendor.toLowerCase() === vendor.toLowerCase()
      );
      if (match) return match;
    }
  }

  // Fall back to first public free-tier offer
  return publicOffers[0];
}

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

function buildLimitations(stack: StackComponent[]): string[] {
  const limitations: string[] = [];
  for (const component of stack) {
    // Extract key limitations from description
    const desc = component.description.toLowerCase();
    if (desc.includes("hobby") || desc.includes("non-commercial")) {
      limitations.push(`${component.vendor} free tier may restrict commercial use`);
    }
    if (desc.includes("pause") || desc.includes("sleep") || desc.includes("inactive")) {
      limitations.push(`${component.vendor} may pause after inactivity`);
    }
  }
  if (limitations.length === 0) {
    limitations.push("Free tiers have usage limits — check vendor pricing pages for details");
  }
  return limitations;
}

export function getStackRecommendation(
  useCase: string,
  requirements?: string[]
): StackRecommendation {
  let roles: { role: string; category: string; preferredVendors?: string[] }[];
  let upgradePath: string;

  if (requirements && requirements.length > 0) {
    // User-specified requirements override template
    roles = requirements.map((req) => {
      const lower = req.toLowerCase();
      const category = ROLE_TO_CATEGORY[lower] ?? req;
      return { role: req.charAt(0).toUpperCase() + req.slice(1), category };
    });
    upgradePath = "Check individual vendor pricing pages for upgrade options";
  } else {
    const template = matchTemplate(useCase);
    if (template) {
      roles = template.roles;
      upgradePath = template.upgrade_path;
    } else {
      // Fallback: common categories
      roles = [
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

  const stack: StackComponent[] = [];
  for (const { role, category, preferredVendors } of roles) {
    const offer = findBestOffer(category, preferredVendors);
    if (offer) {
      const vendorChanges = changesByVendor.get(offer.vendor.toLowerCase()) ?? [];
      stack.push({
        role,
        vendor: offer.vendor,
        tier: offer.tier,
        description: offer.description.length > 200 ? offer.description.slice(0, 197) + "..." : offer.description,
        url: offer.url,
        risk_level: vendorRiskLevel(vendorChanges),
        stability: classifyStability(vendorChanges),
      });
    }
  }

  const limitations = buildLimitations(stack);
  const risk_warnings = buildRiskWarnings(stack);

  return {
    use_case: useCase,
    stack,
    total_monthly_cost: "$0",
    limitations,
    upgrade_path: upgradePath,
    risk_warnings,
  };
}

function buildRiskWarnings(stack: StackComponent[]): string[] {
  const warnings: string[] = [];
  for (const c of stack) {
    if (c.risk_level === "risky") {
      warnings.push(`${c.vendor} (${c.role}): high risk — free tier removal or open-source license change in the last 12 months. Consider alternatives.`);
    } else if (c.stability === "volatile") {
      warnings.push(`${c.vendor} (${c.role}): volatile — free tier removed or multiple negative pricing changes recorded.`);
    } else if (c.risk_level === "caution" || c.stability === "watch") {
      warnings.push(`${c.vendor} (${c.role}): monitor — has had limit reductions or pricing restructuring.`);
    }
  }
  return warnings;
}
