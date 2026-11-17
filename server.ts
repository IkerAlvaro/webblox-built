// Standalone webblox: /blox/ (host page + engine, cross-origin isolated) and a
// Wisp server at /wisp/ that only reaches Roblox. Run with Bun after
// `bun run fetch:webblox`; to embed in your own server instead, mount
// createBloxHandler (server/blox.ts) the same way.
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { Readable } from "node:stream";
import { logging, server as wisp } from "@mercuryworkshop/wisp-js/server";
import { BLOX_PREFIX, createBloxHandler } from "./server/blox";

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "127.0.0.1";

const ROOT_FILES: Record<string, string> = {
  "/": "proxy/index.html",
  "/index.html": "proxy/index.html",
  "/sw.js": "proxy/sw.js",
  "/scramjet/scramjet.js": "proxy/scramjet/scramjet.js",
  "/scramjet/scramjet.wasm": "proxy/scramjet/scramjet.wasm",
  "/controller/controller.api.js": "proxy/controller/controller.api.js",
  "/controller/controller.inject.js": "proxy/controller/controller.inject.js",
  "/controller/controller.sw.js": "proxy/controller/controller.sw.js",
  "/epoxy/index.js": "node_modules/@mercuryworkshop/epoxy-transport/dist/index.js",
  "/launch-plugin.mjs": "proxy/launch-plugin.mjs",
  "/licenses/AGPL-3.0-Scramjet.txt": "licenses/AGPL-3.0-Scramjet.txt",
};

const ROOT_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

// The page's epoxy client opens TLS to Roblox through this; nothing else is
// reachable, so the server is not an open proxy.
wisp.options.hostname_whitelist = [
  /(^|\.)(roblox\.com|rbxcdn\.com|robloxlabs\.com|arkoselabs\.com|funcaptcha\.com|px-cloud\.net)$/i,
];
wisp.options.port_whitelist = [443];
logging.set_level(logging.WARN);

const handleBlox = createBloxHandler({
  host: resolve(import.meta.dir, "webblox"),
  engine: resolve(import.meta.dir, "vendor", "webblox", "engine"),
  epoxy: Bun.resolveSync("@mercuryworkshop/epoxy-transport", import.meta.dir),
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const rootFile = ROOT_FILES[url.pathname];
  let response: Response;
  if (url.pathname === "/healthz") {
    response = new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  } else if (url.pathname === BLOX_PREFIX.slice(0, -1)) {
    response = new Response(null, { status: 308, headers: { location: `${BLOX_PREFIX}${url.search}` } });
  } else if (url.pathname.startsWith(BLOX_PREFIX)) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    response = await handleBlox(new Request(url, { method: req.method, headers, signal: abort.signal }), url.pathname);
  } else if (rootFile !== undefined && (req.method === "GET" || req.method === "HEAD")) {
    const path = resolve(import.meta.dir, rootFile);
    const file = Bun.file(path);
    response = (await file.exists())
      ? new Response(req.method === "HEAD" ? null : file, {
          headers: {
            "content-type": ROOT_MIME[extname(path).toLowerCase()] ?? file.type ?? "application/octet-stream",
            "cache-control": "no-cache",
            "x-content-type-options": "nosniff",
            "referrer-policy": "strict-origin-when-cross-origin",
          },
        })
      : new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  } else {
    response = new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) Readable.fromWeb(response.body as never).pipe(res);
  else res.end();
});

server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/wisp/")) wisp.routeRequest(req, socket, head);
  else socket.destroy();
});

server.listen(PORT, HOST, () => console.log(`[webblox] http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/blox/`));
