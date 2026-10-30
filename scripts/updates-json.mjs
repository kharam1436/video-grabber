// Prints the Firefox update manifest for a signed release:
//   node scripts/updates-json.mjs <version> <path/to/signed.xpi>
// https://extensionworkshop.com/documentation/manage/updating-your-extension/
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const [version, xpiPath] = process.argv.slice(2);
if (!version || !xpiPath) {
  console.error("usage: updates-json.mjs <version> <xpi>");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const repo = process.env.GITHUB_REPOSITORY || "kharam1436/video-grabber";
const hash = createHash("sha256").update(readFileSync(xpiPath)).digest("hex");

const updates = {
  addons: {
    [manifest.browser_specific_settings.gecko.id]: {
      updates: [
        {
          version,
          update_link: `https://github.com/${repo}/releases/download/v${version}/${basename(xpiPath)}`,
          update_hash: `sha256:${hash}`,
        },
      ],
    },
  },
};
console.log(JSON.stringify(updates, null, 2));
