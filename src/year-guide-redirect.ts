const CURRENT_GUIDE_PATHS = new Set([
  "accounting-software-pricing", "analytics-free-tier-comparison", "api-development-free-tier-comparison",
  "auth-comparison", "aws-free-tier", "azure-free-tier", "business-bank-account-fees",
  "cicd-free-tier-comparison", "cloud-free-tier-comparison", "company-formation-pricing",
  "database-free-tier-comparison", "digitalocean-free-tier", "email-comparison", "gcp-free-tier",
  "google-developer-program", "hosting-free-tier-comparison", "mistral-api-pricing",
  "monitoring-comparison", "security-free-tier-comparison", "serverless-free-tier-comparison",
  "storage-comparison", "testing-free-tier-comparison",
]);

export function yearGuideRedirect(path: string, now: Date = new Date()): string | null {
  const match = /^\/([a-z0-9-]+)-(\d{4})$/.exec(path);
  if (!match || !CURRENT_GUIDE_PATHS.has(match[1])) return null;
  const year = Number(match[2]);
  if (year <= 2026 || year > now.getUTCFullYear() + 1) return null;
  return `/${match[1]}-2026`;
}
