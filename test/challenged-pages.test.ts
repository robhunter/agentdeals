import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

const {
  CHALLENGE_STATUSES,
  MIN_PAGE_TEXT_LENGTH,
  aChallengeARenderingClientCouldAnswer,
  challengeRendersThisRun,
  fetchPageText,
  forgetChallengeRenders,
  pageBehindAChallenge,
} = await import("../scripts/verify-freshness.js");
const {
  NO_RENDERING_CLIENT,
  READ_BY_RENDERING,
  RENDERED_ITS_OWN_ERROR_PAGE,
  RENDERED_THE_CHALLENGE_AGAIN,
  RENDER_TIMED_OUT,
  documentTitle,
  renderPageHtml,
  theRenderingClientsOwnErrorPage,
  theSitesBotChallenge,
  withoutARenderingClient,
} = await import("../scripts/rendered-page.js");
const { classifyFetchError, FAILURE_BOT_BLOCK } = await import("../scripts/verification-state.js");
const { priceSignals } = await import("../scripts/change-gate.js");
const { sourceCheckRecord } = await import("../scripts/vendor-naming.js");

const OFFER = {
  vendor: "Widgetson",
  category: "Monitoring",
  tier: "Free",
  description: "Free for up to 5 hosts",
  url: "https://widgetson.example/pricing",
};

const CHALLENGE_PROSE = (
  "Performing security verification. This website uses a security service to protect against " +
  "malicious bots. The action you just performed triggered it. Enable JavaScript and cookies to " +
  "continue. Ray ID: 0000000000000000. Performance and security by a third party. "
).repeat(3);

const INTERSTITIAL = `<html><head><title>Just a moment...</title></head><body><p>${CHALLENGE_PROSE}</p></body></html>`;

function pageOfAtLeastTheFloor(sentence: string) {
  const filler = " Paid plans add retention, alerting and single sign-on.";
  let body = sentence;
  while (body.length < MIN_PAGE_TEXT_LENGTH) body += filler;
  return `<html><head><title>Widgetson Pricing</title></head><body><p>${body}</p></body></html>`;
}

const RENDERED_WITH_TERMS = pageOfAtLeastTheFloor(
  "Widgetson pricing. The Free plan is $0 per month for up to 5 hosts."
);

function renderSpy(result: unknown) {
  const asked: string[] = [];
  return {
    asked,
    render: async (url: string) => {
      asked.push(url);
      return result;
    },
  };
}

async function readWhenTheSiteAnswers(
  status: number,
  options: Record<string, unknown>,
  url = OFFER.url
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html></html>", { status })) as typeof fetch;
  try {
    return await fetchPageText(url, { renderedThisRun: new Set(), ...options });
  } finally {
    globalThis.fetch = original;
  }
}

async function fetchPageTextAgainst(status: number, options: Record<string, unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html></html>", { status })) as typeof fetch;
  try {
    return await fetchPageText(OFFER.url, options);
  } finally {
    globalThis.fetch = original;
  }
}

beforeEach(() => forgetChallengeRenders());

describe("a page behind a challenge is read again by the rendering client", () => {
  for (const status of CHALLENGE_STATUSES) {
    it(`hands HTTP ${status} to the rendering client before recording a failure`, async () => {
      const spy = renderSpy({ ok: true, html: RENDERED_WITH_TERMS });
      const page = await readWhenTheSiteAnswers(status, { render: spy.render });
      assert.deepStrictEqual(spy.asked, [OFFER.url]);
      assert.strictEqual(page.ok, true);
      assert.ok(page.text.includes("Widgetson pricing"));
    });

    it(`records a page recovered from HTTP ${status} as read by rendering`, async () => {
      const spy = renderSpy({ ok: true, html: RENDERED_WITH_TERMS });
      const page = await readWhenTheSiteAnswers(status, { render: spy.render });
      assert.strictEqual(page.read, READ_BY_RENDERING);
      const check = sourceCheckRecord(OFFER, page, priceSignals(page.text), "2026-09-14");
      assert.strictEqual(check.rendered, true);
    });
  }

  it("keeps the status the fetcher was given, so the two readings can be compared", async () => {
    const spy = renderSpy({ ok: true, html: RENDERED_WITH_TERMS });
    const page = await readWhenTheSiteAnswers(403, { render: spy.render });
    assert.strictEqual(page.status_before_rendering, 403);
  });

  it("claims no landing place the rendering client never reported", async () => {
    const spy = renderSpy({ ok: true, html: RENDERED_WITH_TERMS });
    const page = await readWhenTheSiteAnswers(429, { render: spy.render });
    assert.strictEqual(page.finalUrl, undefined);
  });

  it("escalates exactly the statuses a browser could answer", () => {
    assert.deepStrictEqual(CHALLENGE_STATUSES, [401, 403, 429]);
    for (const status of CHALLENGE_STATUSES) {
      assert.strictEqual(aChallengeARenderingClientCouldAnswer(status), true);
    }
    for (const status of [200, 301, 404, 410, 418, 500, 503]) {
      assert.strictEqual(aChallengeARenderingClientCouldAnswer(status), false);
    }
  });

  it("grades the recovered reading like any other", async () => {
    const spy = renderSpy({ ok: true, html: RENDERED_WITH_TERMS });
    const page = await readWhenTheSiteAnswers(403, { render: spy.render });
    const check = sourceCheckRecord(OFFER, page, priceSignals(page.text), "2026-09-14");
    assert.strictEqual(check.outcome, "ok");
  });
});

describe("a challenge the rendering client cannot answer is recorded as it was before", () => {
  const unchanged = (page: any, status: number) => {
    assert.strictEqual(page.ok, false);
    assert.strictEqual(page.error, `HTTP ${status}`);
    assert.strictEqual(page.read, undefined);
    assert.strictEqual(classifyFetchError(page.error), FAILURE_BOT_BLOCK);
  };

  it("says HTTP 403 when the rendering client did not finish", async () => {
    const spy = renderSpy({ ok: false, error: RENDER_TIMED_OUT });
    unchanged(await readWhenTheSiteAnswers(403, { render: spy.render }), 403);
  });

  it("says HTTP 429 when the rendered page is still under the floor", async () => {
    const spy = renderSpy({ ok: true, html: `<html><body><p>Widgetson</p></body></html>` });
    unchanged(await readWhenTheSiteAnswers(429, { render: spy.render }), 429);
  });

  it("says HTTP 403 when the rendering client throws", async () => {
    const page = await readWhenTheSiteAnswers(403, {
      render: async () => {
        throw new Error("spawn failed");
      },
    });
    unchanged(page, 403);
  });

  it("says HTTP 401 when no rendering client is installed", async () => {
    unchanged(await readWhenTheSiteAnswers(401, { render: withoutARenderingClient }), 401);
  });

  it("says HTTP 403 when the rendering client is served the challenge in its turn", async () => {
    const page = await readWhenTheSiteAnswers(403, {
      render: async () => renderPageHtml(OFFER.url, {
        renderer: "/bin/sh",
        dump: async () => ({ ok: true, html: INTERSTITIAL }),
      }),
    });
    unchanged(page, 403);
  });
});

describe("what a challenge costs is bounded", () => {
  it("renders a url once however many offers cite it in a run", async () => {
    const ledger = new Set<string>();
    const spy = renderSpy({ ok: true, html: RENDERED_WITH_TERMS });
    const first = await readWhenTheSiteAnswers(403, { render: spy.render, renderedThisRun: ledger });
    const second = await readWhenTheSiteAnswers(403, { render: spy.render, renderedThisRun: ledger });
    assert.deepStrictEqual(spy.asked, [OFFER.url]);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.error, "HTTP 403");
  });

  it("renders a second url the same run reaches", async () => {
    const ledger = new Set<string>();
    const spy = renderSpy({ ok: true, html: RENDERED_WITH_TERMS });
    const other = "https://other.example/pricing";
    await readWhenTheSiteAnswers(403, { render: spy.render, renderedThisRun: ledger });
    await readWhenTheSiteAnswers(403, { render: spy.render, renderedThisRun: ledger }, other);
    assert.deepStrictEqual(spy.asked, [OFFER.url, other]);
  });

  it("counts the run's renders without being handed a ledger", async () => {
    const spy = renderSpy({ ok: true, html: RENDERED_WITH_TERMS });
    assert.strictEqual(challengeRendersThisRun(), 0);
    await fetchPageTextAgainst(403, { render: spy.render });
    await fetchPageTextAgainst(403, { render: spy.render });
    assert.strictEqual(challengeRendersThisRun(), 1);
    assert.deepStrictEqual(spy.asked, [OFFER.url]);
  });

  it("holds no slot against a url nothing could render", async () => {
    await fetchPageTextAgainst(403, { render: withoutARenderingClient });
    assert.strictEqual(challengeRendersThisRun(), 0);
  });
});

describe("a dump that is not the site is not a reading of the site", () => {
  it("refuses the rendering client's own error page", async () => {
    const errorPage = `<html><body class="neterror"><div id="main-message"><h1>This site can't be reached</h1></div></body></html>`;
    const rendered = await renderPageHtml(OFFER.url, {
      renderer: "/bin/sh",
      dump: async () => ({ ok: true, html: errorPage }),
    });
    assert.strictEqual(rendered.ok, false);
    assert.strictEqual(rendered.error, RENDERED_ITS_OWN_ERROR_PAGE);
  });

  it("refuses the certificate interstitial the same way", () => {
    const ssl = `<html><body id="body" class="ssl"><div id="main-message">Your connection is not private</div></body></html>`;
    assert.strictEqual(theRenderingClientsOwnErrorPage(ssl), true);
  });

  it("refuses the site's own bot challenge", async () => {
    const rendered = await renderPageHtml(OFFER.url, {
      renderer: "/bin/sh",
      dump: async () => ({ ok: true, html: INTERSTITIAL }),
    });
    assert.strictEqual(rendered.ok, false);
    assert.strictEqual(rendered.error, RENDERED_THE_CHALLENGE_AGAIN);
  });

  it("reads a page whose prose happens to carry those words", async () => {
    const aboutBots = pageOfAtLeastTheFloor(
      "Widgetson blocks bots and shows a checking-your-browser interstitial to anyone we cannot verify."
    );
    const rendered = await renderPageHtml(OFFER.url, {
      renderer: "/bin/sh",
      dump: async () => ({ ok: true, html: aboutBots }),
    });
    assert.strictEqual(rendered.ok, true);
  });

  it("takes the title from the document and nothing else", () => {
    assert.strictEqual(documentTitle(INTERSTITIAL), "Just a moment...");
    assert.strictEqual(documentTitle(RENDERED_WITH_TERMS), "Widgetson Pricing");
    assert.strictEqual(documentTitle("<html><body>no title</body></html>"), "");
  });

  it("holds a page with no title and no error markers to be the site", () => {
    assert.strictEqual(theSitesBotChallenge("<html><body>terms</body></html>"), false);
    assert.strictEqual(theRenderingClientsOwnErrorPage("<html><body>terms</body></html>"), false);
    assert.strictEqual(theRenderingClientsOwnErrorPage(""), false);
  });

  it("passes a page the rendering client never produced straight through", async () => {
    const nothing = await renderPageHtml(OFFER.url, { env: { PATH: "/no/such/directory" } });
    assert.strictEqual(nothing.error, NO_RENDERING_CLIENT);
  });
});

describe("the challenge reading is assembled from what came back", () => {
  it("refuses a rendering the client never completed", () => {
    assert.deepStrictEqual(pageBehindAChallenge(403, { ok: false, error: RENDER_TIMED_OUT }), {
      ok: false,
      error: "HTTP 403",
    });
  });

  it("refuses a rendering with nothing in it", () => {
    assert.deepStrictEqual(pageBehindAChallenge(429, undefined), { ok: false, error: "HTTP 429" });
  });

  it("carries the prices the rendered markup states", () => {
    const withMarkup = `<html><head><title>Widgetson</title><script type="application/ld+json">{"@type":"Offer","price":"0","priceCurrency":"USD"}</script></head><body><p>${"Widgetson free plan. ".repeat(40)}</p></body></html>`;
    const page = pageBehindAChallenge(403, { ok: true, html: withMarkup });
    assert.strictEqual(page.ok, true);
    assert.ok(page.structured);
  });
});
