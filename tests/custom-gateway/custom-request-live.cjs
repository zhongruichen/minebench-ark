/**
 * Live proof that Custom Body reaches the wire and that the override is real:
 * sends the reference-screenshot config (max_tokens=128000 overriding the
 * locked 131072) to the actual gateway and asserts it is accepted.
 *
 *   MB_TEST_BASE_URL=... MB_TEST_API_KEY=... node tests/custom-gateway/custom-request-live.cjs
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

const baseUrl = process.env.MB_TEST_BASE_URL;
const apiKey = process.env.MB_TEST_API_KEY;
if (!baseUrl || !apiKey) {
  console.log("SKIP: set MB_TEST_BASE_URL + MB_TEST_API_KEY");
  process.exit(0);
}

let fail = 0;
const ok = (label, condition, detail) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!condition) fail++;
};

const provider = {
  id: "p",
  label: "Ark plan/v3",
  apiKind: "openai_chat",
  baseUrl,
  apiKey,
  appendV1: false,
  lockedEnvelope: true,
  structuredOutput: false,
  stream: true,
  userAgent: "",
  conversationId: "",
  reasoningEffort: "low",
  thinkingMode: "enabled",
  // Exactly the reference screenshot: a UA header plus three body keys.
  headers: [
    { name: "User-Agent", value: "claude-cli/2.1.179 (external, cli)", enabled: true },
    { name: "X-Custom-Probe", value: "minebench-custom-request", enabled: true },
  ],
  params: [
    { key: "thinking", type: "auto", value: '{"type": "enabled"}', enabled: true },
    { key: "reasoning_effort", type: "auto", value: "low", enabled: true },
    { key: "max_tokens", type: "auto", value: "128000", enabled: true },
  ],
  models: [],
};

(async () => {
  console.log("=== live custom-request round trip ===\n");
  let log = null;
  const traces = [];
  try {
    const result = await transport.configuredProviderGenerateText({
      provider,
      model: { id: "m", modelId: process.env.MB_TEST_MODEL || "ark-code-latest", enabled: true },
      system: "Reply with one word.",
      user: "Reply with exactly: PONG",
      onTrace: (m) => traces.push(m),
      onLog: (l) => {
        log = l;
      },
    });

    ok("gateway accepted the overridden body", /pong/i.test(result.text), JSON.stringify(result.text.slice(0, 60)));
    ok("status 200", log && log.status === 200, log ? String(log.status) : "no log");
    ok("custom max_tokens on the wire", log && log.requestBody.max_tokens === 128000,
      log ? String(log.requestBody.max_tokens) : "");
    ok("custom thinking on the wire",
      log && JSON.stringify(log.requestBody.thinking) === '{"type":"enabled"}');
    ok("custom UA header sent",
      log && log.requestHeaders["User-Agent"] === "claude-cli/2.1.179 (external, cli)");
    ok("extra custom header sent",
      log && log.requestHeaders["X-Custom-Probe"] === "minebench-custom-request");
    ok("key still redacted", log && log.requestHeaders.Authorization === "«redacted»");
    ok("override recorded on the log", log && Array.isArray(log.overrides) && log.overrides.length === 1,
      log && log.overrides ? JSON.stringify(log.overrides) : "none");
    ok("override reported in trace", traces.some((m) => m.includes("Custom Body overrode")),
      traces.find((m) => m.includes("Custom Body overrode")) || "none");
  } catch (error) {
    ok("live round trip", false, error.message.slice(0, 200));
  }

  console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : `${fail} CHECK(S) FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
})();
