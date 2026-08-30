// Builds a fully self-contained HTML viewer for a voxel build.
//
// The output has no external dependencies: block data is embedded as base64 and
// the WebGL renderer is inlined, so the file can be opened by double-clicking or
// shared as a single attachment.
//
// Shared by the web UI (components/sandbox) and the CLI
// (scripts/export-html-viewer.mjs) so both stay in sync.

import BLOCK_COLORS from "@/lib/blocks/block-colors.generated.json";
import type { VoxelBuild } from "@/lib/voxel/types";

type Rgb = [number, number, number];
type ColorEntry = { top: Rgb; side: Rgb };

const COLORS = BLOCK_COLORS as unknown as Record<string, ColorEntry>;

function hashColor(type: string): Rgb {
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
  return [120 + (h % 90), 110 + ((h >> 8) % 90), 110 + ((h >> 16) % 90)];
}

export function blockTopColor(type: string): Rgb {
  return COLORS[type]?.top ?? hashColor(type);
}

export function blockSideColor(type: string): Rgb {
  return COLORS[type]?.side ?? blockTopColor(type);
}

/** Expands boxes/lines into blocks and dedupes by cell (last write wins). */
export function expandBuildToBlocks(build: VoxelBuild): { x: number; y: number; z: number; type: string }[] {
  const cells = new Map<string, { x: number; y: number; z: number; type: string }>();
  const put = (x: number, y: number, z: number, type: string) => {
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
    const steps =
      Math.max(
        Math.abs(l.to.x - l.from.x),
        Math.abs(l.to.y - l.from.y),
        Math.abs(l.to.z - l.from.z),
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

  return [...cells.values()];
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as number[]);
  }
  if (typeof btoa === "function") return btoa(bin);
  // Node fallback (CLI path)
  return Buffer.from(bytes).toString("base64");
}

export type HtmlViewerPayload = {
  dataB64: string;
  palette: (string | number)[][];
  meta: {
    blockCount: number;
    typeCount: number;
    wide: boolean;
    prompt: string;
    generated: string;
    model?: string;
  };
};

/** Encodes a build into the payload embedded by the HTML template. */
export function buildViewerPayload(args: {
  build: VoxelBuild;
  prompt?: string;
  model?: string;
}): HtmlViewerPayload {
  const blocks = expandBuildToBlocks(args.build);
  if (blocks.length === 0) throw new Error("Build has no blocks to export");

  let maxCoord = 0;
  for (const b of blocks) maxCoord = Math.max(maxCoord, b.x, b.y, b.z);
  const wide = maxCoord > 255;
  const bytesPerCoord = wide ? 2 : 1;

  const typeList = [...new Set(blocks.map((b) => b.type))];
  if (typeList.length > 255) throw new Error(`Too many distinct block types (${typeList.length})`);
  const typeIndex = new Map(typeList.map((t, i) => [t, i]));

  const stride = bytesPerCoord * 3 + 1;
  const bytes = new Uint8Array(blocks.length * stride);
  const dv = new DataView(bytes.buffer);
  let o = 0;
  for (const b of blocks) {
    if (wide) {
      dv.setUint16(o, b.x, true);
      dv.setUint16(o + 2, b.y, true);
      dv.setUint16(o + 4, b.z, true);
      bytes[o + 6] = typeIndex.get(b.type)!;
    } else {
      bytes[o] = b.x; bytes[o + 1] = b.y; bytes[o + 2] = b.z;
      bytes[o + 3] = typeIndex.get(b.type)!;
    }
    o += stride;
  }

  const palette = typeList.map((t) => {
    const top = blockTopColor(t);
    const side = blockSideColor(t);
    return [t, top[0], top[1], top[2], side[0], side[1], side[2]];
  });

  return {
    dataB64: bytesToBase64(bytes),
    palette,
    meta: {
      blockCount: blocks.length,
      typeCount: typeList.length,
      wide,
      prompt: args.prompt ?? "",
      generated: new Date().toISOString().slice(0, 19).replace("T", " "),
      ...(args.model ? { model: args.model } : {}),
    },
  };
}

/** Injects the payload into the viewer template. */
export function renderViewerHtml(template: string, payload: HtmlViewerPayload): string {
  const title = (payload.meta.prompt || "MineBench build").replace(/[<>&"]/g, "");
  return template
    .replace("__BLOCK_DATA__", payload.dataB64)
    .replace("__PALETTE__", JSON.stringify(payload.palette))
    .replace("__META__", JSON.stringify(payload.meta))
    .replace(/__TITLE__/g, title);
}
