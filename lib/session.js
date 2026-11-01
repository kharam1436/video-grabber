"use strict";

// Pure helpers for keeping a download inside the page's session: which of
// the page's request headers to send again, and how to find the same stream
// once the page has been reopened. Classic script like lib/formats.js, so
// the Node tests can load it.

// ---------- request headers ----------

// What a server may check before handing out media: where the request comes
// from, who is asking, and custom player headers (X-Playback-Session-Id, ...).
// Cache validators, Range, Accept-Encoding and the like are left to fetch().
const REPLAY_HEADERS = new Set(["referer", "origin", "authorization", "cookie"]);
// Only sent back to the host they were captured from.
const PRIVATE_HEADERS = new Set(["authorization", "cookie"]);

// The headers worth replaying out of a request the page made.
function replayableHeaders(requestHeaders) {
  return requestHeaders
    .filter(({ name, value }) => {
      const n = name.toLowerCase();
      return typeof value === "string" && (REPLAY_HEADERS.has(n) || n.startsWith("x-"));
    })
    .map(({ name, value }) => ({ name, value }));
}

// `sent` is what the page sent and where: { url, headers }. Returns the
// headers to add to a request for `url`, dropping credentials that were
// meant for another host (segments often live on a different CDN).
function headersFor(url, sent) {
  if (!sent) return [];
  let sameHost = false;
  try {
    sameHost = new URL(url).host === new URL(sent.url).host;
  } catch {
    // Unparsable URL: treat as foreign.
  }
  return sent.headers.filter((h) => sameHost || !PRIVATE_HEADERS.has(h.name.toLowerCase()));
}

// Cookies the browser attaches itself are newer (the server may have
// rotated them during the download), so they win; the page's cookies only
// fill in names the extension's cookie jar lacks, e.g. ones Firefox keeps
// partitioned per site or per container.
function mergeCookies(own, captured) {
  const pairs = (s) => s.split(";").map((p) => p.trim()).filter(Boolean);
  const name = (p) => p.split("=")[0].trim();
  const mine = pairs(own);
  const names = new Set(mine.map(name));
  return [...mine, ...pairs(captured).filter((p) => !names.has(name(p)))].join("; ");
}

// Applies `extra` (from headersFor) to the request headers of an extension
// request. The extension's own Origin is dropped: the page's request had
// either its own Origin (replayed) or none at all.
function applyHeaders(requestHeaders, extra) {
  const out = requestHeaders.filter(
    (h) => !(h.name.toLowerCase() === "origin" && /^moz-extension:/i.test(h.value || ""))
  );
  for (const h of extra) {
    const n = h.name.toLowerCase();
    const i = out.findIndex((o) => o.name.toLowerCase() === n);
    if (i < 0) out.push({ name: h.name, value: h.value });
    else if (n === "cookie") out[i] = { name: out[i].name, value: mergeCookies(out[i].value || "", h.value) };
    else out[i] = { name: out[i].name, value: h.value };
  }
  return out;
}

// ---------- finding the stream again ----------

// Signed URLs keep the path and change the query, so the path identifies
// the same file across sessions.
function samePath(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.host === y.host && x.pathname === y.pathname;
  } catch {
    return false;
  }
}

// Same last path segment ("index_720.m3u8"), for tokens put in the path.
function sameFileName(a, b) {
  try {
    const name = (u) => new URL(u).pathname.split("/").pop();
    return name(a) !== "" && name(a) === name(b);
  } catch {
    return false;
  }
}

// Picks the rendition of a freshly loaded master playlist `pl` that matches
// the one being downloaded: `oldUrl` is its previous playlist URL and
// `want` what it was ({ resolution, bandwidth } or { audio: name }).
function pickRendition(pl, oldUrl, want = {}) {
  const all = [...pl.variants, ...pl.audio];
  const byPath = all.find((r) => samePath(r.url, oldUrl)) || all.find((r) => sameFileName(r.url, oldUrl));
  if (byPath) return byPath;
  if (want.audio) return pl.audio.find((a) => a.name === want.audio) || null;
  if (!pl.variants.length) return null;
  const sameRes = pl.variants.filter((v) => want.resolution && v.resolution === want.resolution);
  const pool = sameRes.length ? sameRes : pl.variants;
  const distance = (v) => Math.abs(v.bandwidth - (want.bandwidth || 0));
  return want.bandwidth ? pool.reduce((a, b) => (distance(b) < distance(a) ? b : a)) : pool[0];
}

// Whether a fresh media playlist describes the same video as the one being
// downloaded, so its segments can continue the file. Ads or a different
// episode change the segment count or the length.
function sameStream(old, fresh) {
  if (old.count !== fresh.count) return false;
  if (old.duration && fresh.duration && Math.abs(old.duration - fresh.duration) > 0.5) return false;
  return true;
}
