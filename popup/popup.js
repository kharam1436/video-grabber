"use strict";

const listEl = document.getElementById("list");
const jobsEl = document.getElementById("jobs");
const noticesEl = document.getElementById("notices");
const emptyEl = document.getElementById("empty");
let tabId;
let lastSignature = "";

function formatSize(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function formatDuration(sec) {
  if (!sec) return "";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function download(item, extra = {}) {
  return browser.runtime
    .sendMessage({ type: "download", tabId, url: item.url, ...extra })
    .then(refreshJobs)
    // alert() is unavailable in extension popups. Not in #jobs, which is
    // re-rendered every second.
    .catch((e) => noticesEl.prepend(el("div", { className: "card error", textContent: e.message })));
}

function renderItem(item) {
  const card = el("div", { className: "card" }, [el("div", { className: "url", title: item.url, textContent: item.url })]);
  const meta = [];

  if (item.kind === "file") {
    meta.push(item.contentType.split(";")[0] || "media file", formatSize(item.size));
    card.append(el("div", { className: "meta", textContent: meta.filter(Boolean).join(" · ") }));
    card.append(el("button", { textContent: "Download", onclick: () => download(item) }));
    return card;
  }

  const hls = item.hls;
  meta.push("HLS stream");
  if (!hls) {
    card.append(el("div", { className: "meta", textContent: "HLS stream · analyzing…" }));
    return card;
  }
  if (hls.error) {
    card.append(el("div", { className: "error", textContent: hls.error }));
    return card;
  }
  if (hls.live) meta.push("live (downloads what's available now)");
  if (hls.duration) meta.push(formatDuration(hls.duration));
  card.append(el("div", { className: "meta", textContent: meta.join(" · ") }));

  if (hls.encrypted) {
    card.append(el("div", { className: "error", textContent: "Encrypted stream — can't be downloaded." }));
    return card;
  }

  if (!hls.master) {
    card.append(el("button", { textContent: "Download", onclick: () => download(item) }));
    return card;
  }

  const options = [
    ...hls.variants.map((v) => ({
      url: v.url,
      label: [v.resolution, v.bandwidth && `${Math.round(v.bandwidth / 1000)} kbps`, v.hasSeparateAudio && "no audio"]
        .filter(Boolean)
        .join(" · ") || "variant",
      suffix: v.resolution || "",
    })),
    ...hls.audio.map((a) => ({ url: a.url, label: `Audio: ${a.name}`, suffix: `audio ${a.name}` })),
  ];
  const select = el(
    "select",
    {},
    options.map((o, i) => el("option", { value: String(i), textContent: o.label }))
  );
  const button = el("button", {
    textContent: "Download",
    onclick: () => {
      const o = options[Number(select.value)];
      download(item, { playlistUrl: o.url, suffix: o.suffix });
    },
  });
  card.append(el("div", { className: "row" }, [select, button]));
  if (hls.variants.some((v) => v.hasSeparateAudio)) {
    card.append(
      el("div", {
        className: "meta",
        textContent: "Video and audio are separate tracks here; download both and merge (e.g. with ffmpeg).",
      })
    );
  }
  return card;
}

async function refreshList() {
  const items = await browser.runtime.sendMessage({ type: "list", tabId });
  // Re-render only on change so open <select>s aren't reset by polling.
  const signature = JSON.stringify(items);
  if (signature === lastSignature) return;
  lastSignature = signature;
  listEl.replaceChildren(...items.map(renderItem));
  emptyEl.hidden = items.length > 0;
}

function jobProgress(job) {
  return job.kind === "file"
    ? [formatSize(job.done) || "0 B", formatSize(job.total)].filter(Boolean).join(" / ")
    : `segments ${job.done}/${job.total || "?"}`;
}

function jobStatusText(job) {
  return {
    running: `Downloading ${jobProgress(job)}`,
    waiting: `Retrying in ${Math.max(0, Math.ceil((job.retryAt - Date.now()) / 1000))}s — ${job.error}`,
    renewing: `Server refused (${job.error}); reopening the page to renew the session…`,
    saving: "Saving…",
    done: "Saved to Downloads",
    cancelled: "Cancelled",
    error: job.error,
  }[job.status];
}

// What a job card is built from; anything else (progress, countdown) is
// updated in place, so buttons aren't replaced under the cursor every second.
function jobShape(job) {
  return JSON.stringify([job.status, job.retry, job.name, Boolean(job.total)]);
}

function buildJobCard(job) {
  const statusEl = el("div", { className: job.status === "error" ? "error" : "meta" });
  const children = [el("div", { textContent: job.name }), statusEl];
  let progressEl = null;
  if (job.status === "running" || job.status === "waiting" || job.status === "renewing") {
    // Without a value, <progress> renders as indeterminate (size unknown).
    progressEl = job.total ? el("progress", { max: job.total, value: job.done }) : el("progress");
    children.push(
      el("div", { className: "row" }, [
        progressEl,
        el("button", {
          className: "secondary",
          textContent: "Cancel",
          onclick: () => browser.runtime.sendMessage({ type: "cancel", jobId: job.id }).then(refreshJobs),
        }),
      ])
    );
  }
  if (job.status === "error" && job.retry) {
    const send = (type) => () => browser.runtime.sendMessage({ type, jobId: job.id }).then(refreshJobs);
    const buttons = [
      el("button", {
        // "resume" continues from where it stopped; "restart" starts over.
        textContent: job.retry === "resume" ? `Resume (${jobProgress(job)})` : "Retry",
        onclick: send("retry"),
      }),
    ];
    if (job.kind === "hls") {
      // Frees the partial file kept on disk for resuming.
      buttons.push(el("button", { className: "secondary", textContent: "Discard", onclick: send("discard") }));
    }
    children.push(el("div", { className: "row" }, buttons));
  }
  return { shape: jobShape(job), card: el("div", { className: "card" }, children), statusEl, progressEl };
}

// jobId -> rendered card
const jobCards = new Map();

async function refreshJobs() {
  const jobs = await browser.runtime.sendMessage({ type: "jobs" });
  const cards = jobs.map((job) => {
    let entry = jobCards.get(job.id);
    if (!entry || entry.shape !== jobShape(job)) {
      entry = buildJobCard(job);
      jobCards.set(job.id, entry);
    }
    const text = jobStatusText(job);
    if (entry.statusEl.textContent !== text) entry.statusEl.textContent = text;
    if (entry.progressEl && job.total) {
      entry.progressEl.max = job.total;
      entry.progressEl.value = job.done;
    }
    return entry.card;
  });
  const ids = new Set(jobs.map((job) => job.id));
  for (const id of jobCards.keys()) if (!ids.has(id)) jobCards.delete(id);
  // Touch the DOM only when cards come, go or move.
  const current = jobsEl.children;
  if (cards.length !== current.length || cards.some((card, i) => current[i] !== card)) {
    jobsEl.replaceChildren(...cards);
  }
}

(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;
  // Polls one round at a time, so a busy background never builds a queue.
  for (;;) {
    await Promise.all([refreshList(), refreshJobs()]).catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));
  }
})();
