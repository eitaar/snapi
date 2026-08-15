import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getBuildProfile } from "../dist/builds.js";

function argument(name, argv) {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  if (value === undefined || value.trim() === "" || value.startsWith("--")) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function bodyBytes(entry) {
  const content = entry?.response?.content;
  if (entry?.request?.method !== "GET" || entry?.response?.status !== 200) return undefined;
  if (typeof content?.text !== "string") return undefined;
  if (content.encoding === "base64") return Buffer.from(content.text, "base64");
  if (content.encoding === undefined) return Buffer.from(content.text, "utf8");
  return undefined;
}

const argv = process.argv.slice(2);
const harPath = resolve(argument("--har", argv));
const outputDir = resolve(argument("--output", argv));
const buildId = argument("--build", argv);
const profile = getBuildProfile(buildId);
const har = JSON.parse(await readFile(harPath, "utf8"));
const entries = Array.isArray(har?.log?.entries) ? har.log.entries : [];
const candidates = new Map();
for (const entry of entries) {
  const url = typeof entry?.request?.url === "string" ? new URL(entry.request.url) : undefined;
  if (url?.origin !== "https://cf-st.sc-cdn.net" || !url.pathname.startsWith("/dw/")) continue;
  const name = basename(url.pathname);
  const bytes = bodyBytes(entry);
  if (bytes === undefined || !profile.assets.some((asset) => asset.filename === name)) continue;
  const hash = createHash("sha256").update(bytes).digest("hex");
  candidates.set(name, { bytes, hash });
}

await mkdir(outputDir, { recursive: true });
for (const asset of profile.assets) {
  const candidate = candidates.get(asset.filename);
  if (
    candidate === undefined ||
    candidate.bytes.byteLength !== asset.size ||
    candidate.hash !== asset.sha256
  ) {
    throw new Error(`HAR asset verification failed for ${asset.filename}`);
  }
  await writeFile(join(outputDir, asset.filename), candidate.bytes, { flag: "w" });
}
console.log(JSON.stringify({ buildId: profile.buildId, assetCount: profile.assets.length }));
