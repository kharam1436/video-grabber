"use strict";

const HLS_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
]);
// Individual stream segments: never interesting on their own.
const SEGMENT_TYPES = new Set(["video/mp2t", "audio/mp2t", "video/iso.segment"]);
const SEGMENT_EXT = /\.(ts|m4s|aac|vtt|webvtt)(?:$|[?#])/i;
const MEDIA_EXT = /\.(mp4|webm|mkv|mov|m4v|ogv|flv|avi|mp3|m4a|ogg|opus|wav|flac)(?:$|[?#])/i;
const HLS_EXT = /\.m3u8(?:$|[?#])/i;

const EXT_FOR_TYPE = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/ogg": "ogv",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/x-flv": "flv",
  "video/x-msvideo": "avi",
  "video/3gpp": "3gp",
  "video/mp2t": "ts",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
};
const TYPE_FOR_EXT = Object.fromEntries(Object.entries(EXT_FOR_TYPE).map(([t, e]) => [e, t]));

// tabId -> { items: Map<url, item>, children: Set<url> }
// `children` holds variant/audio playlists of a master playlist, which are
// shown as options under the master instead of as separate entries.
const tabState = new Map();
// jobId -> HLS download job
const jobs = new Map();
let nextJobId = 1;
// url -> Referer to send when the extension itself fetches that url
const referers = new Map();

function stateFor(tabId) {
  let s = tabState.get(tabId);
  if (!s) {
    s = { items: new Map(), children: new Set() };
    tabState.set(tabId, s);
  }
  return s;
}

function header(headers, name) {
  const h = headers.find((h) => h.name.toLowerCase() === name);
  return h ? h.value : "";
}

function classify(url, contentType) {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  if (HLS_TYPES.has(ct) || HLS_EXT.test(url)) return "hls";
  if (SEGMENT_TYPES.has(ct) || SEGMENT_EXT.test(url)) return null;
  if (ct.startsWith("video/") || ct.startsWith("audio/")) return "file";
  if ((!ct || ct === "application/octet-stream" || ct === "binary/octet-stream") && MEDIA_EXT.test(url)) {
    return "file";
  }
  return null;
}

function addItem(tabId, item) {
  const s = stateFor(tabId);
  if (s.items.has(item.url)) return;
  s.items.set(item.url, item);
  updateBadge(tabId);
  if (item.kind === "hls") analyzeHls(tabId, item);
}

function visibleItems(tabId) {
  const s = tabState.get(tabId);
  if (!s) return [];
  return [...s.items.values()].filter((i) => !s.children.has(i.url));
}

function updateBadge(tabId) {
  const n = visibleItems(tabId).length;
  browser.browserAction.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => {});
  browser.browserAction.setBadgeBackgroundColor({ tabId, color: "#2563eb" }).catch(() => {});
}

// ---------- detection ----------

browser.webRequest.onBeforeRequest.addListener(
  (d) => {
    // New top-level page: forget what the previous page played.
    tabState.delete(d.tabId);
    updateBadge(d.tabId);
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

browser.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const kind = classify(d.url, header(d.responseHeaders, "content-type"));
    if (!kind) return;

    let size = Number(header(d.responseHeaders, "content-length")) || 0;
    if (d.statusCode === 206) {
      // Players fetch media in ranges; only the range starting at 0 tells us
      // it's the start of a whole file. Later ranges are the same file again,
      // and MSE players (which we can't help with) produce endless fragments.
      const m = /bytes (\d+)-\d+\/(\d+|\*)/.exec(header(d.responseHeaders, "content-range"));
      if (!m || m[1] !== "0") return;
      size = Number(m[2]) || 0;
    }

    addItem(d.tabId, {
      url: d.url,
      kind,
      contentType: header(d.responseHeaders, "content-type"),
      size,
      referer: d.documentUrl || d.originUrl || "",
    });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "object", "other"] },
  ["responseHeaders"]
);

browser.webRequest.onBeforeSendHeaders.addListener(
  (d) => {
    // Some CDNs reject requests without the page's Referer; requests made by
    // this extension (playlist/segment fetches, downloads) don't carry one.
    if (d.tabId >= 0) return;
    const referer = referers.get(d.url);
    if (!referer) return;
    const headers = d.requestHeaders.filter((h) => h.name.toLowerCase() !== "referer");
    headers.push({ name: "Referer", value: referer });
    return { requestHeaders: headers };
  },
  { urls: ["<all_urls>"] },
  ["blocking", "requestHeaders"]
);

browser.tabs.onRemoved.addListener((tabId) => tabState.delete(tabId));

// ---------- HLS ----------

// Retry tuning; the tests shrink these.
const RETRY = {
  fetchTries: 5,
  baseDelayMs: 1000, // doubled per attempt, capped at 15 s
  // Automatic resumes of a failed HLS job / interrupted file download
  // before asking the user.
  autoDelaysMs: [5_000, 20_000, 60_000],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Errors not worth retrying automatically (the stream itself is unsupported).
function fatal(message) {
  return Object.assign(new Error(message), { fatal: true });
}

// Fetches with retries for transient failures: network errors, 5xx, 408,
// 429 (honouring Retry-After) and media responses that turn out to be a CDN
// error page. Other HTTP errors (403, 404, ...) fail right away.
async function fetchWithReferer(url, referer, as) {
  for (let attempt = 1; ; attempt++) {
    if (referer) referers.set(url, referer);
    let retryAfterMs = 0;
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        retryAfterMs = (Number(res.headers?.get("retry-after")) || 0) * 1000;
        const transient = res.status >= 500 || res.status === 408 || res.status === 429;
        throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { transient });
      }
      if (as === "text") return await res.text();
      const buffer = await res.arrayBuffer();
      const problem = segmentProblem(
        new Uint8Array(buffer, 0, Math.min(64, buffer.byteLength)),
        res.headers?.get("content-type") || ""
      );
      if (problem) throw Object.assign(new Error(`${problem} (${url})`), { transient: true });
      return buffer;
    } catch (e) {
      // fetch() rejects with a TypeError when the network fails.
      const transient = e.transient ?? e.name === "TypeError";
      if (!transient || attempt >= RETRY.fetchTries) throw e;
      const backoff = Math.min(RETRY.baseDelayMs * 2 ** (attempt - 1), 15_000);
      await sleep(Math.max(backoff, Math.min(retryAfterMs, 60_000)) + Math.random() * RETRY.baseDelayMs * 0.5);
    } finally {
      referers.delete(url);
    }
  }
}

async function analyzeHls(tabId, item) {
  try {
    const pl = parsePlaylist(await fetchWithReferer(item.url, item.referer, "text"), item.url);
    item.hls = {
      master: pl.master,
      variants: pl.variants,
      audio: pl.audio,
      encrypted: pl.encrypted,
      live: pl.live,
      duration: pl.duration,
    };
    if (pl.master) {
      const s = stateFor(tabId);
      for (const v of [...pl.variants, ...pl.audio]) s.children.add(v.url);
      updateBadge(tabId);
    }
  } catch (e) {
    item.hls = { error: String(e.message || e) };
  }
}

// Progress is counted in segments for "hls" jobs and bytes for "file" jobs.
// Fields other than PUBLIC_JOB_FIELDS are internal state.
const PUBLIC_JOB_FIELDS = ["id", "kind", "name", "done", "total", "status", "error", "retry", "retryAt"];

function newJob(kind, name, extra = {}) {
  const job = {
    id: nextJobId++,
    kind,
    name,
    done: 0,
    total: 0,
    status: "running",
    error: "",
    retry: null,
    autoRetries: 0,
    ...extra,
  };
  jobs.set(job.id, job);
  return job;
}

function finishJob(job, status, error = "") {
  job.status = status;
  job.error = error;
  job.retry = null;
  setTimeout(() => jobs.delete(job.id), 60_000);
}

// A failed job stays listed (no expiry) until it is retried or discarded.
// retry: "resume" continues where it stopped, "restart" starts over.
function failJob(job, error, retry) {
  job.status = "error";
  job.error = error;
  job.retry = retry;
}

// Schedules an automatic retry if any are left; returns false otherwise.
// Status "waiting" shows a countdown in the popup and can be cancelled.
function scheduleAutoRetry(job, error, run) {
  if (job.autoRetries >= RETRY.autoDelaysMs.length) return false;
  const delay = RETRY.autoDelaysMs[job.autoRetries++];
  job.status = "waiting";
  job.error = error;
  job.retryAt = Date.now() + delay;
  job.retryTimer = setTimeout(run, delay);
  return true;
}

const HLS_PARALLEL = 6;
// Max segments fetched ahead of the one being written; bounds memory.
const HLS_WINDOW = 12;
const TEMP_PREFIX = "hls-";

// Where an HLS download is assembled: a file in the extension's
// origin-private file system (OPFS), so segments go to disk as they arrive
// instead of piling up in memory. Falls back to memory without OPFS.
// Without persistent storage Firefox caps OPFS at 10 GB per extension, even
// with the unlimitedStorage permission (measured); with both, the cap is
// about the free disk space. Asked once, silently granted to extensions
// holding unlimitedStorage.
let persistRequest = null;

async function createSink(jobId) {
  try {
    persistRequest = persistRequest || navigator.storage.persist().catch(() => false);
    await persistRequest;
    const root = await navigator.storage.getDirectory();
    const name = `${TEMP_PREFIX}${jobId}-${Date.now()}`;
    const handle = await root.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    const remove = () => root.removeEntry(name).catch(() => {});
    return {
      write: (chunk) => writable.write(chunk),
      async finish() {
        await writable.close();
        return handle.getFile(); // disk-backed; read lazily by the download
      },
      async discard() {
        await writable.abort().catch(() => {});
        await remove();
      },
      cleanup: remove,
    };
  } catch (e) {
    console.warn("OPFS unavailable; assembling the download in memory", e);
    let parts = [];
    return {
      write: async (chunk) => void parts.push(chunk),
      finish: async () => new Blob(parts),
      discard: async () => void (parts = []),
      cleanup() {},
    };
  }
}

// Temp files left behind by a crash or browser restart (failed jobs don't
// survive a restart, so nothing can resume them).
(async () => {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) {
      if (name.startsWith(TEMP_PREFIX)) await root.removeEntry(name);
    }
  } catch {
    // No OPFS: nothing to clean.
  }
})();

// Resolves the job's media playlist to the list of URLs to fetch, init
// segment (fMP4) first.
async function loadSegmentUrls(job) {
  let pl = parsePlaylist(await fetchWithReferer(job.playlistUrl, job.referer, "text"), job.playlistUrl);
  if (pl.master) {
    // Fallback when asked for a master directly: take the best variant.
    job.playlistUrl = pl.variants[0].url;
    pl = parsePlaylist(await fetchWithReferer(job.playlistUrl, job.referer, "text"), job.playlistUrl);
  }
  if (pl.encrypted) throw fatal("Stream is encrypted (EXT-X-KEY); not supported");
  if (pl.byterange) throw fatal("Byte-range playlists are not supported");
  if (!pl.segments.length) throw fatal("Playlist has no segments");
  return pl.map ? [pl.map, ...pl.segments] : pl.segments;
}

// Writes segment `index` to the job's sink. The first one decides the
// output: TS is remuxed to MP4 on the fly, anything else is copied as is.
async function writeSegment(job, buffer, index) {
  if (index === 0) {
    job.ext = sniffExt(new Uint8Array(buffer, 0, Math.min(64, buffer.byteLength)), { hls: true }) || "ts";
    if (job.ext === "ts") {
      const remuxer = createTsRemuxer();
      try {
        const chunks = remuxer.push(buffer);
        if (remuxer.started) {
          job.remuxer = remuxer;
          job.ext = remuxer.ext;
          for (const chunk of chunks) await job.sink.write(chunk);
          return;
        }
      } catch (e) {
        console.warn("MP4 remux failed; saving the original .ts", e);
      }
    }
  } else if (job.ext === "ts" || job.remuxer) {
    // A TS segment starts with the 0x47 sync byte; anything else would
    // corrupt the output. Not written, so a retry refetches it.
    if (new Uint8Array(buffer, 0, 1)[0] !== 0x47) throw new Error(`Segment ${index} is not MPEG-TS data`);
    if (job.remuxer) {
      for (const chunk of job.remuxer.push(buffer)) await job.sink.write(chunk);
      return;
    }
  }
  await job.sink.write(buffer);
}

// Fetches segments from job.nextWrite on, several at a time, and writes them
// strictly in order. On failure job.nextWrite is the first segment not yet
// written, which is where a resume picks up.
async function fetchSegments(job) {
  const urls = job.urls;
  const fetched = new Map();
  let next = job.nextWrite;
  let failed = false;
  let waiters = [];
  const wake = () => {
    const w = waiters;
    waiters = [];
    for (const resolve of w) resolve();
  };

  let writing = Promise.resolve();
  const drain = () =>
    (writing = writing.then(async () => {
      while (fetched.has(job.nextWrite)) {
        const buffer = fetched.get(job.nextWrite);
        fetched.delete(job.nextWrite);
        await writeSegment(job, buffer, job.nextWrite);
        job.nextWrite++;
      }
      wake();
    }));

  const worker = async () => {
    while (next < urls.length && !failed) {
      if (job.cancelled) throw new Error("Cancelled");
      if (next - job.nextWrite >= HLS_WINDOW) {
        await new Promise((resolve) => waiters.push(resolve));
        continue;
      }
      const i = next++;
      try {
        fetched.set(i, await fetchWithReferer(urls[i], job.referer, "buffer"));
        job.done++;
        await drain();
      } catch (e) {
        failed = true; // stop the other workers too
        wake();
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HLS_PARALLEL, urls.length - next) }, worker));
  await writing;
}

async function runHlsJob(job) {
  job.status = "running";
  job.error = "";
  job.retry = null;
  job.retryAt = 0;
  job.cancelled = false;
  job.done = job.nextWrite;
  try {
    try {
      const urls = await loadSegmentUrls(job);
      // On a resume, take fresh URLs (signed URLs expire) if the playlist
      // still lines up with what was already written.
      if (!job.urls || urls.length === job.urls.length) job.urls = urls;
    } catch (e) {
      if (!job.urls) throw e;
    }
    job.total = job.urls.length;
    job.sink = job.sink || (await createSink(job.id));

    await fetchSegments(job);

    job.status = "saving";
    job.name = `${job.baseName}.${job.ext}`;
    const file = await job.sink.finish();
    const blobUrl = URL.createObjectURL(file);
    const downloadId = await saveAuto(blobUrl, job.name);
    revokeWhenDone(downloadId, blobUrl, job.sink.cleanup);
    finishJob(job, "done");
  } catch (e) {
    const message = String(e.message || e);
    if (job.cancelled) {
      await job.sink?.discard();
      finishJob(job, "cancelled");
      return;
    }
    // The sink and job.nextWrite are kept, so every path below can resume.
    if (e.fatal) {
      await job.sink?.discard();
      failJob(job, message, null);
    } else if (e.name === "QuotaExceededError") {
      failJob(job, "Not enough disk space. Free some up, then resume.", "resume");
    } else {
      // Progress since the last failure earns a fresh set of automatic
      // retries; a long download can hit several unrelated hiccups.
      if (job.nextWrite > (job.failedAt ?? -1)) job.autoRetries = 0;
      job.failedAt = job.nextWrite;
      if (!scheduleAutoRetry(job, message, () => runHlsJob(job))) failJob(job, message, "resume");
    }
  }
}

async function downloadHls(playlistUrl, referer, baseName) {
  const job = newJob("hls", baseName, { playlistUrl, referer, baseName, nextWrite: 0 });
  runHlsJob(job);
  return job.id;
}

function revokeWhenDone(downloadId, blobUrl, cleanup = () => {}) {
  const listener = (delta) => {
    if (delta.id !== downloadId || !delta.state) return;
    if (delta.state.current === "complete" || delta.state.current === "interrupted") {
      URL.revokeObjectURL(blobUrl);
      cleanup();
      browser.downloads.onChanged.removeListener(listener);
    }
  };
  browser.downloads.onChanged.addListener(listener);
}

// ---------- downloads ----------

// Reads just the first bytes of a remote file to sniff its real format.
async function fetchHead(url, referer) {
  if (referer) referers.set(url, referer);
  try {
    const res = await fetch(url, { credentials: "include", headers: { Range: "bytes=0-63" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    // Servers that ignore Range would otherwise stream the whole file.
    reader.cancel().catch(() => {});
    return { bytes: value || new Uint8Array(), contentType: res.headers.get("content-type") || "" };
  } finally {
    referers.delete(url);
  }
}

// Sniffed bytes beat Content-Type (often application/octet-stream), which
// beats the URL extension (often absent or misleading).
async function detectExt(item) {
  let contentType = item.contentType;
  try {
    const head = await fetchHead(item.url, item.referer);
    contentType = contentType || head.contentType;
    const sniffed = sniffExt(head.bytes, { contentType });
    if (sniffed) return sniffed;
  } catch {
    // Fall through to header/URL based guesses.
  }
  const fromType = EXT_FOR_TYPE[contentType.split(";")[0].trim().toLowerCase()];
  if (fromType) return fromType;
  const m = MEDIA_EXT.exec(new URL(item.url).pathname);
  return m ? m[1].toLowerCase() : "mp4";
}

function saveAuto(url, filename) {
  // No dialog: straight into the Downloads folder, " (1)" etc. on name clashes.
  return browser.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" });
}

async function downloadFile(item, baseName) {
  const job = newJob("file", baseName, { url: item.url, referer: item.referer });
  try {
    job.name = `${baseName}.${await detectExt(item)}`;
    await startFileDownload(job);
  } catch (e) {
    failJob(job, String(e.message || e), "restart");
  }
  return job.id;
}

async function startFileDownload(job) {
  if (job.referer) referers.set(job.url, job.referer);
  try {
    // Firefox does the transfer; syncFileJobs() mirrors its progress.
    job.downloadId = await saveAuto(job.url, job.name);
  } finally {
    // The download request has been issued by now.
    setTimeout(() => referers.delete(job.url), 30_000);
  }
}

async function syncFileJobs() {
  const running = [...jobs.values()].filter((j) => j.kind === "file" && j.status === "running" && j.downloadId);
  await Promise.all(
    running.map(async (job) => {
      const [d] = await browser.downloads.search({ id: job.downloadId });
      if (!d) return finishJob(job, "error", "Download was removed");
      job.done = d.bytesReceived;
      job.total = Math.max(d.totalBytes, 0); // -1 when the size is unknown
      if (d.state === "complete") finishJob(job, "done");
      // "interrupted" is handled by the onChanged listener below.
    })
  );
}

// Interrupted file downloads: network/server failures that Firefox can
// continue (server supports ranges) are resumed automatically a few times,
// then left to the user. Listens even while the popup is closed.
browser.downloads.onChanged.addListener(async (delta) => {
  if (delta.state?.current !== "interrupted") return;
  const job = [...jobs.values()].find((j) => j.kind === "file" && j.downloadId === delta.id);
  if (!job || job.status !== "running") return;
  const [d] = await browser.downloads.search({ id: delta.id });
  if (!d) return;
  if (d.error === "USER_CANCELED") return finishJob(job, "cancelled");
  const transient = /^(NETWORK_|SERVER_FAILED)/.test(d.error || "");
  const resume = async () => {
    job.status = "running";
    job.retryAt = 0;
    try {
      await browser.downloads.resume(job.downloadId);
    } catch (e) {
      failJob(job, String(e.message || e), "restart");
    }
  };
  if (!(d.canResume && transient && scheduleAutoRetry(job, d.error, resume))) {
    failJob(job, d.error, d.canResume ? "resume" : "restart");
  }
});

async function videoTitle(tabId) {
  try {
    const title = await browser.tabs.sendMessage(tabId, { type: "pageTitle" }, { frameId: 0 });
    if (title) return title;
  } catch {
    // No content script (e.g. page loaded before install); use the tab title.
  }
  const tab = await browser.tabs.get(tabId);
  return tab.title || "video";
}

// ---------- messaging ----------

browser.runtime.onMessage.addListener(async (msg, sender) => {
  switch (msg.type) {
    case "found": {
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null || tabId < 0) return;
      for (const url of msg.urls) {
        addItem(tabId, {
          url,
          kind: classify(url, "") === "hls" ? "hls" : "file",
          contentType: "",
          size: 0,
          referer: sender.url || "",
        });
      }
      return;
    }

    case "list":
      // Newest first: the video that just started playing is usually the one wanted.
      return visibleItems(msg.tabId).reverse();

    case "download": {
      const item = stateFor(msg.tabId).items.get(msg.url);
      if (!item) throw new Error("Item no longer available; reload the page");
      let baseName = sanitize(await videoTitle(msg.tabId));
      if (msg.suffix) baseName += ` (${sanitize(msg.suffix)})`;
      if (item.kind === "hls") {
        return { jobId: await downloadHls(msg.playlistUrl || item.url, item.referer, baseName) };
      }
      return { jobId: await downloadFile(item, baseName) };
    }

    case "jobs":
      await syncFileJobs();
      // Newest first, so a download just started shows at the top.
      return [...jobs.values()]
        .sort((a, b) => b.id - a.id)
        .map((job) => Object.fromEntries(PUBLIC_JOB_FIELDS.map((k) => [k, job[k]])));

    case "cancel": {
      const job = jobs.get(msg.jobId);
      if (!job) return;
      if (job.status === "waiting") {
        clearTimeout(job.retryTimer);
        await job.sink?.discard();
        if (job.downloadId) await browser.downloads.cancel(job.downloadId).catch(() => {});
        finishJob(job, "cancelled");
      } else if (job.downloadId) {
        await browser.downloads.cancel(job.downloadId);
      } else {
        job.cancelled = true;
      }
      return;
    }

    case "retry": {
      const job = jobs.get(msg.jobId);
      if (!job || job.status !== "error") return;
      job.autoRetries = 0;
      if (job.kind === "hls") {
        runHlsJob(job); // picks up at job.nextWrite
      } else {
        const retry = job.retry;
        job.status = "running";
        job.error = "";
        job.retry = null;
        try {
          if (retry === "resume") await browser.downloads.resume(job.downloadId);
          else await startFileDownload(job);
        } catch (e) {
          failJob(job, String(e.message || e), "restart");
        }
      }
      return;
    }

    case "discard": {
      const job = jobs.get(msg.jobId);
      if (!job || job.status !== "error") return;
      await job.sink?.discard();
      jobs.delete(job.id);
      return;
    }
  }
});
