// Bumps manifest.json to the given version, commits, tags and pushes; the
// tag push triggers .github/workflows/release.yml.
//   npm run release -- 1.2.3
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
  console.error("usage: npm run release -- <major.minor.patch>");
  process.exit(1);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

if (git("status", "--porcelain")) {
  console.error("Working tree is not clean; commit or stash first.");
  process.exit(1);
}
if (git("branch", "--show-current") !== "main") {
  console.error("Release from main.");
  process.exit(1);
}

const path = new URL("../manifest.json", import.meta.url);
const text = readFileSync(path, "utf8");
const current = JSON.parse(text).version;
// Edit the text rather than re-serialising, to keep the file's formatting.
writeFileSync(path, text.replace(`"version": "${current}"`, `"version": "${version}"`));

git("commit", "-am", `Release v${version}`);
git("tag", "-m", `v${version}`, `v${version}`);
git("push", "--atomic", "origin", "main", `v${version}`);
console.log(`Pushed v${version} (was ${current}); the Release workflow takes it from here.`);
