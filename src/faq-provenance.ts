import { compiledNotice, getPageReview, qualityBudget, reviewStatus, utcToday, type PageReviewRecord } from "./page-reviews.js";

export interface FaqItem {
  q: string;
  a: string;
}

export const FAQ_BASELINE = {
  answers: qualityBudget("faq_answers"),
  stating_a_figure: qualityBudget("faq_answers_stating_a_figure"),
  a_digit_but_no_figure: qualityBudget("faq_answers_with_a_digit_but_no_figure"),
};

const CURRENCY_AMOUNT = /[$€£¢]\s?\d|\d\s?¢|\b\d[\d,.]*\s?(?:USD|EUR|GBP)\b/;

const PERCENTAGE = /\d[\d.]*\s?%/;

const FIRST_PERSON = /\b(?:we|our|ours)\b/i;

export const CONSUMPTION_UNITS = [
  "GiB", "TiB", "MiB", "KiB", "GB", "TB", "MB", "KB",
  "seconds", "minutes", "minute", "mins", "min", "hours", "hour", "hrs", "days", "day", "months", "month",
  "requests", "request", "emails", "email", "errors", "events", "users", "MAU", "seats", "seat", "members",
  "collaborators", "runs", "run", "records", "record", "replays", "resources", "resource", "builds",
  "build", "credits", "tokens", "token", "commands", "calls", "invocations", "characters", "messages",
  "sessions", "rows", "operations", "ops", "projects", "repositories", "repos", "domains", "sites",
  "containers", "workflows", "jobs", "pipelines", "spans", "logs", "traces", "metrics", "monitors",
  "checks", "images", "vectors", "environments", "branches", "apps", "concurrency",
];

const QUOTA_FIGURE = new RegExp(
  `(?<![\\w-])\\d[\\d,.]*(?:\\s?[-–]\\s?\\d[\\d,.]*)?\\+?[\\s-]?[KMB]?[\\s-]*(?:[a-zA-Z][a-zA-Z-]*[\\s-]+){0,2}(?:${CONSUMPTION_UNITS.join("|")})\\b`,
  "g",
);

const OWN_COUNT_WINDOW = 40;

function statesQuota(answer: string): boolean {
  QUOTA_FIGURE.lastIndex = 0;
  for (let m = QUOTA_FIGURE.exec(answer); m !== null; m = QUOTA_FIGURE.exec(answer)) {
    if (!FIRST_PERSON.test(answer.slice(Math.max(0, m.index - OWN_COUNT_WINDOW), m.index))) return true;
  }
  return false;
}

export function statesVendorFigure(answer: string): boolean {
  if (CURRENCY_AMOUNT.test(answer) || statesQuota(answer)) return true;
  return PERCENTAGE.test(answer) && !FIRST_PERSON.test(answer);
}

export function faqProvenanceClause(record: PageReviewRecord | null, today: string): string {
  if (!record) return "";
  const status = reviewStatus(record, today);
  const notice = compiledNotice(record.published, status.reviewed_at);
  return status.review_outcome === "fail" ? `${notice}; corrections outstanding.` : `${notice}.`;
}

export function pageFaqProvenanceClause(pagePath: string, today = utcToday()): string {
  return faqProvenanceClause(getPageReview(pagePath), today);
}

const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;

function plainText(answer: string): string {
  return answer.replace(HTML_TAG, "").replace(/\s+/g, " ").trim();
}

export function answerWithProvenance(answer: string, clause: string): string {
  const text = plainText(answer);
  if (!clause || !statesVendorFigure(text)) return text;
  return `${text} ${clause}`;
}

export function faqPageJsonLd(pagePath: string, items: FaqItem[], today = utcToday()): Record<string, unknown> {
  const clause = pageFaqProvenanceClause(pagePath, today);
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map(item => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: answerWithProvenance(item.a, clause) },
    })),
  };
}
