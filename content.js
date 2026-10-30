// Reports <video>/<audio> sources that point at real URLs (blob: URLs from
// MediaSource players are useless here; those are caught via network requests).
(() => {
  const seen = new Set();

  function scan() {
    const urls = [];
    for (const el of document.querySelectorAll("video, audio, video source, audio source")) {
      for (const src of [el.currentSrc, el.src]) {
        if (src && /^https?:/i.test(src) && !seen.has(src)) {
          seen.add(src);
          urls.push(src);
        }
      }
    }
    if (urls.length) {
      browser.runtime.sendMessage({ type: "found", urls }).catch(() => {});
    }
  }

  // The tab title often carries noise ("(3) Some clip - SiteName"), so prefer
  // the page's own metadata for the video title and strip the site name.
  function pageTitle() {
    const meta = (sel) => (document.querySelector(sel)?.getAttribute("content") || "").trim();
    const siteName = meta('meta[property="og:site_name"]');
    let title =
      meta('meta[property="og:title"]') ||
      meta('meta[name="twitter:title"]') ||
      document.title.trim();

    title = title.replace(/^\(\d+\+?\)\s*/, ""); // unread-count prefix
    if (siteName) {
      const escaped = siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      title = title
        .replace(new RegExp(`\\s*[-|–—:·]\\s*${escaped}\\s*$`, "i"), "")
        .replace(new RegExp(`^\\s*${escaped}\\s*[-|–—:·]\\s*`, "i"), "");
    }
    return title.trim();
  }

  if (window === window.top) {
    browser.runtime.onMessage.addListener((msg) => {
      if (msg.type === "pageTitle") return Promise.resolve(pageTitle());
    });
  }

  scan();
  // "play" doesn't bubble, so listen in the capture phase.
  document.addEventListener("play", scan, true);
  document.addEventListener("loadedmetadata", scan, true);
})();
