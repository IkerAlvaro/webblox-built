// Brotli and gzip copies of the proxy page's big static files, which
// server/static.ts sends to browsers that accept them. Run by build:proxy.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const files = [
  "proxy/scramjet/scramjet.js",
  "proxy/scramjet/scramjet.wasm",
  "proxy/controller/controller.api.js",
  "proxy/controller/controller.inject.js",
  "proxy/controller/controller.sw.js",
  "proxy/launch-plugin.mjs",
  "node_modules/@mercuryworkshop/epoxy-transport/dist/index.js",
  "node_modules/@mercuryworkshop/epoxy-transport/dist/index.mjs",
];

let before = 0;
let after = 0;
for (const file of files) {
  const path = resolve(root, file);
  const data = await readFile(path);
  const br = brotliCompressSync(data, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
  });
  await writeFile(`${path}.br`, br);
  await writeFile(`${path}.gz`, gzipSync(data, { level: 9 }));
  before += data.length;
  after += br.length;
}
console.log(`Precompressed ${files.length} files: ${(before / 1e6).toFixed(2)} MB → ${(after / 1e6).toFixed(2)} MB with brotli.`);
