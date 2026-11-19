// Service worker for /blox/. Roblox's web client talks to *.roblox.com and
// *.rbxcdn.com with ordinary fetch/XHR, from the page and from its pthread
// workers. Those hosts may be unreachable from here, so every cross-origin
// request is handed to a page in this scope, which sends it over Wisp
// (host.js) with the Roblox session attached, and the reply comes back here.
// Same-origin requests are left alone: the server already sends the
// cross-origin isolation headers the engine's SharedArrayBuffer needs.

const SCOPE = new URL(self.registration.scope);
const PINNED_FLAGS = new URL("engine/PinnedFlags.json", SCOPE).href;
// WasmPlayer.js loads the engine's flags from here. The engine on disk is one
// pinned version, so it gets the flags fetched alongside it, not whatever
// Roblox's live flags are for a newer engine.
const FLAGS_URL = /^https:\/\/clientsettingscdn\.roblox\.com\/v2\/settings\/application\/WebClientApp(?:\/bucket\/[^?#]*)?(?:[?#]|$)/;
const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const RELAY_TIMEOUT_MS = 120_000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!/^https?:/.test(request.url)) return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    const version = request.method === "GET" ? ENGINE_VERSIONED.exec(url.pathname) : null;
    if (version) event.respondWith(cachedEngineFile(request, version[1]));
    return;
  }
  event.respondWith(crossOrigin(request, event.clientId));
});

// ---- Engine cache ---------------------------------------------------------------
// engine/v/<upload>/… never changes, so it is kept in Cache Storage, one cache
// per engine version. Every copy is checked against the size the server sent
// (x-blox-size) when stored and when used; a short or missing copy is dropped
// and fetched again, and caches of other versions are deleted.

const ENGINE_VERSIONED = new RegExp(`^${SCOPE.pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}engine/v/(version-[0-9a-f]{16})/`);
const CACHE_PREFIX = "blox-engine-";
const pruned = new Set();

async function intact(response) {
  if (!response?.ok) return false;
  const expected = Number(response.headers.get("x-blox-size"));
  if (!Number.isFinite(expected) || expected <= 0) return true;
  try {
    return (await response.clone().blob()).size === expected;
  } catch {
    return false;
  }
}

async function pruneOtherVersions(keep) {
  if (pruned.has(keep)) return;
  pruned.add(keep);
  for (const name of await caches.keys()) {
    if (name.startsWith(CACHE_PREFIX) && name !== keep) await caches.delete(name);
  }
}

async function cachedEngineFile(request, upload) {
  const name = `${CACHE_PREFIX}${upload}`;
  let cache = null;
  try {
    cache = await caches.open(name);
    void pruneOtherVersions(name);
    const hit = await cache.match(request.url);
    if (hit && (await intact(hit))) return hit;
    if (hit) {
      console.warn("[blox] cached engine file damaged, fetching it again:", request.url);
      await cache.delete(request.url);
    }
  } catch (error) {
    console.warn("[blox] engine cache unavailable:", error);
  }
  const response = await fetch(request.url, { credentials: "same-origin", cache: "no-cache" });
  if (cache && (await intact(response))) {
    // Stored in the background: the engine gets its bytes now.
    cache.put(request.url, response.clone()).catch((error) => console.warn("[blox] could not cache", request.url, error));
  }
  return response;
}

async function crossOrigin(request, clientId) {
  if (request.method === "GET" && FLAGS_URL.test(request.url)) {
    const pinned = await fetch(PINNED_FLAGS, { cache: "no-cache" }).catch(() => null);
    if (pinned?.ok) return reply(200, "", [["content-type", "application/json"]], withLocalFlags(await pinned.text()));
  }
  try {
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    const result = await relay(clientId, {
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body,
    });
    return reply(result.status, result.statusText, result.headers, result.body);
  } catch (error) {
    return reply(502, "Bad Gateway", [["content-type", "application/json"]], JSON.stringify({ error: String(error?.message || error) }));
  }
}

// Lets the page pick the renderer with ?renderer=webgl|webgpu (WasmPlayer.js
// only reads it with this flag on); host.js uses it to keep old Chrome off WebGPU.
function withLocalFlags(text) {
  try {
    const flags = JSON.parse(text);
    if (flags?.applicationSettings) flags.applicationSettings.FFlagWebClientRenderQueryParams = "True";
    return JSON.stringify(flags);
  } catch {
    return text;
  }
}

function reply(status, statusText, headers, body) {
  const out = new Headers(headers);
  // The page is cross-origin isolated (COEP require-corp): without this, any
  // no-cors load (an <img>) of a relayed response would be blocked.
  out.set("cross-origin-resource-policy", "cross-origin");
  // The engine fetches with credentials and reads headers such as
  // x-csrf-token, so answer as Roblox would to its own site.
  out.set("access-control-allow-origin", self.location.origin);
  out.set("access-control-allow-credentials", "true");
  const names = [...new Set([...out.keys()])].join(", ");
  if (names) out.set("access-control-expose-headers", names);
  return new Response(NULL_BODY.has(status) ? null : body, { status, statusText, headers: out });
}

// A page of ours in this scope. Requests from the engine's workers carry the
// worker's client id, so fall back to any window.
async function relayPage(clientId) {
  const own = clientId ? await self.clients.get(clientId) : null;
  if (own?.type === "window") return own;
  const pages = await self.clients.matchAll({ type: "window" });
  const page = pages.find((client) => client.frameType === "top-level") ?? pages[0];
  if (!page) throw new Error("no page to relay through");
  return page;
}

async function relay(clientId, message) {
  const page = await relayPage(clientId);
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error("relay timed out"));
    }, RELAY_TIMEOUT_MS);
    channel.port1.onmessage = ({ data }) => {
      clearTimeout(timer);
      channel.port1.close();
      if (data.ok) resolve(data);
      else reject(new Error(data.error));
    };
    const transfer = message.body ? [channel.port2, message.body] : [channel.port2];
    page.postMessage({ type: "blox-fetch", ...message }, transfer);
  });
}
