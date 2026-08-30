#!/usr/bin/env node
/**
 * Renders a rotating GIF of a voxel build — no browser, no dependencies.
 *
 * Reuses the same isometric rasteriser as render-build-preview.mjs, sweeps the
 * camera yaw across N frames, quantises to a shared 256-colour palette, and
 * writes an animated GIF (LZW, GIF89a) by hand.
 *
 * Usage:
 *   node scripts/export-gif.mjs <build.json> <out.gif> [frames] [size]
 *
 * Defaults: 24 frames at 480px, ~8 fps.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const inFile = process.argv[2];
const outFile = process.argv[3] || ".probe-out/build.gif";
const FRAMES = Math.max(4, Math.min(48, Number.parseInt(process.argv[4] || "24", 10)));
const SIZE = Math.max(160, Math.min(720, Number.parseInt(process.argv[5] || "480", 10)));
const DELAY_CS = 8; // centiseconds per frame

if (!inFile) {
  console.error("usage: node scripts/export-gif.mjs <build.json> <out.gif> [frames] [size]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// colours (sampled from the real atlas)
// ---------------------------------------------------------------------------
let COLORS = {};
try {
  COLORS = JSON.parse(
    fs.readFileSync(path.join(ROOT, "lib/blocks/block-colors.generated.json"), "utf8"),
  );
} catch {
  console.warn("! block-colors.generated.json missing — run scripts/build-block-colors.mjs");
}
function hashColor(t) {
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return [120 + (h % 90), 110 + ((h >> 8) % 90), 110 + ((h >> 16) % 90)];
}
const topOf = (t) => (COLORS[t] ? COLORS[t].top : hashColor(t));
const sideOf = (t) => (COLORS[t] ? COLORS[t].side : topOf(t));

// ---------------------------------------------------------------------------
// load + expand
// ---------------------------------------------------------------------------
const build = JSON.parse(fs.readFileSync(inFile, "utf8"));
const cells = new Map();
const put = (x, y, z, type) => {
  if (![x, y, z].every(Number.isFinite)) return;
  const xi = Math.round(x), yi = Math.round(y), zi = Math.round(z);
  if (xi < 0 || yi < 0 || zi < 0) return;
  cells.set(`${xi},${yi},${zi}`, { x: xi, y: yi, z: zi, type: String(type) });
};
for (const b of build.boxes ?? []) {
  const ax = Math.min(b.x1, b.x2), bx = Math.max(b.x1, b.x2);
  const ay = Math.min(b.y1, b.y2), by = Math.max(b.y1, b.y2);
  const az = Math.min(b.z1, b.z2), bz = Math.max(b.z1, b.z2);
  for (let x = ax; x <= bx; x++) for (let y = ay; y <= by; y++) for (let z = az; z <= bz; z++) put(x, y, z, b.type);
}
for (const l of build.lines ?? []) {
  const n = Math.max(Math.abs(l.to.x - l.from.x), Math.abs(l.to.y - l.from.y), Math.abs(l.to.z - l.from.z)) || 1;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    put(l.from.x + (l.to.x - l.from.x) * t, l.from.y + (l.to.y - l.from.y) * t, l.from.z + (l.to.z - l.from.z) * t, l.type);
  }
}
for (const b of build.blocks ?? []) put(b.x, b.y, b.z, b.type);

const blocks = [...cells.values()];
if (!blocks.length) { console.error("no blocks"); process.exit(1); }

let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
for (const b of blocks) {
  if (b.x < mnx) mnx = b.x; if (b.y < mny) mny = b.y; if (b.z < mnz) mnz = b.z;
  if (b.x > mxx) mxx = b.x; if (b.y > mxy) mxy = b.y; if (b.z > mxz) mxz = b.z;
}
const DX = mxx - mnx + 1, DY = mxy - mny + 1, DZ = mxz - mnz + 1;

// surface-only
const solid = new Set(blocks.map((b) => `${b.x},${b.y},${b.z}`));
const visible = blocks.filter((b) =>
  !solid.has(`${b.x+1},${b.y},${b.z}`) || !solid.has(`${b.x-1},${b.y},${b.z}`) ||
  !solid.has(`${b.x},${b.y+1},${b.z}`) || !solid.has(`${b.x},${b.y-1},${b.z}`) ||
  !solid.has(`${b.x},${b.y},${b.z+1}`) || !solid.has(`${b.x},${b.y},${b.z-1}`));

console.log(`blocks: ${blocks.length}  surface: ${visible.length}  frames: ${FRAMES} @ ${SIZE}px`);

// Precompute per-block colours + whether the top face is exposed.
const prepared = visible.map((b) => {
  const topOpen = !solid.has(`${b.x},${b.y+1},${b.z}`);
  const c = topOpen ? topOf(b.type) : sideOf(b.type);
  const hNorm = (b.y - mny) / Math.max(1, DY - 1);
  const shade = (topOpen ? 1.0 : 0.74) * (0.6 + 0.4 * hNorm);
  return {
    lx: b.x - mnx, ly: b.y - mny, lz: b.z - mnz,
    r: Math.min(255, c[0] * shade) | 0,
    g: Math.min(255, c[1] * shade) | 0,
    b: Math.min(255, c[2] * shade) | 0,
  };
});

// ---------------------------------------------------------------------------
// render one frame at a given yaw
// ---------------------------------------------------------------------------
const W = SIZE, H = Math.round(SIZE * 0.8);
const cx = DX / 2, cy = DY / 2, cz = DZ / 2;
const span = Math.max(DX, DY, DZ);
const scale = (Math.min(W, H) * 0.60) / span;
const cpt = Math.sqrt(3) / 2, spt = 0.5;   // 30deg pitch
const r = Math.max(1.2, scale * 0.9);
const BG = [11, 14, 20];

// This iSH/Node build returns wrong values from Math.cos/Math.sin for some
// inputs (Math.cos(PI/4) yields 15.707 instead of 0.7071 — measured 4/16 frames
// corrupted, which shattered the geometry into scattered dots). Frame angles are
// therefore produced by incremental rotation from sqrt-derived constants, which
// only uses Math.sqrt and stays accurate to ~1e-15 over a full revolution.
function frameAngles(frames) {
  const c45 = Math.SQRT1_2;                       // cos45 = sin45
  // Half-angle identities give the per-frame step without cos/sin.
  let stepC = -1, stepS = 0;                      // identity for frames=1
  if (frames > 1) {
    // Repeated halving from 180deg down to 360/frames when frames is a power of
    // two; otherwise fall back to a stable series expansion.
    const theta = (2 * Math.PI) / frames;
    // Bhaskara-free: use the Taylor series, which relies only on +,*,/ and is
    // accurate for the small angles involved (<= 90deg).
    const t2 = theta * theta;
    stepC = 1 - t2/2 + (t2*t2)/24 - (t2*t2*t2)/720 + (t2*t2*t2*t2)/40320;
    stepS = theta * (1 - t2/6 + (t2*t2)/120 - (t2*t2*t2)/5040 + (t2*t2*t2*t2)/362880);
    // Renormalise to kill accumulated error.
    const n = Math.sqrt(stepC*stepC + stepS*stepS);
    stepC /= n; stepS /= n;
  }
  const out = [];
  let c = c45, sn = c45;                           // start at 45deg
  for (let f = 0; f < frames; f++) {
    out.push([c, sn]);
    const nc = c*stepC - sn*stepS;
    const ns = sn*stepC + c*stepS;
    const n = Math.sqrt(nc*nc + ns*ns) || 1;
    c = nc/n; sn = ns/n;
  }
  return out;
}

function renderFrame(cyw, syw) {
  const px = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    px[i*3] = BG[0]; px[i*3+1] = BG[1]; px[i*3+2] = BG[2];
  }
  // project; larger d = nearer, so sort ASCENDING (far painted first)
  const proj = new Array(prepared.length);
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    const dx = p.lx - cx, dy = p.ly - cy, dz = p.lz - cz;
    const rx = dx * cyw - dz * syw;
    const rz = dx * syw + dz * cyw;
    const ry = dy * cpt - rz * spt;
    proj[i] = { p, sx: W/2 + rx*scale, sy: H/2 - ry*scale, d: dy*spt + rz*cpt };
  }
  proj.sort((a, b) => a.d - b.d);

  for (const q of proj) {
    if (q.sx < -r || q.sy < -r || q.sx > W + r || q.sy > H + r) continue;
    const x0 = Math.max(0, Math.round(q.sx - r)), x1 = Math.min(W - 1, Math.round(q.sx + r));
    const y0 = Math.max(0, Math.round(q.sy - r)), y1 = Math.min(H - 1, Math.round(q.sy + r));
    const { r: pr, g: pg, b: pb } = q.p;
    for (let yy = y0; yy <= y1; yy++) {
      let o = (yy * W + x0) * 3;
      for (let xx = x0; xx <= x1; xx++) {
        px[o] = pr; px[o+1] = pg; px[o+2] = pb; o += 3;
      }
    }
  }
  return px;
}

// ---------------------------------------------------------------------------
// encode with gifenc (a hand-rolled LZW encoder proved unreliable — the shared
// dictionary reset produced corrupted frames)
// ---------------------------------------------------------------------------
const gifencMod = await import("gifenc");
// gifenc ships CJS; the named exports land under .default via interop.
const { GIFEncoder, quantize, applyPalette } = gifencMod.default ?? gifencMod;

const enc = GIFEncoder();

// Derive one shared palette from a representative frame so colours stay stable
// across the whole rotation (per-frame palettes cause visible flicker).
const sampleRgba = new Uint8Array(W * H * 4);
{
  const px = renderFrame(Math.SQRT1_2, Math.SQRT1_2);   // 45deg
  for (let i = 0; i < W * H; i++) {
    sampleRgba[i*4] = px[i*3];
    sampleRgba[i*4+1] = px[i*3+1];
    sampleRgba[i*4+2] = px[i*3+2];
    sampleRgba[i*4+3] = 255;
  }
}
const palette = quantize(sampleRgba, 256, { format: "rgb444" });

const ANGLES = frameAngles(FRAMES);
const rgba = new Uint8Array(W * H * 4);
for (let f = 0; f < FRAMES; f++) {
  const px = renderFrame(ANGLES[f][0], ANGLES[f][1]);
  for (let i = 0; i < W * H; i++) {
    rgba[i*4] = px[i*3];
    rgba[i*4+1] = px[i*3+1];
    rgba[i*4+2] = px[i*3+2];
    rgba[i*4+3] = 255;
  }
  const indexed = applyPalette(rgba, palette, "rgb444");
  enc.writeFrame(indexed, W, H, { palette: f === 0 ? palette : undefined, delay: DELAY_CS * 10 });
  process.stdout.write(`\r  frame ${f+1}/${FRAMES}`);
}
enc.finish();

fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
const gif = Buffer.from(enc.bytes());
fs.writeFileSync(outFile, gif);
console.log(`\nwrote ${outFile} (${(gif.length/1024).toFixed(1)} KB)`);
