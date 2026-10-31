import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// lib/formats.js is a classic browser script that defines globals; run it in
// a sandbox and pull the functions out of that sandbox's global object.
const context = vm.createContext({ URL });
vm.runInContext(readFileSync(new URL("../lib/formats.js", import.meta.url), "utf8"), context);
vm.runInContext("globalThis.api = { parsePlaylist, sniffExt, sanitize, segmentProblem };", context);
const { sniffExt, sanitize, segmentProblem } = context.api;
// Objects built in the sandbox have the sandbox's prototypes, which strict
// deepEqual rejects; cloning brings them into this realm.
const parsePlaylist = (...args) => structuredClone(context.api.parsePlaylist(...args));

const bytes = (str, extra = []) => new Uint8Array([...Buffer.from(str, "latin1"), ...extra]);

test("sniffExt identifies containers from leading bytes", () => {
  const cases = [
    ["mp4", bytes("\0\0\0\x20ftypisom\0\0\0\0")],
    ["mov", bytes("\0\0\0\x14ftypqt  \0\0\0\0")],
    ["m4a", bytes("\0\0\0\x20ftypM4A \0\0\0\0")],
    ["3gp", bytes("\0\0\0\x18ftyp3gp4\0\0\0\0")],
    ["mp4", bytes("\0\0\0\x18styp\0\0\0\0")],
    ["webm", bytes("\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x84webm")],
    ["mkv", bytes("\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x88matroska")],
    ["flv", bytes("FLV\x01\x05")],
    ["avi", bytes("RIFF\0\0\0\0AVI LIST")],
    ["wav", bytes("RIFF\0\0\0\0WAVEfmt ")],
    ["flac", bytes("fLaC\0\0\0\x22")],
    ["ts", bytes("\x47\x40\x00\x10")],
    ["mp3", bytes("ID3\x04\0\0\0\0")],
    ["aac", new Uint8Array([0xff, 0xf1, 0x50, 0x80])],
  ];
  for (const [ext, b] of cases) assert.equal(sniffExt(b), ext, ext);
  assert.equal(sniffExt(bytes("OggS\0\x02"), { contentType: "video/ogg" }), "ogv");
  assert.equal(sniffExt(bytes("OggS\0\x02")), "ogg");
  assert.equal(sniffExt(bytes("ID3\x04\0\0\0\0"), { hls: true }), "aac");
  assert.equal(sniffExt(bytes("<!DOCTYPE html>")), null);
  assert.equal(sniffExt(new Uint8Array(2)), null);
});

test("parsePlaylist reads a master playlist", () => {
  const pl = parsePlaylist(
    [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"',
      "360p/index.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080",
      "https://cdn.example.com/1080p/index.m3u8",
    ].join("\n"),
    "https://example.com/video/master.m3u8"
  );
  assert.equal(pl.master, true);
  assert.equal(pl.live, false);
  // Sorted best first, relative URIs resolved against the playlist URL.
  assert.deepEqual(
    pl.variants.map((v) => [v.resolution, v.url, v.hasSeparateAudio]),
    [
      ["1920x1080", "https://cdn.example.com/1080p/index.m3u8", false],
      ["640x360", "https://example.com/video/360p/index.m3u8", true],
    ]
  );
  assert.deepEqual(pl.audio, [{ url: "https://example.com/video/audio/en.m3u8", name: "English" }]);
});

test("parsePlaylist reads a media playlist", () => {
  const pl = parsePlaylist(
    [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:6",
      '#EXT-X-MAP:URI="init.mp4"',
      "#EXTINF:6.0,",
      "seg1.m4s",
      "#EXTINF:4.5,",
      "seg2.m4s",
      "#EXT-X-ENDLIST",
    ].join("\r\n"),
    "https://example.com/v/index.m3u8"
  );
  assert.equal(pl.master, false);
  assert.equal(pl.live, false);
  assert.equal(pl.encrypted, false);
  assert.equal(pl.duration, 10.5);
  assert.equal(pl.map, "https://example.com/v/init.mp4");
  assert.deepEqual(pl.segments, ["https://example.com/v/seg1.m4s", "https://example.com/v/seg2.m4s"]);
});

test("parsePlaylist flags encryption, byte ranges and live streams", () => {
  const encrypted = parsePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:6,\na.ts', "https://e.com/");
  assert.equal(encrypted.encrypted, true);
  assert.equal(encrypted.live, true);

  const clear = parsePlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST", "https://e.com/");
  assert.equal(clear.encrypted, false);

  const ranged = parsePlaylist("#EXTM3U\n#EXTINF:6,\n#EXT-X-BYTERANGE:100@0\na.ts", "https://e.com/");
  assert.equal(ranged.byterange, true);

  assert.throws(() => parsePlaylist("<html>", "https://e.com/"), /Not an HLS playlist/);
});

test("sanitize makes safe file names", () => {
  assert.equal(sanitize('a/b:c*d?"e<f>g|h'), "a b c d e f g h");
  assert.equal(sanitize("  ..My Clip..  "), "My Clip");
  assert.equal(sanitize("///"), "video");
  assert.equal(sanitize("x".repeat(300)).length, 120);
});

test("segmentProblem flags error pages served in place of media", () => {
  assert.equal(segmentProblem(bytes("\x47\x40\x00\x10"), "video/mp2t"), null);
  assert.equal(segmentProblem(bytes("\0\0\0\x18stypmsdh"), ""), null);
  // Some servers label segments text/plain; only the bytes count then.
  assert.equal(segmentProblem(bytes("\x47\x40\x00\x10"), "text/plain"), null);
  assert.match(segmentProblem(new Uint8Array(0), "video/mp2t"), /Empty/);
  assert.match(segmentProblem(bytes("\x47\x40"), "text/html; charset=utf-8"), /web page/);
  for (const body of ["<!DOCTYPE html><html>", "  <html><body>", '<?xml version="1.0"?>', "<Error><Code>", '{"error":"denied"}']) {
    assert.match(segmentProblem(bytes(body), "application/octet-stream"), /error page/, body);
  }
});
