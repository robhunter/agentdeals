const recentChanges: Record<string, [string, string]> = {
  "accounting-software-pricing-2026": ["Free Plans and Price Increases", "Free Plans and Recent Price Increases"],
  "business-bank-account-fees-2026": ["Free Plans, Fees and Changes", "Free Plans, Fees and Recent Changes"],
  "company-formation-pricing-2026": ["Costs and Changes", "Costs and Recent Changes"],
};

const currentYearAlternatives = new Set([
  "localstack-alternatives", "postman-alternatives", "freshping-alternatives",
  "firebase-alternatives", "github-actions-alternatives", "cursor-alternatives",
  "datadog-alternatives", "vercel-alternatives", "auth0-alternatives",
  "mongodb-alternatives", "redis-alternatives", "email-service-alternatives",
  "ai-free-tiers", "database-alternatives", "hosting-alternatives",
  "monitoring-alternatives", "ci-cd-alternatives", "security-alternatives",
  "storage-alternatives", "testing-alternatives", "analytics-alternatives",
  "ai-ml-alternatives", "design-alternatives", "email-alternatives",
  "project-management-alternatives", "ide-code-editors-alternatives",
  "free-llm-apis", "api-development-alternatives", "team-collaboration-alternatives",
  "free-startup-stack", "free-ai-stack", "free-devops-stack", "free-frontend-stack",
  "free-nextjs-stack", "free-django-stack", "free-fastapi-stack", "free-go-stack", "free-saas-stack",
]);

const currentYearComparisons = new Set([
  "monitoring-comparison-2026",
  "llm-api-pricing",
  "cloud-free-tier-comparison-2026",
  "database-free-tier-comparison-2026",
  "cicd-free-tier-comparison-2026",
  "serverless-free-tier-comparison-2026",
  "auth-comparison-2026",
  "email-comparison-2026",
  "storage-comparison-2026",
  "testing-free-tier-comparison-2026",
  "analytics-free-tier-comparison-2026",
  "api-development-free-tier-comparison-2026",
  "security-free-tier-comparison-2026",
  "hosting-free-tier-comparison-2026",
]);

export function currentYearLabel(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  return now.getUTCMonth() === 11 && now.getUTCDate() >= 10 ? `${year}–${year + 1}` : `${year}`;
}

export function pricingGuideTitle(slug: string, title: string, now: Date = new Date()): string {
  const wording = recentChanges[slug];
  if (!wording && !currentYearAlternatives.has(slug) && !currentYearComparisons.has(slug)) return title;
  const dated = title.replace("2026", currentYearLabel(now));
  const year = now.getUTCFullYear();
  return wording && year >= 2027 ? dated.replace(wording[0], wording[1]) : dated;
}

export function pricingGuideDescription(slug: string, description: string, now: Date = new Date()): string {
  return currentYearComparisons.has(slug) ? description.replace("2026", currentYearLabel(now)) : description;
}
