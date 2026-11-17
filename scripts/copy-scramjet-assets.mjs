import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const assets = [
  ["node_modules/@mercuryworkshop/scramjet/dist/scramjet.js", "proxy/scramjet/scramjet.js"],
  ["node_modules/@mercuryworkshop/scramjet/dist/scramjet.wasm", "proxy/scramjet/scramjet.wasm"],
  ["node_modules/@mercuryworkshop/scramjet-controller/dist/controller.api.js", "proxy/controller/controller.api.js"],
  ["node_modules/@mercuryworkshop/scramjet-controller/dist/controller.inject.js", "proxy/controller/controller.inject.js"],
  ["node_modules/@mercuryworkshop/scramjet-controller/dist/controller.sw.js", "proxy/controller/controller.sw.js"],
];

for (const [source, target] of assets) {
  const destination = resolve(root, target);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(resolve(root, source), destination);
}

console.log("Copied the locked Scramjet runtime and controller assets.");
