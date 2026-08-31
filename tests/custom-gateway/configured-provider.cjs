/**
 * Unit + live checks for the configured-provider layer.
 *
 * Unit checks always run. The live round-trip only runs when
 * MB_TEST_BASE_URL / MB_TEST_API_KEY are set, so the suite stays usable
 * offline and in CI without credentials.
 *
 *   sh   tests/custom-gateway/build-configured.sh
 *   node tests/custom-gateway/configured-provider.cjs
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

const cfg = require(path.join(BUILD, "ai/providerConfig.js"));
const req = require(path.join(BUILD, "ai/providerRequest.js"));
const guard = require(path.join(BUILD, "ai/providers/customApiGuard.js"));
const transport = require(path.join(BUILD, "ai/providers/configuredProvider.js"));

let fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${JSON.stringify(actual)}`);
  if (!ok) {
    console.log(`      expected: ${JSON.stringify(expected)}`);
    fail++;
  }
};
const ok = (label, condition, detail) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!condition) fail++;
};

const baseProvider = (overrides = {}) => ({
  id: "p1",
  label: "Test",
  apiKind: "openai_chat",
  baseUrl: "https://example.com/api/plan/v3/chat/completions",
  apiKey: "k",
  appendV1: false,
  lockedEnvelope: false,
  structuredOutput: false,
  stream: true,
  userAgent: "",
  conversationId: "",
  maxTokens: undefined,
  temperature: undefined,
  reasoningEffort: "none",
  thinkingMode: "omit",
  thinkingBudgetTokens: undefined,
  params: [],
  headers: [],
  models: [],
  ...overrides,
});
const model = (overrides = {}) => ({
  id: "m1",
  modelId: "test-model",
  enabled: true,
  ...overrides,
});

console.log("=== endpoint URL construction (the /v1 switch) ===\n");

const url = (baseUrl, endpoint, appendV1) =>
  guard.buildProviderEndpointUrl({ baseUrl, endpoint, appendV1 }).toString();

check(
  "appendV1=false keeps a non-standard path verbatim",
  url("https://ark.cn-beijing.volces.com/api/plan/v3", "chat_completions", false),
  "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions",
);
check(
  "appendV1=true injects /v1",
  url("https://api.openai.com", "chat_completions", true),
  "https://api.openai.com/v1/chat/completions",
);
check(
  "appendV1=true does not double an existing /v1",
  url("https://api.openai.com/v1", "chat_completions", true),
  "https://api.openai.com/v1/chat/completions",
);
check(
  "appendV1=true leaves an existing /v3 alone",
  url("https://host/api/v3", "chat_completions", true),
  "https://host/api/v3/chat/completions",
);
check(
  "a full endpoint URL is preserved",
  url("https://host/api/plan/v3/chat/completions", "chat_completions", true),
  "https://host/api/plan/v3/chat/completions",
);
check(
  "rebases when a different endpoint suffix was pasted",
  url("https://host/v1/chat/completions", "models", true),
  "https://host/v1/models",
);
check(
  "anthropic messages endpoint",
  url("https://api.anthropic.com", "messages", true),
  "https://api.anthropic.com/v1/messages",
);
check(
  "responses endpoint",
  url("https://api.openai.com", "responses", true),
  "https://api.openai.com/v1/responses",
);

console.log("\n=== custom config wins over presets (escape hatch) ===\n");

// Custom Body is the last word: it must override provider settings AND the
// locked-envelope preset. This is the inverse of the earlier behaviour and the
// whole point of the feature, so it is asserted explicitly.
const locked = req.buildProviderRequestBody({
  provider: baseProvider({
    lockedEnvelope: true,
    maxTokens: 999_999,
    thinkingMode: "disabled",
    reasoningEffort: "max",
    params: [
      { key: "max_tokens", type: "auto", value: "128000", enabled: true },
      { key: "thinking", type: "auto", value: '{"type":"disabled"}', enabled: true },
    ],
  }),
  model: model(),
  system: "s",
  user: "u",
});
check("custom max_tokens overrides locked pin", locked.body.max_tokens, 128000);
check("custom thinking overrides locked pin", locked.body.thinking, { type: "disabled" });
check("locked stream_options still applied", locked.body.stream_options, { include_usage: true });
check("locked reasoning_effort passes through", locked.body.reasoning_effort, "max");
check("locked drops response_format", "response_format" in locked.body, false);
// Overriding a locked value is legitimate but risky, so it must be reported.
check("override collision reported", locked.overrides.length, 2);
check(
  "override records old and new",
  locked.overrides.find((o) => o.key === "max_tokens"),
  { key: "max_tokens", previous: 131072, next: 128000 },
);

// With no colliding params the preset must still hold exactly as before.
const lockedClean = req.buildProviderRequestBody({
  provider: baseProvider({ lockedEnvelope: true, maxTokens: 999_999 }),
  model: model(),
  system: "s",
  user: "u",
});
check("preset clamps when uncontested", lockedClean.body.max_tokens, 131072);
check("preset thinking when uncontested", lockedClean.body.thinking, { type: "enabled" });
check("no spurious overrides", lockedClean.overrides.length, 0);

console.log("\n=== automatic type inference ===\n");

const inferred = req.buildProviderRequestBody({
  provider: baseProvider({
    params: [
      { key: "obj", type: "auto", value: '{"type": "enabled"}', enabled: true },
      { key: "arr", type: "auto", value: "[1,2]", enabled: true },
      { key: "num", type: "auto", value: "128000", enabled: true },
      { key: "neg", type: "auto", value: "-1.5", enabled: true },
      { key: "yes", type: "auto", value: "true", enabled: true },
      { key: "nil", type: "auto", value: "null", enabled: true },
      { key: "word", type: "auto", value: "max", enabled: true },
      // Must stay a string: converting would change the value.
      { key: "padded", type: "auto", value: "007", enabled: true },
      { key: "trailing", type: "auto", value: "1.50", enabled: true },
      // Malformed JSON degrades to a string rather than failing the request.
      { key: "broken", type: "auto", value: "{oops", enabled: true },
      // Explicit type must beat inference.
      { key: "forced", type: "string", value: "128000", enabled: true },
    ],
  }),
  model: model(),
  system: "s",
  user: "u",
});
check("infers object", inferred.body.obj, { type: "enabled" });
check("infers array", inferred.body.arr, [1, 2]);
check("infers number", inferred.body.num, 128000);
check("infers negative float", inferred.body.neg, -1.5);
check("infers boolean", inferred.body.yes, true);
check("infers null", inferred.body.nil, null);
check("keeps bare word as string", inferred.body.word, "max");
check("keeps zero-padded as string", inferred.body.padded, "007");
check("keeps trailing-zero decimal as string", inferred.body.trailing, "1.50");
check("malformed JSON degrades to string", inferred.body.broken, "{oops");
check("explicit string type beats inference", inferred.body.forced, "128000");

console.log("\n=== reference screenshot config, end to end ===\n");

// The exact configuration from the reference UI: a UA header plus three body
// keys, two of which collide with locked-envelope pins.
const reference = req.buildProviderRequestBody({
  provider: baseProvider({
    lockedEnvelope: true,
    headers: [
      { name: "User-Agent", value: "claude-cli/2.1.179 (external, cli)", enabled: true },
    ],
    params: [
      { key: "thinking", type: "auto", value: '{"type": "enabled"}', enabled: true },
      { key: "reasoning_effort", type: "auto", value: "max", enabled: true },
      { key: "max_tokens", type: "auto", value: "128000", enabled: true },
    ],
  }),
  model: model({ modelId: "ark-code-latest" }),
  system: "s",
  user: "u",
});
check("reference thinking", reference.body.thinking, { type: "enabled" });
check("reference reasoning_effort", reference.body.reasoning_effort, "max");
check("reference max_tokens (custom wins)", reference.body.max_tokens, 128000);
check("reference UA header", reference.headers["User-Agent"], "claude-cli/2.1.179 (external, cli)");
// thinking was already {type:"enabled"} so it is NOT a collision; only
// max_tokens actually changed.
check("reference reports only the real collision", reference.overrides.map((o) => o.key), [
  "max_tokens",
]);

console.log("\n=== per-model overrides beat provider defaults ===\n");

const overridden = req.buildProviderRequestBody({
  provider: baseProvider({ maxTokens: 1000, temperature: 0.5, reasoningEffort: "low" }),
  model: model({ maxTokens: 2000, temperature: 1.2, reasoningEffort: "high" }),
  system: "s",
  user: "u",
});
check("model max_tokens wins", overridden.body.max_tokens, 2000);
check("model temperature wins", overridden.body.temperature, 1.2);
check("model reasoning_effort wins", overridden.body.reasoning_effort, "high");

console.log("\n=== custom params, including nested keys ===\n");

const withParams = req.buildProviderRequestBody({
  provider: baseProvider({
    params: [
      { key: "top_p", type: "number", value: "0.9", enabled: true },
      { key: "stream_options.include_usage", type: "boolean", value: "false", enabled: true },
      { key: "metadata", type: "json", value: '{"tag":"x"}', enabled: true },
      { key: "ignored", type: "string", value: "no", enabled: false },
      { key: "", type: "string", value: "no-key", enabled: true },
    ],
  }),
  model: model(),
  system: "s",
  user: "u",
});
check("number param", withParams.body.top_p, 0.9);
check("nested boolean param", withParams.body.stream_options, { include_usage: false });
check("json param", withParams.body.metadata, { tag: "x" });
check("disabled param omitted", "ignored" in withParams.body, false);
check("blank key ignored", "undefined" in withParams.body, false);

console.log("\n=== flavour-specific bodies ===\n");

const anthropic = req.buildProviderRequestBody({
  provider: baseProvider({
    apiKind: "anthropic",
    maxTokens: 8000,
    thinkingMode: "budget",
    thinkingBudgetTokens: 4000,
    temperature: 0.7,
  }),
  model: model(),
  system: "SYS",
  user: "U",
});
check("anthropic endpoint", anthropic.endpoint, "messages");
check("anthropic hoists system", anthropic.body.system, "SYS");
check("anthropic messages", anthropic.body.messages, [{ role: "user", content: "U" }]);
check("anthropic thinking budget", anthropic.body.thinking, {
  type: "enabled",
  budget_tokens: 4000,
});
ok(
  "anthropic drops temperature while thinking",
  !("temperature" in anthropic.body),
  "extended thinking requires temperature=1",
);

const responses = req.buildProviderRequestBody({
  provider: baseProvider({ apiKind: "openai_responses", maxTokens: 4096, reasoningEffort: "high" }),
  model: model(),
  system: "SYS",
  user: "U",
});
check("responses endpoint", responses.endpoint, "responses");
check("responses max_output_tokens", responses.body.max_output_tokens, 4096);
check("responses reasoning", responses.body.reasoning, { effort: "high" });
ok("responses uses input[]", Array.isArray(responses.body.input));

console.log("\n=== auth headers per flavour ===\n");

check("openai uses Bearer", req.authHeadersForProvider("openai_chat", "abc"), {
  Authorization: "Bearer abc",
});
check("anthropic uses x-api-key", req.authHeadersForProvider("anthropic", "abc"), {
  "x-api-key": "abc",
  "anthropic-version": "2023-06-01",
});
check("empty key sends no auth header", req.authHeadersForProvider("openai_chat", "  "), {});

console.log("\n=== secrets never reach a log ===\n");

const redacted = transport.redactHeaders({
  Authorization: "Bearer super-secret",
  "x-api-key": "another-secret",
  "User-Agent": "claude-cli/2.1.179 (external, cli)",
});
check("Authorization redacted", redacted.Authorization, "«redacted»");
check("x-api-key redacted", redacted["x-api-key"], "«redacted»");
check("User-Agent preserved", redacted["User-Agent"], "claude-cli/2.1.179 (external, cli)");

console.log("\n=== usage normalization across flavours ===\n");

check(
  "openai usage",
  req.normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }).total_tokens,
  15,
);
check(
  "anthropic usage totals",
  req.normalizeUsage({ input_tokens: 10, output_tokens: 5 }).total_tokens,
  15,
);

console.log("\n=== default User-Agent ===\n");
const ua = require(path.join(BUILD, "ai/userAgent.js"));
check(
  "project default UA",
  ua.DEFAULT_OUTBOUND_USER_AGENT,
  "claude-cli/2.1.179 (external, cli)",
);
check("explicit UA wins", ua.resolveOutboundUserAgent("custom/1.0"), "custom/1.0");

console.log("\n=== stream frame parsing per flavour ===\n");

const collect = (apiKind, frames) => {
  let text = "";
  let reasoning = "";
  let usage = null;
  for (const frame of frames) {
    transport.applyStreamFrame(apiKind, JSON.stringify(frame), {
      onText: (d) => {
        text += d;
      },
      onReasoning: (d) => {
        reasoning += d;
      },
      onUsage: (u) => {
        usage = u;
      },
    });
  }
  return { text, reasoning, usage };
};

// openai_chat: Ark puts reasoning_content as a sibling of content. If that ever
// leaks into the text channel it corrupts the JSON tool call we must parse.
const chatParsed = collect("openai_chat", [
  { choices: [{ delta: { reasoning_content: "thinking..." } }] },
  { choices: [{ delta: { content: '{"tool"' } }] },
  { choices: [{ delta: { content: ':"voxel.exec"}' } }] },
  { choices: [], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } },
]);
check("openai_chat text", chatParsed.text, '{"tool":"voxel.exec"}');
check("openai_chat reasoning isolated", chatParsed.reasoning, "thinking...");
check("openai_chat usage", chatParsed.usage.total_tokens, 12);

const anthropicParsed = collect("anthropic", [
  { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
  { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
  { type: "content_block_delta", delta: { type: "text_delta", text: "hello " } },
  { type: "content_block_delta", delta: { type: "text_delta", text: "world" } },
  { type: "message_delta", usage: { input_tokens: 3, output_tokens: 9 } },
]);
check("anthropic text", anthropicParsed.text, "hello world");
check("anthropic reasoning isolated", anthropicParsed.reasoning, "hmm");
check("anthropic usage", anthropicParsed.usage.total_tokens, 12);

const responsesParsed = collect("openai_responses", [
  { type: "response.reasoning_summary_text.delta", delta: "plan" },
  { type: "response.output_text.delta", delta: "abc" },
  { type: "response.output_text.delta", delta: "def" },
  { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 4 } } },
]);
check("responses text", responsesParsed.text, "abcdef");
check("responses reasoning isolated", responsesParsed.reasoning, "plan");
check("responses usage", responsesParsed.usage.total_tokens, 6);

console.log("\n=== non-streamed extraction per flavour ===\n");

const chatBody = transport.extractNonStreamed("openai_chat", {
  choices: [{ message: { content: "hi", reasoning_content: "why" } }],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
});
check("openai_chat non-stream text", chatBody.text, "hi");
check("openai_chat non-stream reasoning", chatBody.reasoningText, "why");

const anthropicBody = transport.extractNonStreamed("anthropic", {
  content: [
    { type: "thinking", thinking: "deep" },
    { type: "text", text: "answer" },
  ],
  usage: { input_tokens: 4, output_tokens: 6 },
});
check("anthropic non-stream text", anthropicBody.text, "answer");
check("anthropic non-stream reasoning", anthropicBody.reasoningText, "deep");
check("anthropic non-stream usage", anthropicBody.usage.total_tokens, 10);

const responsesBody = transport.extractNonStreamed("openai_responses", {
  output: [
    { type: "reasoning", summary: [{ text: "steps" }] },
    { type: "message", content: [{ type: "output_text", text: "final" }] },
  ],
  usage: { input_tokens: 1, output_tokens: 1 },
});
check("responses non-stream text", responsesBody.text, "final");
check("responses non-stream reasoning", responsesBody.reasoningText, "steps");

console.log("\n=== non-streaming request omits stream fields ===\n");

const nonStreamBody = req.buildProviderRequestBody({
  provider: baseProvider({ stream: false }),
  model: model(),
  system: "s",
  user: "u",
});
check("stream false", nonStreamBody.body.stream, false);
check("no stream_options when not streaming", "stream_options" in nonStreamBody.body, false);

(async () => {
  const baseUrl = process.env.MB_TEST_BASE_URL;
  const apiKey = process.env.MB_TEST_API_KEY;

  if (!baseUrl || !apiKey) {
    console.log("\n=== live round-trip: SKIPPED (set MB_TEST_BASE_URL + MB_TEST_API_KEY) ===");
  } else {
    console.log("\n=== live round-trip ===\n");
    const provider = baseProvider({
      label: "Ark plan/v3",
      baseUrl,
      apiKey,
      lockedEnvelope: true,
      appendV1: false,
      reasoningEffort: process.env.MB_TEST_REASONING || "low",
      models: [],
    });

    let streamedText = "";
    let sawReasoning = false;
    let capturedLog = null;

    try {
      const result = await transport.configuredProviderGenerateText({
        provider,
        model: model({ modelId: process.env.MB_TEST_MODEL || "ark-code-latest" }),
        system: "You reply with exactly one word.",
        user: "Reply with exactly: PONG",
        onDelta: (delta) => {
          streamedText += delta;
        },
        onReasoningDelta: () => {
          sawReasoning = true;
        },
        onLog: (log) => {
          capturedLog = log;
        },
      });

      ok("live request succeeded", result.text.length > 0, JSON.stringify(result.text.slice(0, 80)));
      ok("streamed deltas match final text", streamedText === result.text);
      ok("response contains PONG", /pong/i.test(result.text), result.text.slice(0, 80));
      ok("usage reported", Boolean(result.usage && result.usage.total_tokens > 0),
        JSON.stringify(result.usage));
      ok("exchange log captured", Boolean(capturedLog));
      if (capturedLog) {
        check("logged status", capturedLog.status, 200);
        check("logged max_tokens is the locked value", capturedLog.requestBody.max_tokens, 131072);
        check("logged thinking", capturedLog.requestBody.thinking, { type: "enabled" });
        check(
          "logged UA",
          capturedLog.requestHeaders["User-Agent"],
          "claude-cli/2.1.179 (external, cli)",
        );
        check("log hides the key", capturedLog.requestHeaders.Authorization, "«redacted»");
        ok("raw SSE body captured", (capturedLog.responseBodyRaw || "").includes("data:"));
      }
      ok(
        "reasoning routed separately from text",
        !/<think|reasoning_content/i.test(result.text),
        `reasoning seen: ${sawReasoning}`,
      );
    } catch (error) {
      ok("live request succeeded", false, error.message);
    }

    console.log("\n=== live model list ===\n");
    try {
      const listed = await transport.fetchProviderModels({ provider });
      ok("model list returned", Array.isArray(listed.models), `${listed.models.length} models`);
    } catch (error) {
      // Many locked gateways do not expose /models; that is not a failure of
      // this layer, so report it without failing the suite.
      console.log(`INFO  model list unavailable on this endpoint: ${error.message.slice(0, 120)}`);
    }
  }

  console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : `${fail} CHECK(S) FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
})();
