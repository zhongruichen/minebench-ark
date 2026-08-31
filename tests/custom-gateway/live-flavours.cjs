/**
 * Exercises the non-Ark flavours end to end where credentials are available.
 *
 * Every flavour is optional and skipped when its key is absent, so this is safe
 * to run anywhere:
 *   MB_OPENAI_KEY   -> openai_chat + openai_responses + /models
 *   MB_ANTHROPIC_KEY-> anthropic
 */
const path = require("node:path");
const BUILD = path.join(
  process.env.MB_ROOT || path.join(__dirname, "../.."),
  process.env.MB_BUILD_DIR || ".btest-configured",
);
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith("@/lib/")) request = path.join(BUILD, request.slice("@/lib/".length));
  else if (request.startsWith("@/")) request = path.join(BUILD, request.slice(2));
  return origResolve.call(this, request, parent, ...rest);
};

const transport = require(path.join(BUILD, "ai/providers/configuredProvider.js"));

let fail = 0;
let ran = 0;
const ok = (label, condition, detail) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!condition) fail++;
};

const provider = (overrides) => ({
  id: "p",
  label: "Live",
  apiKind: "openai_chat",
  baseUrl: "",
  apiKey: "",
  appendV1: true,
  lockedEnvelope: false,
  structuredOutput: false,
  stream: true,
  userAgent: "",
  conversationId: "",
  reasoningEffort: "none",
  thinkingMode: "omit",
  params: [],
  headers: [],
  models: [],
  ...overrides,
});

async function roundTrip(label, cfg, modelId) {
  ran++;
  console.log(`\n=== ${label} ===\n`);
  let streamed = "";
  let log = null;
  try {
    const result = await transport.configuredProviderGenerateText({
      provider: cfg,
      model: { id: "m", modelId, enabled: true },
      system: "Reply with one word only.",
      user: "Reply with exactly: PONG",
      onDelta: (d) => {
        streamed += d;
      },
      onLog: (l) => {
        log = l;
      },
    });
    ok(`${label}: text returned`, result.text.trim().length > 0, JSON.stringify(result.text.slice(0, 60)));
    ok(`${label}: contains PONG`, /pong/i.test(result.text));
    if (cfg.stream) {
      ok(`${label}: streamed text matches`, streamed === result.text);
    }
    ok(`${label}: status 200`, log && log.status === 200, log ? String(log.status) : "no log");
    ok(`${label}: key redacted in log`, log && !JSON.stringify(log.requestHeaders).includes(cfg.apiKey));
    ok(`${label}: usage captured`, Boolean(result.usage && result.usage.total_tokens > 0),
      JSON.stringify(result.usage));
  } catch (error) {
    ok(`${label}: round trip`, false, error.message.slice(0, 200));
  }
}

(async () => {
  const openaiKey = process.env.MB_OPENAI_KEY;
  const anthropicKey = process.env.MB_ANTHROPIC_KEY;

  if (openaiKey) {
    const base = { baseUrl: "https://api.openai.com", apiKey: openaiKey, appendV1: true };
    await roundTrip(
      "openai_chat",
      provider({ ...base, apiKind: "openai_chat", maxTokens: 64 }),
      process.env.MB_OPENAI_MODEL || "gpt-4o-mini",
    );
    await roundTrip(
      "openai_responses",
      provider({ ...base, apiKind: "openai_responses", maxTokens: 256 }),
      process.env.MB_OPENAI_MODEL || "gpt-4o-mini",
    );

    console.log("\n=== openai /models ===\n");
    ran++;
    try {
      const listed = await transport.fetchProviderModels({
        provider: provider({ ...base, label: "OpenAI" }),
      });
      ok("model list non-empty", listed.models.length > 0, `${listed.models.length} models`);
      ok("model list sorted", listed.models.every((m, i, a) => i === 0 || a[i - 1].id <= m.id));
    } catch (error) {
      ok("model list", false, error.message.slice(0, 160));
    }
  } else {
    console.log("SKIP  openai flavours (set MB_OPENAI_KEY)");
  }

  if (anthropicKey) {
    await roundTrip(
      "anthropic",
      provider({
        apiKind: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: anthropicKey,
        appendV1: true,
        maxTokens: 256,
      }),
      process.env.MB_ANTHROPIC_MODEL || "claude-3-5-haiku-20241022",
    );
  } else {
    console.log("SKIP  anthropic flavour (set MB_ANTHROPIC_KEY)");
  }

  if (ran === 0) {
    console.log("\nNo live credentials provided; nothing exercised.");
    process.exit(0);
  }
  console.log(`\n${fail === 0 ? "ALL LIVE CHECKS PASSED" : `${fail} CHECK(S) FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
})();
