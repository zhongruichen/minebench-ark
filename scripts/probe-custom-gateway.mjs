#!/usr/bin/env node
/**
 * Standalone end-to-end probe of the custom gateway contract.
 * Mirrors lib/ai/providers/customGateway.ts without needing the Next build,
 * so the request envelope can be validated before the app boots.
 *
 * Usage: node scripts/probe-custom-gateway.mjs "build a small stone tower"
 */
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");

function loadEnv() {
  const file = path.join(ROOT, ".env.local");
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

const env = { ...loadEnv(), ...process.env };
const KEY = env.CUSTOM_API_KEY;
const BASE = (env.CUSTOM_API_BASE_URL || "").replace(/\/+$/, "");
const MODEL = env.CUSTOM_API_MODEL_ID || "ark-code-latest";
const EFFORT = env.CUSTOM_API_REASONING_EFFORT || "medium";
const UA = env.CUSTOM_API_USER_AGENT || "Kelivo";

if (!KEY || !BASE) {
  console.error("Missing CUSTOM_API_KEY / CUSTOM_API_BASE_URL in .env.local");
  process.exit(1);
}

const url = new URL(BASE.endsWith("/chat/completions") ? BASE : `${BASE}/chat/completions`);
const promptText = process.argv[2] || "a small stone watchtower with a wooden roof";
const GRID = 64;

const system = `You are a voxel build generator for a Minecraft-style grid.

Return ONLY a single JSON object, no prose, no markdown fences:
{"tool":"voxel.exec","input":{"code":"<javascript>","gridSize":${GRID},"palette":"simple","seed":123}}

Inside "code" you may use ONLY these globals:
- block(x,y,z,type)
- box(x1,y1,z1,x2,y2,z2,type)
- line(x1,y1,z1,x2,y2,z2,type)
- rng()
- Math

Rules:
- Coordinates are integers within [0,${GRID - 1}]; Y is vertical, Y=0 is ground.
- Center the build near x=${Math.floor(GRID / 2)}, z=${Math.floor(GRID / 2)}.
- Produce at least 400 blocks.
- Allowed block types: stone, cobblestone, stone_bricks, oak_planks, oak_log, glass, glowstone, dirt, grass_block, water, bricks, iron_block, gold_block, white_wool, black_wool, gray_wool, brown_wool, blue_wool, oak_leaves.
- The "code" value must be a valid JSON string (escape newlines as \\n).`;

const body = {
  model: MODEL,
  messages: [
    { role: "system", content: system },
    { role: "user", content: `## Build Request\n${promptText}` },
  ],
  stream: true,
  max_tokens: 131072,
  thinking: { type: "enabled" },
  stream_options: { include_usage: true },
  ...(EFFORT && EFFORT !== "none" ? { reasoning_effort: EFFORT } : {}),
};

const payload = JSON.stringify(body);
console.log(`POST ${url.toString()}`);
console.log(`model=${MODEL} max_tokens=131072 thinking=enabled reasoning_effort=${EFFORT}\n`);

const req = https.request(
  {
    method: "POST",
    hostname: url.hostname,
    path: `${url.pathname}${url.search}`,
    port: 443,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-Conversation-Id": randomUUID(),
      "User-Agent": UA,
      "Content-Length": Buffer.byteLength(payload),
    },
  },
  (res) => {
    console.log(`HTTP ${res.statusCode}\n`);
    let buf = "";
    let content = "";
    let reasoning = "";
    let usage = null;

    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buf += chunk;
      const frames = buf.split(/\r?\n\r?\n/);
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let p;
          try {
            p = JSON.parse(data);
          } catch {
            continue;
          }
          if (p.usage) usage = p.usage;
          const d = p.choices?.[0]?.delta;
          if (!d) continue;
          if (typeof d.reasoning_content === "string" && d.reasoning_content) {
            reasoning += d.reasoning_content;
            process.stdout.write("\x1b[90m.\x1b[0m");
          }
          if (typeof d.content === "string" && d.content) {
            content += d.content;
            process.stdout.write("+");
          }
        }
      }
    });

    res.on("end", () => {
      console.log("\n\n=== STREAM COMPLETE ===");
      console.log(`reasoning_content chars: ${reasoning.length}`);
      console.log(`content chars:           ${content.length}`);
      if (usage) console.log(`usage: ${JSON.stringify(usage)}`);

      const outDir = path.join(ROOT, ".probe-out");
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "content.txt"), content);
      fs.writeFileSync(path.join(outDir, "reasoning.txt"), reasoning);

      // Tolerant extraction: strip fences, scan balanced top-level objects.
      const slices = [];
      let depth = 0, start = -1, inStr = false, esc = false;
      for (let i = 0; i < content.length; i++) {
        const c = content[i];
        if (inStr) {
          if (esc) { esc = false; continue; }
          if (c === "\\") { esc = true; continue; }
          if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === "{") { if (depth === 0) start = i; depth++; continue; }
        if (c === "}") {
          if (depth === 0) continue;
          depth--;
          if (depth === 0 && start >= 0) { slices.push(content.slice(start, i + 1)); start = -1; }
        }
      }
      console.log(`\ntop-level JSON candidates: ${slices.length}`);

      let call = null;
      for (const s of slices) {
        try {
          const o = JSON.parse(s);
          if (o && o.tool === "voxel.exec" && o.input?.code) { call = o; break; }
        } catch { /* keep scanning */ }
      }

      if (!call) {
        console.log("\n!! No voxel.exec tool call found.");
        console.log("--- content head ---");
        console.log(content.slice(0, 1500));
        process.exit(2);
      }

      console.log("\n=== TOOL CALL EXTRACTED ===");
      console.log(`gridSize=${call.input.gridSize} palette=${call.input.palette} seed=${call.input.seed}`);
      console.log(`code length: ${call.input.code.length} chars`);
      fs.writeFileSync(path.join(outDir, "code.js"), call.input.code);

      // Execute the emitted code with the same runtime surface as voxel.exec.
      const blocks = [];
      const boxes = [];
      const lines = [];
      const push = (x, y, z, type) => {
        if (![x, y, z].every((v) => Number.isFinite(v))) return;
        const xi = Math.round(x), yi = Math.round(y), zi = Math.round(z);
        if (xi < 0 || yi < 0 || zi < 0 || xi >= GRID || yi >= GRID || zi >= GRID) return;
        blocks.push({ x: xi, y: yi, z: zi, type: String(type) });
      };
      let seed = call.input.seed ?? 123;
      const rng = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };
      const api = {
        block: push,
        box: (x1, y1, z1, x2, y2, z2, type) => {
          boxes.push({ x1, y1, z1, x2, y2, z2, type: String(type) });
          const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)];
          const [ay, by] = [Math.min(y1, y2), Math.max(y1, y2)];
          const [az, bz] = [Math.min(z1, z2), Math.max(z1, z2)];
          for (let x = ax; x <= bx; x++)
            for (let y = ay; y <= by; y++)
              for (let z = az; z <= bz; z++) push(x, y, z, type);
        },
        line: (x1, y1, z1, x2, y2, z2, type) => {
          lines.push({ from: { x: x1, y: y1, z: z1 }, to: { x: x2, y: y2, z: z2 }, type: String(type) });
          const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), Math.abs(z2 - z1)) || 1;
          for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            push(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, z1 + (z2 - z1) * t, type);
          }
        },
        rng,
        Math,
      };

      try {
        const fn = new Function(
          "block", "box", "line", "rng", "Math",
          `"use strict";\n${call.input.code}`,
        );
        fn(api.block, api.box, api.line, api.rng, Math);
      } catch (e) {
        console.log(`\n!! Generated code threw: ${e.message}`);
        process.exit(3);
      }

      // Dedupe by cell, last write wins (same as validation).
      const cells = new Map();
      for (const b of blocks) cells.set(`${b.x},${b.y},${b.z}`, b);
      const finalBlocks = [...cells.values()];

      console.log("\n=== VOXEL EXEC RESULT ===");
      console.log(`raw placements:  ${blocks.length}`);
      console.log(`unique blocks:   ${finalBlocks.length}`);
      console.log(`boxes: ${boxes.length}  lines: ${lines.length}`);
      const types = [...new Set(finalBlocks.map((b) => b.type))];
      console.log(`distinct types:  ${types.length} -> ${types.slice(0, 12).join(", ")}`);
      if (finalBlocks.length) {
        const ex = (k) => finalBlocks.map((b) => b[k]);
        const xs = ex("x"), ys = ex("y"), zs = ex("z");
        console.log(
          `bounds: x[${Math.min(...xs)}..${Math.max(...xs)}] y[${Math.min(...ys)}..${Math.max(...ys)}] z[${Math.min(...zs)}..${Math.max(...zs)}]`,
        );
      }

      const build = { version: "1.0", boxes, lines, blocks: finalBlocks };
      const outFile = path.join(outDir, "build.json");
      fs.writeFileSync(outFile, JSON.stringify(build));
      console.log(`\nbuild written: ${outFile}`);
      console.log(finalBlocks.length >= 400 ? "\nPASS: full pipeline verified." : "\nWARN: block count below target.");
    });
  },
);

req.on("error", (e) => { console.error(`request error: ${e.message}`); process.exit(1); });
req.write(payload);
req.end();
