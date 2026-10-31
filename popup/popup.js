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

async function refreshJobs() {
  const jobs = await browser.runtime.sendMessage({ type: "jobs" });
  jobsEl.replaceChildren(
    ...jobs.map((job) => {
      const progress =
        job.kind === "file"
          ? [formatSize(job.done) || "0 B", formatSize(job.total)].filter(Boolean).join(" / ")
          : `segments ${job.done}/${job.total || "?"}`;
      const status = {
        running: `Downloading ${progress}`,
        waiting: `Retrying in ${Math.max(0, Math.ceil((job.retryAt - Date.now()) / 1000))}s — ${job.error}`,
        saving: "Saving…",
        done: "Saved to Downloads",
        cancelled: "Cancelled",
        error: job.error,
      }[job.status];
      const children = [
        el("div", { textContent: job.name }),
        el("div", { className: job.status === "error" ? "error" : "meta", textContent: status }),
      ];
      if (job.status === "running" || job.status === "waiting") {
        children.push(
          el("div", { className: "row" }, [
            // Without a value, <progress> renders as indeterminate (size unknown).
            job.total ? el("progress", { max: job.total, value: job.done }) : el("progress"),
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
            textContent: job.retry === "resume" ? `Resume (${progress})` : "Retry",
            onclick: send("retry"),
          }),
        ];
        if (job.kind === "hls") {
          // Frees the partial file kept on disk for resuming.
          buttons.push(el("button", { className: "secondary", textContent: "Discard", onclick: send("discard") }));
        }
        children.push(el("div", { className: "row" }, buttons));
      }
      return el("div", { className: "card" }, children);
    })
  );
}

(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;
  await Promise.all([refreshList(), refreshJobs()]);
  setInterval(() => {
    refreshList();
    refreshJobs();
  }, 1000);
})();
