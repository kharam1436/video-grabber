import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveObjectURL } from "node:buffer";
import vm from "node:vm";

// Runs the real background scripts against stubbed WebExtension APIs and a
// fake network serving the test fixtures. No OPFS here, so jobs use the
// in-memory sink; the ordering/retry/resume logic is the same.
//
// `serve(url, init, requestHeaders)` gets the headers the extension's
// blocking onBeforeSendHeaders listener would put on the request.
// `onTabCreated(tab, bg)` plays the part of a page loading in a tab the
// extension opened (see pageRequests).
function loadBackground(serve, { retry = {}, onTabCreated } = {}) {
  const downloads = [];
  const listeners = {};
  const event = (name) => ({
    addListener: (fn) => (listeners[name] ||= []).push(fn),
    removeListener: (fn) => (listeners[name] = (listeners[name] || []).filter((f) => f !== fn)),
  });
  const emit = (name, ...args) => (listeners[name] || []).map((fn) => fn(...args)).find((r) => r !== undefined);
  const tabs = { opened: [], closed: [] };
  const bg = { downloads, tabs, emit, downloadState: {}, downloadCalls: [] };
  const browser = {
    webRequest: Object.fromEntries(
      ["onBeforeRequest", "onSendHeaders", "onErrorOccurred", "onHeadersReceived", "onBeforeSendHeaders"].map((n) => [n, event(n)])
    ),
    tabs: {
      onRemoved: event("tabs.onRemoved"),
      create: async (props) => {
        const tab = { id: 100 + tabs.opened.length, ...props };
        tabs.opened.push(tab);
        setTimeout(() => onTabCreated?.(tab, bg), 0);
        return tab;
      },
      remove: async (id) => void tabs.closed.push(id),
      sendMessage: async () => {},
    },
    runtime: { onMessage: event("runtime.onMessage") },
    // Download ids are 1-based indexes into `downloads`; a test sets the
    // state Firefox would report in `downloadState`.
    downloads: {
      onChanged: event("downloads.onChanged"),
      download: async (opts) => downloads.push(opts) && downloads.length,
      search: async ({ id }) => [{ id, state: "in_progress", bytesReceived: 0, totalBytes: -1, ...bg.downloadState[id] }],
      cancel: async (id) => void bg.downloadCalls.push(["cancel", id]),
      erase: async ({ id }) => void bg.downloadCalls.push(["erase", id]),
      resume: async (id) => void bg.downloadCalls.push(["resume", id]),
    },
    browserAction: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  };
  const sendHeaders = (url) =>
    emit("onBeforeSendHeaders", { url, tabId: -1, requestHeaders: [] })?.requestHeaders ?? [];
  const context = vm.createContext({
    browser,
    URL,
    Blob,
    console: { ...console, warn() {} }, // "OPFS unavailable" is expected here
    fetch: (url, init) => serve(url, init, sendHeaders(url)),
    AbortController,
    // Don't let the jobs' 60 s expiry timers keep the test process alive.
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout,
  });
  context.window = context;
  for (const file of ["vendor/mux-mp4.min.js", "lib/formats.js", "lib/session.js", "lib/remux.js", "background.js"]) {
    vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
  }
  // Top-level const/let live in the context's script scope, not on its global.
  Object.assign(vm.runInContext("RETRY", context), { baseDelayMs: 1, autoDelaysMs: [], ...retry });
  Object.assign(vm.runInContext("REVISIT", context), { timeoutMs: 300, kickEveryMs: 50 });
  bg.context = context;
  bg.send = (msg) => emit("runtime.onMessage", msg, {});
  bg.jobs = vm.runInContext("jobs", context);
  return bg;
}

// What the page in `tab` does as its player starts: requests `url` with
// `headers`, gets an HLS playlist (or `type`) back.
let requestId = 0;
function pageRequests(bg, tab, url, headers, type = "application/vnd.apple.mpegurl") {
  const id = String(++requestId);
  bg.emit("onSendHeaders", { requestId: id, tabId: tab.id, url, requestHeaders: headers });
  bg.emit("onHeadersReceived", {
    requestId: id,
    tabId: tab.id,
    url,
    statusCode: 200,
    responseHeaders: [{ name: "Content-Type", value: type }],
  });
}

const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url));
const mediaPlaylist =
  "#EXTM3U\n#EXT-X-TARGETDURATION:1\n" + [0, 1, 2].map((i) => `#EXTINF:1.0,\nseg${i}.ts`).join("\n") + "\n#EXT-X-ENDLIST\n";

// `script` maps a path to responses to give, in order, before behaving
// normally: a status number, "html" for a 200 OK error page, or
// { delay: ms } to answer only after that long. Like fetch(), a request
// rejects with an AbortError as soon as its signal is aborted.
function network(script = {}, playlist = mediaPlaylist) {
  const requests = {};
  const aborted = {};
  const serve = async (url, { signal } = {}) => {
    const name = new URL(url).pathname.slice(1);
    requests[name] = (requests[name] || 0) + 1;
    const scripted = script[name]?.shift();
    if (scripted?.delay) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, scripted.delay);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          aborted[name] = (aborted[name] || 0) + 1;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }
    const respond = (status, body, type) => ({
      ok: status === 200,
      status,
      headers: { get: (h) => (h === "content-type" ? type : null) },
      text: async () => body.toString(),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    });
    if (typeof scripted === "number") return respond(scripted, Buffer.alloc(0), "text/plain");
    if (scripted === "html") return respond(200, Buffer.from("<!DOCTYPE html><title>Busy</title>"), "text/html");
    if (name === "index.m3u8") return respond(200, Buffer.from(playlist), "application/vnd.apple.mpegurl");
    return respond(200, fixture(name), "video/mp2t");
  };
  return { serve, requests, aborted };
}

async function settle(job) {
  while (["running", "saving", "waiting", "renewing"].includes(job.status)) await new Promise((r) => setTimeout(r, 10));
}

async function download(bg) {
  const job = bg.jobs.get(await bg.context.downloadHls({ playlistUrl: "https://e.com/index.m3u8", baseName: "clip" }));
  await settle(job);
  return job;
}

const savedBytes = async (d) => Buffer.from(await resolveObjectURL(d.url).arrayBuffer());

// Reference output: everything in one go.
let expected;
test.before(async () => {
  const bg = loadBackground(network().serve);
  const job = await download(bg);
  assert.equal(job.status, "done");
  assert.equal(bg.downloads[0].filename, "clip.mp4");
  expected = await savedBytes(bg.downloads[0]);
});

test("a failed HLS download resumes where it stopped and matches an uninterrupted one", async () => {
  // seg2 keeps failing past fetchMedia's retries; no automatic resumes.
  const net = network({ "seg2.ts": Array(5).fill(503) });
  const bg = loadBackground(net.serve);
  const job = await download(bg);
  assert.equal(job.status, "error");
  assert.equal(job.retry, "resume");
  assert.equal(job.nextWrite, 2);
  assert.equal(bg.downloads.length, 0);

  bg.context.runHlsJob(job); // what the popup's Resume button does
  await settle(job);
  assert.equal(job.status, "done");
  assert.equal(net.requests["seg0.ts"], 1, "written segments aren't fetched again");
  assert.deepEqual(await savedBytes(bg.downloads[0]), expected);
});

test("error pages served as 200 OK are retried instead of saved", async () => {
  const net = network({ "seg1.ts": ["html", "html"] });
  const bg = loadBackground(net.serve);
  const job = await download(bg);
  assert.equal(job.status, "done");
  assert.equal(net.requests["seg1.ts"], 3);
  assert.deepEqual(await savedBytes(bg.downloads[0]), expected);
});

test("a job that runs out of fetch retries resumes automatically", async () => {
  // 5 failures exhaust one run's fetch retries; the automatic resume succeeds.
  const net = network({ "seg2.ts": Array(5).fill(503) });
  const bg = loadBackground(net.serve, { retry: { autoDelaysMs: [5] } });
  const job = await download(bg);
  assert.equal(job.status, "done");
  assert.equal(job.autoRetries, 1);
  assert.deepEqual(await savedBytes(bg.downloads[0]), expected);
});

test("permanent HTTP errors fail without retrying", async () => {
  const net = network({ "seg1.ts": [404] });
  const bg = loadBackground(net.serve);
  const job = await download(bg);
  assert.equal(job.status, "error");
  assert.equal(net.requests["seg1.ts"], 1);
  assert.equal(job.retry, "resume", "the user can still try again (e.g. after a URL refresh)");
});

test("unsupported streams fail without offering a resume", async () => {
  const encrypted = mediaPlaylist.replace("#EXT-X-TARGETDURATION:1", '#EXT-X-TARGETDURATION:1\n#EXT-X-KEY:METHOD=AES-128,URI="k"');
  const bg = loadBackground(network({}, encrypted).serve, { retry: { autoDelaysMs: [5] } });
  const job = await download(bg);
  assert.equal(job.status, "error");
  assert.match(job.error, /encrypted/);
  assert.equal(job.retry, null);
  assert.equal(job.autoRetries, 0);
});

test("cancel aborts segment requests in flight instead of waiting for them", async () => {
  const net = network({ "seg1.ts": [{ delay: 60_000 }] });
  const bg = loadBackground(net.serve);
  const job = bg.jobs.get(await bg.context.downloadHls({ playlistUrl: "https://e.com/index.m3u8", baseName: "clip" }));
  while (!net.requests["seg1.ts"]) await new Promise((r) => setTimeout(r, 5));
  const started = Date.now();
  await bg.send({ type: "cancel", jobId: job.id });
  await settle(job);
  assert.equal(job.status, "cancelled");
  assert.equal(net.aborted["seg1.ts"], 1);
  assert.ok(Date.now() - started < 1000, "didn't wait for the slow segment");
  assert.equal(bg.downloads.length, 0);
});

test("a failure stops the other workers before the job can be resumed", async () => {
  // seg0 fails for good while seg2 is still downloading: seg2's request is
  // aborted, and nothing is written after the job reports the error.
  const net = network({ "seg0.ts": [404], "seg2.ts": [{ delay: 60_000 }] });
  const bg = loadBackground(net.serve);
  const job = await download(bg);
  assert.equal(job.status, "error");
  assert.equal(job.nextWrite, 0);
  assert.equal(net.aborted["seg2.ts"], 1);

  bg.context.runHlsJob(job);
  await settle(job);
  assert.equal(job.status, "done");
  assert.deepEqual(await savedBytes(bg.downloads[0]), expected);
});

// A site whose links stop working mid-download: every URL carries a token
// (`?t=`), and once seg0 has been served only a newer token is accepted,
// for the playlist too. Reopening the page hands out the newer one.
// `tokenInPlaylistUrl: false` keeps the playlist URL itself token-free, so
// re-fetching it is enough to get fresh segment URLs.
function expiringSite({ tokenInPlaylistUrl = true, freshPlaylist = mediaPlaylist } = {}) {
  let valid = "old";
  const sent = {}; // path -> headers of the last request for it
  const serve = async (url, init, headers) => {
    const u = new URL(url);
    const name = u.pathname.slice(1);
    sent[name] = headers;
    const token = u.searchParams.get("t");
    const respond = (status, body, type) => ({
      ok: status === 200,
      status,
      headers: { get: (h) => (h === "content-type" ? type : null) },
      text: async () => body.toString(),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    });
    if (name === "index.m3u8") {
      if (tokenInPlaylistUrl && token !== valid) return respond(403, Buffer.alloc(0), "text/plain");
      const pl = valid === "new" ? freshPlaylist : mediaPlaylist;
      return respond(200, Buffer.from(pl.replace(/(seg\d\.ts)/g, `$1?t=${valid}`)), "application/vnd.apple.mpegurl");
    }
    if (token !== valid) return respond(403, Buffer.alloc(0), "text/plain");
    if (name === "seg0.ts") valid = "new"; // the session runs out here
    return respond(200, fixture(name), "video/mp2t");
  };
  return { serve, sent, renew: () => (valid = "new") };
}

const page = { url: "https://e.com/watch/1", windowId: 1, cookieStoreId: "firefox-default", incognito: false };

test("a download the server starts refusing continues after reopening the page", async () => {
  const site = expiringSite();
  const bg = loadBackground(site.serve, {
    onTabCreated: (tab, bg) =>
      pageRequests(bg, tab, "https://e.com/index.m3u8?t=new", [
        { name: "Referer", value: page.url },
        { name: "Cookie", value: "session=new" },
        { name: "Accept-Encoding", value: "gzip" },
      ]),
  });
  const job = bg.jobs.get(
    bg.context.downloadHls({
      playlistUrl: "https://e.com/index.m3u8?t=old",
      sent: { url: "https://e.com/index.m3u8?t=old", headers: [{ name: "Cookie", value: "session=old" }] },
      baseName: "clip",
      page,
    })
  );
  await settle(job);
  assert.equal(job.status, "done", job.error);
  assert.deepEqual(await savedBytes(bg.downloads[0]), expected);

  const [tab] = bg.tabs.opened;
  assert.equal(bg.tabs.opened.length, 1);
  assert.deepEqual([tab.url, tab.active, tab.muted, tab.windowId], [page.url, false, true, 1]);
  assert.deepEqual(bg.tabs.closed, [tab.id], "the background tab is closed again");
  // The rest of the download is sent as the reopened page sent it.
  const headers = Object.fromEntries(site.sent["seg2.ts"].map((h) => [h.name, h.value]));
  assert.deepEqual(headers, { Referer: page.url, Cookie: "session=new" });
});

test("fresh segment URLs from the same playlist are used without reopening the page", async () => {
  const site = expiringSite({ tokenInPlaylistUrl: false });
  const bg = loadBackground(site.serve);
  const job = bg.jobs.get(
    bg.context.downloadHls({ playlistUrl: "https://e.com/index.m3u8", baseName: "clip", page })
  );
  await settle(job);
  assert.equal(job.status, "done", job.error);
  assert.equal(bg.tabs.opened.length, 0);
  assert.deepEqual(await savedBytes(bg.downloads[0]), expected);
});

test("a different video on the reopened page isn't spliced in", async () => {
  // The page now plays something with another segment count (an ad, say).
  const twoSegments = mediaPlaylist.replace("#EXTINF:1.0,\nseg2.ts\n", "");
  const site = expiringSite({ freshPlaylist: twoSegments });
  const bg = loadBackground(site.serve, {
    onTabCreated: (tab, bg) => pageRequests(bg, tab, "https://e.com/index.m3u8?t=new", []),
  });
  const job = bg.jobs.get(
    bg.context.downloadHls({ playlistUrl: "https://e.com/index.m3u8?t=old", baseName: "clip", page })
  );
  await settle(job);
  assert.equal(job.status, "error");
  assert.match(job.error, /HTTP 403.*reopening the page didn't help/);
  assert.equal(job.retry, "resume");
  assert.equal(job.nextWrite, 1, "what was written is kept for a resume");
  assert.equal(bg.tabs.opened.length, 1, "no second attempt without progress");
  assert.equal(bg.tabs.closed.length, 1);
});

test("cancel during a session renewal stops it and closes the tab", async () => {
  const site = expiringSite();
  const bg = loadBackground(site.serve); // the page never loads the video
  const job = bg.jobs.get(
    bg.context.downloadHls({ playlistUrl: "https://e.com/index.m3u8?t=old", baseName: "clip", page })
  );
  while (job.status !== "renewing" || !bg.tabs.opened.length) await new Promise((r) => setTimeout(r, 5));
  await bg.send({ type: "cancel", jobId: job.id });
  await settle(job);
  assert.equal(job.status, "cancelled");
  assert.equal(bg.tabs.closed.length, 1);
});

test("a file download refused with 403 restarts from the URL the reopened page uses", async () => {
  const forbidden = async () => ({ ok: false, status: 403, headers: { get: () => null } });
  const bg = loadBackground(forbidden, {
    onTabCreated: (tab, bg) =>
      pageRequests(bg, tab, "https://e.com/v.mp4?t=new", [{ name: "Cookie", value: "s=new" }], "video/mp4"),
  });
  const item = { url: "https://e.com/v.mp4?t=old", kind: "file", contentType: "video/mp4", size: 0, sent: null };
  const job = bg.jobs.get(await bg.context.downloadFile(item, "clip", page));
  assert.equal(bg.downloads[0].url, item.url);

  // Firefox reports the server refusing to go on halfway through.
  bg.downloadState[1] = { state: "interrupted", error: "SERVER_FORBIDDEN", bytesReceived: 50, canResume: true };
  await bg.emit("downloads.onChanged", { id: 1, state: { current: "interrupted" } });
  while (bg.downloads.length < 2 && job.status !== "error") await new Promise((r) => setTimeout(r, 5));

  assert.equal(job.status, "running", job.error);
  assert.equal(bg.downloads[1].url, "https://e.com/v.mp4?t=new");
  assert.equal(bg.downloads[1].filename, "clip.mp4");
  assert.equal(job.downloadId, 2);
  assert.deepEqual(bg.downloadCalls, [["cancel", 1], ["erase", 1]], "the dead partial download is dropped");
  assert.equal(bg.tabs.closed.length, 1);
});
