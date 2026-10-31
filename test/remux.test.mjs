import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Load the vendored mux.js and lib/remux.js the way the background page does:
// as classic scripts sharing one global scope.
const context = vm.createContext({});
context.window = context;
for (const file of ["../vendor/mux-mp4.min.js", "../lib/remux.js"]) {
  vm.runInContext(readFileSync(new URL(file, import.meta.url), "utf8"), context);
}

// Three 1 s H.264/AAC HLS segments made with ffmpeg (testsrc2 + sine).
const segments = [0, 1, 2].map((i) => {
  const b = readFileSync(new URL(`fixtures/seg${i}.ts`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
});

// Top-level and nested MP4 boxes as [name, start, size] (only the containers
// the init segment needs).
function boxes(bytes, start = 0, end = bytes.length, out = []) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let pos = start; pos + 8 <= end; ) {
    const size = view.getUint32(pos);
    const name = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    out.push([name, pos, size]);
    if (["moov", "trak", "mdia"].includes(name)) boxes(bytes, pos + 8, pos + size, out);
    pos += size;
  }
  return out;
}

test("remuxTsToMp4 streams TS segments into a playable fragmented MP4", () => {
  const result = context.remuxTsToMp4(segments);
  assert.ok(result);
  assert.equal(result.ext, "mp4");

  const [init, ...fragments] = result.parts;
  // One chunk per pushed segment, each a moof/mdat pair per track.
  assert.equal(fragments.length, segments.length);
  for (const f of fragments) assert.deepEqual(boxes(f).map(([name]) => name), ["moof", "mdat", "moof", "mdat"]);

  // mfhd sequence numbers start at 1 and never repeat; mux.js's own 0,0,1,1
  // makes AVFoundation report only the last segment's length.
  const sequences = fragments.flatMap((f) => {
    const view = new DataView(f.buffer, f.byteOffset, f.byteLength);
    return boxes(f)
      .filter(([name]) => name === "moof")
      .map(([, pos]) => view.getUint32(pos + 8 + 12)); // mfhd is moof's first child
  });
  assert.deepEqual(sequences, [1, 2, 3, 4, 5, 6]);

  const initBoxes = boxes(init);
  assert.equal(initBoxes[0][0], "ftyp");
  assert.equal(initBoxes.filter(([name]) => name === "trak").length, 2, "video + audio tracks");

  // Header durations cleared from mux.js's 0xffffffff placeholder.
  const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
  for (const [name, pos] of initBoxes) {
    if (name === "mvhd" || name === "mdhd") assert.equal(view.getUint32(pos + 24), 0, name);
    if (name === "tkhd") assert.equal(view.getUint32(pos + 28), 0, name);
  }
});

test("remuxTsToMp4 returns null for data it can't remux", () => {
  assert.equal(context.remuxTsToMp4([new Uint8Array(188 * 4).buffer]), null);
});
