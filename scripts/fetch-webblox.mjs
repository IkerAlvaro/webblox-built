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

// Newest first. An archived build marked complete can still lack files the
// engine needs (the 0.748 archive has no WebClient.metadata.json), so main()
// tries these in turn until one passes the checks in restoreRelease().
const ARCHIVE_ATTEMPTS = 5;
// What the engine cannot start without; the rest is checked against the metadata list.
const ARCHIVE_REQUIRED = ["WasmPlayer.js", "WebClient.js", "WebClient.wasm", "WebClient.metadata.json"];

async function getArchiveReleases(requestedUpload, exact) {
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
  if (exact) {
    if (!requested) throw new Error(`Roblox client ${requestedUpload} is not in the public archive.`);
    return [requested];
  }
  const ordered = requested ? [requested, ...complete.filter(release => release !== requested)] : complete;
  if (!ordered.length) throw new Error("No complete archived Roblox browser client is available.");
  return ordered.slice(0, ARCHIVE_ATTEMPTS);
}

async function restoreArchivedClient(requestedUpload, exact) {
  const releases = await getArchiveReleases(requestedUpload, exact);
  const failures = [];
  for (const release of releases) {
    try {
      return await restoreRelease(release);
    } catch (error) {
      console.warn(`[webblox] skipping archived ${release.tag_name}: ${error.message}`);
      failures.push(`${release.tag_name}: ${error.message}`);
    }
  }
  throw new Error(`no usable archived client (${failures.join("; ")})`);
}

// Downloads one archived build, checks it, and only then replaces OUT with it.
async function restoreRelease(release) {
  const asset = release.assets.find(item => item.name?.endsWith(".zip"));
  const match = /^webclient-version-([0-9a-f]{16})$/.exec(release.tag_name);
  if (!asset || !match) throw new Error("invalid release format");
  const upload = `version-${match[1]}`;
  const assetUrl = new URL(asset.browser_download_url);
  if (assetUrl.origin !== "https://github.com" || !assetUrl.pathname.startsWith("/setup-rbxcdn/webclient-archive/releases/download/")) {
    throw new Error("download is not from the expected GitHub release");
  }
  const temp = await mkdtemp(join(ROOT, ".webclient-archive-"));
  const zipPath = join(temp, asset.name);
  try {
    const response = await fetch(assetUrl);
    if (!response.ok || !response.body) throw new Error(`download: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(zipPath));

    const hash = createHash("sha256");
    for await (const chunk of createReadStream(zipPath)) hash.update(chunk);
    const actualDigest = `sha256:${hash.digest("hex")}`;
    if (actualDigest !== asset.digest || (await sizeOnDisk(zipPath)) !== asset.size) {
      throw new Error("failed GitHub's published SHA-256 or size check");
    }

    const { stdout } = await execFileAsync("unzip", ["-Z1", zipPath], { maxBuffer: 8 * 1024 * 1024 });
    const names = stdout.trim().split("\n").filter(Boolean);
    const prefix = `${upload}/`;
    if (!names.length || names.some(name => name.startsWith("/") || !name.startsWith(prefix) || name.split("/").includes(".."))) {
      throw new Error("archive contains an unexpected path");
    }
    const missingCore = ARCHIVE_REQUIRED.filter(name => !names.includes(`${prefix}${name}`));
    if (missingCore.length) throw new Error(`archive lacks ${missingCore.join(", ")}`);
    await execFileAsync("unzip", ["-q", zipPath, "-d", temp], { maxBuffer: 8 * 1024 * 1024 });
    const sourceDir = join(temp, upload);

    const files = await readMetadata(sourceDir);
    const missing = [];
    for (const entry of files) {
      const actual = await sizeOnDisk(join(sourceDir, entry.path));
      if (actual !== entry.size) missing.push(`${entry.path} (${actual}/${entry.size})`);
    }
    if (missing.length) throw new Error(`${missing.length} content files missing or wrong size: ${missing.slice(0, 5).join(", ")}`);

    let applicationSettings;
    try {
      const archivedFlags = JSON.parse(await readFile(join(sourceDir, "client-settings", "application-WebClientApp.json"), "utf8"));
      applicationSettings = archivedFlags.applicationSettings;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!applicationSettings || typeof applicationSettings !== "object") {
      console.warn(`[webblox] ${release.tag_name} has no saved feature flags; fetching Roblox's current flags`);
      applicationSettings = (await getJson(FLAGS_URL)).applicationSettings;
    }
    if (!applicationSettings || typeof applicationSettings !== "object") {
      throw new Error("no usable Roblox feature flags");
    }
    await rm(OUT, { recursive: true, force: true });
    await cp(sourceDir, OUT, { recursive: true });
    return {
      upload,
      version: release.name?.split(" ")[0] ?? null,
      base: `${CDN}/${upload}-RobloxWebClient`,
      applicationSettings,
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

// Pulls the engine straight from Roblox's CDN. Throws on any failure, so main()
// can fall back to the public archive.
async function fetchFromCdn(pinned) {
  const live = pinned ? null : await getJson(CLIENT_VERSION_URL);
  const upload = pinned ?? live?.clientVersionUpload;
  if (!VERSION_RE.test(upload ?? "")) throw new Error(`unexpected client-version response: ${JSON.stringify(live)}`);
  const base = `${CDN}/${upload}-RobloxWebClient`;
  const version = live?.version ?? null;
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
  const record = { clientVersionUpload: upload, version, source: base, complete: false };
  await writeFile(VERSION_FILE, `${JSON.stringify(record, null, 2)}\n`);

  for (const name of CORE) {
    const fetched = await download(`${base}/${name}`, join(OUT, name));
    console.log(`[webblox] ${fetched ? "fetched" : "kept"} ${name}`);
  }

  const files = await readMetadata();
  const total = files.reduce((sum, entry) => sum + (Number(entry.size) || 0), 0);
  console.log(`[webblox] ${files.length} content files, ${(total / 1e6).toFixed(1)} MB`);
  const failures = await pool(files, entry =>
    download(`${base}${encodeURI(entry.path)}`, join(OUT, entry.path), entry.size));
  if (failures.length) {
    for (const message of failures) console.error(`[webblox] failed ${message}`);
    throw new Error(`${failures.length} Roblox client files could not be downloaded: ${failures.slice(0, 5).join("; ")}`);
  }

  const { applicationSettings } = await getJson(FLAGS_URL);
  if (!applicationSettings || typeof applicationSettings !== "object") throw new Error("Roblox returned no application settings");
  return { record, applicationSettings, archived: false };
}

// The metadata list's paths are rooted at the engine base; refuse anything
// that would escape OUT.
async function readMetadata(dir = OUT) {
  const metadata = JSON.parse(await readFile(join(dir, "WebClient.metadata.json"), "utf8"));
  if (!Array.isArray(metadata)) throw new Error("WebClient.metadata.json is not a file list");
  return metadata.filter(entry => {
    const ok = typeof entry?.path === "string" && entry.path.startsWith("/") && !entry.path.split("/").includes("..");
    if (!ok) console.warn(`[webblox] skipping bad metadata entry ${JSON.stringify(entry)}`);
    return ok;
  });
}

async function main() {
  const pinned = process.argv[2];
  if (pinned !== undefined && !VERSION_RE.test(pinned)) {
    console.error(`[webblox] "${pinned}" is not a version-<16 hex> upload id`);
    process.exit(1);
  }

  // Roblox blocks some networks (datacenter IPs among them) from its client
  // settings or its CDN, whether with an HTTP error or by not answering at all.
  // Any failure there falls back to the public archive of complete builds.
  let result;
  try {
    result = await fetchFromCdn(pinned);
  } catch (cdnError) {
    console.warn(`[webblox] Roblox's CDN failed (${cdnError.message}); using the latest complete public archive`);
    let archived;
    try {
      archived = await restoreArchivedClient(pinned ?? null, Boolean(pinned));
    } catch (archiveError) {
      throw new Error(`Roblox's CDN failed (${cdnError.message}) and so did the public archive (${archiveError.message})`);
    }
    const record = {
      clientVersionUpload: archived.upload,
      version: archived.version,
      source: archived.base,
      complete: false,
      archived: true,
    };
    await writeFile(VERSION_FILE, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`[webblox] restored complete archived client ${archived.upload} (${archived.version ?? "version unknown"})`);
    result = { record, applicationSettings: archived.applicationSettings, archived: true };
  }
  const { record, applicationSettings } = result;
  const upload = record.clientVersionUpload;

  for (const name of GZIP) {
    const path = join(OUT, name);
    if ((await sizeOnDisk(`${path}.gz`)) >= 0) continue;
    await pipeline(createReadStream(path), createGzip({ level: 9 }), createWriteStream(`${path}.gz.part`));
    await rename(`${path}.gz.part`, `${path}.gz`);
    console.log(`[webblox] gzipped ${name} (${((await sizeOnDisk(`${path}.gz`)) / 1e6).toFixed(1)} MB)`);
  }

  const files = await readMetadata();
  if (result.archived) {
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
