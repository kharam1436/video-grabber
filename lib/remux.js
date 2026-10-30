"use strict";

// MPEG-TS -> MP4 for HLS downloads. Relies on mux.js
// (vendor/mux-mp4.min.js, which defines the global `muxjs`). Like
// lib/formats.js this is a classic script so the Node tests can load it.

// Returns { parts, ext } for an MP4 built from the TS segments, or null when
// mux.js finds no H.264/AAC it can remux (e.g. HEVC), in which case the
// caller should keep the original .ts.
function remuxTsToMp4(segments) {
  const transmuxer = new muxjs.Transmuxer({ remux: true });
  let init = null;
  let type = "";
  const fragments = [];
  transmuxer.on("data", (segment) => {
    init = init || segment.initSegment;
    type = type || segment.type;
    fragments.push(segment.data);
  });

  // A single flush yields one moof/mdat fragment per track. With fragments
  // per segment, AVFoundation (QuickTime) reports the movie as only as long
  // as the last fragment.
  for (const segment of segments) transmuxer.push(new Uint8Array(segment));
  transmuxer.flush();
  if (!init || !fragments.length) return null;

  clearMp4Durations(init);
  return { parts: [init, ...fragments], ext: type === "audio" ? "m4a" : "mp4" };
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
      const name = String.fromCharCode(...init.subarray(pos + 4, pos + 8));
      if (size < 8 || pos + size > end) return;
      if (name === "moov" || name === "trak" || name === "mdia") walk(pos + 8, pos + size);
      else if (name === "mvhd" || name === "mdhd") clear(pos, 24, 32);
      else if (name === "tkhd") clear(pos, 28, 36);
      pos += size;
    }
  };
  walk(0, init.byteLength);
}
