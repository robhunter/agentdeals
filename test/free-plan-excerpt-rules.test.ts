import { describe, it } from "node:test";
import assert from "node:assert";
import {
  EXCERPT_HOLDS_A_DATE_BESIDE_THE_TERMS,
  EXCERPT_HOLDS_AN_UNDECODED_ENTITY,
  EXCERPT_HOLDS_TEMPLATE_SYNTAX,
  EXCERPT_NAMES_NO_ALLOWANCE_LIMIT_OR_PRICE,
  EXCERPT_NEVER_SAYS_IT_IS_THE_FREE_OFFER,
  EXCERPT_REPEATS_A_RUN_OF_ITS_WORDS,
  LONGEST_RUN_AN_EXCERPT_MAY_REPEAT,
  holdsADateBesideTheTerms,
  namesAnAllowanceALimitOrAPrice,
  repeatsARunOfItsOwnWords,
  saysItIsTheFreeOffer,
  whyTheExcerptCannotStand,
} from "../dist/free-plan-excerpt-rules.js";
import { tierWhoseFreeOfferIsTheLicence } from "../dist/free-tier-record.js";
import { FREE_PLAN_EXCERPT, TIER_WHOSE_FREE_OFFER_IS_THE_LICENCE, excerptTheFreePlan } from "../scripts/free-plan-excerpt.js";

type StoredQuote = { vendor: string; tier: string; programme?: true; text: string; refusedAs?: string; neverSaysItIsTheFreeOffer?: true };

const STORED_BY_THE_READ_OF_2026_10_02: StoredQuote[] = [
  { vendor: "Render", tier: "Hobby", text: "Hobby For individuals building personal projects and prototypes. $ 0 /mo + compute Deploy for free" },
  { vendor: "CircleCI", tier: "Free", text: "Cloud Server Free All our premium features. For free. &emsp; &emsp; &emsp; &emsp; No credit card required. $0 /month Start now Up to 6,000 build minutes Number of build minutes when using a small Docker resource class Up to 5 active users/month Docker, Windows, Linux, Arm, macOS, self hosted runners 30x concurrency", refusedAs: EXCERPT_HOLDS_AN_UNDECODED_ENTITY },
  { vendor: "Apify", tier: "Free", text: "Free $0 $5 to spend in Apify Store or on your own Actors $0.2 per compute unit Community support No Apify Store discount Start for free No credit card required." },
  { vendor: "Doppler", tier: "Free", text: "Free for 3 users $8/mo per additional user Integrations Doppler CLI for local development Service tokens Email alerts and recurring reminders 3 days of activity logs Secrets referencing Secret value types API and webhooks access Config syncs (5)" },
  { vendor: "Pixlr", tier: "Free", text: "Pixlr is free for Education. See Plans & Pricing", refusedAs: EXCERPT_NAMES_NO_ALLOWANCE_LIMIT_OR_PRICE },
  { vendor: "Cohere", tier: "Free", text: "API calls made from a Trial API key are free. However, trial keys are rate limited and are not permitted to be used for production or commercial purposes." },
  { vendor: "Grafana k6 Cloud", tier: "Free", text: "free Always free Always $0 Perfect for personal projects, exploring new ideas, and early-stage startups. No charges ever. Start free Benefits: All Grafana Cloud services, with usage limits Adaptive Telemetry, AI Assistant, and much more Community support 14 days retention for metrics, logs, traces, profiles, & k6 performance tests" },
  { vendor: "Sematext", tier: "Basic (Free)", text: "Basic ${{ infrastructure_.price.basic }} /month per host Retention 1 day Try free for 14 days No credit card needed", refusedAs: EXCERPT_HOLDS_TEMPLATE_SYNTAX },
  { vendor: "Conversion Tools", tier: "Free", text: "100 free API calls/month + 100 AI credits/month" },
  { vendor: "DatoCMS", tier: "Free", text: "No signup. No email. No credit card. Launch the demo", refusedAs: EXCERPT_NAMES_NO_ALLOWANCE_LIMIT_OR_PRICE },
  { vendor: "CertKit", tier: "Free", text: "Homelab Free Personal, non-commercial use." },
  { vendor: "Pocket Alert", tier: "Free", text: "Yes — the free plan gives you 50 push notifications a day with one device, one application, and one webhook, free forever and with no credit card required." },
  { vendor: "fivenines.io", tier: "Trial", text: "No credit card · 14-day free trial · Live in 2 minutes" },
  { vendor: "pagecrawl.io", tier: "Free", text: "Free Forever $ 0 / month $0 billed annually Track 6 pages Get started for free Pages : Up to 6 Checks : Up to 220 Frequency : Up to 60 min" },
  { vendor: "Back4App", tier: "Free", text: "Start for Free — Perfect for developing, learning and prototyping 25K Requests 250MB Database 1GB Transfer 1GB Files" },
  { vendor: "Ente", tier: "Free", text: "10GB free forever End-to-end encrypted backups Stored in 3 locations 10GB free forever End-to-end encrypted backups Stored in 3 locations", refusedAs: EXCERPT_REPEATS_A_RUN_OF_ITS_WORDS },
  { vendor: "QRtracer", tier: "Free", text: "Free to create. Choose tracking next. No credit card. 1,000+ QR codes generated 100+ registered users 20,000+ recorded scans", refusedAs: EXCERPT_NAMES_NO_ALLOWANCE_LIMIT_OR_PRICE },
  { vendor: "Microsoft for Startups", tier: "Startup Program", programme: true, text: "Access cutting-edge AI models, developer tools, and up to $150,000 in credits , backed by Microsoft’s global customer network, enterprise-grade security, and privacy you can trust." },
  { vendor: "ScaleGrid Startup Program", tier: "Startup Program", programme: true, text: "Up to 50% Off MySQL™ PostgreSQL® MongoDB® Redis® FOR 12 MONTHS DBaaS Plans Bring Your Own Cloud (BYOC) 50% off medium or larger plan sizes Dedicated Hosting 25% off medium or larger plan sizes Eligibility Criteria Less than $1.5M in revenue Less than $1.5M in funding New to ScaleGrid Small plan sizes receive 50% off BYOC and 25% off Dedicated Hosting plans for 3 months." },
  { vendor: "Esri Startup Program", tier: "Startup Program", programme: true, text: "Be founded within the last five years, generating less than US$2 million annually" },
  { vendor: "MATLAB and Simulink for Startups", tier: "Startup Program", programme: true, text: "Founded within the last 5 years Fewer than 15 engineers Less than $1 million USD in annual revenue" },
  { vendor: "NS1 Connect", tier: "Free", text: "Plan Name: Trial 30 day Free Trial Pricing: Free trial Features 50M DNS queries/month 500 DNS records 20 health check monitor 10 traffic steering chains 50 HTTPS redirects" },
  { vendor: "Google Cloud BigQuery", tier: "Always Free", text: "The first 1 TiB of query data processed per month is free." },
  { vendor: "Google Cloud Logging", tier: "Always Free", text: "First 50 GiB/project/month July 1, 2018", refusedAs: EXCERPT_HOLDS_A_DATE_BESIDE_THE_TERMS },
  { vendor: "Standard Notes", tier: "Free", text: "Standard Free You’ll have End-to-end encryption Unlimited device sync on web, desktop, and mobile Plain text notes Offline access Organize your notes into tags Password protect individual notes Full data export in encrypted or plaintext format Two-factor authentication Daily encrypted email backups Community support Start for free" },
  { vendor: "Dropbox", tier: "Free (Basic)", text: "Basic Free 2 GB to store and share your files" },
  { vendor: "Grafana", tier: "Free OSS", text: "Includes a robust free tier with access to 10k metrics, 50GB logs, 50GB traces, 50GB profiles, 50k frontend sessions, and 500VUh of k6 testing for 3 users.", refusedAs: TIER_WHOSE_FREE_OFFER_IS_THE_LICENCE },
  { vendor: "Mockoon", tier: "Free OSS", text: "Users with a valid work email are eligible for a 14-day free trial without credit card requirement.", refusedAs: TIER_WHOSE_FREE_OFFER_IS_THE_LICENCE },
];

const STORED_BY_THE_READ_OF_2026_10_03: StoredQuote[] = [
  { vendor: "Render", tier: "Hobby", text: "Hobby For individuals building personal projects and prototypes. $ 0 /mo + compute Deploy for free" },
  { vendor: "Supabase", tier: "Free", text: "Perfect for passion projects & simple websites. Start for Free $ 0 / month Get started with: Unlimited API requests 50,000 monthly active users 500 MB database size Shared CPU • 500 MB RAM 5 GB egress 5 GB cached egress 1 GB file storage Community support Free projects are paused after 1 week of inactivity. Limit of 2 active projects." },
  { vendor: "Firebase", tier: "Spark", text: "No-cost (Spark plan) Generous no-cost usage limits No payment method needed" },
  { vendor: "Apify", tier: "Free", text: "Free $0 $5 to spend in Apify Store or on your own Actors $0.2 per compute unit Community support No Apify Store discount Start for free No credit card required." },
  { vendor: "Cursor", tier: "Free", text: "Hobby For the tinkerer Free Includes: ✓ No credit card required ✓ Limited Agent requests ✓ Access to Composer Try Cursor" },
  { vendor: "Mistral AI", tier: "Free", text: "Free Your personal AI agent for everyday tasks. Test out Vibe’s capabilities. Access on web and mobile. Limited messages and web searches. Limited coding sessions. State-of-the-art image generation. Test Mistral models in Studio. $10 /mo in API credits. 100+ connectors." },
  { vendor: "Doppler", tier: "Free", text: "Free for 3 users $8/mo per additional user Integrations Doppler CLI for local development Service tokens Email alerts and recurring reminders 3 days of activity logs Secrets referencing Secret value types API and webhooks access Config syncs (5)" },
  { vendor: "Pixlr", tier: "Free", text: "Pixlr is free for Education. See Plans & Pricing" },
  { vendor: "Cerebras", tier: "Trial", text: "New accounts receive $5 in free credits after adding a verified payment method. These credits expire 30 days after they’re granted and can be used across all public models. There is no charge until you choose to purchase additional credits." },
  { vendor: "Cohere", tier: "Free", text: "API calls made from a Trial API key are free. However, trial keys are rate limited and are not permitted to be used for production or commercial purposes." },
  { vendor: "LocalStack", tier: "Free", text: "Hobby For hobbyists & other non-commercial usage. Free" },
  { vendor: "Brave Search API", tier: "Free", text: "Includes $5 in free credits every month Credits are automatically applied to your account" },
  { vendor: "Grafana k6 Cloud", tier: "Free", text: "free Always free Always $0 Perfect for personal projects, exploring new ideas, and early-stage startups. No charges ever. Start free Benefits: All Grafana Cloud services, with usage limits Adaptive Telemetry, AI Assistant, and much more Community support 14 days retention for metrics, logs, traces, profiles, & k6 performance tests" },
  { vendor: "Deepgram", tier: "Free Credits", text: "Price Free $200 Credit then pay-as-you-go" },
  { vendor: "Weaviate", tier: "Open Source", text: "Database Engram ✦ Always free Free Forever $0 /mo No credit card required A fully managed AI Database to explore Weaviate features. Easiest way to get started, always free. Start free ✓ Always free — 1 cluster per user, upgrade to paid anytime. ✓ 100,000 objects · 1 GB memory · 10 GB disk. ✓ 1 collection, up to 3 tenants. ✓ Embeddings (2,000 req/day) + Query Agent (1,000 req/mo)." },
  { vendor: "Thunder Client", tier: "Free", text: "Free $0 Per user/month Billed monthly Includes: Extension VS Code Free version limits" },
  { vendor: "Middleware.io", tier: "Free", text: "Free Forever $0 Free access to all features with monthly limits. Sign Up Now Up to 100GB Data Up to 1k RUM Sessions Up to 20k Synthetic Checks 10 Browser Test Runs 2 million OpsAI Tokens Unlimited Users Community Based Support 14 day retention" },
  { vendor: "360 Monitoring", tier: "Lite", text: "Lite Perfect for single server or site owners. Free forever. $ 0 /mo Start Now" },
  { vendor: "Bitrise", tier: "Hobby", text: "Hobby Build and distribute your passion project without the extra cost. ‍ Free Forever Get started Access for a team of one (that's you!) Enough build credits for you to build your small project a few times per month Support from the Bitrise Community via Slack or Discuss forum" },
  { vendor: "Calendarific", tier: "Free", text: "Free $0.00 /Month Save $0.00 on yearly plan 500 Calls/month Attribution Required Community Support Single Language Limited Historical Data Limited Upcoming Data Dataset updated quarterly" },
  { vendor: "CarAPI.dev", tier: "Free", text: "Free Perfect for testing and small projects 100 requests/month All API endpoints Basic support" },
  { vendor: "Conversion Tools", tier: "Free", text: "100 free API calls/month + 100 AI credits/month" },
  { vendor: "Doczilla", tier: "Free", text: "Hobby €0/mo Ideal for developers exploring the platform. 250 requests/month No credit card needed 30 requests per minute" },
  { vendor: "Market Data API", tier: "Free", text: "$0 Forever 100 Sheets Formulas 100 Daily API Credits Standard API Endpoints 1 Year Historical Data 24h Delayed Stock Data 24h Delayed Options Data" },
  { vendor: "MockAPI", tier: "Free", text: "Free Projects 1 Resources 2 Custom response Collaboration" },
  { vendor: "Sofodata", tier: "Free", text: "Pricing Free € 0 per month 2 APIs 2,500 API Calls 10MB Disk Space 1 API-calls/sec Sign up" },
  { vendor: "Tavily AI", tier: "Free", text: "Researcher Free / month For new creators 1,000 API credits / month No credit card required Email support" },
  { vendor: "UniRateAPI", tier: "Free", text: "$0 /month Perfect for testing and personal projects 870+ currencies (FIAT + Crypto) Historical forex data 200 requests/day EU VAT rates included IBAN validation API Precious metals API" },
  { vendor: "RepoForge", tier: "Free", text: "Free For open source projects £ 0 / user / mo 100 MB storage Free forever Unlimited public packages Not for commercial use" },
  { vendor: "Pullflow", tier: "Free", text: "$ 0 forever For open source projects, startups, and small dev teams. Unlimited public repos Public users unlimited Unlimited private repo 5 private-repo users" },
  { vendor: "RightFeature", tier: "Free", text: "Starter Free Forever free Perfect for getting started Get Started 1 Product 1 Product board 1 Team member Custom statuses Guest posting AI Features" },
  { vendor: "DatoCMS", tier: "Free", text: "No signup. No email. No credit card. Launch the demo", neverSaysItIsTheFreeOffer: true },
  { vendor: "Supermaven", tier: "Free", text: "Free Tier $0 /month The fastest copilot, completely free. Fast, high-quality code suggestions Works with large codebases 7-day data retention limit ( details )" },
  { vendor: "Have I been pwned?", tier: "Free", text: "0 Data Breaches", neverSaysItIsTheFreeOffer: true },
  { vendor: "Authress", tier: "Free", text: "First 1000 billable calls are free Default SLAs for all customers, no matter the size" },
  { vendor: "Pocket Alert", tier: "Free", text: "Yes — the free plan gives you 50 push notifications a day with one device, one application, and one webhook, free forever and with no credit card required." },
  { vendor: "fivenines.io", tier: "Trial", text: "No credit card · 14-day free trial · Live in 2 minutes" },
  { vendor: "pagecrawl.io", tier: "Free", text: "Free Forever $ 0 / month $0 billed annually Track 6 pages Get started for free Pages : Up to 6 Checks : Up to 220 Frequency : Up to 60 min" },
  { vendor: "Northflank", tier: "Free", text: "Sandbox for testing and building trust with Northflank Always-on-compute – no sleeping :) 2× free services 1× free database 2× free cron jobs Get started for free" },
  { vendor: "Back4App", tier: "Free", text: "Start for Free — Perfect for developing, learning and prototyping 25K Requests 250MB Database 1GB Transfer 1GB Files" },
  { vendor: "SourceForge", tier: "Free", text: "New customers get $300 in free credits to run, test, and deploy workloads. All customers can use 25+ products for free, up to monthly usage limits." },
  { vendor: "Ente", tier: "Free", text: "10GB free forever End-to-end encrypted backups Stored in 3 locations 10GB free forever End-to-end encrypted backups Stored in 3 locations" },
  { vendor: "QRtracer", tier: "Free", text: "Free to create. Choose tracking next. No credit card. 1,000+ QR codes generated 100+ registered users 20,000+ recorded scans" },
  { vendor: "ShadcnUI", tier: "Free", text: "Minimum Payout Amount $2500.00 x $50 (MIN) $10,000 (MAX)", neverSaysItIsTheFreeOffer: true },
  { vendor: "inspectlet.com", tier: "Free", text: "PAGEVIEWS TRACKED 0 Pageviews tracked per month across all user sessions", neverSaysItIsTheFreeOffer: true },
  { vendor: "Microsoft for Startups", tier: "Startup Program", programme: true, text: "Access cutting-edge AI models, developer tools, and up to $150,000 in credits , backed by Microsoft’s global customer network, enterprise-grade security, and privacy you can trust." },
  { vendor: "ScaleGrid Startup Program", tier: "Startup Program", programme: true, text: "Up to 50% Off MySQL™ PostgreSQL® MongoDB® Redis® FOR 12 MONTHS DBaaS Plans Bring Your Own Cloud (BYOC) 50% off medium or larger plan sizes Dedicated Hosting 25% off medium or larger plan sizes Eligibility Criteria Less than $1.5M in revenue Less than $1.5M in funding New to ScaleGrid Small plan sizes receive 50% off BYOC and 25% off Dedicated Hosting plans for 3 months." },
  { vendor: "Esri Startup Program", tier: "Startup Program", programme: true, text: "Be founded within the last five years, generating less than US$2 million annually" },
  { vendor: "MATLAB and Simulink for Startups", tier: "Startup Program", programme: true, text: "Founded within the last 5 years Fewer than 15 engineers Less than $1 million USD in annual revenue" },
  { vendor: "Google Cloud BigQuery", tier: "Always Free", text: "The first 1 TiB of query data processed per month is free." },
  { vendor: "Google Cloud Build", tier: "Always Free", text: "Each billing account comes with 2,500 free build-minutes per month." },
  { vendor: "Google Cloud Logging", tier: "Always Free", text: "First 50 GiB/project/month July 1, 2018" },
  { vendor: "Standard Notes", tier: "Free", text: "Standard Free You’ll have End-to-end encryption Unlimited device sync on web, desktop, and mobile Plain text notes Offline access Organize your notes into tags Password protect individual notes Full data export in encrypted or plaintext format Two-factor authentication Daily encrypted email backups Community support Start for free" },
  { vendor: "Dropbox", tier: "Free (Basic)", text: "Basic Free 2 GB to store and share your files" },
  { vendor: "Exa", tier: "Free", text: "The Free Tier gives you $10 in credits (up to 2,500 Instant searches) the day you sign up, and your free balance resets to $10 on the first of every month. No payment method required. Complete onboarding in the dashboard and your first team earns a one-time $10 bonus." },
  { vendor: "Fireworks AI", tier: "Free Credits", text: "Simply add a payment method to buy credits, and usage is then deducted from your balance. Usage is billed on output, input, and cached tokens. Turn on Auto Reload to top up automatically when your balance runs low, or set a monthly spend limit to cap usage.", neverSaysItIsTheFreeOffer: true },
];

const A_STARTUP_PROGRAMME = { type: "startup", conditions: ["Founded within the last five years"], program: "Startup Program" };

function listingOf(quote: Pick<StoredQuote, "vendor" | "tier" | "programme">) {
  return {
    vendor: quote.vendor,
    category: "Dev Utilities",
    tier: quote.tier,
    url: `https://${quote.vendor.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example/pricing`,
    ...(quote.programme ? { eligibility: A_STARTUP_PROGRAMME } : {}),
  };
}

const pageCarrying = (text: string) => `Pricing ${text} Contact sales`;

async function readAgain(quote: StoredQuote, { copied, held }: { copied: string; held?: string }) {
  const offer = listingOf(quote);
  const record: Record<string, unknown> = { ...offer, ...(held ? { [FREE_PLAN_EXCERPT]: { text: held, url: offer.url, read_on: "2026-10-02" } } : {}) };
  const result = await excerptTheFreePlan(record, {
    offer,
    pageText: pageCarrying(quote.text),
    read: async () => ({ copied, terms: copied ? [copied] : [], otherPlans: [] }),
    readOn: "2026-10-03",
  });
  return { result, stored: (record[FREE_PLAN_EXCERPT] as { text: string } | undefined)?.text ?? null };
}

const refused = STORED_BY_THE_READ_OF_2026_10_02.filter((quote) => quote.refusedAs);
const kept = STORED_BY_THE_READ_OF_2026_10_02.filter((quote) => !quote.refusedAs);

describe("the 28 quotes the read of 2026-10-02 stored, met again by the checks a new copy meets", () => {
  it("refuses 9 of them, each for its own reason, whatever terms the reader names", async () => {
    assert.strictEqual(refused.length, 9);
    for (const quote of refused) {
      const { result, stored } = await readAgain(quote, { copied: quote.text });
      assert.deepStrictEqual([stored, result.why], [null, quote.refusedAs], quote.vendor);
    }
  });

  it("writes the other 19 as the page words them", async () => {
    assert.strictEqual(kept.length, 19);
    for (const quote of kept) {
      const { result, stored } = await readAgain(quote, { copied: quote.text });
      assert.deepStrictEqual([result.outcome, stored], ["written", quote.text], quote.vendor);
    }
  });

  it("removes each of the 9 that a listing still holds at its next read, though the page still carries it, and keeps each of the 19", async () => {
    for (const quote of refused) {
      const { stored } = await readAgain(quote, { copied: "", held: quote.text });
      assert.strictEqual(stored, null, quote.vendor);
    }
    for (const quote of kept) {
      const { result, stored } = await readAgain(quote, { copied: "", held: quote.text });
      assert.deepStrictEqual([result.held_excerpt, stored], ["kept", quote.text], quote.vendor);
    }
  });

  it("gives each stored quote the verdict the vendor page publishes by", () => {
    for (const quote of STORED_BY_THE_READ_OF_2026_10_02) {
      const verdict = tierWhoseFreeOfferIsTheLicence(quote.tier) ? TIER_WHOSE_FREE_OFFER_IS_THE_LICENCE : whyTheExcerptCannotStand(quote.text, listingOf(quote));
      assert.strictEqual(verdict, quote.refusedAs ?? null, quote.vendor);
    }
  });
});

const NEVER_SAY_IT = ["DatoCMS", "Have I been pwned?", "ShadcnUI", "inspectlet.com", "Fireworks AI"];

describe("the 56 quotes the read of 2026-10-03 stored, met by the rule that a quote says it is the free offer", () => {
  const never = STORED_BY_THE_READ_OF_2026_10_03.filter((quote) => quote.neverSaysItIsTheFreeOffer);
  const refusedForThatAlone = never.filter((quote) => whyTheExcerptCannotStand(quote.text, listingOf(quote)) === EXCERPT_NEVER_SAYS_IT_IS_THE_FREE_OFFER);

  it("finds 5 that never say so, a demo button, a breach counter, a payout table, a pageview counter and paid-billing text, and 51 that do", () => {
    assert.strictEqual(STORED_BY_THE_READ_OF_2026_10_03.length, 56);
    assert.deepStrictEqual(never.map((quote) => quote.vendor), NEVER_SAY_IT);
    for (const quote of STORED_BY_THE_READ_OF_2026_10_03) {
      assert.strictEqual(saysItIsTheFreeOffer(quote.text, listingOf(quote)), !quote.neverSaysItIsTheFreeOffer, quote.vendor);
    }
  });

  it("refuses for that reason the 4 of them every earlier check lets stand, and none of the 51", () => {
    assert.deepStrictEqual(refusedForThatAlone.map((quote) => quote.vendor), ["Have I been pwned?", "ShadcnUI", "inspectlet.com", "Fireworks AI"]);
    assert.strictEqual(whyTheExcerptCannotStand(never[0].text, listingOf(never[0])), EXCERPT_NAMES_NO_ALLOWANCE_LIMIT_OR_PRICE);
    for (const quote of STORED_BY_THE_READ_OF_2026_10_03.filter((stored) => !stored.neverSaysItIsTheFreeOffer)) {
      assert.notStrictEqual(whyTheExcerptCannotStand(quote.text, listingOf(quote)), EXCERPT_NEVER_SAYS_IT_IS_THE_FREE_OFFER, quote.vendor);
    }
  });

  it("refuses each of the 4 when the reader copies it again, and removes each one a listing still holds though the page still carries it", async () => {
    for (const quote of refusedForThatAlone) {
      const copiedAgain = await readAgain(quote, { copied: quote.text });
      const heldAgain = await readAgain(quote, { copied: "", held: quote.text });
      assert.deepStrictEqual([copiedAgain.stored, copiedAgain.result.why, heldAgain.stored, heldAgain.result.held_excerpt], [null, EXCERPT_NEVER_SAYS_IT_IS_THE_FREE_OFFER, null, "removed"], quote.vendor);
    }
  });
});

describe("a quote says it is the free offer", () => {
  const basic = { vendor: "Acme", tier: "Basic" };
  const sayIt = (texts: string[], plan: { vendor: string; tier: string; eligibility?: typeof A_STARTUP_PROGRAMME } = basic) => {
    for (const text of texts) assert.strictEqual(saysItIsTheFreeOffer(text, plan), true, text);
  };
  const neverSayIt = (texts: string[], plan: { vendor: string; tier: string; eligibility?: typeof A_STARTUP_PROGRAMME } = basic) => {
    for (const text of texts) assert.strictEqual(saysItIsTheFreeOffer(text, plan), false, text);
  };

  it("keeps a quote that says free as a word of its own, in any case", () => {
    sayIt(["Free for 3 users", "100 free API calls/month", "2× free services", "14-day free trial", "FREE: 3 projects", "Free-tier limits: 3 projects"]);
  });

  it("reads no free inside a longer word", () => {
    neverSayIt(["Freedom to export 3 projects", "Carefree setup for 3 projects", "Freemium analytics: 3 dashboards"]);
  });

  it("keeps a quote that gives a zero price, the symbol before or after, with or without a space or zero decimals", () => {
    sayIt(["$0 /month", "$ 0 forever", "$0.00 /Month", "€0/mo 250 requests/month", "Pricing € 0 per month 2 APIs", "£ 0 / user / mo", "¥0 for 1 GB", "₹0 for 1 GB", "0 € per month, 2 projects", "0,00 € a month for 2 projects", "0 USD per month for 3 projects", "0 $ par mois, 2 projets"]);
  });

  it("reads no zero price into a price that starts with 0 and is not zero, a price over zero, or a count of 0", () => {
    neverSayIt(["$0.2 per compute unit", "$0.005 per request", "$0.50 per GB", "$10 a month", "€0.99 per seat", "10 € per month", "1.0 € per GB", "20 USD per month", "0 Data Breaches", "PAGEVIEWS TRACKED 0 Pageviews tracked per month across all user sessions", "Minimum Payout Amount $2500.00 x $50 (MIN) $10,000 (MAX)"]);
  });

  it("keeps a quote that says no cost, spaced or hyphenated", () => {
    sayIt(["Generous no-cost usage limits", "No cost for the first project", "no‑cost usage of 3 projects", "No  cost up to 3 projects"]);
    neverSayIt(["Know the cost of 3 projects", "Low cost: 3 projects"]);
  });

  it("keeps a quote that gives a first allowance, and reads none into first without a figure after it", () => {
    sayIt(["First 50 GiB/project/month", "The first 1 TiB of query data processed per month", "First 1000 billable calls", "the first $10 of usage each month"]);
    neverSayIt(["Your first project gets 3 GB", "first-time users get 3 projects", "Firstly, 3 projects"]);
  });

  it("counts a first allowance only where the quote states no price above zero, the allowance's own figure aside", () => {
    neverSayIt(["First 10 TB / month $0.09 per GB", "First 1,000 requests, then $ 0.001 each", "the first $10 of usage, then $0.50 per GB", "The first 5 GB, then 0.02 € per GB", "First 3 projects, or 20 USD a month for 10", "Then ¥120 per GB after the first 10 GB"]);
    sayIt(["First 50 GiB/project/month", "the first $10 of usage each month", "the first 25 € of usage each month", "First 10 GB and the first 25 € of usage each month", "First 1,000,000 requests, then 1 request per second"]);
    sayIt(["First 10 TB / month free, then $0.09 per GB", "First 10 TB / month $0 per GB, then $0.09 per GB"]);
  });

  it("keeps a quote that names the plan as a whole word, as the listing names it", () => {
    sayIt(["Hobby For individuals building personal projects 250 requests/month"], { vendor: "Acme", tier: "Hobby" });
    sayIt(["Lite (Personal) 2 GB of storage"], { vendor: "Acme", tier: "Lite (Personal)" });
    neverSayIt(["For hobbyists: 250 requests/month"], { vendor: "Acme", tier: "Hobby" });
    neverSayIt(["Lite 2 GB of storage"], { vendor: "Acme", tier: "Lite (Personal)" });
  });

  it("reads no free offer into the vendor's own name, and none into a word the vendor's name ends", () => {
    neverSayIt(["Free Acme: 0 Data Breaches"], { vendor: "Free Acme", tier: "Basic" });
    sayIt(["Free Acme is free for 3 users"], { vendor: "Free Acme", tier: "Basic" });
    neverSayIt(["Freedom to export 3 projects"], { vendor: "Dom", tier: "Basic" });
  });

  it("asks nothing of a programme's listing, whose offer is a credit or a discount", () => {
    const programme = { vendor: "Acme", tier: "Startup Program", eligibility: A_STARTUP_PROGRAMME };
    sayIt(["Up to 50% off for 12 months", "Up to $150,000 in credits"], programme);
    neverSayIt(["Up to 50% off for 12 months", "Up to $150,000 in credits"]);
  });
});

describe("a quote holds no template syntax and no HTML entity the page never rendered", () => {
  const plan = { vendor: "Acme", tier: "Free" };

  it("refuses double braces, a dollar brace and a template tag", () => {
    for (const text of ["Basic ${{ price.basic }} /month per host", "Free {{ plan.limit }} builds a month", "Free }} 3 projects", "Free ${limit} requests a day", "Free {% if annual %}10{% endif %} GB"]) {
      assert.strictEqual(whyTheExcerptCannotStand(text, plan), EXCERPT_HOLDS_TEMPLATE_SYNTAX, text);
    }
  });

  it("refuses a named or numbered entity, and keeps an ampersand that starts none", () => {
    for (const text of ["Free &emsp; 3 projects", "Free&nbsp;3 projects", "Free &#8203;3 projects", "Free &#x200B;3 projects"]) {
      assert.strictEqual(whyTheExcerptCannotStand(text, plan), EXCERPT_HOLDS_AN_UNDECODED_ENTITY, text);
    }
    for (const text of ["Free: 3 projects & 1 GB of storage", "Free R&D credits: $500", "Terms & conditions apply to the 5 GB free plan"]) {
      assert.strictEqual(whyTheExcerptCannotStand(text, plan), null, text);
    }
  });
});

describe("a quote repeats no run of its own words", () => {
  const words = (count: number, from = 0) => Array.from({ length: count }, (_, at) => `w${from + at}`).join(" ");

  it(`refuses a run of ${LONGEST_RUN_AN_EXCERPT_MAY_REPEAT + 1} words said twice, and keeps a run of ${LONGEST_RUN_AN_EXCERPT_MAY_REPEAT}`, () => {
    const longest = words(LONGEST_RUN_AN_EXCERPT_MAY_REPEAT);
    const longer = words(LONGEST_RUN_AN_EXCERPT_MAY_REPEAT + 1);
    assert.strictEqual(repeatsARunOfItsOwnWords(`Free 5 GB ${longer} then 10 TB ${longer} more`), true);
    assert.strictEqual(repeatsARunOfItsOwnWords(`Free 5 GB ${longest} then 10 TB ${longest} more`), false);
  });

  it("refuses a copy that holds two cards ending in the same eight words", () => {
    const twoCards = "Get up to $350,000 in credits if you're Seed to Series A Build and grow with $200,000 in cloud credits (or up to $350,000 for AI-first startups) through the Google for Startups Cloud Program. Apply now Get $2,000 to build your MVP Ideate and iterate your MVP with $2,000 in credits with the Google for Startups Cloud Program. Apply now";
    assert.strictEqual(whyTheExcerptCannotStand(twoCards, { vendor: "Google Cloud", tier: "Startup Program", eligibility: A_STARTUP_PROGRAMME }), EXCERPT_REPEATS_A_RUN_OF_ITS_WORDS);
  });

  it("refuses a copy that is one stretch said twice, however short", () => {
    assert.strictEqual(repeatsARunOfItsOwnWords("Free 5 GB Free 5 GB"), true);
    assert.strictEqual(whyTheExcerptCannotStand("10GB free forever 10GB free forever", { vendor: "Acme", tier: "Free" }), EXCERPT_REPEATS_A_RUN_OF_ITS_WORDS);
  });

  it("keeps plan rows that share their wording, as a discount table's rows do", () => {
    for (const text of ["Up to 3 projects, up to 3 users", "DBaaS Plans 50% off medium or larger plan sizes Dedicated Hosting 25% off medium or larger plan sizes", "Pages : Up to 6 Checks : Up to 220 Frequency : Up to 60 min"]) {
      assert.strictEqual(repeatsARunOfItsOwnWords(text), false, text);
    }
  });

  it("reads overlapping occurrences of a run as one", () => {
    assert.strictEqual(repeatsARunOfItsOwnWords(`Free ${Array.from({ length: LONGEST_RUN_AN_EXCERPT_MAY_REPEAT + 2 }, () => "ha").join(" ")} 5 GB`), false);
  });
});

describe("a quote holds no date beside its terms that no word ties to them", () => {
  it("refuses a date read from the column beside the allowance, in any common spelling", () => {
    for (const text of ["First 50 GiB/project/month July 1, 2018", "July 1, 2018 First 50 GiB/project/month", "First 50 GiB per month 1 July 2018", "First 50 GiB per month 2018-07-01", "First 50 GiB per month 7/1/2018", "First 50 GiB per month Jul. 2018"]) {
      assert.strictEqual(holdsADateBesideTheTerms(text), true, text);
      assert.strictEqual(whyTheExcerptCannotStand(text, { vendor: "Acme", tier: "Always Free" }), EXCERPT_HOLDS_A_DATE_BESIDE_THE_TERMS, text);
    }
  });

  it("keeps a date the words tie to the terms, such as the day a plan ends or a rule starts", () => {
    for (const text of ["Free until December 31, 2026: 5 GB of storage", "Can use credit for AI tools? No, from September 14, 2026", "Effective 1 July 2026, the free plan gives 3 projects", "The free tier ends on 2027-01-31 and holds 10 GB", "50 GB free a month, as of March 2026"]) {
      assert.strictEqual(holdsADateBesideTheTerms(text), false, text);
    }
  });

  it("reads no date into a year alone, a figure or a word that merely starts like a month", () => {
    for (const text of ["2026 plans: 5 GB free", "Decimal precision on 2,048 requests a day", "May use up to 3 projects", "Free for 2026 users"]) {
      assert.strictEqual(holdsADateBesideTheTerms(text), false, text);
    }
  });
});

describe("a quote names an allowance, a limit or a price for the plan", () => {
  const free = { vendor: "Acme", tier: "Free" };
  const programme = { vendor: "Acme", tier: "Startup Program", eligibility: A_STARTUP_PROGRAMME };

  it("keeps a figure, a limit, a use the plan rules out or the period of an allowance", () => {
    for (const text of ["Free for 3 users", "$0 /month", "Unlimited device sync", "Trial keys are rate limited", "Personal, non-commercial use.", "Enough build credits to build a small project a few times per month", "14-day free trial"]) {
      assert.strictEqual(namesAnAllowanceALimitOrAPrice(text, free), true, text);
    }
  });

  it("refuses a copy that only says how to sign up or who may have the plan", () => {
    for (const text of ["No signup. No email. No credit card. Launch the demo", "Acme is free for Education. See Plans & Pricing", "NO REGISTRATION REQUIRED", "Free forever for students", "Get free credits after a verified payment method"]) {
      assert.strictEqual(whyTheExcerptCannotStand(text, free), EXCERPT_NAMES_NO_ALLOWANCE_LIMIT_OR_PRICE, text);
    }
  });

  it("counts who may apply as a term of a programme, and only of a programme", () => {
    assert.strictEqual(namesAnAllowanceALimitOrAPrice("Open to startups and nonprofits", programme), true);
    assert.strictEqual(namesAnAllowanceALimitOrAPrice("Open to startups and nonprofits", free), false);
  });

  it("counts no figure that describes the site or its customers rather than the plan", () => {
    const text = "Free to create. Choose tracking next. No credit card. 1,000+ QR codes generated 100+ registered users 20,000+ recorded scans";
    assert.strictEqual(whyTheExcerptCannotStand(text, free), EXCERPT_NAMES_NO_ALLOWANCE_LIMIT_OR_PRICE);
    assert.strictEqual(namesAnAllowanceALimitOrAPrice("10k+ teams use Acme. Free plan: 2 projects", free), true);
    assert.strictEqual(namesAnAllowanceALimitOrAPrice("Trusted by 10k+ teams", free), false);
    assert.strictEqual(namesAnAllowanceALimitOrAPrice("2.9% + 30 cents per charge", free), true);
  });

  it("counts no figure inside the vendor's or the plan's own name, or inside a product's model name", () => {
    assert.strictEqual(namesAnAllowanceALimitOrAPrice("1Password Free Sign up", { vendor: "1Password", tier: "Free" }), false);
    assert.strictEqual(namesAnAllowanceALimitOrAPrice("Starter 2 Free", { vendor: "Acme", tier: "Starter 2" }), false);
    assert.strictEqual(namesAnAllowanceALimitOrAPrice("Learn more about the free VM program for e2-micro VM instance.", free), false);
  });
});

describe("a Free OSS listing carries no quote", () => {
  it("names only the Free OSS tier, however it is spaced or cased", () => {
    for (const tier of ["Free OSS", "free oss", " Free  OSS "]) assert.strictEqual(tierWhoseFreeOfferIsTheLicence(tier), true, tier);
    for (const tier of ["Free", "Open Source", "OSS Sponsored", "OSS Teams", "Self-Hosted", "Free OSS Cloud"]) assert.strictEqual(tierWhoseFreeOfferIsTheLicence(tier), false, tier);
  });

  it("never asks the reader about one, and removes a quote one still holds", async () => {
    const quote = { vendor: "Acme", tier: "Free OSS", text: "Includes a free tier with 10k metrics and 50GB logs." };
    const asked: string[] = [];
    const offer = listingOf(quote);
    for (const held of [undefined, { text: quote.text, url: offer.url, read_on: "2026-10-02" }]) {
      const record: Record<string, unknown> = { ...offer, ...(held ? { [FREE_PLAN_EXCERPT]: held } : {}) };
      const result = await excerptTheFreePlan(record, { offer, pageText: pageCarrying(quote.text), read: async () => { asked.push(offer.vendor); return { copied: quote.text, terms: [quote.text] }; }, readOn: "2026-10-03" });
      assert.deepStrictEqual([result.outcome, result.why, FREE_PLAN_EXCERPT in record], [held ? "removed" : "free_offer_is_the_licence", TIER_WHOSE_FREE_OFFER_IS_THE_LICENCE, false]);
    }
    assert.deepStrictEqual(asked, []);
  });
});
