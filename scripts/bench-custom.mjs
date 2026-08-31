#!/usr/bin/env node
/**
 * Runs the official 15-prompt MineBench cohort against a CUSTOM GATEWAY model.
 *
 * The bundled `pnpm batch:generate` only accepts catalog ModelKeys (it resolves
 * via MODEL_CATALOG.find), so it cannot drive a custom endpoint. This script
 * fills that gap: same prompt cohort, but routed through customGatewayMode.
 *
 * Needs no database and no Next.js server — it calls generateVoxelBuild()
 * directly against the compiled output in .btest/.
 *
 * Setup:
 *   sh tests/custom-gateway/build.sh        # compile lib/ai to .btest/
 *
 * Usage:
 *   node scripts/bench-custom.mjs                          # all 15 prompts
 *   node scripts/bench-custom.mjs --prompt castle knight    # subset
 *   node scripts/bench-custom.mjs --grid 256 --reasoning high
 *   node scripts/bench-custom.mjs --resume                  # skip finished ones
 *   node scripts/bench-custom.mjs --html                    # also export viewers
 *
 * Output: .bench-out/<run>/  (build JSON, per-prompt log, report.md, summary.json)
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "..");
const BUILD = path.join(ROOT, ".btest");

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function flagValues(name) {
  const i = argv.indexOf(name);
  if (i < 0) return [];
  const out = [];
  for (let k = i + 1; k < argv.length && !argv[k].startsWith("--"); k++) out.push(argv[k]);
  return out;
}
function flagValue(name, dflt) {
  const v = flagValues(name);
  return v.length ? v[0] : dflt;
}
const has = (name) => argv.includes(name);

const GRID = Number.parseInt(flagValue("--grid", "64"), 10);
if (![64, 256, 512].includes(GRID)) {
  console.error("--grid must be 64, 256 or 512");
  process.exit(1);
}
const PALETTE = flagValue("--palette", "simple");
const REASONING = flagValue("--reasoning", "");
const ATTEMPTS = Number.parseInt(flagValue("--attempts", "2"), 10);
const ONLY = flagValues("--prompt");
const RESUME = has("--resume");
const WANT_HTML = has("--html");
const WANT_GIF = has("--gif");
// Concurrency. Running prompts in parallel collapses total wall-clock time from
// sum(all prompts) to roughly max(slowest prompt), which matters a lot in
// sandboxes that reclaim long-running processes.
const CONCURRENCY = Math.max(1, Math.min(15, Number.parseInt(flagValue("--concurrency", "1"), 10)));
const GIF_FRAMES = Number.parseInt(flagValue("--gif-frames", "16"), 10);
const GIF_SIZE = Number.parseInt(flagValue("--gif-size", "400"), 10);
const OUT_DIR = path.join(ROOT, ".bench-out", flagValue("--name", `grid${GRID}`));

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------
for (const line of fs.existsSync(path.join(ROOT, ".env.local"))
  ? fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)
  : []) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i > 0 && !process.env[t.slice(0, i).trim()]) {
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}
const KEY = process.env.CUSTOM_API_KEY;
const BASE = process.env.CUSTOM_API_BASE_URL;
const MODEL_ID = process.env.CUSTOM_API_MODEL_ID || "ark-code-latest";
const DISPLAY = process.env.CUSTOM_API_DISPLAY_NAME || MODEL_ID;
const EFFORT = REASONING || process.env.CUSTOM_API_REASONING_EFFORT || "medium";

if (!KEY || !BASE) {
  console.error("Missing CUSTOM_API_KEY / CUSTOM_API_BASE_URL (set them in .env.local)");
  process.exit(1);
}
if (!fs.existsSync(path.join(BUILD, "ai/generateVoxelBuild.js"))) {
  console.error("Compiled output missing. Run:  sh tests/custom-gateway/build.sh");
  process.exit(1);
}

// map "@/lib/..." onto the compiled tree
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req.startsWith("@/lib/")) req = path.join(BUILD, req.slice("@/lib/".length));
  else if (req.startsWith("@/")) req = path.join(BUILD, req.slice(2));
  return origResolve.call(this, req, parent, ...rest);
};

const { generateVoxelBuild } = require(path.join(BUILD, "ai/generateVoxelBuild.js"));
const { BENCHMARK_PROMPT_MAP, BENCHMARK_PROMPT_COHORT_ID } =
  require(path.join(BUILD, "benchmark/prompts.js"));

// ---------------------------------------------------------------------------
// structural analysis (same measures as scripts/analyze-build.cjs)
// ---------------------------------------------------------------------------
function analyse(build) {
  const bl = build.blocks ?? [];
  if (bl.length === 0) return null;
  const solid = new Set(bl.map((b) => `${b.x},${b.y},${b.z}`));

  let touching = 0;
  for (const b of bl) {
    if (
      solid.has(`${b.x+1},${b.y},${b.z}`) || solid.has(`${b.x-1},${b.y},${b.z}`) ||
      solid.has(`${b.x},${b.y+1},${b.z}`) || solid.has(`${b.x},${b.y-1},${b.z}`) ||
      solid.has(`${b.x},${b.y},${b.z+1}`) || solid.has(`${b.x},${b.y},${b.z-1}`)
    ) touching++;
  }

  // largest connected component
  const seen = new Set();
  let best = 0, comps = 0;
  for (const start of solid) {
    if (seen.has(start)) continue;
    comps++;
    let size = 0;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop();
      size++;
      const [cx, cy, cz] = cur.split(",").map(Number);
      for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        const k = `${cx+dx},${cy+dy},${cz+dz}`;
        if (solid.has(k) && !seen.has(k)) { seen.add(k); stack.push(k); }
      }
    }
    if (size > best) best = size;
  }

  const xs = bl.map(b=>b.x), ys = bl.map(b=>b.y), zs = bl.map(b=>b.z);
  const span = (a) => Math.max(...a) - Math.min(...a) + 1;
  return {
    blocks: bl.length,
    types: new Set(bl.map(b=>b.type)).size,
    neighbourPct: +(touching / bl.length * 100).toFixed(1),
    components: comps,
    largestPct: +(best / bl.length * 100).toFixed(1),
    spanX: span(xs), spanY: span(ys), spanZ: span(zs),
    fillPct: +(bl.length / Math.pow(GRID, 3) * 100).toFixed(3),
  };
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
const slugs = ONLY.length ? ONLY : Object.keys(BENCHMARK_PROMPT_MAP);
for (const s of slugs) {
  if (!BENCHMARK_PROMPT_MAP[s]) {
    console.error(`Unknown prompt slug: ${s}`);
    console.error(`Available: ${Object.keys(BENCHMARK_PROMPT_MAP).join(", ")}`);
    process.exit(1);
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const summaryPath = path.join(OUT_DIR, "summary.json");
let results = [];
if (RESUME && fs.existsSync(summaryPath)) {
  try { results = JSON.parse(fs.readFileSync(summaryPath, "utf8")).results ?? []; } catch {}
}
const done = new Set(results.filter(r => r.ok).map(r => r.slug));

console.log(`MineBench custom-gateway run`);
console.log(`  cohort   : ${BENCHMARK_PROMPT_COHORT_ID}`);
console.log(`  model    : ${DISPLAY} (${MODEL_ID})`);
console.log(`  endpoint : ${BASE}`);
console.log(`  grid     : ${GRID}  palette: ${PALETTE}  reasoning: ${EFFORT}`);
console.log(`  prompts  : ${slugs.length}${done.size ? `  (resuming, ${done.size} done)` : ""}`);
console.log(`  output   : ${path.relative(ROOT, OUT_DIR)}\n`);

const t0 = Date.now();

// Persisting from multiple workers needs serialising, otherwise a concurrent
// write can truncate the checkpoint file.
let writing = null;
function persist() {
  const doWrite = () => {
    fs.writeFileSync(summaryPath, JSON.stringify({
      cohort: BENCHMARK_PROMPT_COHORT_ID,
      model: MODEL_ID, displayName: DISPLAY, endpoint: BASE,
      grid: GRID, palette: PALETTE, reasoning: EFFORT,
      concurrency: CONCURRENCY,
      generated: new Date().toISOString(),
      results,
    }, null, 2));
  };
  writing = writing ? writing.then(doWrite) : Promise.resolve().then(doWrite);
  return writing;
}

async function runOne(slug, position) {
  const promptText = BENCHMARK_PROMPT_MAP[slug];
  let contentChars = 0, reasoningChars = 0, usage = null;
  const traces = [];
  const started = Date.now();

  let r;
  try {
    r = await generateVoxelBuild({
      model: {
        key: `custom_${MODEL_ID}`,
        provider: "custom",
        modelId: MODEL_ID,
        displayName: DISPLAY,
        baseUrl: BASE,
        customGatewayMode: true,
        userAgent: process.env.CUSTOM_API_USER_AGENT || "claude-cli/2.1.179 (external, cli)",
      },
      prompt: promptText,
      gridSize: GRID,
      palette: PALETTE,
      maxAttempts: ATTEMPTS,
      enableTools: true,
      reasoning: EFFORT,
      allowServerKeys: true,
      providerKeys: { custom: KEY },
      returnExpandedBuild: true,
      onDelta: (d) => { contentChars += d.length; },
      onReasoningDelta: (d) => { reasoningChars += d.length; },
      onUsage: (u) => { usage = u; },
      onProviderTrace: (m) => traces.push(m),
      onRetry: (n, why) => traces.push(`retry ${n}: ${String(why).slice(0, 200)}`),
    });
  } catch (e) {
    r = { ok: false, error: e && e.message ? e.message : String(e) };
  }

  const wallMs = Date.now() - started;
  const rec = {
    slug, prompt: promptText, ok: !!r.ok, wallMs,
    contentChars, reasoningChars,
    usage: usage ? {
      prompt: usage.prompt_tokens, completion: usage.completion_tokens,
      reasoning: usage.completion_tokens_details?.reasoning_tokens,
      total: usage.total_tokens,
    } : null,
  };

  if (r.ok) {
    const stats = analyse(r.build);
    Object.assign(rec, {
      blockCount: r.blockCount,
      generationTimeMs: r.generationTimeMs,
      warnings: r.warnings?.length ?? 0,
      stats,
    });
    const f = path.join(OUT_DIR, `${slug}.json`);
    fs.writeFileSync(f, JSON.stringify(r.build));
    rec.file = path.basename(f);

    // Exports are spawned after the build lands, so a crash mid-export still
    // leaves the JSON on disk for a later --resume pass.
    if (WANT_HTML) {
      try {
        execFileSync("node", [
          path.join(ROOT, "scripts/export-html-viewer.mjs"),
          f, path.join(OUT_DIR, `${slug}.html`), promptText,
        ], { stdio: "ignore" });
        rec.html = `${slug}.html`;
      } catch { /* non-fatal */ }
    }
    if (WANT_GIF) {
      try {
        execFileSync("node", [
          path.join(ROOT, "scripts/export-gif.mjs"),
          f, path.join(OUT_DIR, `${slug}.gif`),
          String(GIF_FRAMES), String(GIF_SIZE),
        ], { stdio: "ignore" });
        rec.gif = `${slug}.gif`;
      } catch { /* non-fatal */ }
    }
    console.log(
      `[${position}] ${slug.padEnd(12)} OK  ${String(r.blockCount).padStart(8)} blocks  ` +
      `${String(stats.types).padStart(2)} types  conn ${String(stats.largestPct).padStart(5)}%  ` +
      `${(wallMs/1000).toFixed(0)}s`
    );
  } else {
    rec.error = r.error;
    console.log(`[${position}] ${slug.padEnd(12)} FAIL  ${String(r.error).slice(0, 80)}`);
  }

  fs.writeFileSync(path.join(OUT_DIR, `${slug}.log`), traces.join("\n"));
  results = results.filter(x => x.slug !== slug).concat(rec);
  await persist();
  return rec;
}

// Worker pool: pull from a shared queue so a slow prompt never blocks others.
const pending = slugs.filter(s => !done.has(s));
for (const s of slugs) {
  if (done.has(s)) console.log(`[skip] ${s} — already done`);
}
let cursor = 0;
async function worker() {
  while (cursor < pending.length) {
    const my = cursor++;
    await runOne(pending[my], `${my + 1}/${pending.length}`);
  }
}
if (pending.length) {
  console.log(`Running ${pending.length} prompt(s) with concurrency ${CONCURRENCY}...\n`);
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()),
  );
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const okRuns = results.filter(r => r.ok);
const totalMs = Date.now() - t0;
const sum = (f) => okRuns.reduce((a, r) => a + (f(r) ?? 0), 0);
const avg = (f) => okRuns.length ? sum(f) / okRuns.length : 0;
const med = (f) => {
  const a = okRuns.map(f).filter(v => typeof v === "number").sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
};

const lines = [];
lines.push(`# MineBench — ${DISPLAY}`);
lines.push("");
lines.push(`- Cohort: \`${BENCHMARK_PROMPT_COHORT_ID}\``);
lines.push(`- Model: \`${MODEL_ID}\` via \`${BASE}\``);
lines.push(`- Grid ${GRID}, palette ${PALETTE}, reasoning_effort ${EFFORT}, attempts ${ATTEMPTS}`);
lines.push(`- Concurrency: ${CONCURRENCY}`);
lines.push(`- Completed ${okRuns.length}/${results.length} prompts in ${(totalMs/60000).toFixed(1)} min`);
lines.push("");
lines.push(`## Aggregate`);
lines.push("");
lines.push(`| Metric | Value |`);
lines.push(`|---|---|`);
lines.push(`| Success rate | ${okRuns.length}/${results.length} (${(okRuns.length/Math.max(1,results.length)*100).toFixed(0)}%) |`);
lines.push(`| Total blocks | ${sum(r => r.blockCount).toLocaleString("en-US")} |`);
lines.push(`| Mean blocks | ${Math.round(avg(r => r.blockCount)).toLocaleString("en-US")} |`);
lines.push(`| Median blocks | ${Math.round(med(r => r.blockCount)).toLocaleString("en-US")} |`);
lines.push(`| Mean distinct types | ${avg(r => r.stats?.types).toFixed(1)} |`);
lines.push(`| Mean connectivity | ${avg(r => r.stats?.largestPct).toFixed(1)}% |`);
lines.push(`| Mean gen time | ${(avg(r => r.generationTimeMs)/1000).toFixed(1)}s |`);
lines.push(`| Total reasoning tokens | ${sum(r => r.usage?.reasoning).toLocaleString("en-US")} |`);
lines.push(`| Total tokens | ${sum(r => r.usage?.total).toLocaleString("en-US")} |`);
lines.push("");
lines.push(`## Per prompt`);
lines.push("");
lines.push(`| Prompt | Blocks | Types | Conn% | Comps | Span (x/y/z) | Warn | Gen s | Tokens |`);
lines.push(`|---|---:|---:|---:|---:|---|---:|---:|---:|`);
for (const r of results) {
  if (!r.ok) {
    lines.push(`| **${r.slug}** | FAIL | — | — | — | — | — | ${(r.wallMs/1000).toFixed(0)} | — |`);
    continue;
  }
  const s = r.stats ?? {};
  const links = [
    r.html ? `[3D](${r.html})` : null,
    r.gif ? `[GIF](${r.gif})` : null,
  ].filter(Boolean).join(" ");
  lines.push(
    `| ${r.slug}${links ? ` ${links}` : ""} ` +
    `| ${r.blockCount.toLocaleString("en-US")} | ${s.types} | ${s.largestPct} | ${s.components} ` +
    `| ${s.spanX}/${s.spanY}/${s.spanZ} | ${r.warnings} ` +
    `| ${(r.generationTimeMs/1000).toFixed(0)} | ${(r.usage?.total ?? 0).toLocaleString("en-US")} |`
  );
}
const failed = results.filter(r => !r.ok);
if (failed.length) {
  lines.push("");
  lines.push(`## Failures`);
  lines.push("");
  for (const r of failed) lines.push(`- **${r.slug}**: ${r.error}`);
}
lines.push("");
lines.push(`> Connectivity = share of blocks in the largest 6-connected component.`);
lines.push(`> A high value means one coherent structure rather than scattered fragments.`);
lines.push("");

const reportPath = path.join(OUT_DIR, "report.md");
fs.writeFileSync(reportPath, lines.join("\n"));

console.log(`\n${"─".repeat(58)}`);
console.log(`Done: ${okRuns.length}/${results.length} ok in ${(totalMs/60000).toFixed(1)} min`);
if (okRuns.length) {
  console.log(`Mean: ${Math.round(avg(r=>r.blockCount)).toLocaleString("en-US")} blocks, ` +
              `${avg(r=>r.stats?.types).toFixed(1)} types, ` +
              `${avg(r=>r.stats?.largestPct).toFixed(1)}% connectivity`);
  console.log(`Tokens: ${sum(r=>r.usage?.total).toLocaleString("en-US")} total ` +
              `(${sum(r=>r.usage?.reasoning).toLocaleString("en-US")} reasoning)`);
}
console.log(`Report: ${path.relative(ROOT, reportPath)}`);
