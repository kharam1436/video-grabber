"use strict";

// Pure helpers shared by background.js (loaded first as a classic script)
// and the Node tests, which evaluate this file in a vm context.

// ---------- HLS playlists ----------

function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

function parsePlaylist(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new Error("Not an HLS playlist");

  const pl = {
    master: false,
    variants: [],
    audio: [],
    segments: [],
    map: null,
    encrypted: false,
    byterange: false,
    live: true,
    duration: 0,
  };
  let streamInf = null;
  let segDuration = 0;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pl.master = true;
      streamInf = parseAttrs(line.slice(18));
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = parseAttrs(line.slice(13));
      if (a.TYPE === "AUDIO" && a.URI) {
        pl.audio.push({ url: new URL(a.URI, base).href, name: a.NAME || a.LANGUAGE || "audio" });
      }
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const a = parseAttrs(line.slice(11));
      if (a.METHOD && a.METHOD !== "NONE") pl.encrypted = true;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const a = parseAttrs(line.slice(11));
      pl.map = new URL(a.URI, base).href;
      if (a.BYTERANGE) pl.byterange = true;
    } else if (line.startsWith("#EXT-X-BYTERANGE")) {
      pl.byterange = true;
    } else if (line.startsWith("#EXT-X-ENDLIST")) {
      pl.live = false;
    } else if (line.startsWith("#EXTINF:")) {
      segDuration = parseFloat(line.slice(8)) || 0;
    } else if (!line.startsWith("#")) {
      const url = new URL(line, base).href;
      if (streamInf) {
        pl.variants.push({
          url,
          bandwidth: Number(streamInf.BANDWIDTH) || 0,
          resolution: streamInf.RESOLUTION || "",
          hasSeparateAudio: Boolean(streamInf.AUDIO),
        });
        streamInf = null;
      } else {
        pl.segments.push(url);
        pl.duration += segDuration;
        segDuration = 0;
      }
    }
  }
  if (pl.master) pl.live = false;
  pl.variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return pl;
}

// ---------- file names and formats ----------

function sanitize(name) {
  const clean = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 120);
  return clean || "video";
}

function ascii(bytes, start, len) {
  return String.fromCharCode(...bytes.subarray(start, start + len));
}

// Identifies the container from its leading bytes; returns null if unknown.
function sniffExt(b, { hls = false, contentType = "" } = {}) {
  if (b.length < 4) return null;
  const box = ascii(b, 4, 4);
  if (box === "ftyp") {
    const brand = ascii(b, 8, 4);
    if (brand === "qt  ") return "mov";
    if (brand === "M4A " || brand === "M4B ") return "m4a";
    if (brand.startsWith("3g")) return "3gp";
    return "mp4";
  }
  if (box === "moof" || box === "styp" || box === "sidx" || box === "moov") return "mp4";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return ascii(b, 0, b.length).includes("webm") ? "webm" : "mkv";
  }
  if (ascii(b, 0, 4) === "OggS") return contentType.startsWith("video/") ? "ogv" : "ogg";
  if (ascii(b, 0, 3) === "FLV") return "flv";
  if (ascii(b, 0, 4) === "RIFF") {
    const kind = ascii(b, 8, 4);
    if (kind === "AVI ") return "avi";
    if (kind === "WAVE") return "wav";
  }
  if (ascii(b, 0, 4) === "fLaC") return "flac";
  if (b[0] === 0x47) return "ts"; // MPEG-TS sync byte
  // HLS packed audio is AAC behind an ID3 timestamp tag.
  if (ascii(b, 0, 3) === "ID3") return hls ? "aac" : "mp3";
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return "aac"; // ADTS
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "mp3"; // MPEG audio frame
  return null;
}
