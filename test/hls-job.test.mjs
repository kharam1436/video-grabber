import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveObjectURL } from "node:buffer";
import vm from "node:vm";

// Runs the real background scripts against stubbed WebExtension APIs and a
// fake network serving the test fixtures. No OPFS here, so jobs use the
// in-memory sink; the ordering/resume logic is the same.
function loadBackground(serve) {
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
    console,
    fetch: serve,
    // Don't let the jobs' 60 s expiry timers keep the test process alive.
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  });
  context.window = context;
  for (const file of ["vendor/mux-mp4.min.js", "lib/formats.js", "lib/remux.js", "background.js"]) {
    vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), context, { filename: file });
  }
  // Top-level const/let live in the context's script scope, not on its global.
  return { context, downloads, jobs: vm.runInContext("jobs", context) };
}

const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url));
const playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:1\n" + [0, 1, 2].map((i) => `#EXTINF:1.0,\nseg${i}.ts`).join("\n") + "\n#EXT-X-ENDLIST\n";

function network(failing) {
  return async (url) => {
    const name = new URL(url).pathname.slice(1);
    if (failing.has(name)) return { ok: false, status: 503 };
    const body = name === "index.m3u8" ? Buffer.from(playlist) : fixture(name);
    return {
      ok: true,
      status: 200,
      text: async () => body.toString(),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
}

async function settle(job) {
  while (job.status === "running" || job.status === "saving") await new Promise((r) => setTimeout(r, 20));
}

async function savedBytes(download) {
  return Buffer.from(await resolveObjectURL(download.url).arrayBuffer());
}

test("a failed HLS download resumes where it stopped and matches an uninterrupted one", { timeout: 30_000 }, async () => {
  // Reference: everything in one go.
  const clean = loadBackground(network(new Set()));
  const cleanJob = clean.jobs.get(await clean.context.downloadHls("https://e.com/index.m3u8", "", "clip"));
  await settle(cleanJob);
  assert.equal(cleanJob.status, "done");
  assert.equal(clean.downloads[0].filename, "clip.mp4");
  const expected = await savedBytes(clean.downloads[0]);

  // seg2 is unavailable at first: seg0/seg1 get written, then the job fails
  // (after fetchWithReferer's retries) and waits for a resume.
  const failing = new Set(["seg2.ts"]);
  const flaky = loadBackground(network(failing));
  const job = flaky.jobs.get(await flaky.context.downloadHls("https://e.com/index.m3u8", "", "clip"));
  await settle(job);
  assert.equal(job.status, "error");
  assert.equal(job.retry, "resume");
  assert.equal(job.nextWrite, 2);
  assert.equal(flaky.downloads.length, 0);

  failing.clear();
  flaky.context.runHlsJob(job);
  await settle(job);
  assert.equal(job.status, "done");
  assert.equal(flaky.downloads[0].filename, "clip.mp4");
  assert.deepEqual(await savedBytes(flaky.downloads[0]), expected);
});
