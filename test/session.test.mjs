import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Same approach as formats.test.mjs: run the classic script in a sandbox.
const context = vm.createContext({ URL });
vm.runInContext(readFileSync(new URL("../lib/session.js", import.meta.url), "utf8"), context);
vm.runInContext(
  "globalThis.api = { replayableHeaders, headersFor, mergeCookies, applyHeaders, samePath, sameFileName, pickRendition, sameStream };",
  context
);
// Clone results out of the sandbox realm so deepEqual compares plain objects.
const api = Object.fromEntries(
  Object.entries(context.api).map(([name, fn]) => [name, (...args) => structuredClone(fn(...args))])
);

const h = (name, value) => ({ name, value });

test("replayableHeaders keeps what a server may check and drops the rest", () => {
  const sent = [
    h("Host", "e.com"),
    h("Referer", "https://e.com/watch"),
    h("Origin", "https://e.com"),
    h("Cookie", "s=1"),
    h("Authorization", "Bearer t"),
    h("X-Playback-Session-Id", "abc"),
    h("Range", "bytes=0-"),
    h("Accept-Encoding", "gzip"),
    h("If-None-Match", '"etag"'),
    { name: "X-Binary", binaryValue: [1, 2] },
  ];
  assert.deepEqual(
    api.replayableHeaders(sent).map((x) => x.name),
    ["Referer", "Origin", "Cookie", "Authorization", "X-Playback-Session-Id"]
  );
});

test("headersFor sends credentials only back to the host they came from", () => {
  const sent = { url: "https://e.com/master.m3u8", headers: [h("Referer", "https://e.com/"), h("Cookie", "s=1"), h("Authorization", "a")] };
  assert.equal(api.headersFor("https://e.com/seg1.ts", sent).length, 3);
  assert.deepEqual(api.headersFor("https://cdn.other.net/seg1.ts", sent), [h("Referer", "https://e.com/")]);
  assert.deepEqual(api.headersFor("https://e.com/x", null), []);
});

test("mergeCookies keeps the browser's newer cookies and adds the page's missing ones", () => {
  assert.equal(api.mergeCookies("a=new; b=2", "a=old; c=3"), "a=new; b=2; c=3");
  assert.equal(api.mergeCookies("", "c=3"), "c=3");
});

test("applyHeaders replaces, merges cookies and drops the extension's Origin", () => {
  const request = [h("Accept", "*/*"), h("Origin", "moz-extension://1234"), h("Cookie", "a=1"), h("referer", "x")];
  assert.deepEqual(api.applyHeaders(request, [h("Referer", "https://e.com/"), h("Cookie", "b=2")]), [
    h("Accept", "*/*"),
    h("Cookie", "a=1; b=2"),
    h("referer", "https://e.com/"),
  ]);
  // The page's own Origin is replayed instead.
  assert.deepEqual(api.applyHeaders([h("Origin", "moz-extension://1234")], [h("Origin", "https://e.com")]), [
    h("Origin", "https://e.com"),
  ]);
});

test("samePath and sameFileName ignore changing tokens", () => {
  assert.ok(api.samePath("https://e.com/v/720.m3u8?t=1", "https://e.com/v/720.m3u8?t=2"));
  assert.ok(!api.samePath("https://e.com/v/720.m3u8", "https://e.com/v/480.m3u8"));
  assert.ok(api.sameFileName("https://e.com/tok1/720.m3u8", "https://e.com/tok2/720.m3u8"));
  assert.ok(!api.sameFileName("https://e.com/a/", "https://e.com/b/"));
});

test("pickRendition finds the same rendition in a fresh master playlist", () => {
  const pl = {
    variants: [
      { url: "https://e.com/1080.m3u8?t=2", resolution: "1920x1080", bandwidth: 5_000_000 },
      { url: "https://e.com/720.m3u8?t=2", resolution: "1280x720", bandwidth: 2_800_000 },
      { url: "https://e.com/720b.m3u8?t=2", resolution: "1280x720", bandwidth: 2_000_000 },
    ],
    audio: [{ url: "https://e.com/aud-en.m3u8?t=2", name: "English" }],
  };
  const url = (r) => r && r.url;
  assert.equal(url(api.pickRendition(pl, "https://e.com/720.m3u8?t=1")), "https://e.com/720.m3u8?t=2", "by path");
  // Path changed (token in the path): by what it was.
  const elsewhere = "https://e.com/old/x.m3u8";
  assert.equal(url(api.pickRendition(pl, elsewhere, { resolution: "1280x720", bandwidth: 2_100_000 })), "https://e.com/720b.m3u8?t=2");
  assert.equal(url(api.pickRendition(pl, elsewhere, { audio: "English" })), "https://e.com/aud-en.m3u8?t=2");
  assert.equal(api.pickRendition(pl, elsewhere, { audio: "French" }), null);
  assert.equal(url(api.pickRendition(pl, elsewhere, {})), "https://e.com/1080.m3u8?t=2", "best by default");
});

test("sameStream requires the same segment count and length", () => {
  assert.ok(api.sameStream({ count: 300, duration: 1800 }, { count: 300, duration: 1800.2 }));
  assert.ok(!api.sameStream({ count: 300, duration: 1800 }, { count: 301, duration: 1800 }));
  assert.ok(!api.sameStream({ count: 300, duration: 1800 }, { count: 300, duration: 1830 }));
  assert.ok(api.sameStream({ count: 3, duration: 0 }, { count: 3, duration: 3 }), "unknown length: count only");
});
