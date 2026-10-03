export interface GeminiTimelineEntry {
  dateLabel: string;
  heading: string;
  text: string;
  source: string;
}

export const GEMINI_BILLING_DOCS = "https://ai.google.dev/gemini-api/docs/billing";

export const GEMINI_CHANGELOG = "https://ai.google.dev/gemini-api/docs/changelog";

export const GEMINI_PRICING_PAGE = "https://ai.google.dev/gemini-api/docs/pricing";

export const WELCOME_CREDIT_EXCLUDED: GeminiTimelineEntry = {
  dateLabel: "Mar 2026",
  heading: "$300 Welcome Credit Excluded",
  text: "Accounts opened after 2026-03-02 cannot spend the $300 Google Cloud welcome credit on the Gemini API or AI Studio.",
  source: GEMINI_BILLING_DOCS,
};

export const GEMINI_2_5_MODELS_LIMITED: GeminiTimelineEntry = {
  dateLabel: "Sep 2026",
  heading: "2.5 Models Limited to Existing Users",
  text: "Since 2026-09-18 Google serves the Gemini 2.5 models only to users who have used them before, and points new projects to 3.5 Flash-Lite or 3.8 Flash.",
  source: GEMINI_CHANGELOG,
};

export interface TokenPrices {
  input: string;
  output: string;
}

export interface FlashPriceStep {
  models: string;
  until: TokenPrices & { through: string };
  then: TokenPrices & { from: string };
}

const AMOUNT = String.raw`(\d+(?:\.\d+)?)`;
const DAY = String.raw`(\d{4}-\d{2}-\d{2})`;
const LISTED_PRICE_STEP = new RegExp(
  String.raw`Gemini (\d+(?:\.\d+)? Flash) \$${AMOUNT}\/\$${AMOUNT} until ${DAY}, then \$${AMOUNT} input and \$${AMOUNT} output from ${DAY}(?: \(([^():]+): the same prices and dates\))?`,
);

function modelsPricedAlike(first: string, others: string | undefined): string {
  if (!others) return `Gemini ${first}`;
  return others.includes(" and ") ? `Gemini ${first}, ${others}` : `Gemini ${first} and ${others}`;
}

export function flashPriceStepIn(listingDescription: string): FlashPriceStep | null {
  const found = LISTED_PRICE_STEP.exec(listingDescription);
  if (!found) return null;
  const [, first, untilInput, untilOutput, through, thenInput, thenOutput, from, others] = found;
  return {
    models: modelsPricedAlike(first, others),
    until: { input: untilInput, output: untilOutput, through },
    then: { input: thenInput, output: thenOutput, from },
  };
}

function monthOf(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function pricesDouble(step: FlashPriceStep): boolean {
  return Number(step.then.input) === 2 * Number(step.until.input) && Number(step.then.output) === 2 * Number(step.until.output);
}

export function hasTakenEffect(step: FlashPriceStep, servedOn: string): boolean {
  return servedOn >= step.then.from;
}

export function flashPriceStepEntry(step: FlashPriceStep, servedOn: string): GeminiTimelineEntry {
  const past = hasTakenEffect(step, servedOn);
  const verb = pricesDouble(step) ? (past ? "Doubled" : "Double") : past ? "Changed" : "Change";
  return {
    dateLabel: past ? monthOf(step.then.from) : `${monthOf(step.then.from)} (scheduled)`,
    heading: `Flash Prices ${verb}`,
    text: `${step.models} cost $${step.until.input}/$${step.until.output} per million input/output tokens through ${step.until.through} and $${step.then.input}/$${step.then.output} from ${step.then.from}, by Google's pricing page.`,
    source: GEMINI_PRICING_PAGE,
  };
}
