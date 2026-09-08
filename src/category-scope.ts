import type { Offer } from "./types.js";
import { offerEnded } from "./retirement.js";

export type CategoryAudience = "developer" | "personal";

export type CategoryHolds = "products" | "programmes";

export interface CategoryScope {
  answers: string[];
  audience: CategoryAudience;
  scope: string;
  holds?: CategoryHolds;
  names?: Record<string, string>;
}

export const PROGRAMME_TIERS: readonly string[] = ["Startup Program", "Portfolio"];

export const CATEGORY_SCOPES: Record<string, CategoryScope> = {
  "Storage": {
    answers: ["where do my files live"],
    audience: "developer",
    scope: "Object storage, buckets and upload APIs an application writes to, plus the image and asset hosts built on them.",
  },
  "Cloud Storage": {
    answers: ["where do my files live"],
    audience: "personal",
    scope: "Consumer file-sync drives a person keeps documents and photos in — not storage an application writes to.",
  },
  "CDN": {
    answers: ["where do my files live"],
    audience: "developer",
    scope: "Edge caches and public script and asset CDNs that serve files stored somewhere else.",
  },

  "Cloud Hosting": {
    answers: ["where do I run my code"],
    audience: "developer",
    scope: "Managed platforms that deploy an application from a repository — PaaS, serverless and static hosts.",
  },
  "Cloud IaaS": {
    answers: ["where do I run my code"],
    audience: "developer",
    scope: "Cloud accounts that rent compute by the instance or by credit — the hyperscalers and the resellers on top of them, not a deploy pipeline.",
  },
  "Infrastructure": {
    answers: ["where do I run my code"],
    audience: "developer",
    scope: "Infrastructure-as-code, provisioning and orchestration tools that stand a deployment up — and the bare-metal hosts they target, including Hetzner.",
    names: { "Hetzner": "Infrastructure" },
  },
  "Server Management": {
    answers: ["where do I run my code"],
    audience: "developer",
    scope: "Control panels that administer a server someone has already rented elsewhere.",
  },

  "Monitoring": {
    answers: ["how do I find out it is broken"],
    audience: "developer",
    scope: "Uptime checks, metrics, tracing and the general-purpose observability suites — including Sentry and BetterStack, which also do the three names beside this one.",
    names: { "Sentry": "Monitoring", "BetterStack": "Monitoring" },
  },
  "Logging": {
    answers: ["how do I find out it is broken"],
    audience: "developer",
    scope: "Log shipping, retention and search, from tools that sell that alone.",
  },
  "Error Tracking": {
    answers: ["how do I find out it is broken"],
    audience: "developer",
    scope: "Crash and exception aggregation from dedicated error trackers; the observability suites that also do it, Sentry among them, are filed under Monitoring.",
    names: { "Sentry": "Monitoring" },
  },
  "Status Pages": {
    answers: ["how do I find out it is broken"],
    audience: "developer",
    scope: "Public status and incident pages that tell your own users something is down.",
  },

  "Security": {
    answers: ["who is allowed in, and where are the secrets kept"],
    audience: "developer",
    scope: "Code and dependency scanning, threat intel and network access control — the broad security suites, including 1Password.",
    names: { "1Password": "Security" },
  },
  "Auth": {
    answers: ["who is allowed in, and where are the secrets kept"],
    audience: "developer",
    scope: "Identity providers an application delegates sign-in to — hosted and self-hosted.",
  },
  "Secrets Management": {
    answers: ["who is allowed in, and where are the secrets kept"],
    audience: "developer",
    scope: "Vaults an application reads its own credentials from at run time, not vaults a person logs into.",
  },
  "Password Managers": {
    answers: ["who is allowed in, and where are the secrets kept"],
    audience: "personal",
    scope: "Vaults a person or a team logs into by hand; the suites that also sell one, including 1Password, are filed under Security.",
    names: { "1Password": "Security" },
  },

  "Testing": {
    answers: ["how do I check the code and the browser"],
    audience: "developer",
    scope: "Test runners, coverage, visual review and the hosted grids that execute a suite.",
  },
  "Browser Automation": {
    answers: ["how do I check the code and the browser"],
    audience: "developer",
    scope: "Headless browsers driven by a script, sold as browser sessions rather than as a test suite.",
  },
  "Web Scraping": {
    answers: ["how do I check the code and the browser"],
    audience: "developer",
    scope: "Extraction APIs that return a page as data — the same headless browsers, sold by the page.",
  },
  "Code Quality": {
    answers: ["how do I check the code and the browser"],
    audience: "developer",
    scope: "Static analysis, review bots and coverage reporting that read the source without running the product.",
  },

  "Databases": {
    answers: ["where do I put the data and query it"],
    audience: "developer",
    scope: "Hosted databases and the platforms sold around them — relational, document, key-value and vector.",
  },
  "Search": {
    answers: ["where do I put the data and query it"],
    audience: "developer",
    scope: "Search indexes queried by relevance rather than by key.",
  },
  "Headless CMS": {
    answers: ["where do I put the data and query it"],
    audience: "developer",
    scope: "Editorial stores with an authoring UI in front of them, read over an API.",
  },

  "Project Management": {
    answers: ["how do people working together talk and track work"],
    audience: "developer",
    scope: "Issue trackers, boards and planning tools that hold the work itself.",
  },
  "Team Collaboration": {
    answers: ["how do people working together talk and track work"],
    audience: "developer",
    scope: "Shared workspaces, scheduling and real-time editing around the work — not the chat clients and not the tracker.",
  },
  "Communication": {
    answers: ["how do people working together talk and track work"],
    audience: "developer",
    scope: "Chat, voice, video and support-desk APIs an application embeds — not an app a team signs into.",
  },
  "Communication & Messaging": {
    answers: ["how do people working together talk and track work"],
    audience: "personal",
    scope: "Chat and meeting apps a person signs into — Slack, Teams, Signal — not the APIs behind them.",
    names: { "Slack": "Communication & Messaging", "Signal": "Communication & Messaging" },
  },
  "Messaging": {
    answers: ["how do people working together talk and track work"],
    audience: "developer",
    scope: "Queues, pub/sub, webhooks and notification delivery between services, not between people.",
  },
  "Productivity & Notes": {
    answers: ["how do people working together talk and track work"],
    audience: "personal",
    scope: "Personal note-taking, documents and to-do apps kept by one person.",
  },

  "Design": {
    answers: ["what do I build the interface with"],
    audience: "developer",
    scope: "Interface and product design tools, asset libraries and generators used to build a screen.",
  },
  "Design & Creative": {
    answers: ["what do I build the interface with"],
    audience: "personal",
    scope: "Desktop creative applications — raster, vector, 3D and video editors installed on a machine.",
  },
  "Diagramming": {
    answers: ["what do I build the interface with"],
    audience: "developer",
    scope: "Whiteboards, flowcharts and architecture diagrams.",
  },
  "Low-Code Platforms": {
    answers: ["what do I build the interface with"],
    audience: "developer",
    scope: "Builders that generate an internal tool or admin UI from a data source without a front-end codebase.",
  },
  "Forms": {
    answers: ["what do I build the interface with"],
    audience: "developer",
    scope: "Form builders and form-submission back ends that collect a response.",
  },

  "API Development": {
    answers: ["how do I build and publish an API"],
    audience: "developer",
    scope: "Clients, mocking, schema tooling and integration platforms used while building an API of your own.",
  },
  "API Gateway": {
    answers: ["how do I build and publish an API"],
    audience: "developer",
    scope: "Gateways and proxies that sit in front of an API in production, doing routing, keys and rate limits.",
  },
  "Documentation": {
    answers: ["how do I build and publish an API"],
    audience: "developer",
    scope: "Documentation site generators and hosted docs platforms.",
  },

  "AI / ML": {
    answers: ["what runs the model"],
    audience: "developer",
    scope: "Model APIs, inference hosts, vector stores and training platforms called from your own code.",
  },
  "AI Coding": {
    answers: ["what runs the model", "what do I write code in"],
    audience: "developer",
    scope: "Coding agents and completion assistants that write or edit source, standalone or inside an editor.",
  },
  "Notebooks & Data Science": {
    answers: ["what runs the model"],
    audience: "developer",
    scope: "Hosted notebooks and analysis workspaces with compute attached.",
  },
  "IDE & Code Editors": {
    answers: ["what do I write code in"],
    audience: "developer",
    scope: "Editors, IDEs and cloud development environments — the surface the code is typed into.",
  },

  "Email": {
    answers: ["how does mail get sent and received"],
    audience: "developer",
    scope: "Transactional and bulk sending APIs, inbound parsing, deliverability and disposable-address services.",
  },
  "Consumer Email": {
    answers: ["how does mail get sent and received"],
    audience: "personal",
    scope: "Mailboxes a person reads their own mail in.",
  },

  "Video": {
    answers: ["where does video live"],
    audience: "developer",
    scope: "Video encoding, hosting and meeting-room APIs a product embeds.",
  },
  "Streaming & Media": {
    answers: ["where does video live"],
    audience: "personal",
    scope: "Consumer streaming services a person watches or listens to.",
  },

  "Workflow Automation": {
    answers: ["how do I run work in the background"],
    audience: "developer",
    scope: "Connector platforms that run a sequence of steps between products when something happens.",
  },
  "Background Jobs": {
    answers: ["how do I run work in the background"],
    audience: "developer",
    scope: "Job queues, schedulers and durable execution called from your own code.",
  },

  "Payments": {
    answers: ["where does the money go"],
    audience: "developer",
    scope: "Taking money from your customers — checkout, billing, merchant-of-record and the currency rates behind it.",
  },
  "Banking & Finance": {
    answers: ["where does the money go"],
    audience: "personal",
    scope: "Personal banking, transfers and investing apps.",
  },

  "Startup Perks": {
    answers: ["what does a company get for being a startup"],
    audience: "developer",
    scope: "Credit grants and discounted plans a company qualifies for by stage, accelerator or investor — not a free tier anyone can open.",
    holds: "programmes",
  },

  "CI/CD": {
    answers: [],
    audience: "developer",
    scope: "Pipelines that build, test and release on a push.",
  },
  "Source Control": {
    answers: [],
    audience: "developer",
    scope: "Hosted repositories and code forges.",
  },
  "Container Registry": {
    answers: [],
    audience: "developer",
    scope: "Registries that store and serve container images.",
  },
  "Analytics": {
    answers: [],
    audience: "developer",
    scope: "Product and web analytics, session capture and the pipelines that move events into them.",
  },
  "Feature Flags": {
    answers: [],
    audience: "developer",
    scope: "Flag and experiment services that switch behaviour without a deploy.",
  },
  "DNS & Domain Management": {
    answers: [],
    audience: "developer",
    scope: "Authoritative DNS, dynamic DNS, resolvers and domain registration.",
  },
  "Tunneling & Networking": {
    answers: [],
    audience: "developer",
    scope: "Tunnels and relays that expose a local port or join two networks.",
  },
  "Maps/Geolocation": {
    answers: [],
    audience: "developer",
    scope: "Map tiles, geocoding, IP location and weather APIs.",
  },
  "Localization": {
    answers: [],
    audience: "developer",
    scope: "Translation management and string catalogues for shipping a product in more than one language.",
  },
  "Mobile Development": {
    answers: [],
    audience: "developer",
    scope: "Mobile build, distribution and device-management services.",
  },
  "Dev Utilities": {
    answers: [],
    audience: "developer",
    scope: "Single-purpose APIs a product calls for one narrow thing — validation, conversion, enrichment, screenshots, reference data.",
  },
  "Education": {
    answers: [],
    audience: "personal",
    scope: "Courses and learning platforms.",
  },
  "News & Reading": {
    answers: [],
    audience: "personal",
    scope: "Read-later apps and feed readers.",
  },
  "VPN & Privacy": {
    answers: [],
    audience: "personal",
    scope: "Consumer VPNs and private relays.",
  },
  "Fitness & Health": {
    answers: [],
    audience: "personal",
    scope: "Activity, training and health-tracking apps.",
  },
  "Meditation & Wellness": {
    answers: [],
    audience: "personal",
    scope: "Meditation and mental-wellbeing apps.",
  },
};

export const CATEGORY_ALIASES: Record<string, string> = {
  "Startup Programs": "Startup Perks",
};

export interface CategoryRetirement {
  retired: string;
  reason: string;
}

export const CATEGORY_RETIREMENTS: Record<string, CategoryRetirement> = {
  "Streaming & Media": {
    retired: "2026-09-08",
    reason: "Consumer streaming and listening services are not infrastructure anyone selects while building software. The records were not wrong — the free tiers they described are real — they were out of scope for this index.",
  },
  "Banking & Finance": {
    retired: "2026-09-08",
    reason: "Personal banking, transfer and investing apps are not infrastructure anyone selects while building software. The records were not wrong — the free tiers they described are real — they were out of scope for this index.",
  },
  "News & Reading": {
    retired: "2026-09-08",
    reason: "Read-later apps and feed readers are not infrastructure anyone selects while building software. The records were not wrong — the free tiers they described are real — they were out of scope for this index.",
  },
  "Fitness & Health": {
    retired: "2026-09-08",
    reason: "Activity and health-tracking apps are not infrastructure anyone selects while building software. The records were not wrong — the free tiers they described are real — they were out of scope for this index.",
  },
  "Meditation & Wellness": {
    retired: "2026-09-08",
    reason: "Meditation and mental-wellbeing apps are not infrastructure anyone selects while building software. The records were not wrong — the free tiers they described are real — they were out of scope for this index.",
  },
};

export type CategoryState = "live" | "retired" | "absent";

export function resolveCategoryName(name: string): string {
  return CATEGORY_ALIASES[name] ?? name;
}

export function categoryState(name: string, liveNames: ReadonlySet<string>): CategoryState {
  const resolved = resolveCategoryName(name);
  if (liveNames.has(resolved)) return "live";
  if (CATEGORY_RETIREMENTS[resolved]) return "retired";
  return "absent";
}

export function retirementFor(name: string, liveNames: ReadonlySet<string>): CategoryRetirement | null {
  const resolved = resolveCategoryName(name);
  return categoryState(resolved, liveNames) === "retired" ? CATEGORY_RETIREMENTS[resolved] : null;
}

export function retiredCategoryNames(liveNames: ReadonlySet<string>): string[] {
  return Object.keys(CATEGORY_RETIREMENTS)
    .filter((name) => categoryState(name, liveNames) === "retired")
    .sort();
}

export function scopeFor(name: string): CategoryScope | null {
  return CATEGORY_SCOPES[resolveCategoryName(name)] ?? null;
}

export function publishedScopeFor(name: string, liveNames: ReadonlySet<string>): CategoryScope | null {
  return categoryState(name, liveNames) === "retired" ? null : scopeFor(name);
}

export function categoryHolds(name: string): CategoryHolds {
  return scopeFor(name)?.holds ?? "products";
}

export function familySiblings(name: string): string[] {
  const scope = CATEGORY_SCOPES[resolveCategoryName(name)];
  if (!scope) return [];
  const questions = new Set(scope.answers);
  if (questions.size === 0) return [];
  return Object.entries(CATEGORY_SCOPES)
    .filter(([other, s]) => other !== resolveCategoryName(name) && s.answers.some((a) => questions.has(a)))
    .map(([other]) => other)
    .sort();
}

export interface CategoryDirectoryEntry {
  name: string;
  slug: string;
  count: number;
  audience: CategoryAudience;
  holds: CategoryHolds;
  scope: string;
  answers: string[];
  also_answering: { name: string; slug: string; count: number }[];
  example_members: string[];
}

export const EXAMPLE_MEMBER_COUNT = 3;

export const EXAMPLE_MEMBERS_BASIS =
  "The first members of the category as we list them, with offers the vendor has ended left out. Not a ranking and not a size ordering — no record carries a size.";

export function buildCategoryDirectory(
  categories: { name: string; count: number }[],
  offers: Offer[],
  toSlug: (value: string) => string,
): CategoryDirectoryEntry[] {
  const counts = new Map(categories.map((c) => [c.name, c.count]));
  const membersByCategory = new Map<string, string[]>();
  for (const offer of offers) {
    if (offerEnded(offer)) continue;
    const held = membersByCategory.get(offer.category);
    if (held) {
      if (held.length < EXAMPLE_MEMBER_COUNT) held.push(offer.vendor);
    } else {
      membersByCategory.set(offer.category, [offer.vendor]);
    }
  }

  return categories.map((category) => {
    const scope = scopeFor(category.name);
    const siblings = familySiblings(category.name).filter((s) => counts.has(s));
    return {
      name: category.name,
      slug: toSlug(category.name),
      count: category.count,
      audience: scope?.audience ?? "developer",
      holds: scope?.holds ?? "products",
      scope: scope?.scope ?? "",
      answers: scope?.answers ?? [],
      also_answering: siblings.map((s) => ({ name: s, slug: toSlug(s), count: counts.get(s) ?? 0 })),
      example_members: membersByCategory.get(category.name) ?? [],
    };
  });
}
