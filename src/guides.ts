// Editorial guide metadata for MCP resources.
// This is a lightweight index — the full HTML content lives in serve.ts.

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

// Guide entries: slug, title, one-line description
const GUIDE_ENTRIES: Array<{ slug: string; title: string; description: string }> = [
  { slug: "localstack-alternatives", title: "LocalStack CE Alternatives", description: "LocalStack CE shuts down March 23, 2026 — compare 9 free open-source AWS emulators" },
  { slug: "postman-alternatives", title: "Postman Alternatives", description: "Postman killed free team collaboration March 1, 2026 — 5 free API testing alternatives" },
  { slug: "terraform-alternatives", title: "HCP Terraform Alternatives", description: "HCP Terraform legacy plan ends March 31, 2026 — free IaC alternatives compared" },
  { slug: "hetzner-alternatives", title: "Hetzner Alternatives", description: "Hetzner raises prices 30–50% on April 1, 2026 — cloud hosting alternatives with free tiers" },
  { slug: "freshping-alternatives", title: "Freshping Alternatives", description: "Freshping shut down March 6, 2026 — 13 free uptime monitoring alternatives" },
  { slug: "heroku-alternatives", title: "Heroku Alternatives", description: "Heroku removed free tier Nov 2022, entered sustaining mode Feb 2026 — 8 free PaaS options" },
  { slug: "firebase-alternatives", title: "Firebase Alternatives", description: "Firebase Studio shut down March 19, 2026 + Spark forced Blaze migration — 7 BaaS alternatives" },
  { slug: "github-actions-alternatives", title: "GitHub Actions Alternatives", description: "Self-hosted runner costs introduced March 2026 — 10 free CI/CD alternatives compared" },
  { slug: "cursor-alternatives", title: "Cursor Alternatives", description: "Cursor credit-based pricing drives alternatives search — 8 free AI coding tools compared" },
  { slug: "datadog-alternatives", title: "Datadog Alternatives", description: "Unpredictable pricing drives developer search — 12 free monitoring alternatives compared" },
  { slug: "vercel-alternatives", title: "Vercel Alternatives", description: "Hobby plan limits and $20/seat Pro pricing — 10 free deployment platforms compared" },
  { slug: "auth0-alternatives", title: "Auth0 Alternatives", description: "$0 to $240/mo pricing cliff — 9 free authentication platforms compared" },
  { slug: "mongodb-alternatives", title: "MongoDB Alternatives", description: "512 MB free tier + SSPL license — 10 free databases compared" },
  { slug: "redis-alternatives", title: "Redis Alternatives", description: "BSL license change + 30 MB free tier — 8 open-source and managed alternatives compared" },
  { slug: "ai-free-tiers", title: "Best Free AI APIs and Coding Tools in 2026", description: "Compare 65 free AI APIs, LLM inference, vector databases, and coding tools" },
  { slug: "database-alternatives", title: "Database Alternatives", description: "Compare 30+ free databases by type — Postgres, document, key-value, edge, graph, vector, and time-series" },
  { slug: "hosting-alternatives", title: "Hosting Alternatives", description: "Compare 30+ free hosting options by type — PaaS, static/JAMstack, serverless, containers, VPS" },
  { slug: "monitoring-alternatives", title: "Monitoring Alternatives", description: "Compare 70+ free monitoring tools by type — APM, uptime, logs, error tracking, and infrastructure" },
  { slug: "email-service-alternatives", title: "Email Service Alternatives", description: "SendGrid down to 100/day, Mailgun free tier gone — 8 free transactional email alternatives" },
  { slug: "ci-cd-alternatives", title: "CI/CD Alternatives", description: "35+ free CI/CD tools — build minutes, runners, and pipelines by type" },
  { slug: "security-alternatives", title: "Security Alternatives", description: "100+ free security tools — SAST/DAST, secret scanning, dependency analysis, container security" },
  { slug: "storage-alternatives", title: "Storage Alternatives", description: "55+ free cloud storage tools — object storage, media/image CDN, file hosting" },
  { slug: "testing-alternatives", title: "Testing Alternatives", description: "45+ free testing tools — browser, visual regression, load, E2E, API, and code coverage" },
  { slug: "analytics-alternatives", title: "Analytics Alternatives", description: "45+ free analytics tools — product analytics, web analytics, event tracking, data infrastructure" },
  { slug: "ai-ml-alternatives", title: "AI/ML Alternatives", description: "65+ free AI/ML tools — LLM APIs, AI coding assistants, ML platforms, observability" },
  { slug: "design-alternatives", title: "Design Alternatives", description: "100+ free design tools — UI design, prototyping, components, icons, stock assets" },
  { slug: "email-alternatives", title: "Email Alternatives", description: "59+ free email tools — transactional APIs, marketing, verification, forwarding" },
  { slug: "project-management-alternatives", title: "Project Management Alternatives", description: "93+ free PM tools — issue tracking, kanban, team chat, video conferencing, scheduling" },
  { slug: "ide-code-editors-alternatives", title: "IDE & Code Editor Alternatives", description: "59+ free IDEs and coding tools — desktop editors, cloud IDEs, AI coding assistants" },
  { slug: "free-llm-apis", title: "Free LLM APIs", description: "25+ free LLM API providers — proprietary model APIs, open-model inference, AI gateways" },
  { slug: "api-development-alternatives", title: "API Development Alternatives", description: "39+ free API tools — REST/GraphQL clients, mocking, documentation, marketplaces" },
  { slug: "q1-2026-developer-pricing-report", title: "Q1 2026 Developer Pricing Report — The Great Free Tier Reckoning", description: "50 pricing changes in Q1 2026: 8 free tiers removed, 6 limits reduced, 1 OSS killed. Biggest stories, category breakdown, monthly trend, Cloudflare counter-trend, Q2 outlook" },
  { slug: "hetzner-pricing-2026", title: "Hetzner Pricing 2026", description: "Hetzner April 2026 price increases — before/after tables, impact, alternatives" },
  { slug: "team-collaboration-alternatives", title: "Team Collaboration Alternatives", description: "60+ free team collaboration tools — chat, video, docs, scheduling, async communication" },
  { slug: "free-startup-stack", title: "Free Startup Stack", description: "Complete free SaaS infrastructure stack — 10 categories with recommended picks" },
  { slug: "free-ai-stack", title: "Free AI Stack", description: "Free AI/ML development stack — LLM APIs, vector DB, compute, monitoring, 10 categories" },
  { slug: "free-devops-stack", title: "Free DevOps Stack", description: "Free DevOps infrastructure stack — CI/CD, monitoring, logging, IaC, 10 categories" },
  { slug: "free-frontend-stack", title: "Free Frontend Stack", description: "Free frontend/Jamstack development stack — hosting, CMS, auth, analytics, 10 categories" },
  { slug: "free-nextjs-stack", title: "Free Next.js Stack", description: "Free Next.js full-stack infrastructure — hosting, database, auth, storage, email, monitoring, 10 layers" },
  { slug: "free-django-stack", title: "Free Django Stack", description: "Free Django/Python full-stack infrastructure — WSGI hosting, Postgres, Redis, Celery, auth, storage, 10 layers" },
  { slug: "free-fastapi-stack", title: "Free FastAPI Stack", description: "Free FastAPI/Python full-stack infrastructure — ASGI hosting, async Postgres, Redis, auth, storage, 10 layers" },
  { slug: "free-go-stack", title: "Free Go Stack", description: "Free Go/Golang full-stack infrastructure — single binary hosting, Postgres via pgx, goroutines, stdlib, 10 layers" },
  { slug: "free-saas-stack", title: "Free SaaS Starter Stack", description: "Complete free SaaS infrastructure — hosting, database, auth, payments, email, storage, monitoring, CI/CD, analytics, background jobs, growth costs at 4 scale points" },
  { slug: "q2-pricing-preview-2026", title: "Q2 2026 Pricing Preview", description: "Forward-looking Q2 pricing preview — upcoming changes, expirations, market trends" },
  { slug: "google-developer-program-2026", title: "Google Developer Program Premium 2026", description: "Google Developer Program Premium analysis — price comparison, migration guide, alternatives" },
  { slug: "supabase-vs-firebase", title: "Supabase vs Firebase", description: "Free tier comparison — storage, compute, auth, pricing at scale, decision guide" },
  { slug: "vercel-vs-netlify", title: "Vercel vs Netlify", description: "Free tier comparison — bandwidth, functions, builds, commercial use, hosting alternatives" },
  { slug: "neon-vs-supabase", title: "Neon vs Supabase", description: "Free tier comparison — storage, compute, branching, auth, scale-to-zero" },
  { slug: "railway-vs-render", title: "Railway vs Render", description: "Free tier comparison — usage-based vs fixed pricing, managed databases, sleep behavior" },
  { slug: "datadog-vs-new-relic", title: "Datadog vs New Relic", description: "Free tier comparison — per-host vs per-GB pricing, APM, logs, synthetics, retention" },
  { slug: "free-tier-risk", title: "Free Tier Risk Index", description: "38 vendors scored by free tier sustainability risk — methodology and risk factors" },
  { slug: "hcp-terraform-migration", title: "HCP Terraform Migration Guide", description: "5 migration paths, decision matrix, step-by-step process for HCP Terraform EOL" },
  { slug: "terraform-cloud-free-tier-removed", title: "Terraform Cloud Free Tier Removed", description: "HCP Terraform free tier removal guide — cost analysis at 10-500 resources, 8 alternatives compared, migration paths" },
  { slug: "gemini-api-pricing-2026", title: "Gemini API Pricing 2026", description: "Gemini API billing guide — free tier changes, spend caps ($250-$100K+/mo), prepaid billing, 3.1 Pro paid-only, 8-provider comparison" },
  { slug: "gemini-api-pricing-changes", title: "Gemini API Pricing Overhaul Guide", description: "Complete Gemini API pricing changes guide — before/after limits, cost analysis by usage tier, 11 LLM alternatives compared, migration recommendations by use case" },
  { slug: "free-tier-tracker", title: "Free Tier Tracker Q1 2026", description: "Q1 2026 free tier erosion report — 8 removals, 6 expansions, 4 trend patterns" },
  { slug: "startup-credits", title: "Startup Credits Directory", description: "19 startup credit programs across 3 tiers, $1M+ combined credits, stacking strategy" },
  { slug: "ai-coding-pricing-2026", title: "AI Coding Tools Pricing 2026", description: "9 AI coding tools compared — Cursor, Copilot, Claude Code, Windsurf, pricing and free tiers" },
  { slug: "ai-coding-tools-pricing", title: "AI Coding Tools Pricing Comparison 2026", description: "The definitive comparison of 16 AI coding tools — IDE, CLI, cloud agent, app builder categories with free tier analysis, hidden costs, and cost breakdowns" },
  { slug: "aws-free-tier-2026", title: "AWS Free Tier Guide 2026", description: "29 services, 3 tier types, hidden costs, alternatives — comprehensive AWS free tier guide" },
  { slug: "gcp-free-tier-2026", title: "GCP Free Tier Guide 2026", description: "31 Always Free products, $300 trial, AI/ML tools, hidden costs — comprehensive GCP guide" },
  { slug: "azure-free-tier-2026", title: "Azure Free Tier Guide 2026", description: "65+ always-free services, $200 trial, Cosmos DB lifetime tier, Founders Hub $150K" },
  { slug: "cicd-free-tier-comparison-2026", title: "CI/CD Free Tier Comparison 2026", description: "15+ CI/CD platforms compared — build minutes, runners, parallel jobs, self-hosted options" },
  { slug: "cloud-free-tier-comparison-2026", title: "Cloud Free Tier Comparison 2026", description: "AWS vs GCP vs Azure vs 5 alternatives — compute, storage, databases, and serverless" },
  { slug: "database-free-tier-comparison-2026", title: "Database Free Tier Comparison 2026", description: "15+ databases compared — Postgres, MySQL, MongoDB, Redis, vector, and edge databases" },
  { slug: "hosting-free-tier-comparison-2026", title: "Hosting Free Tier Comparison 2026", description: "12+ hosting platforms compared — Vercel, Netlify, Render, Railway, Cloudflare Pages, Fly.io, Koyeb, bandwidth, compute, cold starts, and scaling costs" },
  { slug: "serverless-free-tier-comparison-2026", title: "Serverless Free Tier Comparison 2026", description: "10+ serverless platforms — invocations, compute, CPU-time vs wall-clock billing" },
  { slug: "auth-comparison-2026", title: "Auth & Identity Comparison 2026", description: "20+ auth services — MAU/MRU limits, overage costs, agentic AI auth, self-hosted options, growth cost traps" },
  { slug: "monitoring-comparison-2026", title: "Monitoring & Observability Comparison 2026", description: "25+ monitoring services — Datadog, Grafana Cloud, New Relic, Better Stack, Sentry, Checkly, SigNoz, HyperDX — data ingest, retention, APM, scaling costs at 10/50/100/500 hosts" },
  { slug: "email-comparison-2026", title: "Email & Transactional Messaging Comparison 2026", description: "20+ email services — SendGrid exodus migration, transactional vs marketing, growth cost at 10K-1M emails/month, deliverability traps" },
  { slug: "storage-comparison-2026", title: "Storage & CDN Comparison 2026", description: "15+ storage and CDN services — S3 vs R2 vs B2, egress tax breakdown, zero-egress providers, media CDN, self-hosted options, scaling costs at 100GB/1TB/10TB/100TB" },
  { slug: "analytics-free-tier-comparison-2026", title: "Analytics Free Tier Comparison 2026", description: "15+ analytics services — events, sessions, retention, privacy, and self-hosting" },
  { slug: "testing-free-tier-comparison-2026", title: "Testing Free Tier Comparison 2026", description: "15+ testing tools — browser tests, parallel runs, visual regression, load testing" },
  { slug: "api-development-free-tier-comparison-2026", title: "API Development Free Tier Comparison 2026", description: "12+ API tools — Postman vs Bruno vs Hoppscotch vs Insomnia, collaboration limits" },
  { slug: "security-free-tier-comparison-2026", title: "Security Free Tier Comparison 2026", description: "20+ security tools — SAST, SCA, DAST, secrets, container/IaC, SSL/TLS, zero trust" },
  { slug: "state-of-free-tiers", title: "State of Developer Free Tiers", description: "Data-driven report: 77 pricing changes tracked, monthly trend visualization, category erosion analysis, stable vendors — the authoritative source on free tier trends" },
  { slug: "tenor-alternatives", title: "Tenor API Shutdown Migration Guide", description: "Google Tenor API shuts down June 2026 — GIF API alternatives (Klipy, Giphy, Imgur), migration code examples, and platform impact" },
  { slug: "firebase-studio-shutdown", title: "Firebase Studio Shutdown Guide", description: "Firebase Studio shuts down June 2026 — free cloud IDE alternatives with compute, storage, and collaboration limits compared" },
  { slug: "openai-assistants-migration-2026", title: "OpenAI Assistants API Migration Guide 2026", description: "Comprehensive Assistants API migration guide — feature map, complexity assessment, decision framework, agent frameworks, wire-compatible bridges, cost comparison" },
  { slug: "developers", title: "REST API Developer Hub", description: "REST API landing page — 18 endpoints, quick start examples in curl/Python/JavaScript, endpoint reference, use cases, no auth required" },
  { slug: "guides/langchain", title: "Using AgentDeals with LangChain", description: "LangChain MCP integration guide — connect AgentDeals tools via langchain-mcp-adapters, Python code examples, multi-agent workflows" },
  { slug: "guides/crewai", title: "Using AgentDeals with CrewAI", description: "CrewAI MCP integration guide — native mcps field configuration, multi-agent pricing research workflows" },
  { slug: "guides/n8n", title: "Using AgentDeals with n8n", description: "n8n MCP integration guide — MCP Server Trigger node setup, no-code automation workflows for pricing monitoring" },
  { slug: "guides/vercel-ai-sdk", title: "Using AgentDeals with Vercel AI SDK", description: "Vercel AI SDK MCP integration guide — experimental_createMCPClient() setup, React/Next.js code examples" },
];

export function getGuideList(): GuideMetadata[] {
  return GUIDE_ENTRIES.map(e => ({
    slug: e.slug,
    title: e.title,
    description: e.description,
    type: classifyGuide(e.slug),
  }));
}

export function getGuideBySlug(slug: string): GuideMetadata | null {
  const entry = GUIDE_ENTRIES.find(e => e.slug === slug);
  if (!entry) return null;
  return {
    slug: entry.slug,
    title: entry.title,
    description: entry.description,
    type: classifyGuide(entry.slug),
  };
}
