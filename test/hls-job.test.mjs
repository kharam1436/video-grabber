import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveObjectURL } from "node:buffer";
import vm from "node:vm";

// Runs the real background scripts against stubbed WebExtension APIs and a
// fake network serving the test fixtures. No OPFS here, so jobs use the
// in-memory sink; the ordering/retry/resume logic is the same.
function loadBackground(serve, retry = { autoDelaysMs: [] }) {
  const downloads = [];
  const listenable = () => new Proxy({}, { get: () => () => {} });
  const browser = {
    webRequest: { onBeforeRequest: listenable(), onHeadersReceived: listenable(), onBeforeSendHeaders: listenable() },
    tabs: { onRemoved: listenable() },
    runtime: { onMessage: listenable() },
    downloads: {
      onChanged: listenable(),
      download: async (opts) => downloads.push(opts) && downloads.length,
    },
    browserAction: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  };
  const context = vm.createContext({
    browser,
    URL,
    Blob,
    console: { ...console, warn() {} }, // "OPFS unavailable" is expected here
    fetch: serve,
    // Don't let the jobs' 60 s expiry timers keep the test process alive.
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout,
  });
  context.window = context;
  for (const file of ["vendor/mux-mp4.min.js", "lib/formats.js", "lib/remux.js", "background.js"]) {
    vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
  }
  // Top-level const/let live in the context's script scope, not on its global.
  Object.assign(vm.runInContext("RETRY", context), { baseDelayMs: 1, ...retry });
  return { context, downloads, jobs: vm.runInContext("jobs", context) };
}

const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url));
const mediaPlaylist =
  "#EXTM3U\n#EXT-X-TARGETDURATION:1\n" + [0, 1, 2].map((i) => `#EXTINF:1.0,\nseg${i}.ts`).join("\n") + "\n#EXT-X-ENDLIST\n";

// `script` maps a path to responses to give, in order, before behaving
// normally: a status number, or "html" for a 200 OK error page.
function network(script = {}, playlist = mediaPlaylist) {
  const requests = {};
  const serve = async (url) => {
    const name = new URL(url).pathname.slice(1);
    requests[name] = (requests[name] || 0) + 1;
    const scripted = script[name]?.shift();
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
  return { serve, requests };
}

async function settle(job) {
  while (["running", "saving", "waiting"].includes(job.status)) await new Promise((r) => setTimeout(r, 10));
}

async function download(bg) {
  const job = bg.jobs.get(await bg.context.downloadHls("https://e.com/index.m3u8", "", "clip"));
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
  // seg2 keeps failing past fetchWithReferer's retries; no automatic resumes.
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
  const bg = loadBackground(net.serve, { autoDelaysMs: [5] });
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
  const bg = loadBackground(network({}, encrypted).serve, { autoDelaysMs: [5] });
  const job = await download(bg);
  assert.equal(job.status, "error");
  assert.match(job.error, /encrypted/);
  assert.equal(job.retry, null);
  assert.equal(job.autoRetries, 0);
});
