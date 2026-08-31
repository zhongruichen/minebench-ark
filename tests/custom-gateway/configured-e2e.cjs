/**
 * End-to-end: a real voxel build generated through a CONFIGURED provider,
 * exercising the same code path the /battle page uses (prompt -> provider
 * transport -> tool-call extraction -> voxel.exec -> validation).
 *
 *   sh   tests/custom-gateway/build.sh
 *   sh   tests/custom-gateway/build-configured.sh
 *   node tests/custom-gateway/configured-e2e.cjs "a stone lighthouse"
 */
const path = require("node:path");
const fs = require("node:fs");
const ROOT = path.join(__dirname, "..", "..");
const BUILD = path.join(ROOT, process.env.MB_BUILD_DIR || ".btest");
const CONFIGURED = path.join(ROOT, ".btest-configured");

// generateVoxelBuild is compiled into .btest; the configured-provider layer into
// .btest-configured. Resolve @/lib from whichever build has the file.
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith("@/lib/") || request.startsWith("@/")) {
    const rel = request.startsWith("@/lib/")
      ? request.slice("@/lib/".length)
      : request.slice(2);
    for (const base of [BUILD, CONFIGURED]) {
      const candidate = path.join(base, rel);
      if (fs.existsSync(`${candidate}.js`) || fs.existsSync(candidate)) {
        return origResolve.call(this, candidate, parent, ...rest);
      }
    }
    return origResolve.call(this, path.join(BUILD, rel), parent, ...rest);
  }
  return origResolve.call(this, request, parent, ...rest);
};

const envFile = path.join(ROOT, ".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index > 0) process.env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
}

const baseUrl = process.env.MB_TEST_BASE_URL || process.env.CUSTOM_API_BASE_URL;
const apiKey = process.env.MB_TEST_API_KEY || process.env.CUSTOM_API_KEY;
if (!baseUrl || !apiKey) {
  console.log("SKIP: set MB_TEST_BASE_URL + MB_TEST_API_KEY (or CUSTOM_API_* in .env.local)");
  process.exit(0);
}

const { generateVoxelBuild } = require(path.join(BUILD, "ai/generateVoxelBuild.js"));

const prompt = process.argv[2] || "a small stone lighthouse on a rocky island";
const gridSize = Number(process.env.MB_GRID || 64);

const provider = {
  id: "prov_e2e",
  label: "Ark plan/v3 (e2e)",
  apiKind: "openai_chat",
  baseUrl,
  apiKey,
  appendV1: false,
  lockedEnvelope: true,
  structuredOutput: false,
  stream: true,
  userAgent: "",
  conversationId: "",
  maxTokens: 131072,
  reasoningEffort: process.env.MB_TEST_REASONING || "low",
  thinkingMode: "enabled",
  params: [],
  headers: [],
  models: [],
};
const modelConfig = {
  id: "model_e2e",
  modelId: process.env.MB_TEST_MODEL || "ark-code-latest",
  enabled: true,
};

let fail = 0;
const ok = (label, condition, detail) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!condition) fail++;
};

(async () => {
  console.log(`=== configured-provider end-to-end (grid ${gridSize}) ===`);
  console.log(`prompt: ${prompt}\n`);

  let exchanges = 0;
  let sawReasoning = false;
  let deltaChars = 0;
  let loggedBody = null;

  const started = Date.now();
  const result = await generateVoxelBuild({
    model: {
      key: "e2e",
      provider: "custom",
      modelId: modelConfig.modelId,
      displayName: "Ark e2e",
      configured: { provider, model: modelConfig },
    },
    prompt,
    gridSize,
    palette: "advanced",
    maxAttempts: 2,
    allowServerKeys: true,
    onDelta: (delta) => {
      deltaChars += delta.length;
    },
    onReasoningDelta: () => {
      sawReasoning = true;
    },
    onProviderTrace: (message) => console.log(`  trace: ${message.slice(0, 150)}`),
    onExchange: (exchange) => {
      exchanges += 1;
      loggedBody = exchange.requestBody;
    },
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log("");

  ok("generation succeeded", result.ok === true, result.ok ? `${elapsed}s` : result.error);
  if (!result.ok) {
    console.log(`\n${fail} CHECK(S) FAILED`);
    process.exit(1);
  }

  ok("blocks produced", result.blockCount > 0, `${result.blockCount.toLocaleString()} blocks`);
  ok("streamed deltas observed", deltaChars > 0, `${deltaChars.toLocaleString()} chars`);
  ok("reasoning channel used", sawReasoning);
  ok("exchange logged", exchanges > 0, `${exchanges} exchange(s)`);
  ok("logged max_tokens locked", loggedBody && loggedBody.max_tokens === 131072);
  ok(
    "logged thinking enabled",
    loggedBody && JSON.stringify(loggedBody.thinking) === '{"type":"enabled"}',
  );
  ok("build is a valid spec", result.build && result.build.version === "1.0");

  const out = path.join(ROOT, "e2e-build.json");
  fs.writeFileSync(out, JSON.stringify(result.build));
  console.log(`\nwrote ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);

  console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : `${fail} CHECK(S) FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error(`FAIL  unexpected error -- ${error.message}`);
  process.exit(1);
});
