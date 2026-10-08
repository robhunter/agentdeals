import { describe, it } from "node:test";
import assert from "node:assert";
import {
  classifyHttpStatus,
  classifyNetworkError,
  isTerminalStatus,
  landsOnAnotherPage,
  programPageAnswers,
  unreachableNotice,
  LINK_GRACE_DAYS,
  type LinkCheckRecord,
} from "../src/link-health.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-25T00:00:00Z").getTime();

function record(over: Partial<LinkCheckRecord> = {}): LinkCheckRecord {
  return {
    url: "https://example.test/pricing",
    checked: "2026-08-25",
    outcome: "unreachable",
    detail: "GET 404",
    terminal: false,
    last_reachable: "2026-05-23",
    consecutive_unreachable: 4,
    ...over,
  };
}

describe("#1046 outcome classification", () => {
  it("treats 2xx and 3xx as reachable", () => {
    for (const status of [200, 201, 204, 301, 302, 307, 308]) {
      assert.equal(classifyHttpStatus(status), "reachable", `status ${status}`);
    }
  });

  it("treats 404 and 410 as evidence about the destination", () => {
    assert.equal(classifyHttpStatus(404), "unreachable");
    assert.equal(classifyHttpStatus(410), "unreachable");
  });

  it("treats every status that means we were refused as unknown, not as a dead link", () => {
    for (const status of [401, 402, 403, 405, 429, 451, 500, 502, 503, 504]) {
      assert.equal(
        classifyHttpStatus(status),
        "unknown",
        `status ${status} must not be publishable as evidence about a vendor`
      );
    }
  });

  it("treats a name that does not resolve as unreachable and a temporary resolver failure as unknown", () => {
    assert.equal(classifyNetworkError("ENOTFOUND"), "unreachable");
    assert.equal(classifyNetworkError("EAI_AGAIN"), "unknown");
    assert.equal(classifyNetworkError("UND_ERR_CONNECT_TIMEOUT"), "unknown");
    assert.equal(classifyNetworkError("ECONNREFUSED"), "unknown");
    assert.equal(classifyNetworkError("ECONNRESET"), "unknown");
    assert.equal(classifyNetworkError("TIMEOUT"), "unknown");
    assert.equal(classifyNetworkError(undefined), "unknown");
  });

  it("treats 410 alone as terminal", () => {
    assert.equal(isTerminalStatus(410), true);
    assert.equal(isTerminalStatus(404), false);
    assert.equal(isTerminalStatus(403), false);
  });
});

describe("#1046 when an unreachable link becomes publishable", () => {
  it("publishes nothing while the link is still inside its grace window", () => {
    const justOutOfReach = new Date(NOW - (LINK_GRACE_DAYS - 1) * DAY).toISOString().slice(0, 10);
    assert.equal(unreachableNotice(record({ last_reachable: justOutOfReach }), NOW), null);
  });

  it("publishes once the link has been out of reach for the whole grace window", () => {
    const atTheEdge = new Date(NOW - LINK_GRACE_DAYS * DAY).toISOString().slice(0, 10);
    const notice = unreachableNotice(record({ last_reachable: atTheEdge }), NOW);
    assert.ok(notice);
    assert.equal(notice.last_reachable, atTheEdge);
    assert.equal(notice.checked, "2026-08-25");
  });

  it("publishes a 410 immediately, because the server has stated the answer", () => {
    const yesterday = new Date(NOW - DAY).toISOString().slice(0, 10);
    const notice = unreachableNotice(
      record({ terminal: true, detail: "GET 410", last_reachable: yesterday }),
      NOW
    );
    assert.ok(notice);
    assert.equal(notice.terminal, true);
  });

  it("publishes nothing for a link we were merely refused, however long it has been refused", () => {
    const longAgo = new Date(NOW - 400 * DAY).toISOString().slice(0, 10);
    assert.equal(
      unreachableNotice(record({ outcome: "unknown", detail: "GET 403", last_reachable: longAgo }), NOW),
      null
    );
  });

  it("publishes nothing for a link that answered on the last check", () => {
    assert.equal(unreachableNotice(record({ outcome: "reachable", detail: "HEAD 200" }), NOW), null);
  });

  it("publishes nothing for a URL that has never been checked", () => {
    assert.equal(unreachableNotice(undefined, NOW), null);
  });

  it("publishes nothing when we hold no date the link was last reachable and the server has not said gone", () => {
    assert.equal(unreachableNotice(record({ last_reachable: null }), NOW), null);
  });
});

describe("#1152 where a redirect lands counts as another page only when the page differs", () => {
  it("calls a different path another page", () => {
    assert.equal(landsOnAnotherPage("https://www.example.test/referral", "https://www.example.test/"), true);
    assert.equal(landsOnAnotherPage("https://example.test/refer", "https://example.test/partners/refer"), true);
  });

  it("calls a different host another page", () => {
    assert.equal(landsOnAnotherPage("https://example.test/refer", "https://other.test/refer"), true);
  });

  it("calls the same page reached by a trailing slash, a www prefix, https or a query string the same page", () => {
    assert.equal(landsOnAnotherPage("https://example.test/refer", "https://example.test/refer/"), false);
    assert.equal(landsOnAnotherPage("https://example.test/refer", "https://www.example.test/refer"), false);
    assert.equal(landsOnAnotherPage("http://example.test/refer", "https://example.test/refer"), false);
    assert.equal(landsOnAnotherPage("https://example.test/refer", "https://example.test/refer?ref=nav"), false);
  });

  it("calls nothing another page when it does not know where the request landed", () => {
    assert.equal(landsOnAnotherPage("https://example.test/refer", undefined), false);
    assert.equal(landsOnAnotherPage("https://example.test/refer", "not a url"), false);
  });
});

describe("#1152 a referral program's page answers only when nothing says it is gone or elsewhere", () => {
  it("answers when it has never been checked", () => {
    assert.equal(programPageAnswers(undefined), true);
  });

  it("answers when the last check reached it where we cite it", () => {
    assert.equal(programPageAnswers(record({ outcome: "reachable", detail: "HEAD 200" })), true);
  });

  it("answers when we were only refused, which is not evidence about the page", () => {
    assert.equal(programPageAnswers(record({ outcome: "unknown", detail: "GET 403" })), true);
  });

  it("does not answer once a check found it unreachable, with no grace window", () => {
    assert.equal(programPageAnswers(record({ last_reachable: null, consecutive_unreachable: 1 })), false);
    assert.equal(programPageAnswers(record({ last_reachable: "2026-08-24", consecutive_unreachable: 1 })), false);
  });

  it("does not answer when it was reached only by redirecting to another page", () => {
    assert.equal(
      programPageAnswers(record({ outcome: "reachable", detail: "HEAD 200", redirected_to: "https://example.test/" })),
      false
    );
  });
});
