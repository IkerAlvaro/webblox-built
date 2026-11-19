import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { serveStatic } from "./static";

const root = mkdtempSync(join(tmpdir(), "static-"));
const script = "console.log('scramjet');".repeat(40);
const path = join(root, "scramjet.js");
writeFileSync(path, script);
writeFileSync(`${path}.br`, brotliCompressSync(script));
writeFileSync(`${path}.gz`, gzipSync(script));
writeFileSync(join(root, "plain.wasm"), new Uint8Array([0, 97, 115, 109]));

afterAll(() => rmSync(root, { recursive: true, force: true }));

const get = (file: string, headers: HeadersInit = {}, method = "GET") =>
  serveStatic(new Request("http://proxy.test/x", { method, headers }), join(root, file));

describe("serveStatic", () => {
  test("lets the browser revalidate instead of downloading again", async () => {
    const first = (await get("scramjet.js"))!;
    const modified = first.headers.get("last-modified");
    expect(first.headers.get("cache-control")).toBe("no-cache");
    expect(modified).not.toBeNull();
    const again = (await get("scramjet.js", { "if-modified-since": modified! }))!;
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  test("sends the smallest copy the browser accepts", async () => {
    const br = (await get("scramjet.js", { "accept-encoding": "gzip, br" }))!;
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("vary")).toBe("Accept-Encoding");
    expect(br.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect((await get("scramjet.js", { "accept-encoding": "gzip" }))!.headers.get("content-encoding")).toBe("gzip");
    const plain = (await get("scramjet.js"))!;
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.text()).toBe(script);
  });

  test("answers HEAD without a body and a missing file with null", async () => {
    const head = (await get("plain.wasm", {}, "HEAD"))!;
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("application/wasm");
    expect(await head.text()).toBe("");
    expect(await get("missing.js")).toBeNull();
  });
});
