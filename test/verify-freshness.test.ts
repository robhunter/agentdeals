import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const {
  findStaleOffers,
  fetchPageText,
  stripHtml,
  verifyOfferAgainstPage,
  parseVerifierResponse,
  createVerifierClient,
  verifyFreshness,
  VERIFIER_MODEL,
  VERIFIER_API_KEY_ENV,
  VERIFIER_BASE_URL,
} = await import("../scripts/verify-freshness.js");
const { verbatimExcerpt } = await import("../scripts/free-plan-excerpt.js");

function stubClient(text: string) {
  return { model: VERIFIER_MODEL, baseUrl: VERIFIER_BASE_URL, complete: async () => text };
}

describe("verify-freshness", () => {
  const now = new Date("2026-03-16T00:00:00Z");

  describe("findStaleOffers", () => {
    it("skips fresh entries", () => {
      const offers = [
        { vendor: "Fresh", category: "Hosting", url: "https://example.com", verifiedDate: "2026-03-10" },
        { vendor: "AlsoFresh", category: "CI/CD", url: "https://example.com", verifiedDate: "2026-03-15" },
      ];
      const { stale, freshCount } = findStaleOffers(offers, 25, now);
      assert.strictEqual(stale.length, 0);
      assert.strictEqual(freshCount, 2);
    });

    it("identifies stale entries beyond threshold", () => {
      const offers = [
        { vendor: "Fresh", category: "Hosting", url: "https://example.com", verifiedDate: "2026-03-10" },
        { vendor: "Stale", category: "Databases", url: "https://example.com", verifiedDate: "2026-02-01" },
        { vendor: "VeryStale", category: "CI/CD", url: "https://example.com", verifiedDate: "2025-12-01" },
      ];
      const { stale, freshCount } = findStaleOffers(offers, 25, now);
      assert.strictEqual(stale.length, 2);
      assert.strictEqual(freshCount, 1);
    });

    it("treats missing verifiedDate as stale", () => {
      const offers = [
        { vendor: "NoDate", category: "Auth", url: "https://example.com" },
      ];
      const { stale } = findStaleOffers(offers, 25, now);
      assert.strictEqual(stale.length, 1);
      assert.strictEqual(stale[0].offer.vendor, "NoDate");
    });

    it("sorts stale entries by staleness descending", () => {
      const offers = [
        { vendor: "A", category: "A", url: "https://example.com", verifiedDate: "2026-02-10" },
        { vendor: "B", category: "B", url: "https://example.com", verifiedDate: "2025-12-01" },
        { vendor: "C", category: "C", url: "https://example.com", verifiedDate: "2026-01-15" },
      ];
      const { stale } = findStaleOffers(offers, 25, now);
      assert.strictEqual(stale.length, 3);
      assert.strictEqual(stale[0].offer.vendor, "B");
      assert.strictEqual(stale[1].offer.vendor, "C");
      assert.strictEqual(stale[2].offer.vendor, "A");
    });

    it("preserves original index for data updates", () => {
      const offers = [
        { vendor: "Fresh", category: "A", url: "https://example.com", verifiedDate: "2026-03-15" },
        { vendor: "Stale", category: "B", url: "https://example.com", verifiedDate: "2026-01-01" },
        { vendor: "AlsoStale", category: "C", url: "https://example.com", verifiedDate: "2026-01-15" },
      ];
      const { stale } = findStaleOffers(offers, 25, now);
      assert.strictEqual(stale[0].index, 1);
      assert.strictEqual(stale[0].offer.vendor, "Stale");
      assert.strictEqual(stale[1].index, 2);
      assert.strictEqual(stale[1].offer.vendor, "AlsoStale");
    });

    it("respects custom threshold", () => {
      const offers = [
        { vendor: "A", category: "Hosting", url: "https://example.com", verifiedDate: "2026-03-10" },
        { vendor: "B", category: "Hosting", url: "https://example.com", verifiedDate: "2026-03-14" },
      ];
      const { stale, freshCount } = findStaleOffers(offers, 5, now);
      assert.strictEqual(stale.length, 1);
      assert.strictEqual(stale[0].offer.vendor, "A");
      assert.strictEqual(freshCount, 1);
    });
  });

  describe("fetchPageText", () => {
    it("returns error for unreachable URLs", async () => {
      const result = await fetchPageText("http://localhost:19999/nonexistent");
      assert.strictEqual(result.ok, false);
      assert.ok(result.error);
    });

    it("returns error for non-200 responses", async () => {
      const result = await fetchPageText("https://httpstat.us/404");
      assert.strictEqual(result.ok, false);
      assert.ok(result.error?.includes("404") || result.error?.includes("timeout") || result.error);
    });
  });

  describe("verifyOfferAgainstPage", () => {
    const offer = { vendor: "Test", category: "Hosting", tier: "Free", description: "Free hosting" };

    it("parses confirmed response", async () => {
      const result = await verifyOfferAgainstPage(stubClient('{"status":"confirmed"}'), offer, "Free hosting plan available");
      assert.strictEqual(result.status, "confirmed");
    });

    it("parses changed response", async () => {
      const result = await verifyOfferAgainstPage(
        stubClient('{"status":"changed","summary":"Free tier removed"}'),
        offer,
        "Paid plans start at $5/mo"
      );
      assert.strictEqual(result.status, "changed");
      assert.strictEqual(result.summary, "Free tier removed");
    });

    it("handles unclear response", async () => {
      const result = await verifyOfferAgainstPage(
        stubClient('{"status":"unclear","summary":"Page requires login"}'),
        offer,
        "Please sign in"
      );
      assert.strictEqual(result.status, "unclear");
    });

    it("sends the stored terms and the page text in the prompt", async () => {
      let seen = "";
      const client = { complete: async (prompt: string) => { seen = prompt; return '{"status":"confirmed"}'; } };
      await verifyOfferAgainstPage(client, offer, "Free hosting plan available");
      for (const fragment of [offer.vendor, offer.tier, offer.description, "Free hosting plan available"]) {
        assert.ok(seen.includes(fragment), `prompt should carry ${fragment}`);
      }
    });
  });

  describe("parseVerifierResponse", () => {
    it("handles malformed AI response gracefully", () => {
      assert.strictEqual(parseVerifierResponse("I think the deal looks correct").status, "unclear");
    });

    it("extracts JSON from verbose AI response", () => {
      assert.strictEqual(parseVerifierResponse('The deal is still valid. {"status":"confirmed"}').status, "confirmed");
    });

    it("reads a fenced code block", () => {
      const result = parseVerifierResponse('```json\n{"status":"changed","summary":"Limit cut"}\n```');
      assert.strictEqual(result.status, "changed");
      assert.strictEqual(result.summary, "Limit cut");
    });

    it("reads a fenced answer whose text contains a closing brace", () => {
      const result = parseVerifierResponse(
        '```json\n{"status":"changed","summary":"Template ${quota} removed","change_type":"limits_reduced"}\n```'
      );
      assert.strictEqual(result.status, "changed");
      assert.strictEqual(result.change_type, "limits_reduced");
    });

    it("refuses a status it does not recognise", () => {
      assert.strictEqual(parseVerifierResponse('{"status":"probably fine"}').status, "unclear");
    });

    it("refuses a non-string response", () => {
      assert.strictEqual(parseVerifierResponse(undefined).status, "unclear");
    });
  });

  describe("createVerifierClient", () => {
    it("refuses to run without a key, naming the variable", () => {
      const saved = process.env[VERIFIER_API_KEY_ENV];
      delete process.env[VERIFIER_API_KEY_ENV];
      try {
        assert.throws(() => createVerifierClient(), new RegExp(VERIFIER_API_KEY_ENV));
      } finally {
        if (saved !== undefined) process.env[VERIFIER_API_KEY_ENV] = saved;
      }
    });

    it("posts an OpenAI-shaped chat completion to the configured endpoint", async () => {
      const calls: any[] = [];
      const client = createVerifierClient({
        apiKey: "test-key",
        baseUrl: "https://openrouter.test/api/v1",
        fetchImpl: async (url: string, init: any) => {
          calls.push({ url, init });
          return {
            ok: true,
            json: async () => ({ choices: [{ message: { content: '{"status":"confirmed"}' } }] }),
          };
        },
      });
      const text = await client.complete("does this still hold?");
      assert.strictEqual(text, '{"status":"confirmed"}');
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].url, "https://openrouter.test/api/v1/chat/completions");
      assert.strictEqual(calls[0].init.method, "POST");
      assert.strictEqual(calls[0].init.headers.Authorization, "Bearer test-key");
      const body = JSON.parse(calls[0].init.body);
      assert.strictEqual(body.model, VERIFIER_MODEL);
      assert.deepStrictEqual(body.messages, [{ role: "user", content: "does this still hold?" }]);
      assert.strictEqual(body.temperature, 0);
    });

    it("caps the answer at 400 tokens unless the caller asks for more room", async () => {
      const capsSent: number[] = [];
      const fetchImpl = async (_url: string, init: any) => {
        capsSent.push(JSON.parse(init.body).max_tokens);
        return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }] }) };
      };
      await createVerifierClient({ apiKey: "test-key", fetchImpl }).complete("one page");
      await createVerifierClient({ apiKey: "test-key", fetchImpl, maxTokens: 1500 }).complete("two pages");
      assert.deepStrictEqual(capsSent, [400, 1500]);
    });

    it("defaults to the OpenRouter endpoint", () => {
      assert.strictEqual(createVerifierClient({ apiKey: "test-key" }).baseUrl, VERIFIER_BASE_URL);
      assert.match(VERIFIER_BASE_URL, /^https:\/\/openrouter\.ai\//);
    });

    it("asks the model the cost and accuracy were measured on", () => {
      assert.strictEqual(
        VERIFIER_MODEL,
        "google/gemma-3-27b-it",
        "changing the model changes both the price per record and the answer quality — measure again before moving it"
      );
    });

    it("reports the status when the endpoint rejects the request", async () => {
      const client = createVerifierClient({
        apiKey: "test-key",
        fetchImpl: async () => ({ ok: false, status: 401, text: async () => "No auth credentials found" }),
      });
      await assert.rejects(() => client.complete("hello"), /401/);
    });

    it("reports a response carrying no message content", async () => {
      const client = createVerifierClient({
        apiKey: "test-key",
        fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [] }) }),
      });
      await assert.rejects(() => client.complete("hello"), /no message content/);
    });
  });

  describe("verifyFreshness (integration with mock)", () => {
    let tmpDir;
    let indexPath;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "verify-freshness-"));
      indexPath = join(tmpDir, "index.json");
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("reports all fresh when no stale entries", async () => {
      const data = {
        offers: [
          { vendor: "Fresh", category: "Hosting", url: "https://example.com", verifiedDate: "2026-03-10", tier: "Free", description: "Free plan" },
        ],
      };
      writeFileSync(indexPath, JSON.stringify(data));

      const result = await verifyFreshness({ thresholdDays: 25, dryRun: true, indexPath, now });
      assert.strictEqual(result.verified, 0);
      assert.strictEqual(result.alreadyFresh, 1);
    });

    it("dry-run does not modify index file", async () => {
      const data = {
        offers: [
          { vendor: "Stale", category: "Hosting", url: "http://localhost:19999/fake", verifiedDate: "2025-01-01", tier: "Free", description: "Free plan" },
        ],
      };
      writeFileSync(indexPath, JSON.stringify(data));
      const before = readFileSync(indexPath, "utf-8");

      await verifyFreshness({ thresholdDays: 25, dryRun: true, indexPath, now, client: stubClient('{"status":"confirmed"}') });
      const after = readFileSync(indexPath, "utf-8");
      assert.strictEqual(before, after);
    });

    it("respects limit parameter", async () => {
      const offers = Array.from({ length: 10 }, (_, i) => ({
        vendor: `V${i}`,
        category: "Hosting",
        url: "http://localhost:19999/fake",
        verifiedDate: "2025-01-01",
        tier: "Free",
        description: "Free plan",
      }));
      writeFileSync(indexPath, JSON.stringify({ offers }));

      const result = await verifyFreshness({ thresholdDays: 25, dryRun: true, limit: 3, indexPath, now, client: stubClient('{"status":"confirmed"}') });
      assert.strictEqual(result.skipped, 7);
      assert.ok(result.failed <= 3);
    });
  });
});

describe("the text a reader sees of a page", () => {
  it("leaves out the names an icon font draws as symbols, so a tick reads as nothing rather than as the word check", () => {
    const firebase = '<div class="pricing-table__header__cell__plan-description"> <i class="material-icons" aria-hidden="true" translate="no"> check </i> Generous no-cost usage limits <br> <i class="material-icons" aria-hidden="true" translate="no"> check </i> No payment method needed </br> </div>';
    assert.strictEqual(stripHtml(firebase), "Generous no-cost usage limits No payment method needed");
    assert.strictEqual(stripHtml('<li><span class="icon material-symbols-outlined">close</span> Custom domains</li>'), "Custom domains");
    assert.strictEqual(stripHtml("<li><span class='material-icons-round'>done</span>SSO</li>"), "SSO");
    assert.strictEqual(stripHtml("<li><mat-icon>check_circle</mat-icon> 3 projects</li>"), "3 projects");
    assert.strictEqual(stripHtml('<p><span class="google-symbols">arrow_forward</span> Start</p>'), "Start");
  });

  it("keeps words in any other element, including one whose class only mentions an icon", () => {
    assert.strictEqual(stripHtml("<p>Every plan comes with a <i>check</i> on usage</p>"), "Every plan comes with a check on usage");
    assert.strictEqual(stripHtml('<p><span class="icon-label">Unlimited</span> seats</p>'), "Unlimited seats");
    assert.strictEqual(stripHtml('<p><span class="not-material-icons">Free</span> plan</p>'), "Free plan");
    assert.strictEqual(stripHtml('<p><span data-class="material-icons">Free</span> plan</p>'), "Free plan");
  });

  it("leaves out a price the page strikes through, so an anchor price beside a discount does not read as the price", () => {
    assert.strictEqual(stripHtml("<p>Teams <s>$199</s> $49/month</p>"), "Teams $49/month");
    assert.strictEqual(stripHtml("<p>Teams <del>$199</del> $49/month</p>"), "Teams $49/month");
    assert.strictEqual(stripHtml("<p>Teams <strike>$199</strike> $49/month</p>"), "Teams $49/month");
    assert.strictEqual(stripHtml('<p>Teams <s class="was">$<b>199</b></s> $49/month</p>'), "Teams $49/month");
    assert.strictEqual(stripHtml('<p>Teams <span style="color:#999; text-decoration: line-through">$199</span> $49/month</p>'), "Teams $49/month");
    assert.strictEqual(stripHtml("<p>Teams <span style='text-decoration-line:line-through'>$199</span> $49/month</p>"), "Teams $49/month");
    assert.strictEqual(stripHtml('<p>Starts at <span class="text-2xl text-signoz_vanilla-400 line-through">$199</span> $49/month</p>'), "Starts at $49/month");
  });

  it("keeps a price in an ordinary element, and in one whose class or style only resembles a strike or a fade", () => {
    assert.strictEqual(stripHtml("<p>Teams <span>$199</span>/month</p>"), "Teams $199 /month");
    assert.strictEqual(stripHtml('<p>Teams <span class="hover:line-through">$199</span>/month</p>'), "Teams $199 /month");
    assert.strictEqual(stripHtml('<p>Teams <span class="is-faded">$199</span>/month</p>'), "Teams $199 /month");
    assert.strictEqual(stripHtml('<p>Teams <span style="text-decoration: underline">$199</span>/month</p>'), "Teams $199 /month");
    assert.strictEqual(stripHtml('<p>Teams <span data-style="text-decoration: line-through">$199</span>/month</p>'), "Teams $199 /month");
    assert.strictEqual(stripHtml("<section><p>Teams $199/month</p></section><details>Billed monthly</details>"), "Teams $199/month Billed monthly");
  });

  describe("on trimmed copies of two pricing pages saved on 2026-10-03", () => {
    const SIGNOZ_PRICING = "<div><p class=\"mb-1\">Starts at <span class=\"line-through\">$199</span> $49/month, including $49 of usage</p><p class=\"mb-0 text-xs opacity-75\"></p></div><div class=\"mb-4 flex flex-col md:flex-row md:justify-between\"><div class=\"w-full md:w-[60%]\"><h3 id=\"teams\" class=\"pinkish-gradient mb-1 text-2xl font-bold tracking-tight md:text-3xl\">Teams</h3><p class=\"text-base text-gray-400\">For fast-scaling teams that need observability to scale with them.</p></div><div class=\"mt-4 flex w-full flex-col items-start md:mt-0 md:w-[40%] md:items-end\"><span class=\"text-sm text-signoz_vanilla-400\">starts from</span><div class=\"flex items-baseline\"><span class=\"text-3xl font-bold text-signoz_vanilla-100 md:text-4xl\"><span class=\"text-2xl text-signoz_vanilla-400 line-through\">$199</span> $49</span><span class=\"ml-1 text-signoz_vanilla-400\">/month</span></div></div></div>";
    const LOCALSTACK_PRICING = "<div class=\"pricing_indpackage_wrap is-aws\"><div class=\"pricing_info_wrapper\"><div class=\"pricing_div_info\"><h2 class=\"u-heading-lg-new\">Hobby</h2><p data-tippy-content=\"Hobby is permitted only for non-commercial use. Refer to our &lt;a href=&#x27;https://www.localstack.cloud/legal/terms-of-service&#x27;&gt;Terms &amp; Conditions &lt;/a&gt;for details.\" class=\"u-bodytext-base-new is-tooltip\">For hobbyists &amp; other non-commercial usage.</p></div></div><div id=\"w-node-_33f48fcf-0b84-7154-4879-d00c3f6c73dd-a79dbcdd\" class=\"pricing_div_price\"><div class=\"u-heading-2xl-new is-pricinglist\">Free</div></div></div><div class=\"pricing_indpackage_wrap is-aws\"><div class=\"pricing_info_wrapper\"><div class=\"pricing_div_info\"><h2 class=\"u-heading-lg-new\">Base</h2><p class=\"u-bodytext-base-new\">For teams building simple applications.</p></div></div><div id=\"w-node-_727c326e-5500-98b7-3569-1d611a1c0ea5-a79dbcdd\" class=\"pricing_div_price\"><div style=\"opacity:1;display:flex\" class=\"pricing-wrapper-switch is-annualy\"><div class=\"price-div-wrapper\"><div class=\"price-div-item\"><div class=\"u-heading-2xl-new is-price is-faded\">$39</div></div><div class=\"pricing-side-div-wrapper\"><div class=\"u-bodytext-sm-new is-descriptivetext\">per license/<br/></div><div class=\"u-bodytext-sm-new is-descriptivetext\">per month<br/></div></div></div><div class=\"pricing_text_pricesupport u-bodytext-sm\">billed annually</div></div><div style=\"opacity:0;display:none\" class=\"pricing-wrapper-switch is-monthly\"><div class=\"price-div-wrapper\"><div class=\"price-div-item\"><div class=\"u-heading-2xl-new is-price is-faded\">$45</div></div><div class=\"pricing-side-div-wrapper\"><div class=\"u-bodytext-sm-new\">per license/<br/></div><div class=\"u-bodytext-sm-new\">per month<br/></div></div></div><div class=\"pricing_text_pricesupport u-bodytext-sm\">billed monthly</div></div></div></div><div class=\"pricing_indpackage_wrap is-snowflake\"><div class=\"pricing_info_wrapper\"><div class=\"pricing_div_info\"><h2 class=\"u-heading-lg-new\">Base</h2><p class=\"u-bodytext-base-new\">Need to test your queries in an isolated sandbox without cloud dependencies? Built to mitigate expensive mistakes, for any engineer</p></div></div><div class=\"pricing_div_price\"><div style=\"opacity:1;display:flex\" class=\"pricing-wrapper-switch is-annualy\"><div class=\"price-div-wrapper\"><div class=\"price-div-item\"><div class=\"u-heading-2xl-new is-price\">$29</div></div><div class=\"pricing-side-div-wrapper\"><div class=\"u-bodytext-sm-new is-descriptivetext\">per license/<br/></div><div class=\"u-bodytext-sm-new is-descriptivetext\">per month<br/></div></div></div><div class=\"pricing_text_pricesupport u-bodytext-sm\">billed annually</div></div><div style=\"opacity:0;display:none\" class=\"pricing-wrapper-switch is-monthly\"><div class=\"price-div-wrapper\"><div class=\"price-div-item\"><div class=\"u-heading-2xl-new is-price\">$35</div></div><div class=\"pricing-side-div-wrapper\"><div class=\"u-bodytext-sm-new\">per license/<br/></div><div class=\"u-bodytext-sm-new\">per month<br/></div></div></div><div class=\"pricing_text_pricesupport u-bodytext-sm\">billed monthly</div></div></div></div>";

    it("reads SigNoz's Teams plan at the $49 it charges, never at the $199 it strikes through", () => {
      assert.strictEqual(stripHtml(SIGNOZ_PRICING), "Starts at $49/month, including $49 of usage Teams For fast-scaling teams that need observability to scale with them. starts from $49 /month");
    });

    it("keeps LocalStack for AWS's Base price, which its is-faded class draws in full, beside LocalStack for Snowflake's", () => {
      assert.strictEqual(stripHtml(LOCALSTACK_PRICING), "Hobby For hobbyists & other non-commercial usage. Free Base For teams building simple applications. $39 per license/ per month billed annually $45 per license/ per month billed monthly Base Need to test your queries in an isolated sandbox without cloud dependencies? Built to mitigate expensive mistakes, for any engineer $29 per license/ per month billed annually $35 per license/ per month billed monthly");
    });

    it("still finds a quote of either page's own words, and refuses a copy holding the struck price", () => {
      assert.strictEqual(verbatimExcerpt("Hobby For hobbyists & other non-commercial usage. Free", stripHtml(LOCALSTACK_PRICING)).excerpt, "Hobby For hobbyists & other non-commercial usage. Free");
      assert.strictEqual(verbatimExcerpt("Starts at $49/month, including $49 of usage", stripHtml(SIGNOZ_PRICING)).excerpt, "Starts at $49/month, including $49 of usage");
      assert.strictEqual(verbatimExcerpt("Starts at $199 $49/month", stripHtml(SIGNOZ_PRICING)).excerpt, null);
    });
  });
});
