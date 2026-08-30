#!/usr/bin/env node
/**
 * Derives per-block average colours by sampling the real texture atlas, so the
 * standalone HTML viewer matches in-app rendering instead of relying on a
 * hand-written palette.
 *
 * Writes lib/blocks/block-colors.generated.json:
 *   { "<blockId>": { "top": [r,g,b], "side": [r,g,b] }, ... }
 *
 * Usage: node scripts/build-block-colors.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const ATLAS_PNG = path.join(ROOT, "public/textures/atlas.png");
const ATLAS_MAP = path.join(ROOT, "lib/blocks/atlas-map.json");
const PALETTES = path.join(ROOT, "lib/blocks/palettes.json");
const OUT = path.join(ROOT, "lib/blocks/block-colors.generated.json");

// --- minimal PNG decoder (RGBA8 / RGB8, non-interlaced) --------------------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  let pos = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  let palette = null, trns = null;

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced png unsupported");
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      trns = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} unsupported`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 1;
  const stride = w * channels;
  const out = Buffer.alloc(w * h * 4);

  let prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = Buffer.from(raw.subarray(rp, rp + stride));
    rp += stride;
    // undo filters
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 255;
    }
    prev = line;
    // expand to RGBA
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (colorType === 6) {
        out[o] = line[x*4]; out[o+1] = line[x*4+1]; out[o+2] = line[x*4+2]; out[o+3] = line[x*4+3];
      } else if (colorType === 2) {
        out[o] = line[x*3]; out[o+1] = line[x*3+1]; out[o+2] = line[x*3+2]; out[o+3] = 255;
      } else if (colorType === 3 && palette) {
        const pi = line[x] * 3;
        out[o] = palette[pi]; out[o+1] = palette[pi+1]; out[o+2] = palette[pi+2];
        out[o+3] = trns && line[x] < trns.length ? trns[line[x]] : 255;
      } else if (colorType === 0) {
        out[o] = out[o+1] = out[o+2] = line[x]; out[o+3] = 255;
      } else if (colorType === 4) {
        out[o] = out[o+1] = out[o+2] = line[x*2]; out[o+3] = line[x*2+1];
      }
    }
  }
  return { width: w, height: h, data: out };
}

// --- average an atlas tile, ignoring transparent pixels -------------------
function averageTile(img, tile) {
  let r = 0, g = 0, b = 0, n = 0;
  const x0 = tile.x, y0 = tile.y, x1 = tile.x + tile.w, y1 = tile.y + tile.h;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const o = (y * img.width + x) * 4;
      const a = img.data[o + 3];
      if (a < 24) continue;              // skip fully/near transparent
      const wgt = a / 255;
      r += img.data[o] * wgt;
      g += img.data[o + 1] * wgt;
      b += img.data[o + 2] * wgt;
      n += wgt;
    }
  }
  if (n === 0) return null;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

// --- texture key resolution (mirrors lib/blocks/textures.ts) ---------------
const ALIASES = { water: "water_still", lava: "lava_still" };
function resolveKey(keys, blockId, face) {
  if (blockId === "grass_block") {
    if (face === "up") return "grass_block_top";
    return "grass_block_side";
  }
  const base = ALIASES[blockId] ?? blockId;
  const cands = face === "up"
    ? [`${base}_top`, `${base}_side`, base]
    : [`${base}_side`, base, `${base}_top`];
  for (const c of cands) if (keys[c]) return c;
  return null;
}

// Textures that ship as greyscale masks and are tinted at runtime by the game
// (biome/foliage/water colours). Averaging them raw yields grey, so the
// canonical tint is applied on top of the sampled luminance.
const RUNTIME_TINTS = {
  grass_block:      [124, 189, 107],
  grass:            [124, 189, 107],
  tall_grass:       [124, 189, 107],
  fern:             [124, 189, 107],
  large_fern:       [124, 189, 107],
  oak_leaves:       [ 96, 161,  74],
  birch_leaves:     [128, 167,  85],
  spruce_leaves:    [ 97, 153,  97],
  jungle_leaves:    [ 84, 168,  56],
  acacia_leaves:    [110, 174,  70],
  dark_oak_leaves:  [ 90, 150,  62],
  mangrove_leaves:  [ 92, 163,  74],
  azalea_leaves:    [124, 189, 107],
  vine:             [ 96, 161,  74],
  water:            [ 63, 118, 228],
  water_still:      [ 63, 118, 228],
  bubble_column:    [ 63, 118, 228],
  lily_pad:         [ 96, 161,  74],
  sugar_cane:       [124, 189, 107],
};

function applyTint(rgb, tint) {
  // Treat the sampled value as luminance and modulate the tint by it.
  const lum = (rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114) / 255;
  // Normalise so mid-grey masks land on the tint itself rather than darkening it.
  const k = Math.min(1.35, Math.max(0.55, lum / 0.62));
  return [
    Math.min(255, Math.round(tint[0] * k)),
    Math.min(255, Math.round(tint[1] * k)),
    Math.min(255, Math.round(tint[2] * k)),
  ];
}

function isDesaturated(rgb) {
  const mx = Math.max(rgb[0], rgb[1], rgb[2]);
  const mn = Math.min(rgb[0], rgb[1], rgb[2]);
  return mx - mn < 26;
}

// --- run ------------------------------------------------------------------
const atlasMap = JSON.parse(fs.readFileSync(ATLAS_MAP, "utf8"));
const palettesRaw = JSON.parse(fs.readFileSync(PALETTES, "utf8"));
const img = decodePng(fs.readFileSync(ATLAS_PNG));
console.log(`atlas: ${img.width}x${img.height}`);

const allBlocks = [...palettesRaw.simple, ...palettesRaw.advanced];
console.log(`palette blocks: ${allBlocks.length}`);

const result = {};
let ok = 0, miss = 0, tinted = 0;
for (const def of allBlocks) {
  const topKey = resolveKey(atlasMap.keys, def.id, "up");
  const sideKey = resolveKey(atlasMap.keys, def.id, "side");
  let top = topKey ? averageTile(img, atlasMap.keys[topKey]) : null;
  let side = sideKey ? averageTile(img, atlasMap.keys[sideKey]) : null;
  if (!top && !side) {
    miss++;
    console.log(`  miss: ${def.id}`);
    continue;
  }
  top = top ?? side;
  side = side ?? top;

  const tint = RUNTIME_TINTS[def.id];
  if (tint) {
    // grass_block keeps its (already coloured) dirt side in most packs
    const tintTop = isDesaturated(top);
    const tintSide = isDesaturated(side);
    if (tintTop) top = applyTint(top, tint);
    if (tintSide) side = applyTint(side, tint);
    if (tintTop || tintSide) {
      tinted++;
      console.log(`  tinted: ${def.id} -> top ${JSON.stringify(top)}`);
    }
  }

  result[def.id] = { top, side };
  ok++;
}

fs.writeFileSync(OUT, JSON.stringify(result, null, 0));
console.log(`resolved: ${ok}  tinted: ${tinted}  missing: ${miss}`);
console.log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
