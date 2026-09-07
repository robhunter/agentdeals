import { describe, it } from "node:test";
import assert from "node:assert";
const {
  classifyClient,
  classifyRequest,
  isObservabilityPath,
  CLIENT_CLASSES,
  AGENT_TRIGGERS,
  agentFamiliesByTrigger,
  agentFamilyRuleCount,
  agentTriggerForFamily,
  clientRuleTable,
} = await import("../src/client-class.ts");
type ClientClass = import("../src/client-class.ts").ClientClass;

const UA = {
  chatgptUser: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
  oaiSearch: "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)",
  gptbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
  claudeUser: "Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)",
  claudeCode: "claude-code/2.1.4 (external, cli)",
  claudeBot: "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  perplexityUser: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Perplexity-User/1.0",
  perplexityBot: "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  googleExtended: "Mozilla/5.0 (compatible; Google-Extended/1.0)",
  applebotExtended: "Mozilla/5.0 (compatible; Applebot-Extended/0.1; +http://www.apple.com/go/applebot)",
  applebot: "Mozilla/5.0 (compatible; Applebot/0.1; +http://www.apple.com/go/applebot)",
  metaAgent: "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  ccbot: "CCBot/2.0 (https://commoncrawl.org/faq/)",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  bingbot: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  ahrefs: "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
  semrush: "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",
  curl: "curl/8.5.0",
  undici: "undici",
  httpx: "python-httpx/0.27.0",
  requests: "python-requests/2.31.0",
  go: "Go-http-client/2.0",
  chrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  safariIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  headless: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36",
  facebookExternal: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  uptime: "Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)",
  unknownBot: "Mozilla/5.0 (compatible; SomeNewThingBot/1.0; +http://example.com/bot)",
  internal: "agentdeals-internal/1.0 (verification)",
  claudeCodeReal: "Claude-User (claude-code/2.1.260; +https://support.anthropic.com/)",
  garbage: "\u0000\u0001 xyzzy",
} as const;

const REAL_CLAUDE_CODE_UAS = [
  UA.claudeCodeReal,
  "Claude-User (claude-code/2.1.255; +https://support.anthropic.com/)",
  "Claude-User (claude-code/2.1.252; +https://support.anthropic.com/)",
] as const;

describe("classifyClient — AI agents", () => {
  const cases: [keyof typeof UA, string][] = [
    ["chatgptUser", "ChatGPT-User"],
    ["oaiSearch", "OAI-SearchBot"],
    ["gptbot", "GPTBot"],
    ["claudeUser", "Claude-User"],
    ["claudeCode", "Claude-Code"],
    ["claudeBot", "ClaudeBot"],
    ["perplexityUser", "Perplexity-User"],
    ["perplexityBot", "PerplexityBot"],
    ["googleExtended", "Google-Extended"],
    ["applebotExtended", "Applebot-Extended"],
    ["metaAgent", "meta-externalagent"],
    ["ccbot", "CCBot"],
  ];
  for (const [key, family] of cases) {
    it(`${key} -> ai_agent / ${family}`, () => {
      const got = classifyClient(UA[key]);
      assert.equal(got.client_class, "ai_agent", `${key} misclassified as ${got.client_class}`);
      assert.equal(got.family, family);
    });
  }

  it("counts every AI agent the old isBot() filter discarded", () => {
    const discarded = [UA.chatgptUser, UA.oaiSearch, UA.claudeUser, UA.gptbot, UA.claudeBot];
    for (const ua of discarded) {
      assert.equal(classifyClient(ua).client_class, "ai_agent");
    }
  });
});

describe("classifyClient — ordering traps", () => {
  it("Applebot-Extended is an AI crawler, plain Applebot is a search crawler", () => {
    assert.equal(classifyClient(UA.applebotExtended).client_class, "ai_agent");
    assert.equal(classifyClient(UA.applebot).client_class, "search_crawler");
  });

  it("Claude-User (agent mid-task) is distinguished from ClaudeBot (training crawler)", () => {
    assert.equal(classifyClient(UA.claudeUser).family, "Claude-User");
    assert.equal(classifyClient(UA.claudeBot).family, "ClaudeBot");
  });

  it("a coding-agent request carries both tokens and is not filed as the plain one", () => {
    for (const ua of REAL_CLAUDE_CODE_UAS) {
      assert.match(ua, /Claude-User/, "the observed strings carry both tokens — that is the whole trap");
      assert.match(ua, /claude-code/);
      const seen = classifyClient(ua);
      assert.equal(seen.family, "Claude-Code", `${ua} must not be pooled into Claude-User`);
      assert.equal(seen.client_class, "ai_agent");
    }
    const plain = classifyClient(UA.claudeUser);
    assert.equal(plain.family, "Claude-User");
    assert.equal(plain.client_class, "ai_agent");
    assert.notEqual(classifyClient(REAL_CLAUDE_CODE_UAS[0]).family, plain.family);
  });

  it("OAI-SearchBot is an AI agent, not a search crawler, despite the name", () => {
    assert.equal(classifyClient(UA.oaiSearch).client_class, "ai_agent");
  });

  it("HeadlessChrome carries a full browser UA but is not a human", () => {
    assert.equal(classifyClient(UA.headless).client_class, "sdk_client");
    assert.equal(classifyClient(UA.headless).family, "headless-browser");
  });

  it("a Mozilla-shaped UA that also declares itself a bot is not a browser", () => {
    assert.equal(classifyClient(UA.unknownBot).client_class, "other_bot");
    assert.match(UA.unknownBot, /Mozilla/);
  });
});

describe("classifyClient — the rest of the taxonomy", () => {
  it("search crawlers", () => {
    assert.equal(classifyClient(UA.googlebot).client_class, "search_crawler");
    assert.equal(classifyClient(UA.bingbot).client_class, "search_crawler");
  });

  it("SEO crawlers are separate from search crawlers", () => {
    assert.equal(classifyClient(UA.ahrefs).client_class, "seo_crawler");
    assert.equal(classifyClient(UA.semrush).client_class, "seo_crawler");
  });

  it("SDK clients stay out of ai_agent — overclaiming them would make the headline unquotable", () => {
    for (const key of ["curl", "undici", "httpx", "requests", "go"] as const) {
      assert.equal(classifyClient(UA[key]).client_class, "sdk_client", key);
    }
  });

  it("browsers", () => {
    for (const key of ["chrome", "safariIos", "firefox", "edge"] as const) {
      assert.equal(classifyClient(UA[key]).client_class, "browser", key);
    }
    assert.equal(classifyClient(UA.edge).family, "edge");
  });

  it("declared non-AI bots land in other_bot, not unknown", () => {
    assert.equal(classifyClient(UA.facebookExternal).client_class, "other_bot");
    assert.equal(classifyClient(UA.uptime).client_class, "other_bot");
  });

  it("an absent or unreadable User-Agent is unknown, not guessed", () => {
    assert.equal(classifyClient("").client_class, "unknown");
    assert.equal(classifyClient(undefined).client_class, "unknown");
    assert.equal(classifyClient(null).client_class, "unknown");
    assert.equal(classifyClient("   ").client_class, "unknown");
    assert.equal(classifyClient(UA.garbage).client_class, "unknown");
  });
});

describe("classifyClient — invariants", () => {
  it("returns exactly one class from the fixed taxonomy for any input", () => {
    const inputs = [...Object.values(UA), "", "x", "a".repeat(5000), "%00%00", "ChatGPT"];
    for (const ua of inputs) {
      const got = classifyClient(ua);
      assert.ok(
        CLIENT_CLASSES.includes(got.client_class as ClientClass),
        `${got.client_class} is not in the taxonomy`,
      );
    }
  });

  it("never returns the user agent, or any fragment of it, as the family — NO PII", () => {
    const nonce = "SECRET-abc123-DEVICE-ID";
    for (const shape of [`Mozilla/5.0 (${nonce}) Chrome/126.0`, `curl/8.5.0 ${nonce}`, nonce]) {
      const { family } = classifyClient(shape);
      assert.ok(!family.includes(nonce), `family leaked the UA: ${family}`);
      assert.ok(family.length <= 32, `family is unbounded: ${family}`);
    }
  });

  it("is pure — repeated calls give the same answer", () => {
    for (const ua of Object.values(UA)) {
      const a = classifyClient(ua);
      const b = classifyClient(ua);
      const c = classifyClient(ua);
      assert.deepEqual(a, b);
      assert.deepEqual(b, c);
    }
  });
});

describe("classifyRequest — internal attribution", () => {
  it("observing the system is not using it, whatever the user agent says", () => {
    for (const path of ["/api/pageviews", "/api/query-log", "/api/traffic", "/api/metrics", "/health"]) {
      assert.equal(classifyRequest(path, UA.chrome).client_class, "internal", path);
      assert.equal(classifyRequest(path, UA.chatgptUser).client_class, "internal", path);
      assert.equal(classifyRequest(path, "").client_class, "internal", path);
    }
  });

  it("ignores the query string when matching an observability path", () => {
    assert.equal(classifyRequest("/api/query-log?limit=200", UA.curl).client_class, "internal");
  });

  it("the rollup endpoints are internal, so the collector cannot inflate what it records", () => {
    assert.equal(isObservabilityPath("/api/analytics/daily"), true);
    assert.equal(isObservabilityPath("/api/analytics/history"), true);
    assert.equal(classifyRequest("/api/analytics/daily?date=2026-08-20", UA.curl).client_class, "internal");
    assert.equal(classifyRequest("/api/analytics/history", UA.chrome).client_class, "internal");
  });

  it("a content path is classified on its user agent, not its path", () => {
    assert.equal(classifyRequest("/vendor/neon", UA.chatgptUser).client_class, "ai_agent");
    assert.equal(classifyRequest("/api/offers", UA.chrome).client_class, "browser");
    assert.equal(classifyRequest("/best/free-databases", UA.googlebot).client_class, "search_crawler");
  });

  it("the internal user-agent marker works, and is an additional signal not the mechanism", () => {
    assert.equal(classifyRequest("/vendor/neon", UA.internal).client_class, "internal");
    assert.equal(classifyRequest("/best/free-databases", UA.curl).client_class, "sdk_client");
  });

  it("isObservabilityPath tolerates junk input", () => {
    assert.equal(isObservabilityPath(""), false);
    assert.equal(isObservabilityPath("/api/pageviews/extra"), false);
    assert.equal(isObservabilityPath(undefined as unknown as string), false);
  });
});

function expandBranch(source: string, from: number, stop: string): { candidates: string[]; next: number } {
  let candidates = [""];
  const branches: string[][] = [];
  let i = from;
  const flush = () => {
    branches.push(candidates);
    candidates = [""];
  };
  const append = (parts: string[]) => {
    const out: string[] = [];
    for (const head of candidates) for (const tail of parts) out.push(head + tail);
    candidates = out;
  };
  while (i < source.length) {
    const ch = source[i];
    if (stop && ch === stop) break;
    if (ch === "|") {
      flush();
      i++;
      continue;
    }
    if (ch === "^" || ch === "$") {
      i++;
      continue;
    }
    if (ch === "\\") {
      const esc = source[i + 1];
      i += 2;
      if (esc === "b" || esc === "B") continue;
      if (esc === "d") append(["1"]);
      else if (esc === "s") append([" "]);
      else if (esc === "w") append(["a"]);
      else append([esc]);
      continue;
    }
    if (ch === "[") {
      const close = source.indexOf("]", i + 1);
      assert.ok(close > i, `unterminated character class in ${source}`);
      const body = source.slice(i + 1, close);
      assert.ok(!body.startsWith("^"), `negated character class is not expandable in ${source}`);
      const first = body.startsWith("\\") ? body.slice(0, 2) : body.slice(0, 1);
      append([first === "\\d" ? "1" : first === "\\w" ? "a" : first.replace("\\", "")]);
      i = close + 1;
      if (source[i] === "?") i++;
      continue;
    }
    if (ch === "(") {
      let start = i + 1;
      if (source.startsWith("(?:", i)) start = i + 3;
      const inner = expandBranch(source, start, ")");
      assert.equal(source[inner.next], ")", `unterminated group in ${source}`);
      i = inner.next + 1;
      const optional = source[i] === "?";
      if (optional) i++;
      append(optional ? [...inner.candidates, ""] : inner.candidates);
      continue;
    }
    assert.ok(!"*+{".includes(ch), `unsupported quantifier ${ch} in ${source} — widen the expander rather than skipping the rule`);
    append([ch]);
    i++;
  }
  flush();
  return { candidates: branches.flat(), next: i };
}

function candidatesFor(pattern: RegExp): string[] {
  const expanded = expandBranch(pattern.source, 0, "");
  const usable = expanded.candidates.filter((c) => c.length > 0);
  assert.ok(usable.length > 0, `no candidate string could be built from ${pattern}`);
  for (const candidate of usable) {
    assert.match(candidate, pattern, "a candidate that does not match its own rule would make this property vacuous");
  }
  return usable;
}

describe("the client rule table — every family it declares is reachable", () => {
  const table = clientRuleTable();

  it("builds a matching candidate string for every rule in the table", () => {
    assert.ok(table.length > 50, `only ${table.length} rules read from the table`);
    for (const rule of table) assert.ok(candidatesFor(rule.pattern).length > 0);
  });

  it("no rule is shadowed by an earlier one — a first-match table can strand a family silently", () => {
    const stranded: string[] = [];
    for (const rule of table) {
      const reaches = candidatesFor(rule.pattern).some((candidate) => {
        const seen = classifyClient(candidate);
        return seen.family === rule.family && seen.client_class === rule.client_class;
      });
      if (!reaches) stranded.push(`${rule.client_class}/${rule.family} via ${rule.pattern}`);
    }
    assert.deepStrictEqual(stranded, []);
  });

  it("a rule inserted above an existing one is caught by that property", () => {
    const claudeUser = table.find((r) => r.family === "Claude-User");
    assert.ok(claudeUser, "the table must still declare Claude-User for this control to mean anything");
    const shadow = /Claude/i;
    const reaches = candidatesFor(claudeUser.pattern).some((candidate) => !shadow.test(candidate));
    assert.equal(reaches, false, "a broader rule above this one would swallow every string that reaches it");
  });
});

describe("the client rule table — one trigger per AI agent family", () => {
  it("every ai_agent rule declares a trigger and no other rule does", () => {
    for (const rule of clientRuleTable()) {
      if (rule.client_class === "ai_agent") {
        assert.ok(rule.trigger !== null, `${rule.family} is an AI agent family with no declared trigger`);
        assert.ok(AGENT_TRIGGERS.includes(rule.trigger), `${rule.family} declares an unknown trigger ${rule.trigger}`);
      } else {
        assert.equal(rule.trigger, null, `${rule.family} is ${rule.client_class} and cannot carry an agent trigger`);
      }
    }
  });

  it("the grouping covers every family in the table exactly once", () => {
    const grouped = agentFamiliesByTrigger();
    const flat = AGENT_TRIGGERS.flatMap((trigger) => grouped[trigger]);
    assert.equal(new Set(flat).size, flat.length, "a family in two groups would double-count its hits");
    assert.equal(flat.length, agentFamilyRuleCount(), "every ai_agent rule contributes exactly one family to the grouping");
    for (const rule of clientRuleTable()) {
      if (rule.client_class !== "ai_agent") continue;
      assert.ok(flat.includes(rule.family), `${rule.family} is in the table and absent from the grouping`);
      assert.equal(agentTriggerForFamily(rule.family), rule.trigger);
    }
  });

  it("a family with no rule has no trigger rather than a guessed one", () => {
    assert.equal(agentTriggerForFamily("unknown"), null);
    assert.equal(agentTriggerForFamily("SomeNewThingBot"), null);
  });

  it("the families that carry this project's own tooling are user_initiated and named as such", () => {
    assert.equal(agentTriggerForFamily("Claude-Code"), "user_initiated");
    assert.equal(agentTriggerForFamily("agent-scraper"), "ambiguous");
    assert.equal(classifyClient(UA.claudeCodeReal).family, "Claude-Code");
  });
});
