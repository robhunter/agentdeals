import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  fetchPageText,
  MIN_PAGE_TEXT_LENGTH,
  PAGE_TOO_SHORT_ERROR,
  pageOnlyARenderingClientCanRead,
  renderingClientCouldNotReadIt,
  tooShortForARenderingClientToo,
  tooShortToRead,
} = await import("../scripts/verify-freshness.js");
const {
  NO_RENDERING_CLIENT,
  READ_BY_RENDERING,
  RENDER_TIMED_OUT,
  findRenderer,
  renderArguments,
  renderPageHtml,
  withoutARenderingClient,
} = await import("../scripts/rendered-page.js");
const { classifyFetchError, FAILURE_EMPTY_PAGE } = await import("../scripts/verification-state.js");
const { priceSignals } = await import("../scripts/change-gate.js");
const { classifySource, sourceCheckRecord } = await import("../scripts/vendor-naming.js");

const OFFER = {
  vendor: "Widgetson",
  category: "Monitoring",
  tier: "Free",
  description: "Free for up to 5 hosts",
  url: "https://widgetson.example/pricing",
};

const SHELL = `<html><head><title>Widgetson</title></head><body><div id="root"></div></body></html>`;

function pageOfAtLeastTheFloor(sentence: string) {
  const filler = " Paid plans add retention, alerting and single sign-on.";
  let body = sentence;
  while (body.length < MIN_PAGE_TEXT_LENGTH) body += filler;
  return `<html><body><p>${body}</p></body></html>`;
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

async function readWith(body: string, init: ResponseInit, options: Record<string, unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, { status: 200, ...init })) as typeof fetch;
  try {
    return await fetchPageText(OFFER.url, options);
  } finally {
    globalThis.fetch = original;
  }
}

async function readWhenTheFetchThrows(options: Record<string, unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  try {
    return await fetchPageText(OFFER.url, options);
  } finally {
    globalThis.fetch = original;
  }
}

describe("a page too short to read is read again by a rendering client", () => {
  it("returns what the rendering client read", async () => {
    const spy = renderSpy({ ok: true, html: RENDERED_WITH_TERMS });
    const page = await readWith(SHELL, {}, { render: spy.render });
    assert.deepStrictEqual(spy.asked, [OFFER.url]);
    assert.strictEqual(page.ok, true);
    assert.ok(page.text.length >= MIN_PAGE_TEXT_LENGTH);
    assert.strictEqual(page.read, READ_BY_RENDERING);
  });

  it("keeps the length the fetcher got, so the two readings can be compared", async () => {
    const spy = renderSpy({ ok: true, html: RENDERED_WITH_TERMS });
    const page = await readWith(SHELL, {}, { render: spy.render });
    assert.ok(page.chars_before_rendering < MIN_PAGE_TEXT_LENGTH);
  });

  it("grades the record on the rendered reading", async () => {
    const spy = renderSpy({ ok: true, html: RENDERED_WITH_TERMS });
    const page = await readWith(SHELL, {}, { render: spy.render });
    const grade = classifySource(OFFER, page, priceSignals(page.text));
    assert.strictEqual(grade.outcome, "ok");
  });

  it("says on the record that a rendering client is what read the page", async () => {
    const spy = renderSpy({ ok: true, html: RENDERED_WITH_TERMS });
    const page = await readWith(SHELL, {}, { render: spy.render });
    const check = sourceCheckRecord(OFFER, page, priceSignals(page.text), "2026-09-10");
    assert.strictEqual(check.rendered, true);
  });

  it("leaves no rendering marker on a page the fetcher read on its own", async () => {
    const spy = renderSpy({ ok: true, html: RENDERED_WITH_TERMS });
    const page = await readWith(RENDERED_WITH_TERMS, {}, { render: spy.render });
    const check = sourceCheckRecord(OFFER, page, priceSignals(page.text), "2026-09-10");
    assert.strictEqual(check.rendered, undefined);
    assert.deepStrictEqual(spy.asked, []);
  });
});

describe("only a page that answered and came back too short is rendered", () => {
  for (const status of [403, 404, 410, 429, 500]) {
    it(`does not render a page that answered HTTP ${status}`, async () => {
      const spy = renderSpy({ ok: true, html: RENDERED_WITH_TERMS });
      const page = await readWith(SHELL, { status }, { render: spy.render });
      assert.deepStrictEqual(spy.asked, []);
      assert.strictEqual(page.ok, false);
      assert.strictEqual(page.error, `HTTP ${status}`);
    });
  }

  it("does not render a page that never answered", async () => {
    const spy = renderSpy({ ok: true, html: RENDERED_WITH_TERMS });
    const page = await readWhenTheFetchThrows({ render: spy.render });
    assert.deepStrictEqual(spy.asked, []);
    assert.strictEqual(page.ok, false);
  });

  it("recognises the one failure that escalates and no other", () => {
    assert.strictEqual(tooShortToRead({ ok: false, error: PAGE_TOO_SHORT_ERROR }), true);
    assert.strictEqual(tooShortToRead({ ok: false, error: "HTTP 403" }), false);
    assert.strictEqual(tooShortToRead({ ok: false, error: "timeout" }), false);
    assert.strictEqual(tooShortToRead({ ok: false, error: "page too large: 99 bytes" }), false);
    assert.strictEqual(tooShortToRead({ ok: true, text: "" }), false);
  });
});

describe("when the rendering client cannot help", () => {
  it("says exactly what it said before when no rendering client is installed", async () => {
    const page = await readWith(SHELL, {}, { render: withoutARenderingClient });
    assert.strictEqual(page.ok, false);
    assert.strictEqual(page.error, PAGE_TOO_SHORT_ERROR);
    assert.strictEqual(page.read, undefined);
  });

  it("names the failure when the rendering client did not finish", async () => {
    const spy = renderSpy({ ok: false, error: RENDER_TIMED_OUT });
    const page = await readWith(SHELL, {}, { render: spy.render });
    assert.strictEqual(page.error, renderingClientCouldNotReadIt(RENDER_TIMED_OUT));
    assert.strictEqual(page.read, READ_BY_RENDERING);
  });

  it("reports the rendered length when the rendered page is still under the floor", async () => {
    const spy = renderSpy({ ok: true, html: `<html><body><p>Widgetson</p></body></html>` });
    const page = await readWith(SHELL, {}, { render: spy.render });
    assert.strictEqual(page.error, tooShortForARenderingClientToo(9));
    assert.strictEqual(page.chars, 9);
  });

  it("keeps every one of those refusals in the empty-page failure class", () => {
    assert.strictEqual(classifyFetchError(PAGE_TOO_SHORT_ERROR), FAILURE_EMPTY_PAGE);
    assert.strictEqual(classifyFetchError(tooShortForARenderingClientToo(12)), FAILURE_EMPTY_PAGE);
    assert.strictEqual(
      classifyFetchError(renderingClientCouldNotReadIt(RENDER_TIMED_OUT)),
      FAILURE_EMPTY_PAGE
    );
  });

  it("keeps the prices the markup carried when the rendering client adds nothing", () => {
    const short = { ok: false, error: PAGE_TOO_SHORT_ERROR, chars: 40, structured: { prices: [1] } };
    const still = pageOnlyARenderingClientCanRead(short, { ok: false, error: RENDER_TIMED_OUT });
    assert.deepStrictEqual(still.structured, short.structured);
  });
});

describe("what a render costs is bounded", () => {
  it("runs one rendering client at a time", async () => {
    let live = 0;
    let mostAtOnce = 0;
    const dump = async () => {
      live++;
      mostAtOnce = Math.max(mostAtOnce, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return { ok: true, html: SHELL };
    };
    await Promise.all(
      ["one", "two", "three"].map((host) =>
        renderPageHtml(`https://${host}.example`, { renderer: "/bin/sh", dump })
      )
    );
    assert.strictEqual(mostAtOnce, 1);
  });

  it("keeps rendering after one render fails", async () => {
    const failing = async () => {
      throw new Error("spawn failed");
    };
    await assert.rejects(renderPageHtml("https://one.example", { renderer: "/bin/sh", dump: failing }));
    const after = await renderPageHtml("https://two.example", {
      renderer: "/bin/sh",
      dump: async () => ({ ok: true, html: SHELL }),
    });
    assert.strictEqual(after.ok, true);
  });

  it("asks for the rendered DOM and bounds how long a page may keep loading", () => {
    const args = renderArguments(OFFER.url, { env: {} });
    assert.ok(args.includes("--dump-dom"));
    assert.ok(args.some((arg: string) => /^--virtual-time-budget=\d+$/.test(arg)));
    assert.strictEqual(args.at(-1), OFFER.url);
  });

  it("passes through the arguments the environment asks for", () => {
    const args = renderArguments(OFFER.url, {
      env: { AGENTDEALS_RENDERER_ARGS: "--proxy-server=proxy.example:8080 --ignore-certificate-errors" },
    });
    assert.ok(args.includes("--proxy-server=proxy.example:8080"));
    assert.ok(args.includes("--ignore-certificate-errors"));
  });

  it("takes the path it is handed ahead of anything on the PATH", () => {
    assert.strictEqual(findRenderer({ AGENTDEALS_RENDERER: "/bin/sh", PATH: "/usr/bin" }), "/bin/sh");
  });

  it("reports that nothing is installed rather than guessing", async () => {
    assert.strictEqual(findRenderer({ PATH: "/no/such/directory" }), null);
    const nothing = await renderPageHtml(OFFER.url, { env: { PATH: "/no/such/directory" } });
    assert.strictEqual(nothing.error, NO_RENDERING_CLIENT);
  });
});

describe("no test spawns a rendering client of its own", () => {
  it("stubs the rendering client wherever it stubs the network", () => {
    const files = readdirSync(__dirname).filter((name) => name.endsWith(".test.ts"));
    const sources = new Map(
      files.map((name) => [name, readFileSync(path.join(__dirname, name), "utf-8")])
    );
    const stubbingTheNetwork = files.filter((name) => {
      const source = sources.get(name) ?? "";
      return source.includes("globalThis.fetch") && source.includes("fetchPageText(");
    });
    assert.ok(stubbingTheNetwork.length > 0);
    assert.deepStrictEqual(
      stubbingTheNetwork.filter((name) => !(sources.get(name) ?? "").includes("render")),
      []
    );
  });
});
