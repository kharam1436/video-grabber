"use strict";

// MPEG-TS -> MP4 for HLS downloads. Relies on mux.js
// (vendor/mux-mp4.min.js, which defines the global `muxjs`). Like
// lib/formats.js this is a classic script so the Node tests can load it.

// Streaming remuxer: push() each TS segment in order and write out the
// returned chunks; nothing is retained between calls, so memory stays at
// about one segment. The first chunks include the MP4 init segment.
function createTsRemuxer() {
  const transmuxer = new muxjs.Transmuxer({ remux: true });
  let started = false;
  let type = "";
  let sequence = 1;
  let out = [];
  transmuxer.on("data", (segment) => {
    if (!started) {
      started = true;
      type = segment.type;
      clearMp4Durations(segment.initSegment);
      out.push(segment.initSegment);
    }
    sequence = renumberFragments(segment.data, sequence);
    out.push(segment.data);
  });

  return {
    push(buffer) {
      transmuxer.push(new Uint8Array(buffer));
      transmuxer.flush();
      const chunks = out;
      out = [];
      return chunks;
    },
    // False until mux.js has produced output, i.e. found H.264/AAC it can
    // remux; when it stays false (e.g. HEVC) the caller should keep the .ts.
    get started() {
      return started;
    },
    get ext() {
      return type === "audio" ? "m4a" : "mp4";
    },
  };
}

// Whole-file convenience wrapper (used by the tests): { parts, ext } or null.
function remuxTsToMp4(segments) {
  const remuxer = createTsRemuxer();
  const parts = segments.flatMap((s) => remuxer.push(s));
  return remuxer.started ? { parts, ext: remuxer.ext } : null;
}

function boxName(bytes, pos) {
  return String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
}

// mux.js numbers fragments per flush and per track (0, 0, 1, 1, ...), but
// mfhd sequence numbers must start at 1 and increase. AVFoundation
// (QuickTime) treats the repeats as replacements and reports only the last
// segment's length. Rewrites them in place; returns the next number to use.
function renumberFragments(data, sequence) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let pos = 0; pos + 8 <= data.byteLength; ) {
    const size = view.getUint32(pos);
    if (size < 8) break;
    if (boxName(data, pos) === "moof") {
      for (let child = pos + 8; child + 8 <= pos + size; child += view.getUint32(child)) {
        if (boxName(data, child) === "mfhd") {
          view.setUint32(child + 12, sequence++);
          break;
        }
      }
    }
    pos += size;
  }
  return sequence;
}

// mux.js writes 0xffffffff ("unknown") as the movie and track durations,
// which AVFoundation reads literally (a 6 s clip shows as 27 hours). Players
// add the fragments' durations to these header durations, so the correct
// value for a file whose samples all live in fragments is 0. Edits in place.
function clearMp4Durations(init) {
  const view = new DataView(init.buffer, init.byteOffset, init.byteLength);

  // Offset of the duration field in version 0 / version 1 boxes.
  const clear = (boxStart, v0Offset, v1Offset) => {
    if (view.getUint8(boxStart + 8) === 1) {
      view.setBigUint64(boxStart + v1Offset, 0n);
    } else {
      view.setUint32(boxStart + v0Offset, 0);
    }
  };

  const walk = (start, end) => {
    for (let pos = start; pos + 8 <= end; ) {
      const size = view.getUint32(pos);
      const name = boxName(init, pos);
      if (size < 8 || pos + size > end) return;
      if (name === "moov" || name === "trak" || name === "mdia") walk(pos + 8, pos + size);
      else if (name === "mvhd" || name === "mdhd") clear(pos, 24, 32);
      else if (name === "tkhd") clear(pos, 28, 36);
      pos += size;
    }
  };
  walk(0, init.byteLength);
}
