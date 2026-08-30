import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { buildViewerPayload, renderViewerHtml } from "@/lib/voxel/export/htmlViewer";
import type { VoxelBuild } from "@/lib/voxel/types";

export const runtime = "nodejs";

// Keep the request bounded: a 512^3 build can legitimately be large, but the
// expanded payload is what actually lands in the file.
const MAX_BODY_BLOCKS = 4_000_000;

const pointSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
});

const buildSchema = z.object({
  version: z.literal("1.0"),
  blocks: z
    .array(
      z.object({
        x: z.number().int(),
        y: z.number().int(),
        z: z.number().int(),
        type: z.string().min(1).max(120),
      }),
    )
    .max(MAX_BODY_BLOCKS),
  boxes: z
    .array(
      z.object({
        x1: z.number().int(), y1: z.number().int(), z1: z.number().int(),
        x2: z.number().int(), y2: z.number().int(), z2: z.number().int(),
        type: z.string().min(1).max(120),
      }),
    )
    .max(200_000)
    .optional(),
  lines: z
    .array(
      z.object({
        from: pointSchema,
        to: pointSchema,
        type: z.string().min(1).max(120),
      }),
    )
    .max(200_000)
    .optional(),
});

const reqSchema = z.object({
  build: buildSchema,
  prompt: z.string().max(800).optional(),
  model: z.string().max(200).optional(),
});

let templateCache: string | null = null;
async function loadTemplate(): Promise<string> {
  if (templateCache) return templateCache;
  const file = path.join(process.cwd(), "scripts", "viewer-template.html");
  templateCache = await fs.readFile(file, "utf8");
  return templateCache;
}

export async function POST(req: Request) {
  const json = (await req.json().catch(() => null)) as unknown;
  const parsed = reqSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  try {
    const template = await loadTemplate();
    const payload = buildViewerPayload({
      build: parsed.data.build as VoxelBuild,
      prompt: parsed.data.prompt,
      model: parsed.data.model,
    });
    const html = renderViewerHtml(template, payload);

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Block-Count": String(payload.meta.blockCount),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build HTML viewer";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
