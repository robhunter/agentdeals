// Client-class attribution — the pure classifier (#1019).
//
// The whole point of the issue is that we were dropping AI-agent traffic on the floor,
// so the cases that matter most are the ones where a wrong answer is invisible: a
// ChatGPT-User read as a crawler, an Applebot-Extended read as a search engine, a
// headless browser read as a human. Each of those is asserted by name below.

import { describe, it } from "node:test";
import assert from "node:assert";
const {
  classifyClient,
  classifyRequest,
  isObservabilityPath,
  CLIENT_CLASSES,
} = await import("../src/client-class.ts");
type ClientClass = import("../src/client-class.ts").ClientClass;

// Real strings, as they appear in the wild and in our own request log.
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
  garbage: "\u0000\u0001 xyzzy",
} as const;

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

  // These are the exact user agents the issue found in the request log being dropped by
  // `isBot()`. If any of them ever reads as anything but ai_agent, we are back to
  // discarding the traffic the product exists to measure.
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

  it("OAI-SearchBot is an AI agent, not a search crawler, despite the name", () => {
    assert.equal(classifyClient(UA.oaiSearch).client_class, "ai_agent");
  });

  it("HeadlessChrome carries a full browser UA but is not a human", () => {
    assert.equal(classifyClient(UA.headless).client_class, "sdk_client");
    assert.equal(classifyClient(UA.headless).family, "headless-browser");
  });

  it("a Mozilla-shaped UA that also declares itself a bot is not a browser", () => {
    assert.equal(classifyClient(UA.unknownBot).client_class, "other_bot");
    // ...and the browser rules would have matched it, which is why the guard exists.
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
    // Edge's UA contains Chrome/ and Safari/ too; the more specific token has to win.
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
    // A long, distinctive UA. The family must come from the rule table, so nothing
    // request-derived can reach storage through it.
    const nonce = "SECRET-abc123-DEVICE-ID";
    for (const shape of [`Mozilla/5.0 (${nonce}) Chrome/126.0`, `curl/8.5.0 ${nonce}`, nonce]) {
      const { family } = classifyClient(shape);
      assert.ok(!family.includes(nonce), `family leaked the UA: ${family}`);
      assert.ok(family.length <= 32, `family is unbounded: ${family}`);
    }
  });

  it("is pure — repeated calls give the same answer", () => {
    // Regex objects with the /g flag carry lastIndex state and would fail this.
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
    // The documented gap: a bare curl against a content page cannot be inferred as ours.
    // It must land in sdk_client — never in ai_agent, which is the number we quote.
    assert.equal(classifyRequest("/best/free-databases", UA.curl).client_class, "sdk_client");
  });

  it("isObservabilityPath tolerates junk input", () => {
    assert.equal(isObservabilityPath(""), false);
    assert.equal(isObservabilityPath("/api/pageviews/extra"), false);
    assert.equal(isObservabilityPath(undefined as unknown as string), false);
  });
});
