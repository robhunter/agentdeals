import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const PAGE = "/cicd-free-tier-comparison-2026";
const PRICING = "/ci-cd-pricing";
const ALTERNATIVES = "/ci-cd-alternatives";
const GITHUB_ACTIONS_ALTERNATIVES = "/github-actions-alternatives";
const SITEMAPS_OF_GUIDES_AND_REPORTS = ["/sitemap-pages.xml", "/sitemap-reports.xml", "/sitemap-misc.xml"];

const MAIN_TABLE_ROWS: Record<string, string[]> = {
  "GitHub Actions": [
    "2 vCPU, 8 GB RAM (Linux, private repos); 4 vCPU, 16 GB (public)"
  ],
  "GitLab CI": [
    "500 jobs in active pipelines",
    "10 GiB per project (repo + LFS only); artifacts up to 1 GB each, 30 days",
    "2 vCPU, 8 GB RAM (default Linux runner)",
    "Same rate; GitLab for Open Source projects get 50K minutes"
  ],
  "CircleCI": [
    "2 GB-months storage + 1 GB transfer, then credits",
    "Open source: up to 400,000 credits/mo (Linux, Arm, Docker)",
    "Free runner time; 5 concurrent self-hosted tasks"
  ],
  "Bitbucket Pipelines": [
    "10 steps at once (100 self-hosted)",
    "4 GB (1x step); 8 GB (2x, double minutes)",
    "Yes (no build minutes used)"
  ],
  "Google Cloud Build": [
    "10-30 concurrent builds (default pool)"
  ],
  "Buildkite": [
    "Hosted Linux Small (2 vCPU, 4 GB) or your hardware",
    "Yes (Free plan, up to 5 users)"
  ],
  "Harness CI": [
    "2 GB cache; 1 GB transfer"
  ],
  "Bitrise": [
    "5 concurrent",
    "90-min build timeout",
    "macOS Medium/Large, Linux Medium",
    "1 private app; unlimited public apps",
    "Paid plans only"
  ],
  "Drone CI": [
    "One machine (Community Edition)"
  ]
};

const MAIN_TABLE_CELLS_WITHDRAWN: Record<string, string[]> = {
  "GitHub Actions": [
    "2 vCPU, 7 GB RAM (Linux)"
  ],
  "GitLab CI": [
    "Varies by runner",
    "5 GB project storage (incl. artifacts + registry)",
    "1 vCPU, 3.75 GB RAM (shared)",
    "Same limits for all repos"
  ],
  "CircleCI": [
    "Included in credits",
    "Same limits for all repos",
    "Free (unlimited)"
  ],
  "Bitbucket Pipelines": [
    "1 concurrent",
    "4 GB RAM (2x pipeline)",
    "No"
  ],
  "Google Cloud Build": [
    "10 concurrent"
  ],
  "Buildkite": [
    "Your hardware (self-hosted)",
    "Yes (personal)"
  ],
  "Harness CI": [
    "Included in credits"
  ],
  "Bitrise": [
    "1 concurrent",
    "10-min build time limit",
    "Standard runners",
    "Same limits for all repos",
    "No"
  ],
  "Drone CI": [
    "Unlimited"
  ]
};

const SECTION_TABLE_ROWS: Array<{ section: string; vendor: string; cells: string[]; withdrawn: string[] }> = [
  {
    "section": "developer-focused",
    "vendor": "Buildkite",
    "cells": [
      "Free plan: 5 users, 10 concurrent jobs, 2,000 hosted minutes/mo",
      "Up to 10 concurrent jobs on Free",
      "10 concurrent jobs"
    ],
    "withdrawn": [
      "Free for personal use (unlimited self-hosted agents)",
      "Unlimited, first-class",
      "Unlimited (your hardware)"
    ]
  },
  {
    "section": "developer-focused",
    "vendor": "Semaphore CI",
    "cells": [
      "Unlimited (Community Edition); $0.0025/min on Cloud",
      "Self-hosted teams"
    ],
    "withdrawn": [
      "Unlimited",
      "Self-hosted, Ruby/Elixir communities"
    ]
  },
  {
    "section": "developer-focused",
    "vendor": "Buddy",
    "cells": [
      "1 seat, 1 concurrent run, 300 pipeline GB-minutes/mo"
    ],
    "withdrawn": [
      "5 projects, 500 executions/mo"
    ]
  },
  {
    "section": "general-purpose",
    "vendor": "GitHub Actions",
    "cells": [
      "33,000+ marketplace actions"
    ],
    "withdrawn": [
      "17,000+ marketplace actions"
    ]
  },
  {
    "section": "general-purpose",
    "vendor": "GitLab CI",
    "cells": [
      "Built-in (outside the 10 GiB limit)"
    ],
    "withdrawn": [
      "Built-in (5 GB total)"
    ]
  },
  {
    "section": "mobile",
    "vendor": "Bitrise",
    "cells": [
      "300 credits/mo, 5 concurrent",
      "iOS, Android and cross-platform apps"
    ],
    "withdrawn": [
      "300 credits/mo, 1 concurrent",
      "Broadest mobile platform support"
    ]
  },
  {
    "section": "mobile",
    "vendor": "Codemagic",
    "cells": [
      "macOS M2 (Linux builds billed)",
      "First-class (built by Nevercode)",
      "Flutter apps"
    ],
    "withdrawn": [
      "Linux runners",
      "First-class (by Flutter team)",
      "Flutter apps (built by Flutter team)"
    ]
  },
  {
    "section": "mobile",
    "vendor": "Appcircle",
    "cells": [
      "20 builds/mo, 30 min/build, 1 concurrent"
    ],
    "withdrawn": [
      "25 min/build, limited builds"
    ]
  },
  {
    "section": "specialized",
    "vendor": "Codefresh",
    "cells": [
      "No published free plan (now part of Octopus Deploy)"
    ],
    "withdrawn": [
      "3 users, 1 concurrent, unlimited builds"
    ]
  },
  {
    "section": "specialized",
    "vendor": "Terramate",
    "cells": [
      "Free up to 2 users, 1,000 resources",
      "IaC orchestration inside your CI/CD"
    ],
    "withdrawn": [
      "Free for open source",
      "Infrastructure-as-code CI/CD"
    ]
  },
  {
    "section": "self-hosted",
    "vendor": "Drone CI",
    "cells": [
      "Kubernetes runner (Beta; not in the Community Edition)"
    ],
    "withdrawn": [
      "Kubernetes runner"
    ]
  }
];

const STATED_ON_THE_PAGE: string[] = [
  "Quick verdict: On public repositories, GitHub Actions' standard runners are free with no minute limit. For private repositories, GitHub Free includes 2,000 minutes a month. GitLab Free includes 400 compute minutes a month and a container registry. CircleCI Free gives 30,000 credits a month (up to 6,000 minutes on a small Docker resource class) and 30 concurrent jobs. Buildkite's Free plan includes 5 users, 10 concurrent jobs and 2,000 Linux vCPU minutes a month (1,000 minutes on its 2-vCPU agent).",
  "The CI/CD landscape in 2026: GitHub announced a charge for self-hosted runners on 2025-12-16 and postponed it the next day, with no new date. GitLab Free has included 400 compute minutes a month since October 2020. Drone's free open-source edition runs on a single machine; Woodpecker CI is a community fork of Drone. For mobile CI, Bitrise's free Hobby plan gives 300 credits a month and Codemagic 500 macOS M2 build minutes.",
  "Minutes vs credits: GitHub charges each runner type its own per-minute rate. GitLab multiplies job time by a cost factor. CircleCI and Bitrise use their own credits, which do not compare across vendors. On public repositories, GitHub Actions' standard runners have no minute limit. For private repositories, CircleCI's 30,000 monthly credits cover up to 6,000 minutes on a small Docker resource class.",
  "Four hosted CI/CD services with free tiers: GitHub Actions, GitLab CI, CircleCI and Bitbucket Pipelines.",
  "GitHub Marketplace lists more than 33,000 actions. GitLab puts CI/CD, a container registry and issue tracking in one platform. CircleCI Free runs 30 concurrent Linux jobs, against GitHub Free's 20. Bitbucket Pipelines Free gives 50 build minutes a month on cloud runners, the smallest of these four, and does not charge build minutes for self-hosted runners.",
  "Buildkite's Free plan supports up to 5 users and 10 concurrent jobs, with 2,000 Linux vCPU minutes a month on Buildkite-hosted agents, which is 1,000 minutes on its 2-vCPU Small agent. Jobs can also run on your own agents.",
  "Semaphore is a hosted cloud service with $15 of free credits a month. Its free, self-hosted Community Edition has unlimited users and concurrency.",
  "Codemagic is built by Nevercode Ltd and launched for Flutter apps at Flutter Live 2018. Its free plan gives 500 macOS M2 build minutes a month.",
  "Bitrise's Step Library has 400+ pre-built steps for iOS, Android, React Native and Flutter workflows.",
  "Codefresh publishes no free plan: its pricing page redirects to Octopus Deploy, which acquired Codefresh in February 2024 and directs Codefresh CI inquiries to its team. Google Cloud Build gives 2,500 build-minutes a month per billing account.",
  "Woodpecker CI and Drone's Apache 2.0 Community Edition are open source and run on your own servers with no build-minute limits. Drone's Community Edition runs on one machine.",
  "Drone's open-source edition runs on one machine. Its Enterprise edition is free for individuals and small companies; larger ones get a trial. Woodpecker CI is an Apache 2.0 community fork of Drone. You pay for the machines that run them.",
  "Past the free quota, GitHub charges $0.006 a minute for Linux 2-core, $0.010 for Windows 2-core and $0.062 for macOS 3- or 4-core. Its docs no longer list multipliers but say usage totals include them. GitLab's cost factor multiplies job time: 1 on small Linux, 2 on medium, 6 on macOS M1 (paid tiers only).",
  "GitLab: each project's 10 GiB covers its Git repository and LFS only. Artifacts can be up to 1 GB each and expire after 30 days unless set otherwise. CircleCI: Artifacts stored for 30 days on free plan. No cache is unlimited: GitHub includes 10 GB per repository and drops entries unused for 7 days; GitLab-hosted runners drop caches not updated in 14 days; CircleCI keeps caches 15 days; Bitbucket caches are 1 GB each, kept 7 days.",
  "Bitbucket Pipelines Free runs up to 10 steps at once on cloud runners and 100 on self-hosted runners. Codemagic's free plan runs one build at a time; Bitrise Hobby allows 5. GitHub Free allows 20 concurrent jobs on standard runners (5 for macOS).",
  "Google Cloud Build charges network egress at standard rates; its pricing page names no free allowance. CircleCI meters network transfer only to self-hosted runners: Free includes 1 GB, then draws from credits. GitLab publishes no data-transfer allowance for its Free tier.",
  "GitHub and GitLab charge nothing for jobs on your own runners. Buildkite's Free plan allows up to 10 concurrent jobs on self-hosted agents. CircleCI Free runs at most 5 self-hosted tasks at once and draws credits for storage and network use past its allotments. You pay for the machines that host the runners.",
  "Unlimited free minutes for public repos on standard runners, 33,000+ marketplace actions, native GitHub integration.",
  "GitLab CI: 400 min/mo, unlimited minutes on your own runners (up to 50 per project) and a built-in container registry.",
  "First-class Flutter, iOS and Android support",
  "400+ pre-built steps for mobile workflows.",
  "skips tasks that already ran with the same inputs",
  "Drone's Community Edition runs on one machine; Woodpecker is an Apache 2.0 community fork of Drone.",
  "See Hidden Costs and Gotchas for what you pay past the free limits."
];

const WITHDRAWN_FROM_EVERY_GUIDE: string[] = [
  "down from 400 to 400",
  "5 GB project storage",
  "best free option for Kubernetes",
  "Free for 3 users with unlimited builds",
  "allows only 1 concurrent build",
  "macOS minutes at 10x",
  "17,000+ marketplace",
  "unlimited self-hosted agents",
  "unlimited free self-hosted",
  "Codefresh (1,200 free min)",
  "built by the Flutter",
  "Built by the Flutter"
];

const RANKING_BADGES: string[] = [
  "BEST OSS",
  "MOST CREDITS",
  "BEST ALL-IN-ONE",
  "ECOSYSTEM LEADER",
  "BEST SELF-HOSTED",
  "BEST FLUTTER",
  "MOST MATURE",
  "Best for Open Source",
  "Most Generous Credits",
  "Best Self-Hosted"
];

const UNSOURCED_TREND_ON_THE_PRICING_PAGE: string[] = [
  "Free CI/CD minutes are shrinking while self-hosted runner support is expanding.",
  "Buildkite continues to offer unlimited free self-hosted agents.",
];

const GITHUB_RATES_ON_THE_PRICING_PAGE ="GitHub charges a per-minute rate for each runner type past the free quota: $0.006 for Linux 2-core, $0.010 for Windows 2-core and $0.062 for macOS.";

let server: ChildProcess;
let base = "";
const served = new Map<string, string>();

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;|’/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&rarr;/g, "→")
    .replace(/&#10003;/g, "✓")
    .replace(/&#10007;/g, "✗")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function textOf(html: string): string {
  return decode(
    html
      .replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/g, " ")
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").replace(/ ([,.:;])/g, "$1").trim();
}

function rowsOf(html: string): string[][] {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => textOf(cell)))
    .filter((cells) => cells.length >= 2);
}

function tableAfter(html: string, heading: string): string {
  const at = html.indexOf(heading);
  assert.ok(at >= 0, `the page has a section headed ${heading}`);
  const start = html.indexOf("<table", at);
  return html.slice(start, html.indexOf("</table>", start));
}

async function routesIn(sitemap: string): Promise<string[]> {
  const xml = await (await fetch(`${base}${sitemap}`)).text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => new URL(loc).pathname);
}


function rowOf(rows: string[][], vendor: string): string[] | undefined {
  return rows.find((cells) => cells[0] === vendor || cells[0].startsWith(`${vendor} `));
}

describe("the CI/CD free tier comparison states each service's terms as the vendor does", () => {
  before(async () => {
    server = spawn("node", [path.join(REPO, "dist", "serve.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PORT: "0", BASE_URL: "http://localhost", TZ: "UTC" },
    });
    base = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 30000);
      server.stderr!.on("data", (data: Buffer) => {
        const match = data.toString().match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://localhost:${match[1]}`);
        }
      });
      server.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    const routes = new Set<string>([PAGE, PRICING, ALTERNATIVES, GITHUB_ACTIONS_ALTERNATIVES]);
    for (const sitemap of SITEMAPS_OF_GUIDES_AND_REPORTS) for (const route of await routesIn(sitemap)) routes.add(route);
    for (const route of routes) {
      const response = await fetch(`${base}${route}`);
      if (response.status === 200) served.set(route, await response.text());
    }
  });
  after(() => {
    server?.kill();
  });

  it("reads the page, the three pages that repeat its claims, and the rest of the guides and reports", () => {
    assert.ok(served.size > 60, `read ${served.size} routes`);
    for (const route of [PAGE, PRICING, ALTERNATIVES, GITHUB_ACTIONS_ALTERNATIVES]) assert.ok(served.has(route), `${route} renders`);
  });

  it("sets each main table cell as the vendor's own pages state it", () => {
    const rows = rowsOf(tableAfter(served.get(PAGE)!, 'id="main-comparison"'));
    const missing = Object.entries(MAIN_TABLE_ROWS).flatMap(([vendor, cells]) => {
      const row = rowOf(rows, vendor);
      if (!row) return [`${vendor}: no row`];
      return cells.filter((cell) => !row.includes(cell)).map((cell) => `${vendor}: ${cell}`);
    });
    assert.deepStrictEqual(missing, []);
    const standing = Object.entries(MAIN_TABLE_CELLS_WITHDRAWN).flatMap(([vendor, cells]) =>
      cells.filter((cell) => rowOf(rows, vendor)?.includes(cell)).map((cell) => `${vendor}: ${cell}`));
    assert.deepStrictEqual(standing, []);
  });

  it("sets each section table cell as the vendor's own pages state it", () => {
    const html = served.get(PAGE)!;
    const wrong = SECTION_TABLE_ROWS.flatMap(({ section, vendor, cells, withdrawn }) => {
      const row = rowOf(rowsOf(tableAfter(html, `id="${section}"`)), vendor);
      if (!row) return [`${section} / ${vendor}: no row`];
      return [
        ...cells.filter((cell) => !row.includes(cell)).map((cell) => `${section} / ${vendor}: missing ${cell}`),
        ...withdrawn.filter((cell) => row.includes(cell)).map((cell) => `${section} / ${vendor}: still ${cell}`),
      ];
    });
    assert.deepStrictEqual(wrong, []);
  });

  it("states every paragraph, use case and FAQ answer as written", () => {
    const text = textOf(served.get(PAGE)!);
    assert.deepStrictEqual(STATED_ON_THE_PAGE.filter((sentence) => !text.includes(sentence)), []);
  });

  it("ranks no service in a badge or a stat card", () => {
    const html = served.get(PAGE)!;
    assert.deepStrictEqual(RANKING_BADGES.filter((badge) => html.includes(badge)), []);
    assert.ok(!html.includes('class="winner-badge"'));
  });

  it("repeats none of the withdrawn claims on any guide or report", () => {
    const found = [...served].flatMap(([route, html]) =>
      WITHDRAWN_FROM_EVERY_GUIDE.filter((claim) => textOf(html).includes(claim)).map((claim) => `${route}: ${claim}`));
    assert.deepStrictEqual(found, []);
  });

  it("gives GitHub's per-minute rates on the pricing page, and sells no Codefresh free plan there or on either alternatives page", () => {
    assert.ok(textOf(served.get(PRICING)!).includes(GITHUB_RATES_ON_THE_PRICING_PAGE));
    for (const route of [PRICING, ALTERNATIVES]) {
      const rows = rowsOf(served.get(route)!).filter((cells) => cells[0].startsWith("Codefresh"));
      assert.deepStrictEqual(rows, [], route);
    }
    const handTyped = rowsOf(served.get(GITHUB_ACTIONS_ALTERNATIVES)!)
      .filter((cells) => cells[0].startsWith("Codefresh") && cells.includes("120 builds/mo"));
    assert.deepStrictEqual(handTyped, [], GITHUB_ACTIONS_ALTERNATIVES);
  });

  it("states no trend on the pricing page that no source gives", () => {
    const text = textOf(served.get(PRICING)!);
    for (const sentence of UNSOURCED_TREND_ON_THE_PRICING_PAGE) {
      assert.ok(!text.includes(sentence), `${PRICING} still says: ${sentence}`);
    }
  });

  it("keeps GitHub's and CircleCI's free allowances and Google Cloud Build's minutes", () => {
    const html = served.get(PAGE)!;
    assert.ok(textOf(html).includes("2,000 min/mo"));
    assert.ok(textOf(html).includes("30,000 credits/mo"));
    assert.match(rowOf(rowsOf(tableAfter(html, 'id="main-comparison"')), "Google Cloud Build")![1], /^2,500 min\/mo/);
  });
});
