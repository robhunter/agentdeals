import { FREE_TIER_TRACKER_HEADING } from "./free-tier-tracker.js";
import { guideBlurb } from "./guide-blurbs.js";

export interface GuideMetadata {
  slug: string;
  title: string;
  description: string;
  type: "pricing" | "comparison" | "stack" | "alternatives" | "report" | "integration";
}

function classifyGuide(slug: string): GuideMetadata["type"] {
  if (slug.startsWith("guides/")) return "integration";
  if (slug.includes("-vs-") || slug.includes("-comparison-")) return "comparison";
  if (slug.startsWith("free-") && slug.endsWith("-stack")) return "stack";
  if (slug.includes("pricing") || slug.includes("report") || slug.includes("preview")) return "pricing";
  if (slug.endsWith("-alternatives") || slug === "ai-free-tiers" || slug === "free-llm-apis" || slug === "api-development-alternatives") return "alternatives";
  return "report";
}

const GUIDE_ENTRIES: Array<{ slug: string; title: string }> = [
  { slug: "localstack-alternatives", title: "LocalStack CE Alternatives" },
  { slug: "postman-alternatives", title: "Postman Alternatives" },
  { slug: "terraform-alternatives", title: "HCP Terraform Alternatives" },
  { slug: "hetzner-alternatives", title: "Hetzner Alternatives" },
  { slug: "freshping-alternatives", title: "Freshping Alternatives" },
  { slug: "heroku-alternatives", title: "Heroku Alternatives" },
  { slug: "firebase-alternatives", title: "Firebase Alternatives" },
  { slug: "github-actions-alternatives", title: "GitHub Actions Alternatives" },
  { slug: "cursor-alternatives", title: "Cursor Alternatives" },
  { slug: "datadog-alternatives", title: "Datadog Alternatives" },
  { slug: "vercel-alternatives", title: "Vercel Alternatives" },
  { slug: "auth0-alternatives", title: "Auth0 Alternatives" },
  { slug: "mongodb-alternatives", title: "MongoDB Alternatives" },
  { slug: "redis-alternatives", title: "Redis Alternatives" },
  { slug: "ai-free-tiers", title: "Best Free AI APIs and Coding Tools in 2026" },
  { slug: "database-alternatives", title: "Database Alternatives" },
  { slug: "hosting-alternatives", title: "Hosting Alternatives" },
  { slug: "monitoring-alternatives", title: "Monitoring Alternatives" },
  { slug: "email-service-alternatives", title: "Email Service Alternatives" },
  { slug: "ci-cd-alternatives", title: "CI/CD Alternatives" },
  { slug: "security-alternatives", title: "Security Alternatives" },
  { slug: "storage-alternatives", title: "Storage Alternatives" },
  { slug: "testing-alternatives", title: "Testing Alternatives" },
  { slug: "analytics-alternatives", title: "Analytics Alternatives" },
  { slug: "ai-ml-alternatives", title: "AI/ML Alternatives" },
  { slug: "design-alternatives", title: "Design Alternatives" },
  { slug: "email-alternatives", title: "Email Alternatives" },
  { slug: "project-management-alternatives", title: "Project Management Alternatives" },
  { slug: "ide-code-editors-alternatives", title: "IDE & Code Editor Alternatives" },
  { slug: "free-llm-apis", title: "Free LLM APIs" },
  { slug: "api-development-alternatives", title: "API Development Alternatives" },
  { slug: "q1-2026-developer-pricing-report", title: "Q1 2026 Developer Pricing Report — The Great Free Tier Reckoning" },
  { slug: "hetzner-pricing-2026", title: "Hetzner Pricing 2026" },
  { slug: "team-collaboration-alternatives", title: "Team Collaboration Alternatives" },
  { slug: "free-startup-stack", title: "Free Startup Stack" },
  { slug: "free-ai-stack", title: "Free AI Stack" },
  { slug: "free-devops-stack", title: "Free DevOps Stack" },
  { slug: "free-frontend-stack", title: "Free Frontend Stack" },
  { slug: "free-nextjs-stack", title: "Free Next.js Stack" },
  { slug: "free-django-stack", title: "Free Django Stack" },
  { slug: "free-fastapi-stack", title: "Free FastAPI Stack" },
  { slug: "free-go-stack", title: "Free Go Stack" },
  { slug: "free-saas-stack", title: "Free SaaS Starter Stack" },
  { slug: "q2-pricing-preview-2026", title: "Q2 2026 Pricing Preview" },
  { slug: "google-developer-program-2026", title: "Google Developer Program Premium 2026" },
  { slug: "supabase-vs-firebase", title: "Supabase vs Firebase" },
  { slug: "vercel-vs-netlify", title: "Vercel vs Netlify" },
  { slug: "neon-vs-supabase", title: "Neon vs Supabase" },
  { slug: "railway-vs-render", title: "Railway vs Render" },
  { slug: "datadog-vs-new-relic", title: "Datadog vs New Relic" },
  { slug: "free-tier-risk", title: "Free Tier Risk Index" },
  { slug: "gemini-api-pricing-2026", title: "Gemini API Pricing 2026" },
  { slug: "free-tier-tracker", title: FREE_TIER_TRACKER_HEADING },
  { slug: "startup-credits", title: "Startup Credits Directory" },
  { slug: "openai-assistants-migration", title: "OpenAI Assistants API Migration Cost Guide" },
  { slug: "ai-coding-tools-pricing", title: "AI Coding Tools Pricing Comparison 2026" },
  { slug: "ci-cd-pricing", title: "CI/CD Tools Pricing Comparison 2026" },
  { slug: "database-pricing", title: "Database Pricing Comparison 2026" },
  { slug: "vector-database-pricing", title: "Vector Database Pricing Comparison 2026" },
  { slug: "llm-api-pricing", title: "LLM API Free Tiers & Free Credits 2026" },
  { slug: "aws-free-tier-2026", title: "AWS Free Tier Guide 2026" },
  { slug: "gcp-free-tier-2026", title: "GCP Free Tier Guide 2026" },
  { slug: "azure-free-tier-2026", title: "Azure Free Tier Guide 2026" },
  { slug: "cicd-free-tier-comparison-2026", title: "CI/CD Free Tier Comparison 2026" },
  { slug: "cloud-free-tier-comparison-2026", title: "Cloud Free Tier Comparison 2026" },
  { slug: "database-free-tier-comparison-2026", title: "Database Free Tier Comparison 2026" },
  { slug: "hosting-free-tier-comparison-2026", title: "Hosting Free Tier Comparison 2026" },
  { slug: "serverless-free-tier-comparison-2026", title: "Serverless Free Tier Comparison 2026" },
  { slug: "auth-comparison-2026", title: "Auth & Identity Comparison 2026" },
  { slug: "monitoring-comparison-2026", title: "Free Tiers for Error Tracking, Monitoring & Observability 2026" },
  { slug: "email-comparison-2026", title: "Email & Transactional Messaging Comparison 2026" },
  { slug: "storage-comparison-2026", title: "Storage & CDN Comparison 2026" },
  { slug: "analytics-free-tier-comparison-2026", title: "Analytics Free Tier Comparison 2026" },
  { slug: "testing-free-tier-comparison-2026", title: "Testing Free Tier Comparison 2026" },
  { slug: "api-development-free-tier-comparison-2026", title: "API Development Free Tier Comparison 2026" },
  { slug: "security-free-tier-comparison-2026", title: "Security Free Tier Comparison 2026" },
  { slug: "state-of-free-tiers", title: "State of Developer Free Tiers" },
  { slug: "tenor-alternatives", title: "Tenor API Shutdown Migration Guide" },
  { slug: "firebase-studio-shutdown", title: "Firebase Studio Shutdown Guide" },
  { slug: "openai-assistants-migration-2026", title: "OpenAI Assistants API Migration Guide 2026" },
  { slug: "developers", title: "REST API Developer Hub" },
  { slug: "guides/langchain", title: "Using AgentDeals with LangChain" },
  { slug: "guides/crewai", title: "Using AgentDeals with CrewAI" },
  { slug: "guides/n8n", title: "Using AgentDeals with n8n" },
  { slug: "guides/vercel-ai-sdk", title: "Using AgentDeals with Vercel AI SDK" },
  { slug: "aws-app-runner-migration", title: "AWS App Runner Migration Guide" },
  { slug: "free-tier-facts-ai-models-get-wrong", title: "Free-Tier Facts AI Models Get Wrong (2026)" },
  { slug: "accounting-software-pricing-2026", title: "Accounting Software 2026: Free Plans and Price Increases" },
];

export function getGuideList(): GuideMetadata[] {
  return GUIDE_ENTRIES.map(e => ({
    slug: e.slug,
    title: e.title,
    description: guideBlurb(e.slug),
    type: classifyGuide(e.slug),
  }));
}

export function getGuideBySlug(slug: string): GuideMetadata | null {
  const entry = GUIDE_ENTRIES.find(e => e.slug === slug);
  if (!entry) return null;
  return {
    slug: entry.slug,
    title: entry.title,
    description: guideBlurb(entry.slug),
    type: classifyGuide(entry.slug),
  };
}
