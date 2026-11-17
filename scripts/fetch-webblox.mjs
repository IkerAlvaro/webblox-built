// Pull Roblox's official browser client (binary type "WebClientApp") from
// setup.rbxcdn.com into vendor/webblox/engine/, plus a pinned copy of its live
// FFlags. The engine is an Emscripten build: WasmPlayer.js boots WebClient.js +
// WebClient.wasm and prefetches every file listed in WebClient.metadata.json
// from the same base URL.
//
// Run: bun run fetch:webblox [version-xxxxxxxxxxxxxxxx]
// Without an argument the current production version is resolved from
// clientsettings.roblox.com. Files already on disk with the expected size are
// skipped, so an interrupted run resumes. WebClient.wasm (about 100 MB) also
// gets a gzip copy beside it, which the server sends to browsers that accept it.

import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "vendor", "webblox", "engine");
const VERSION_FILE = join(OUT, "version.json");

const BINARY_TYPE = "WebClientApp";
const CLIENT_VERSION_URL = `https://clientsettings.roblox.com/v2/client-version/${BINARY_TYPE}`;
const FLAGS_URL = `https://clientsettingscdn.roblox.com/v2/settings/application/${BINARY_TYPE}`;
const CDN = "https://setup.rbxcdn.com/webclient";
const ARCHIVE_API = "https://api.github.com/repos/setup-rbxcdn/webclient-archive/releases?per_page=20";
const execFileAsync = promisify(execFile);
// Loaded by WasmPlayer.js by name; everything else comes from the metadata list.
const CORE = ["WasmPlayer.js", "WebClient.js", "WebClient.wasm", "WebClient.metadata.json", "audio-processor-fast.js"];
const CONCURRENCY = 16;
const RETRIES = 3;
const VERSION_RE = /^version-[0-9a-f]{16}$/;
const GZIP = ["WebClient.wasm"];

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function getArchiveRelease(requestedUpload, exact) {
  const response = await fetch(ARCHIVE_API, {
    headers: { accept: "application/vnd.github+json", "user-agent": "webblox-built" },
  });
  if (!response.ok) throw new Error(`Roblox build archive: HTTP ${response.status}`);
  const releases = await response.json();
  const complete = releases.filter(release =>
    /^webclient-version-[0-9a-f]{16}$/.test(release.tag_name ?? "") &&
    release.author?.login === "github-actions[bot]" &&
    /Archive status:\s*\*\*complete\*\*/i.test(release.body ?? "") &&
    release.assets?.some(asset => asset.name?.endsWith(".zip") && /^sha256:[0-9a-f]{64}$/.test(asset.digest ?? "")),
  );
  const requested = requestedUpload && complete.find(release => release.tag_name === `webclient-${requestedUpload}`);
  if (exact && !requested) throw new Error(`Roblox client ${requestedUpload} is not in the public archive.`);
  const release = requested ?? complete[0];
  if (!release) throw new Error("No complete archived Roblox browser client is available.");
  return release;
}

async function restoreArchivedClient(requestedUpload, exact) {
  const release = await getArchiveRelease(requestedUpload, exact);
  const asset = release.assets.find(item => item.name?.endsWith(".zip"));
  const match = /^webclient-version-([0-9a-f]{16})$/.exec(release.tag_name);
  if (!asset || !match) throw new Error("The archived Roblox browser client has an invalid release format.");
  const upload = `version-${match[1]}`;
  const assetUrl = new URL(asset.browser_download_url);
  if (assetUrl.origin !== "https://github.com" || !assetUrl.pathname.startsWith("/setup-rbxcdn/webclient-archive/releases/download/")) {
    throw new Error("The archived Roblox client download is not from the expected GitHub release.");
  }
  const temp = await mkdtemp(join(ROOT, ".webclient-archive-"));
  const zipPath = join(temp, asset.name);
  try {
    const response = await fetch(assetUrl);
    if (!response.ok || !response.body) throw new Error(`Roblox client archive download: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(zipPath));

    const hash = createHash("sha256");
    for await (const chunk of createReadStream(zipPath)) hash.update(chunk);
    const actualDigest = `sha256:${hash.digest("hex")}`;
    if (actualDigest !== asset.digest || (await sizeOnDisk(zipPath)) !== asset.size) {
      throw new Error("The archived Roblox client failed GitHub's published SHA-256 or size check.");
    }

    const { stdout } = await execFileAsync("unzip", ["-Z1", zipPath], { maxBuffer: 8 * 1024 * 1024 });
    const names = stdout.trim().split("\n").filter(Boolean);
    const prefix = `${upload}/`;
    if (!names.length || names.some(name => name.startsWith("/") || !name.startsWith(prefix) || name.split("/").includes(".."))) {
      throw new Error("The Roblox client archive contains an unexpected path.");
    }
    await execFileAsync("unzip", ["-q", zipPath, "-d", temp], { maxBuffer: 8 * 1024 * 1024 });
    const sourceDir = join(temp, upload);
    const archivedFlags = JSON.parse(await readFile(join(sourceDir, "client-settings", "application-WebClientApp.json"), "utf8"));
    if (!archivedFlags.applicationSettings || typeof archivedFlags.applicationSettings !== "object") {
      throw new Error("The archived Roblox client has no usable feature flags.");
    }
    await rm(OUT, { recursive: true, force: true });
    await cp(sourceDir, OUT, { recursive: true });
    return {
      upload,
      version: release.name?.split(" ")[0] ?? null,
      base: `${CDN}/${upload}-RobloxWebClient`,
      applicationSettings: archivedFlags.applicationSettings,
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function sizeOnDisk(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

// Downloads url to path, writing through a .part file so a crash never leaves a
// truncated file that a later run would mistake for complete. Anything already
// on disk was therefore fully written for the version recorded in version.json.
async function download(url, path, expectedSize) {
  const existing = await sizeOnDisk(path);
  if (existing >= 0 && (expectedSize === undefined || existing === expectedSize)) return false;
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      const declared = res.headers.get("content-encoding") ? NaN : Number(res.headers.get("content-length"));
      const want = expectedSize ?? (Number.isFinite(declared) ? declared : undefined);
      if (want !== undefined && body.length !== want) throw new Error(`size ${body.length}, expected ${want}`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.part`, body);
      await rename(`${path}.part`, path);
      return true;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`${url}: ${lastError.message}`);
}

async function pool(items, worker) {
  let next = 0;
  let done = 0;
  const failures = [];
  const run = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await worker(item);
      } catch (err) {
        failures.push(err.message);
      }
      if (++done % 250 === 0 || done === items.length) console.log(`[webblox] ${done}/${items.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, run));
  return failures;
}

async function main() {
  const pinned = process.argv[2];
  if (pinned !== undefined && !VERSION_RE.test(pinned)) {
    console.error(`[webblox] "${pinned}" is not a version-<16 hex> upload id`);
    process.exit(1);
  }
  const live = pinned ? null : await getJson(CLIENT_VERSION_URL);
  let upload = pinned ?? live.clientVersionUpload;
  if (!VERSION_RE.test(upload ?? "")) throw new Error(`unexpected client-version response: ${JSON.stringify(live)}`);
  let base = `${CDN}/${upload}-RobloxWebClient`;
  let engineVersion = live?.version ?? null;
  let applicationSettings;
  console.log(`[webblox] engine ${upload}${live ? ` (${live.version})` : " (pinned)"}`);
  console.log(`[webblox] from ${base}`);

  // A different version shares almost nothing byte-for-byte; start clean rather
  // than leave stale assets next to the new engine. The marker is written before
  // any download so an interrupted run can only ever resume the same version.
  let previous = null;
  try {
    previous = JSON.parse(await readFile(VERSION_FILE, "utf8")).clientVersionUpload;
  } catch {}
  if (previous !== upload) {
    if (previous) console.log(`[webblox] replacing ${previous}`);
    await rm(OUT, { recursive: true, force: true });
  }
  await mkdir(OUT, { recursive: true });
  let record = { clientVersionUpload: upload, version: engineVersion, source: base, complete: false };
  await writeFile(VERSION_FILE, `${JSON.stringify(record, null, 2)}\n`);

  let usedArchive = false;
  try {
    for (const name of CORE) {
      const fetched = await download(`${base}/${name}`, join(OUT, name));
      console.log(`[webblox] ${fetched ? "fetched" : "kept"} ${name}`);
    }

    const metadata = JSON.parse(await readFile(join(OUT, "WebClient.metadata.json"), "utf8"));
    if (!Array.isArray(metadata)) throw new Error("WebClient.metadata.json is not a file list");
    const files = metadata.filter(entry => {
      const ok = typeof entry?.path === "string" && entry.path.startsWith("/") && !entry.path.split("/").includes("..");
      if (!ok) console.warn(`[webblox] skipping bad metadata entry ${JSON.stringify(entry)}`);
      return ok;
    });
    const total = files.reduce((sum, entry) => sum + entry.size, 0);
    console.log(`[webblox] ${files.length} content files, ${(total / 1e6).toFixed(1)} MB`);
    const failures = await pool(files, entry =>
      download(`${base}${encodeURI(entry.path)}`, join(OUT, entry.path), entry.size));
    if (failures.length) {
      for (const message of failures) console.error(`[webblox] failed ${message}`);
      throw new Error(`${failures.length} Roblox client files could not be downloaded: ${failures.slice(0, 5).join("; ")}`);
    }

    const flags = await getJson(FLAGS_URL);
    applicationSettings = flags.applicationSettings;
    if (!applicationSettings || typeof applicationSettings !== "object") throw new Error("Roblox returned no application settings");
  } catch (error) {
    if (!/HTTP (403|404)/.test(error.message ?? "")) throw error;
    console.warn(`[webblox] Roblox CDN denied a client file (${error.message}); using the latest complete public archive`);
    const archived = await restoreArchivedClient(pinned ? upload : null, Boolean(pinned));
    upload = archived.upload;
    base = archived.base;
    engineVersion = archived.version;
    applicationSettings = archived.applicationSettings;
    usedArchive = true;
    record = { clientVersionUpload: upload, version: engineVersion, source: base, complete: false, archived: true };
    await writeFile(VERSION_FILE, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`[webblox] restored complete archived client ${upload} (${engineVersion ?? "version unknown"})`);
  }

  for (const name of GZIP) {
    const path = join(OUT, name);
    if ((await sizeOnDisk(`${path}.gz`)) >= 0) continue;
    await pipeline(createReadStream(path), createGzip({ level: 9 }), createWriteStream(`${path}.gz.part`));
    await rename(`${path}.gz.part`, `${path}.gz`);
    console.log(`[webblox] gzipped ${name} (${((await sizeOnDisk(`${path}.gz`)) / 1e6).toFixed(1)} MB)`);
  }

  const metadata = JSON.parse(await readFile(join(OUT, "WebClient.metadata.json"), "utf8"));
  if (!Array.isArray(metadata)) throw new Error("WebClient.metadata.json is not a file list");
  const files = metadata.filter(entry => {
    // Paths are rooted at the engine base; refuse anything that would escape OUT.
    const ok = typeof entry?.path === "string" && entry.path.startsWith("/") && !entry.path.split("/").includes("..");
    if (!ok) console.warn(`[webblox] skipping bad metadata entry ${JSON.stringify(entry)}`);
    return ok;
  });
  if (usedArchive) {
    const missing = [];
    for (const entry of files) {
      const actual = await sizeOnDisk(join(OUT, entry.path));
      if (actual !== entry.size) missing.push(`${entry.path} (${actual}/${entry.size})`);
    }
    if (missing.length) throw new Error(`archived Roblox client is incomplete: ${missing.slice(0, 10).join(", ")}`);
  }

  // Same shape the player page reads: flags pinned to the engine they came from,
  // so a later Roblox flag push cannot break this build.
  const pinnedAt = new Date().toISOString();
  await writeFile(join(OUT, "PinnedFlags.json"),
    JSON.stringify({ engine: upload, pinnedAt, applicationSettings }));
  console.log(`[webblox] pinned ${Object.keys(applicationSettings).length} flags`);

  await writeFile(VERSION_FILE, `${JSON.stringify({ ...record, complete: true, fetchedAt: pinnedAt }, null, 2)}\n`);
  console.log(`[webblox] done: ${OUT}`);
}

main().catch(err => {
  console.error(`[webblox] ${err.message}`);
  process.exit(1);
});
