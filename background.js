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
// Request types players load media with.
const MEDIA_REQUEST_TYPES = ["media", "xmlhttprequest", "object", "other"];

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

// tabId -> { items: Map<url, item>, children: Set<url> }
// `children` holds variant/audio playlists of a master playlist, which are
// shown as options under the master instead of as separate entries.
const tabState = new Map();
// jobId -> download job
const jobs = new Map();
let nextJobId = 1;
// url -> headers to add when the extension itself requests that url
const extraHeaders = new Map();
// requestId -> replayable headers a page sent, until its response arrives
const sentHeaders = new Map();
// Background tabs opened to renew a session (see revisitPage).
const revisitTabs = new Set();

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

// Items carry `sent`: the headers the page sent for that url ({ url,
// headers }), replayed when the extension fetches it (lib/session.js).
function addItem(tabId, item) {
  const s = stateFor(tabId);
  if (s.items.has(item.url)) return;
  s.items.set(item.url, item);
  // A variant of an already analyzed master is hidden and never shown, so
  // fetching it again just to describe it would be wasted traffic. A revisit
  // tab is never shown either; its streams are matched by the job instead.
  if (s.children.has(item.url) || revisitTabs.has(tabId)) return;
  updateBadge(tabId);
  if (item.kind === "hls") analyzeHls(tabId, item);
}

function visibleItems(tabId) {
  const s = tabState.get(tabId);
  if (!s) return [];
  return [...s.items.values()].filter((i) => !s.children.has(i.url));
}

function updateBadge(tabId) {
  if (tabId < 0) return;
  const n = visibleItems(tabId).length;
  browser.browserAction.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => {});
}

browser.browserAction.setBadgeBackgroundColor({ color: "#2563eb" }).catch(() => {});

// ---------- detection ----------

browser.webRequest.onBeforeRequest.addListener(
  (d) => {
    // New top-level page: forget what the previous page played.
    tabState.delete(d.tabId);
    updateBadge(d.tabId);
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

// Remembers what the page's player sent (Referer, Origin, cookies, custom
// X- headers) so the extension's own requests look the same to the server.
// Non-blocking; kept only until the response headers arrive.
browser.webRequest.onSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0) return;
    // Requests that never get a response or an error (rare) mustn't pile up.
    if (sentHeaders.size >= 500) sentHeaders.delete(sentHeaders.keys().next().value);
    sentHeaders.set(d.requestId, replayableHeaders(d.requestHeaders || []));
  },
  { urls: ["<all_urls>"], types: MEDIA_REQUEST_TYPES },
  ["requestHeaders"]
);

browser.webRequest.onErrorOccurred.addListener((d) => sentHeaders.delete(d.requestId), {
  urls: ["<all_urls>"],
  types: MEDIA_REQUEST_TYPES,
});

browser.webRequest.onHeadersReceived.addListener(
  (d) => {
    const sent = sentHeaders.get(d.requestId);
    sentHeaders.delete(d.requestId); // a redirect sends its headers again
    if (d.tabId < 0) return;
    const contentType = header(d.responseHeaders, "content-type");
    const kind = classify(d.url, contentType);
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

    const referer = d.documentUrl || d.originUrl || "";
    addItem(d.tabId, {
      url: d.url,
      kind,
      contentType,
      size,
      // Without a captured request (served before we saw it), at least
      // send the page as Referer; some CDNs reject requests without one.
      sent: { url: d.url, headers: sent ?? (referer ? [{ name: "Referer", value: referer }] : []) },
    });
  },
  { urls: ["<all_urls>"], types: MEDIA_REQUEST_TYPES },
  ["responseHeaders"]
);

browser.webRequest.onBeforeSendHeaders.addListener(
  (d) => {
    const extra = extraHeaders.get(d.url);
    if (!extra) return;
    return { requestHeaders: applyHeaders(d.requestHeaders, extra) };
  },
  // tabId -1: only the extension's own requests. Without it this blocking
  // listener would hold up every request of every page in the browser.
  { urls: ["<all_urls>"], tabId: -1 },
  ["blocking", "requestHeaders"]
);

browser.tabs.onRemoved.addListener((tabId) => tabState.delete(tabId));

// Has the extension's requests for `url` carry the page's headers.
function sendAsPage(url, sent) {
  const headers = headersFor(url, sent);
  if (headers.length) extraHeaders.set(url, headers);
}

// ---------- HLS ----------

// Retry tuning; the tests shrink these.
const RETRY = {
  fetchTries: 5,
  baseDelayMs: 1000, // doubled per attempt, capped at 15 s
  // Automatic resumes of a failed HLS job / interrupted file download
  // before asking the user.
  autoDelaysMs: [5_000, 20_000, 60_000],
};

// Rejects with the signal's reason as soon as it's aborted.
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Errors not worth retrying automatically (the stream itself is unsupported).
function fatal(message) {
  return Object.assign(new Error(message), { fatal: true });
}

// The server turned us away (expired token or session) rather than failing:
// reopening the page, as one would by hand, usually gets a fresh one.
const RENEWABLE_STATUSES = new Set([401, 403, 410]);

// Fetches with the page's headers and retries for transient failures:
// network errors, 5xx, 408, 429 (honouring Retry-After) and media responses
// that turn out to be a CDN error page. Other HTTP errors (403, 404, ...)
// fail right away, with the status on the error. Aborting `signal` stops the
// request and any pending retry at once.
async function fetchMedia(url, sent, as, signal) {
  for (let attempt = 1; ; attempt++) {
    sendAsPage(url, sent);
    let retryAfterMs = 0;
    try {
      const res = await fetch(url, { credentials: "include", signal });
      if (!res.ok) {
        retryAfterMs = (Number(res.headers?.get("retry-after")) || 0) * 1000;
        const transient = res.status >= 500 || res.status === 408 || res.status === 429;
        throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { transient, status: res.status });
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
      if (signal?.aborted || !transient || attempt >= RETRY.fetchTries) throw e;
      const backoff = Math.min(RETRY.baseDelayMs * 2 ** (attempt - 1), 15_000);
      await sleep(Math.max(backoff, Math.min(retryAfterMs, 60_000)) + Math.random() * RETRY.baseDelayMs * 0.5, signal);
    } finally {
      extraHeaders.delete(url);
    }
  }
}

async function analyzeHls(tabId, item) {
  try {
    const pl = parsePlaylist(await fetchMedia(item.url, item.sent, "text"), item.url);
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
    // Progress (segments or bytes) at the last session renewal; another
    // renewal is only tried once the download has moved past it.
    renewedAt: -1,
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

// Loads a media playlist (taking the best variant if handed a master) and
// returns the URLs to fetch, init segment (fMP4) first.
async function loadMediaPlaylist(url, sent, signal) {
  let pl = parsePlaylist(await fetchMedia(url, sent, "text", signal), url);
  if (pl.master) {
    url = pl.variants[0]?.url;
    if (!url) throw fatal("Playlist has no video variants");
    pl = parsePlaylist(await fetchMedia(url, sent, "text", signal), url);
  }
  if (pl.encrypted) throw fatal("Stream is encrypted (EXT-X-KEY); not supported");
  if (pl.byterange) throw fatal("Byte-range playlists are not supported");
  if (!pl.segments.length) throw fatal("Playlist has no segments");
  return { url, urls: pl.map ? [pl.map, ...pl.segments] : pl.segments, duration: pl.duration };
}

async function loadSegmentUrls(job, signal) {
  const pl = await loadMediaPlaylist(job.playlistUrl, job.sent, signal);
  job.playlistUrl = pl.url;
  return pl;
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
//
// The first failure aborts the requests still in flight, and this only
// returns or throws once every worker has stopped and every write is done.
// Otherwise a straggler could finish later and write into the sink while a
// resume (or discard) of the same job is already using it. Segments that
// had already arrived are still written (in order), so a resume needn't
// fetch them again; only a cancel stops writing.
async function fetchSegments(job, controller) {
  const { signal } = controller;
  const urls = job.urls;
  const fetched = new Map();
  let next = job.nextWrite;
  let firstError = null;
  let waiters = [];
  const wake = () => {
    const w = waiters;
    waiters = [];
    for (const resolve of w) resolve();
  };
  signal.addEventListener("abort", wake, { once: true });

  let writing = Promise.resolve();
  const drain = () =>
    (writing = writing.then(async () => {
      while (!job.cancelled && fetched.has(job.nextWrite)) {
        const buffer = fetched.get(job.nextWrite);
        fetched.delete(job.nextWrite);
        await writeSegment(job, buffer, job.nextWrite);
        job.nextWrite++;
      }
      wake();
    }));

  const worker = async () => {
    try {
      while (next < urls.length && !signal.aborted) {
        if (next - job.nextWrite >= HLS_WINDOW) {
          await new Promise((resolve) => waiters.push(resolve));
          continue;
        }
        const i = next++;
        fetched.set(i, await fetchMedia(urls[i], job.sent, "buffer", signal));
        job.done++;
        await drain();
      }
    } catch (e) {
      if (!firstError) {
        firstError = e;
        controller.abort(); // stop the other workers too
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HLS_PARALLEL, urls.length - next) }, worker));
  await writing.catch((e) => (firstError ??= e));
  if (firstError) throw firstError;
  if (signal.aborted) throw signal.reason; // cancelled while every worker was idle
}

async function runHlsJob(job) {
  job.status = "running";
  job.error = "";
  job.retry = null;
  job.retryAt = 0;
  job.cancelled = false;
  job.done = job.nextWrite;
  const controller = (job.controller = new AbortController());
  try {
    try {
      const pl = await loadSegmentUrls(job, controller.signal);
      // On a resume, take fresh URLs (signed URLs expire) if the playlist
      // still lines up with what was already written.
      if (!job.urls || pl.urls.length === job.urls.length) job.urls = pl.urls;
      job.duration ??= pl.duration;
    } catch (e) {
      if (!job.urls || controller.signal.aborted) throw e;
    }
    job.total = job.urls.length;
    job.sink = job.sink || (await createSink(job.id));

    await fetchSegments(job, controller);

    job.status = "saving";
    job.name = `${job.baseName}.${job.ext}`;
    const file = await job.sink.finish();
    const blobUrl = URL.createObjectURL(file);
    const downloadId = await saveAuto(blobUrl, job.name);
    revokeWhenDone(downloadId, blobUrl, job.sink.cleanup);
    finishJob(job, "done");
  } catch (e) {
    let message = String(e.message || e);
    if (job.cancelled) return cancelHlsJob(job);

    if (!e.fatal && RENEWABLE_STATUSES.has(e.status) && job.urls && job.nextWrite > job.renewedAt) {
      job.renewedAt = job.nextWrite;
      job.status = "renewing";
      job.error = message;
      const renewal = (job.controller = new AbortController());
      try {
        await renewHlsSession(job, renewal.signal);
        return runHlsJob(job); // picks up at job.nextWrite with the fresh URLs
      } catch (re) {
        if (job.cancelled) return cancelHlsJob(job);
        message += ` — reopening the page didn't help: ${re.message || re}`;
      }
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

async function cancelHlsJob(job) {
  await job.sink?.discard();
  finishJob(job, "cancelled");
}

// `job` options: playlistUrl, sent (the page's headers), baseName, plus for
// session renewal `page` (the tab it came from) and `want` (which rendition
// of a master playlist; see pickRendition).
function downloadHls(options) {
  const job = newJob("hls", options.baseName, { ...options, nextWrite: 0 });
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

// ---------- session renewal ----------

// Tuning; the tests shrink these.
const REVISIT = {
  timeoutMs: 45_000, // for the reopened page to load the video again
  kickEveryMs: 3_000, // how often to nudge its players into loading
};

// Gets an HLS job past a server that started refusing it, trying the cheap
// fix first: the playlist may still be good and hand out freshly signed
// segment URLs. Otherwise does what works by hand, reopening the page,
// which renews the site's cookies and tokens, and takes the stream from
// there. Updates the job's playlist, segment URLs and headers in place.
async function renewHlsSession(job, signal) {
  try {
    const { urls } = await loadSegmentUrls(job, signal);
    if (urls.length === job.urls.length && urls[job.nextWrite] !== job.urls[job.nextWrite]) {
      job.urls = urls;
      return;
    }
  } catch (e) {
    if (signal.aborted) throw e;
  }
  const fresh = await revisitPage(job.page, signal, (item) => item.kind === "hls" && freshHlsStream(job, item, signal));
  Object.assign(job, fresh);
}

// The job's stream as found among playlists the reopened page loaded, or
// null. Accepted only if it lines up with what was already written.
async function freshHlsStream(job, item, signal) {
  let pl = parsePlaylist(await fetchMedia(item.url, item.sent, "text", signal), item.url);
  let url = item.url;
  if (pl.master) {
    const rendition = pickRendition(pl, job.playlistUrl, job.want);
    if (!rendition) return null;
    url = rendition.url;
    pl = parsePlaylist(await fetchMedia(url, item.sent, "text", signal), url);
  } else if (!samePath(url, job.playlistUrl) && !sameFileName(url, job.playlistUrl)) {
    // Some other media playlist of the page (audio, subtitles, an ad).
    return null;
  }
  const urls = pl.map ? [pl.map, ...pl.segments] : pl.segments;
  if (!sameStream({ count: job.urls.length, duration: job.duration }, { count: urls.length, duration: pl.duration })) {
    return null;
  }
  return { playlistUrl: url, urls, sent: item.sent };
}

// Opens the job's page again in a muted background tab and waits until one
// of the media items it loads passes `match` (which returns what to use, or
// a falsy value). The tab is closed again either way.
async function revisitPage(page, signal, match) {
  if (!page || !/^https?:/i.test(page.url)) throw new Error("no page to reopen");
  const tab = await openQuietTab(page);
  revisitTabs.add(tab.id);
  try {
    const tried = new Set();
    const deadline = Date.now() + REVISIT.timeoutMs;
    let kickAt = 0;
    while (Date.now() < deadline) {
      for (const item of [...(tabState.get(tab.id)?.items.values() ?? [])]) {
        if (tried.has(item.url)) continue;
        tried.add(item.url);
        let found = null;
        try {
          found = await match(item);
        } catch (e) {
          if (signal.aborted) throw e;
          // That candidate didn't work out; keep looking.
        }
        if (found) return found;
      }
      if (Date.now() >= kickAt) {
        // Players that wait for a click: start them, muted so autoplay
        // rules allow it. Goes to every frame, embedded players included.
        browser.tabs.sendMessage(tab.id, { type: "kick" }).catch(() => {});
        kickAt = Date.now() + REVISIT.kickEveryMs;
      }
      await sleep(250, signal);
    }
    throw new Error("the page didn't load the video again");
  } finally {
    revisitTabs.delete(tab.id);
    tabState.delete(tab.id);
    browser.tabs.remove(tab.id).catch(() => {});
  }
}

// A background tab in the same window and container as the original, so
// it runs with the same cookies. A private page is never reopened outside
// private browsing.
async function openQuietTab(page) {
  const props = { url: page.url, active: false, muted: true, windowId: page.windowId };
  if (page.cookieStoreId) props.cookieStoreId = page.cookieStoreId;
  try {
    return await browser.tabs.create(props);
  } catch (e) {
    if (page.incognito) throw e;
    // The original window may be closed by now.
    delete props.windowId;
    try {
      return await browser.tabs.create(props);
    } catch {
      // Containers other than the default may need the "cookies" permission.
      delete props.cookieStoreId;
      return browser.tabs.create(props);
    }
  }
}

// ---------- downloads ----------

// Reads just the first bytes of a remote file to sniff its real format.
async function fetchHead(url, sent) {
  sendAsPage(url, sent);
  try {
    const res = await fetch(url, { credentials: "include", headers: { Range: "bytes=0-63" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    // Servers that ignore Range would otherwise stream the whole file.
    reader.cancel().catch(() => {});
    return { bytes: value || new Uint8Array(), contentType: res.headers.get("content-type") || "" };
  } finally {
    extraHeaders.delete(url);
  }
}

// Sniffed bytes beat Content-Type (often application/octet-stream), which
// beats the URL extension (often absent or misleading).
async function detectExt(item) {
  let contentType = item.contentType;
  try {
    const head = await fetchHead(item.url, item.sent);
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

async function downloadFile(item, baseName, page) {
  const job = newJob("file", baseName, { url: item.url, sent: item.sent, page });
  try {
    job.name = `${baseName}.${await detectExt(item)}`;
    await startFileDownload(job);
  } catch (e) {
    failJob(job, String(e.message || e), "restart");
  }
  return job.id;
}

// Runs `request` (which makes Firefox request job.url) with the page's
// headers attached to that request.
async function asPage(job, request) {
  sendAsPage(job.url, job.sent);
  try {
    return await request();
  } finally {
    // The request has been issued by now.
    setTimeout(() => extraHeaders.delete(job.url), 30_000);
  }
}

async function startFileDownload(job) {
  // Firefox does the transfer; syncFileJobs() mirrors its progress.
  job.downloadId = await asPage(job, () => saveAuto(job.url, job.name));
}

const resumeFileDownload = (job) => asPage(job, () => browser.downloads.resume(job.downloadId));

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
// then left to the user. A 403 first gets the session renewed. Listens even
// while the popup is closed.
browser.downloads.onChanged.addListener(async (delta) => {
  if (delta.state?.current !== "interrupted") return;
  const job = [...jobs.values()].find((j) => j.kind === "file" && j.downloadId === delta.id);
  if (!job || job.status !== "running") return;
  const [d] = await browser.downloads.search({ id: delta.id });
  if (!d) return;
  if (d.error === "USER_CANCELED") return finishJob(job, "cancelled");
  if (d.error === "SERVER_FORBIDDEN" && d.bytesReceived > job.renewedAt) return renewFileSession(job, d);
  const transient = /^(NETWORK_|SERVER_FAILED)/.test(d.error || "");
  const resume = async () => {
    job.status = "running";
    job.retryAt = 0;
    try {
      await resumeFileDownload(job);
    } catch (e) {
      failJob(job, String(e.message || e), "restart");
    }
  };
  if (!(d.canResume && transient && scheduleAutoRetry(job, d.error, resume))) {
    failJob(job, d.error, d.canResume ? "resume" : "restart");
  }
});

// A file download the server stopped allowing: reopen the page and take the
// file from there. Same URL (the session was the problem): resume where it
// stopped. A new signed URL: Firefox can't continue a download from another
// URL, so it starts over from the fresh one.
async function renewFileSession(job, d) {
  job.status = "renewing";
  job.error = d.error;
  job.cancelled = false;
  const controller = (job.controller = new AbortController());
  try {
    const fresh = await revisitPage(job.page, controller.signal, (item) =>
      item.kind === "file" && (samePath(item.url, job.url) || sameFileName(item.url, job.url)) ? item : null
    );
    job.sent = fresh.sent;
    if (fresh.url === job.url && d.canResume) {
      job.renewedAt = d.bytesReceived;
      job.status = "running";
      job.error = "";
      await resumeFileDownload(job);
    } else {
      // Drops the partial file and its entry in the downloads list.
      await browser.downloads.cancel(job.downloadId).catch(() => {});
      await browser.downloads.erase({ id: job.downloadId }).catch(() => {});
      job.url = fresh.url;
      job.renewedAt = 0;
      job.done = 0;
      // Running before the new download exists, so its own interruption
      // isn't ignored by the listener above.
      job.status = "running";
      job.error = "";
      await startFileDownload(job);
    }
  } catch (e) {
    if (job.cancelled) {
      await browser.downloads.cancel(job.downloadId).catch(() => {});
      return finishJob(job, "cancelled");
    }
    failJob(job, `${d.error} — reopening the page didn't help: ${e.message || e}`, d.canResume ? "resume" : "restart");
  }
}

async function videoTitle(tab) {
  try {
    const title = await browser.tabs.sendMessage(tab.id, { type: "pageTitle" }, { frameId: 0 });
    if (title) return title;
  } catch {
    // No content script (e.g. page loaded before install); use the tab title.
  }
  return tab.title || "video";
}

// Which rendition of the item's master playlist `playlistUrl` is, so the
// same one can be picked again after the page is reopened.
function describeRendition(item, playlistUrl) {
  const variant = item.hls?.variants?.find((v) => v.url === playlistUrl);
  if (variant) return { resolution: variant.resolution, bandwidth: variant.bandwidth };
  const audio = item.hls?.audio?.find((a) => a.url === playlistUrl);
  return audio ? { audio: audio.name } : {};
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
          sent: { url, headers: sender.url ? [{ name: "Referer", value: sender.url }] : [] },
        });
      }
      return;
    }

    case "list":
      // Newest first: the video that just started playing is usually the one wanted.
      return visibleItems(msg.tabId)
        .reverse()
        .map(({ sent, ...item }) => item); // headers (cookies) stay in here

    case "download": {
      const item = stateFor(msg.tabId).items.get(msg.url);
      if (!item) throw new Error("Item no longer available; reload the page");
      const tab = await browser.tabs.get(msg.tabId);
      let baseName = sanitize(await videoTitle(tab));
      if (msg.suffix) baseName += ` (${sanitize(msg.suffix)})`;
      // Where to go to renew the session if the server starts refusing.
      const page = { url: tab.url, windowId: tab.windowId, cookieStoreId: tab.cookieStoreId, incognito: tab.incognito };
      if (item.kind === "hls") {
        const playlistUrl = msg.playlistUrl || item.url;
        return {
          jobId: downloadHls({
            playlistUrl,
            sent: item.sent,
            baseName,
            page,
            want: describeRendition(item, playlistUrl),
          }),
        };
      }
      return { jobId: await downloadFile(item, baseName, page) };
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
      } else if (job.status !== "renewing" && job.downloadId) {
        await browser.downloads.cancel(job.downloadId);
      } else {
        // Aborts the job's requests in flight (or its session renewal)
        // instead of waiting for them.
        job.cancelled = true;
        job.controller?.abort();
      }
      return;
    }

    case "retry": {
      const job = jobs.get(msg.jobId);
      if (!job || job.status !== "error") return;
      job.autoRetries = 0;
      job.renewedAt = -1; // the user asked: worth reopening the page again
      if (job.kind === "hls") {
        runHlsJob(job); // picks up at job.nextWrite
      } else {
        const retry = job.retry;
        job.status = "running";
        job.error = "";
        job.retry = null;
        try {
          if (retry === "resume") await resumeFileDownload(job);
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
