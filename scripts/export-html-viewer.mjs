#!/usr/bin/env node
/**
 * Exports a VoxelBuild as a SINGLE self-contained HTML file.
 *
 * The result needs no server, no network, and no dependencies: block data is
 * embedded as base64 and rendered by an inline WebGL renderer with orbit
 * controls. Open it by double-clicking, or send it to someone as one file.
 *
 * Colours come from lib/blocks/block-colors.generated.json (sampled from the
 * real texture atlas) — run scripts/build-block-colors.mjs to regenerate.
 *
 * Usage:
 *   node scripts/export-html-viewer.mjs <build.json> <out.html> ["prompt text"]
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const inFile = process.argv[2] || ".probe-out/integration-build.json";
const outFile = process.argv[3] || ".probe-out/viewer.html";
const promptText = process.argv[4] || "";

// ---------------------------------------------------------------------------
// Colours sampled from the real texture atlas.
// ---------------------------------------------------------------------------
let COLORS = {};
try {
  COLORS = JSON.parse(
    fs.readFileSync(path.join(ROOT, "lib/blocks/block-colors.generated.json"), "utf8"),
  );
} catch {
  console.warn("! block-colors.generated.json missing — run scripts/build-block-colors.mjs");
}
function hashColor(type) {
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
  return [120 + (h % 90), 110 + ((h >> 8) % 90), 110 + ((h >> 16) % 90)];
}
const topColor = (t) => (COLORS[t] ? COLORS[t].top : hashColor(t));
const sideColor = (t) => (COLORS[t] ? COLORS[t].side : topColor(t));

// ---------------------------------------------------------------------------
// Load + expand build (boxes/lines -> blocks) so any spec form works.
// ---------------------------------------------------------------------------
const build = JSON.parse(fs.readFileSync(inFile, "utf8"));
const cells = new Map();
const put = (x, y, z, type) => {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  const xi = Math.round(x), yi = Math.round(y), zi = Math.round(z);
  if (xi < 0 || yi < 0 || zi < 0) return;
  cells.set(`${xi},${yi},${zi}`, { x: xi, y: yi, z: zi, type: String(type) });
};
for (const b of build.boxes ?? []) {
  const ax = Math.min(b.x1, b.x2), bx = Math.max(b.x1, b.x2);
  const ay = Math.min(b.y1, b.y2), by = Math.max(b.y1, b.y2);
  const az = Math.min(b.z1, b.z2), bz = Math.max(b.z1, b.z2);
  for (let x = ax; x <= bx; x++)
    for (let y = ay; y <= by; y++)
      for (let z = az; z <= bz; z++) put(x, y, z, b.type);
}
for (const l of build.lines ?? []) {
  const steps = Math.max(
    Math.abs(l.to.x - l.from.x), Math.abs(l.to.y - l.from.y), Math.abs(l.to.z - l.from.z),
  ) || 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    put(
      l.from.x + (l.to.x - l.from.x) * t,
      l.from.y + (l.to.y - l.from.y) * t,
      l.from.z + (l.to.z - l.from.z) * t,
      l.type,
    );
  }
}
for (const b of build.blocks ?? []) put(b.x, b.y, b.z, b.type);

const blocks = [...cells.values()];
if (blocks.length === 0) {
  console.error("no blocks to export");
  process.exit(1);
}

let maxCoord = 0;
for (const b of blocks) maxCoord = Math.max(maxCoord, b.x, b.y, b.z);
const wide = maxCoord > 255;
const bytesPerCoord = wide ? 2 : 1;

const typeList = [...new Set(blocks.map((b) => b.type))];
const typeIndex = new Map(typeList.map((t, i) => [t, i]));
if (typeList.length > 255) {
  console.error(`too many distinct types (${typeList.length})`);
  process.exit(1);
}

const stride = bytesPerCoord * 3 + 1;
const buf = Buffer.alloc(blocks.length * stride);
let o = 0;
for (const b of blocks) {
  if (wide) {
    buf.writeUInt16LE(b.x, o); buf.writeUInt16LE(b.y, o + 2); buf.writeUInt16LE(b.z, o + 4);
    buf[o + 6] = typeIndex.get(b.type);
  } else {
    buf[o] = b.x; buf[o + 1] = b.y; buf[o + 2] = b.z; buf[o + 3] = typeIndex.get(b.type);
  }
  o += stride;
}

const palette = typeList.map((t) => {
  const a = topColor(t), b = sideColor(t);
  return [t, a[0], a[1], a[2], b[0], b[1], b[2]];
});

const meta = {
  blockCount: blocks.length,
  typeCount: typeList.length,
  wide,
  prompt: promptText,
  generated: new Date().toISOString().slice(0, 19).replace("T", " "),
  source: path.basename(inFile),
};

console.log(`blocks: ${blocks.length}  types: ${typeList.length}  wide:${wide}`);
console.log(`payload: ${(buf.length / 1024).toFixed(1)} KB raw`);

const tpl = fs.readFileSync(path.join(ROOT, "scripts/viewer-template.html"), "utf8");
const html = tpl
  .replace("__BLOCK_DATA__", buf.toString("base64"))
  .replace("__PALETTE__", JSON.stringify(palette))
  .replace("__META__", JSON.stringify(meta))
  .replace(/__TITLE__/g, (meta.prompt || "MineBench build").replace(/[<>&"]/g, ""));

fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`wrote ${outFile} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
