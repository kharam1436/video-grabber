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

async function fetchWithReferer(url, referer, as, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    if (referer) referers.set(url, referer);
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return as === "text" ? await res.text() : await res.arrayBuffer();
    } catch (e) {
      if (attempt >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
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

async function downloadHls(playlistUrl, referer, baseName) {
  const job = { id: nextJobId++, name: baseName, done: 0, total: 0, status: "running", error: "", cancelled: false };
  jobs.set(job.id, job);

  (async () => {
    try {
      let pl = parsePlaylist(await fetchWithReferer(playlistUrl, referer, "text"), playlistUrl);
      if (pl.master) {
        // Fallback when asked for a master directly: take the best variant.
        const best = pl.variants[0];
        pl = parsePlaylist(await fetchWithReferer(best.url, referer, "text"), best.url);
      }
      if (pl.encrypted) throw new Error("Stream is encrypted (EXT-X-KEY); not supported");
      if (pl.byterange) throw new Error("Byte-range playlists are not supported");
      if (!pl.segments.length) throw new Error("Playlist has no segments");

      job.total = pl.segments.length + (pl.map ? 1 : 0);
      const parts = new Array(job.total);
      const urls = pl.map ? [pl.map, ...pl.segments] : pl.segments;

      let next = 0;
      let failed = false;
      const worker = async () => {
        while (next < urls.length && !failed) {
          if (job.cancelled) throw new Error("Cancelled");
          const i = next++;
          try {
            parts[i] = await fetchWithReferer(urls[i], referer, "buffer");
          } catch (e) {
            failed = true; // stop the other workers too
            throw e;
          }
          job.done++;
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, urls.length) }, worker));

      // parts[0] is the init segment for fMP4, otherwise the first segment.
      const ext = sniffExt(new Uint8Array(parts[0], 0, Math.min(64, parts[0].byteLength)), { hls: true }) || "ts";

      job.status = "saving";
      job.name = `${baseName}.${ext}`;
      const blobUrl = URL.createObjectURL(new Blob(parts, { type: TYPE_FOR_EXT[ext] || "video/mp2t" }));
      const downloadId = await saveAuto(blobUrl, job.name);
      revokeWhenDone(downloadId, blobUrl);
      job.status = "done";
    } catch (e) {
      job.status = job.cancelled ? "cancelled" : "error";
      job.error = String(e.message || e);
    }
    setTimeout(() => jobs.delete(job.id), 60_000);
  })();

  return job.id;
}

function revokeWhenDone(downloadId, blobUrl) {
  const listener = (delta) => {
    if (delta.id !== downloadId || !delta.state) return;
    if (delta.state.current === "complete" || delta.state.current === "interrupted") {
      URL.revokeObjectURL(blobUrl);
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
  const filename = `${baseName}.${await detectExt(item)}`;
  if (item.referer) referers.set(item.url, item.referer);
  try {
    await saveAuto(item.url, filename);
    return filename;
  } finally {
    // The download request has been issued (or the dialog dismissed) by now.
    setTimeout(() => referers.delete(item.url), 30_000);
  }
}

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
      return visibleItems(msg.tabId);

    case "download": {
      const item = stateFor(msg.tabId).items.get(msg.url);
      if (!item) throw new Error("Item no longer available; reload the page");
      let baseName = sanitize(await videoTitle(msg.tabId));
      if (msg.suffix) baseName += ` (${sanitize(msg.suffix)})`;
      if (item.kind === "hls") {
        return { jobId: await downloadHls(msg.playlistUrl || item.url, item.referer, baseName) };
      }
      return { filename: await downloadFile(item, baseName) };
    }

    case "jobs":
      return [...jobs.values()].map(({ cancelled, ...j }) => j);

    case "cancel": {
      const job = jobs.get(msg.jobId);
      if (job) job.cancelled = true;
      return;
    }
  }
});
