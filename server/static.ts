// Static files for both the proxy page (server.ts) and /blox/ (server/blox.ts):
// revalidated on every load with Last-Modified, so an unchanged file costs a
// 304 instead of a download, and sent as the .br or .gz copy beside it when
// the browser accepts one (scripts/precompress.mjs and fetch-webblox.mjs make them).
import { extname } from "node:path";

export const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".otf": "font/otf",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

const ENCODINGS = [
  ["br", ".br"],
  ["gzip", ".gz"],
] as const;

// Codings the browser takes, leaving out any it refuses with q=0.
export function acceptedEncodings(header: string | null): Set<string> {
  const accepted = new Set<string>();
  for (const part of (header ?? "").split(",")) {
    const [name = "", ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (name && !(q && Number(q.slice(2)) === 0)) accepted.add(name.trim());
  }
  return accepted;
}

/** The file at `path` as a response, or null when there is no such file. */
export async function serveStatic(req: Request, path: string): Promise<Response | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const headers: Record<string, string> = {
    "content-type": MIME_TYPES[extname(path).toLowerCase()] || file.type || "application/octet-stream",
    "cache-control": "no-cache",
    "last-modified": new Date(file.lastModified).toUTCString(),
  };
  const since = Date.parse(req.headers.get("if-modified-since") ?? "");
  if (Number.isFinite(since) && Math.floor(file.lastModified / 1000) <= Math.floor(since / 1000)) {
    return new Response(null, { status: 304, headers });
  }
  let body: Blob = file;
  const accepted = acceptedEncodings(req.headers.get("accept-encoding"));
  for (const [encoding, suffix] of ENCODINGS) {
    if (!accepted.has(encoding)) continue;
    const compressed = Bun.file(`${path}${suffix}`);
    if (!(await compressed.exists())) continue;
    body = compressed;
    headers["content-encoding"] = encoding;
    headers.vary = "Accept-Encoding";
    break;
  }
  return new Response(req.method === "HEAD" ? null : body, { headers });
}
