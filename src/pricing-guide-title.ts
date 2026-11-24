const recentChanges: Record<string, [string, string]> = {
  "accounting-software-pricing-2026": ["Free Plans and Price Increases", "Free Plans and Recent Price Increases"],
  "business-bank-account-fees-2026": ["Free Plans, Fees and Changes", "Free Plans, Fees and Recent Changes"],
  "company-formation-pricing-2026": ["Costs and Changes", "Costs and Recent Changes"],
};

const currentYearAlternatives = new Set([
  "localstack-alternatives", "postman-alternatives", "freshping-alternatives",
  "firebase-alternatives", "github-actions-alternatives", "cursor-alternatives",
  "datadog-alternatives", "vercel-alternatives", "auth0-alternatives",
  "mongodb-alternatives", "redis-alternatives",
]);

export function pricingGuideTitle(slug: string, title: string, now: Date = new Date()): string {
  const wording = recentChanges[slug];
  if (!wording && !currentYearAlternatives.has(slug)) return title;
  const year = now.getUTCFullYear();
  const label = now.getUTCMonth() === 11 && now.getUTCDate() >= 10 ? `${year}–${year + 1}` : `${year}`;
  const dated = title.replace("2026", label);
  return wording && year >= 2027 ? dated.replace(wording[0], wording[1]) : dated;
}
