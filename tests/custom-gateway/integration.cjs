/**
 * Integration test: drives the REAL generateVoxelBuild() through the custom
 * gateway adapter, exercising prompt -> stream -> extract -> voxel.exec ->
 * validate. Uses the compiled output in .btest/.
 */
const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.join(__dirname, "..", "..");
const BUILD = path.join(ROOT, process.env.MB_BUILD_DIR || ".btest");

// Map "@/lib/..." to the compiled tree.
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith("@/lib/")) {
    request = path.join(BUILD, request.slice("@/lib/".length));
  } else if (request.startsWith("@/")) {
    request = path.join(BUILD, request.slice(2));
  }
  return origResolve.call(this, request, parent, ...rest);
};

// Load .env.local
for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i > 0) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const { generateVoxelBuild } = require(path.join(BUILD, "ai/generateVoxelBuild.js"));

const prompt = process.argv[2] || "a compact stone lighthouse on a rocky island with a glowstone beacon";

let deltaChars = 0;
let reasoningChars = 0;
const traces = [];
let usageSeen = null;

console.log("=== generateVoxelBuild via custom gateway ===");
console.log(`prompt: ${prompt}\n`);

generateVoxelBuild({
  model: {
    key: "ark_gateway_test",
    provider: "custom",
    modelId: process.env.CUSTOM_API_MODEL_ID || "ark-code-latest",
    displayName: "Ark Code (plan/v3)",
    baseUrl: process.env.CUSTOM_API_BASE_URL,
    customGatewayMode: true,
    userAgent: process.env.CUSTOM_API_USER_AGENT || "Kelivo",
  },
  prompt,
  gridSize: 64,
  palette: "simple",
  maxAttempts: 2,
  enableTools: true,
  reasoning: process.env.CUSTOM_API_REASONING_EFFORT || "medium",
  allowServerKeys: true,
  providerKeys: { custom: process.env.CUSTOM_API_KEY },
  returnExpandedBuild: true,
  onDelta: (d) => {
    deltaChars += d.length;
    if (deltaChars % 500 < d.length) process.stdout.write("+");
  },
  onReasoningDelta: (d) => {
    reasoningChars += d.length;
    if (reasoningChars % 500 < d.length) process.stdout.write(".");
  },
  onUsage: (u) => {
    usageSeen = u;
  },
  onProviderTrace: (m) => traces.push(m),
  onRetry: (attempt, reason) => {
    console.log(`\n[retry ${attempt}] ${String(reason).slice(0, 180)}`);
  },
})
  .then((r) => {
    console.log("\n\n=== TRACES ===");
    for (const t of traces) console.log(`  - ${t}`);

    console.log("\n=== CHANNELS ===");
    console.log(`content chars:   ${deltaChars}`);
    console.log(`reasoning chars: ${reasoningChars}`);
    if (usageSeen) console.log(`usage: ${JSON.stringify(usageSeen)}`);

    console.log("\n=== RESULT ===");
    console.log(`ok: ${r.ok}`);
    if (!r.ok) {
      console.log(`error: ${r.error}`);
      console.log(`rawText head:\n${(r.rawText || "").slice(0, 1200)}`);
      process.exit(2);
    }

    console.log(`blockCount:        ${r.blockCount}`);
    console.log(`generationTimeMs:  ${r.generationTimeMs}`);
    console.log(`acceptedTokens:    ${r.acceptedOutputTokens}`);
    console.log(`providerRoute:     ${r.providerRoute}`);
    console.log(`requestConfig:     ${r.requestConfiguration}`);
    console.log(`acceptedConfig:    ${JSON.stringify(r.acceptedRequestConfiguration)}`);
    console.log(`warnings:          ${r.warnings.length}`);
    for (const w of r.warnings.slice(0, 5)) console.log(`   ! ${w}`);

    const types = [...new Set(r.build.blocks.map((b) => b.type))];
    console.log(`distinct types:    ${types.length}`);
    const xs = r.build.blocks.map((b) => b.x);
    const ys = r.build.blocks.map((b) => b.y);
    const zs = r.build.blocks.map((b) => b.z);
    console.log(
      `bounds: x[${Math.min(...xs)}..${Math.max(...xs)}] y[${Math.min(...ys)}..${Math.max(...ys)}] z[${Math.min(...zs)}..${Math.max(...zs)}]`,
    );

    const out = path.join(ROOT, ".probe-out");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "integration-build.json"), JSON.stringify(r.build));
    console.log(`\nbuild saved: ${path.join(out, "integration-build.json")}`);
    console.log("\nPASS: generateVoxelBuild + gateway adapter verified end to end.");
  })
  .catch((e) => {
    console.error(`\nFAILED: ${e && e.message ? e.message : e}`);
    if (e && e.stack) console.error(e.stack.split("\n").slice(0, 8).join("\n"));
    process.exit(1);
  });
