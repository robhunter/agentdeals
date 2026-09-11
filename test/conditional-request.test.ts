import { describe, it } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { datedUrl, entityTag, isNotModified, isRevalidation, matchesEntityTag, parseEntityTags, parseHttpDate, revalidationHeaders } from "../dist/conditional-request.js";

const GET = { method: "GET" };

describe("reading a conditional request", () => {
  it("reads the date format every response of ours advertises", () => {
    assert.equal(parseHttpDate("Thu, 10 Sep 2026 00:00:00 GMT"), Date.parse("2026-09-10T00:00:00Z"));
    assert.equal(parseHttpDate("Sun, 06 Nov 1994 08:49:37 GMT"), Date.parse("1994-11-06T08:49:37Z"));
  });

  it("reads the obsolete asctime form a very old client may still send", () => {
    assert.equal(parseHttpDate("Sun Nov  6 08:49:37 1994"), Date.parse("1994-11-06T08:49:37Z"));
  });

  it("refuses a value that is not an HTTP date, so the full body is served instead of a guess", () => {
    for (const value of ["", "not-a-date", "2026-09-10", "2026", "99999", "Thu, 10 Sep 2026", "Thu, 10 Sep 2026 00:00:00"]) {
      assert.equal(parseHttpDate(value), null, `${JSON.stringify(value)} was read as a date`);
    }
    assert.equal(parseHttpDate(undefined), null);
    assert.equal(parseHttpDate(["Thu, 10 Sep 2026 00:00:00 GMT", "Thu, 10 Sep 2026 00:00:00 GMT"]), null);
  });

  it("treats a request carrying a readable date as a revalidation", () => {
    assert.equal(isRevalidation({ ...GET, ifModifiedSince: "Thu, 10 Sep 2026 00:00:00 GMT" }), true);
    assert.equal(isRevalidation({ method: "HEAD", ifModifiedSince: "Thu, 10 Sep 2026 00:00:00 GMT" }), true);
  });

  it("treats a request that names no readable date as no revalidation at all", () => {
    assert.equal(isRevalidation(GET), false);
    assert.equal(isRevalidation({ ...GET, ifModifiedSince: "" }), false);
    assert.equal(isRevalidation({ ...GET, ifModifiedSince: "last Tuesday" }), false);
  });

  it("treats a method that is not a read as no revalidation at all", () => {
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS", undefined]) {
      assert.equal(isRevalidation({ method, ifModifiedSince: "Thu, 10 Sep 2026 00:00:00 GMT" }), false, `${method} revalidated`);
    }
  });

  it("stands aside when the request also carries an entity tag, which is the stronger validator", () => {
    assert.equal(isRevalidation({ ...GET, ifModifiedSince: "Thu, 10 Sep 2026 00:00:00 GMT", ifNoneMatch: '"abc"' }), false);
  });
});

describe("deciding whether a page has changed since the client last read it", () => {
  const day = "Thu, 10 Sep 2026 00:00:00 GMT";

  it("answers not-modified for the page's own day", () => {
    assert.equal(isNotModified({ ...GET, ifModifiedSince: day }, day), true);
  });

  it("answers not-modified for any later day the client names", () => {
    assert.equal(isNotModified({ ...GET, ifModifiedSince: "Fri, 11 Sep 2026 00:00:00 GMT" }, day), true);
    assert.equal(isNotModified({ ...GET, ifModifiedSince: "Thu, 10 Sep 2026 00:00:01 GMT" }, day), true);
  });

  it("answers modified for an earlier day, by one second or by a year", () => {
    assert.equal(isNotModified({ ...GET, ifModifiedSince: "Wed, 09 Sep 2026 23:59:59 GMT" }, day), false);
    assert.equal(isNotModified({ ...GET, ifModifiedSince: "Tue, 10 Sep 2025 00:00:00 GMT" }, day), false);
  });

  it("answers modified when the page carries no day, however recent the one asked about", () => {
    assert.equal(isNotModified({ ...GET, ifModifiedSince: "Fri, 11 Sep 2036 00:00:00 GMT" }, undefined), false);
    assert.equal(isNotModified({ ...GET, ifModifiedSince: "Fri, 11 Sep 2036 00:00:00 GMT" }, "whenever"), false);
  });

  it("answers modified when nothing was asked", () => {
    assert.equal(isNotModified(GET, day), false);
  });
});

describe("the response that answers a revalidation", () => {
  it("keeps the validators and the caching terms", () => {
    const kept = revalidationHeaders({ "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" });
    assert.deepEqual(kept, { "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" });
  });

  it("drops the description of a body it is not sending, however the header is cased", () => {
    const kept = revalidationHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "content-length": "1234",
      "Cache-Control": "public, max-age=3600",
    });
    assert.deepEqual(kept, { "Cache-Control": "public, max-age=3600" });
  });

  it("survives a response that named no headers at all", () => {
    assert.deepEqual(revalidationHeaders(undefined), {});
  });
});

describe("the entity tag a response carries", () => {
  const body = "<!doctype html><title>Supabase</title>";

  it("is a quoted fingerprint of the bytes being sent, and of nothing else", () => {
    const expected = createHash("sha256").update(body).digest("hex").slice(0, 16);
    assert.equal(entityTag(body), `"${expected}"`);
    assert.match(entityTag(body), /^"[0-9a-f]{16}"$/);
  });

  it("moves when a single byte of the body moves", () => {
    assert.notEqual(entityTag(body), entityTag(body + " "));
    assert.notEqual(entityTag(body), entityTag(body.replace("Supabase", "Supabasf")));
  });

  it("is the same tag for the same bytes, so a page that did not change keeps its tag", () => {
    assert.equal(entityTag(body), entityTag(`${body}`));
  });

  it("is unaffected by the day, the route or anything outside the body", () => {
    assert.equal(entityTag(""), entityTag(""));
  });
});

describe("reading the tags a client says it already holds", () => {
  it("reads one tag, a list of them, and the wildcard", () => {
    assert.deepEqual(parseEntityTags('"abc"'), ['"abc"']);
    assert.deepEqual(parseEntityTags('"abc", "def"'), ['"abc"', '"def"']);
    assert.deepEqual(parseEntityTags('W/"abc","def"'), ['W/"abc"', '"def"']);
    assert.deepEqual(parseEntityTags("*"), ["*"]);
  });

  it("reads nothing from a header that was not sent or was sent twice", () => {
    assert.deepEqual(parseEntityTags(undefined), []);
    assert.deepEqual(parseEntityTags(""), []);
    assert.deepEqual(parseEntityTags(['"abc"', '"def"']), []);
  });
});

describe("deciding whether the client already holds the bytes we would send", () => {
  const served = '"4951f239b9145e03"';
  const GET_TAG = (ifNoneMatch: string) => ({ method: "GET", ifNoneMatch });

  it("answers not-modified when the client names the tag we would serve", () => {
    assert.equal(matchesEntityTag(GET_TAG(served), served), true);
    assert.equal(matchesEntityTag({ method: "HEAD", ifNoneMatch: served }, served), true);
  });

  it("compares weakly, so W/ in front of our own tag still matches", () => {
    assert.equal(matchesEntityTag(GET_TAG(`W/${served}`), served), true);
    assert.equal(matchesEntityTag(GET_TAG(served), `W/${served}`), true);
  });

  it("answers not-modified for the wildcard, which asks whether anything is there", () => {
    assert.equal(matchesEntityTag(GET_TAG("*"), served), true);
  });

  it("finds our tag anywhere in a list the client offers", () => {
    assert.equal(matchesEntityTag(GET_TAG(`"0000000000000000", ${served}`), served), true);
    assert.equal(matchesEntityTag(GET_TAG(`"0000000000000000", "1111111111111111"`), served), false);
  });

  it("answers modified for a tag that is not ours, however close", () => {
    assert.equal(matchesEntityTag(GET_TAG('"4951f239b9145e04"'), served), false);
    assert.equal(matchesEntityTag(GET_TAG('"4951f239b9145e0"'), served), false);
    assert.equal(matchesEntityTag(GET_TAG("4951f239b9145e03"), served), false);
  });

  it("answers modified when we have no tag to compare, whatever the client asks", () => {
    assert.equal(matchesEntityTag(GET_TAG(served), null), false);
    assert.equal(matchesEntityTag(GET_TAG("*"), null), false);
  });

  it("answers modified when nothing was asked", () => {
    assert.equal(matchesEntityTag({ method: "GET" }, served), false);
    assert.equal(matchesEntityTag(GET_TAG(""), served), false);
  });

  it("treats a method that is not a read as no revalidation at all", () => {
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS", undefined]) {
      assert.equal(matchesEntityTag({ method, ifNoneMatch: served }, served), false, `${method} revalidated`);
    }
  });
});

describe("the URL a recorded day belongs to", () => {
  it("is the path, with or without a trailing slash", () => {
    assert.equal(datedUrl("/privacy", ""), "/privacy");
    assert.equal(datedUrl("/vendor/supabase/", ""), "/vendor/supabase");
    assert.equal(datedUrl("/", ""), "/");
  });

  it("is no URL at all once a query string is attached, because that body was never dated", () => {
    assert.equal(datedUrl("/privacy", "?utm_source=x"), null);
    assert.equal(datedUrl("/estimate", "?stack=web"), null);
    assert.equal(datedUrl("/", "?q=redis"), null);
  });
});
