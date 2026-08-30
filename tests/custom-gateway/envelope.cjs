/**
 * Targeted check: the gateway adapter must clamp an over-limit caller value
 * (generateVoxelBuild passes 262144 by default) down to LOCKED_MAX_TOKENS.
 */
const path = require("node:path");
const fs = require("node:fs");
const ROOT = path.join(__dirname, "..", "..");
const BUILD = path.join(ROOT, process.env.MB_BUILD_DIR || ".btest");

const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith("@/lib/")) request = path.join(BUILD, request.slice("@/lib/".length));
  else if (request.startsWith("@/")) request = path.join(BUILD, request.slice(2));
  return origResolve.call(this, request, parent, ...rest);
};

for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i > 0) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const gw = require(path.join(BUILD, "ai/providers/customGateway.js"));

let fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${JSON.stringify(actual)}`);
  if (!ok) {
    console.log(`      expected: ${JSON.stringify(expected)}`);
    fail++;
  }
};

console.log("=== locked envelope unit checks ===\n");

// 1. Over-limit caller value must clamp to 131072.
const over = gw.buildCustomRequestBody({
  modelId: "ark-code-latest",
  system: "s",
  user: "u",
  stream: true,
  maxTokens: 262144,
});
check("clamps 262144 -> 131072", over.max_tokens, 131072);
check("thinking always enabled", over.thinking, { type: "enabled" });
check("stream_options include_usage", over.stream_options, { include_usage: true });
check("no response_format", "response_format" in over, false);
check("reasoning_effort omitted when unset", "reasoning_effort" in over, false);

// 2. Default (no maxTokens) is the locked value.
const def = gw.buildCustomRequestBody({
  modelId: "m",
  system: "s",
  user: "u",
  stream: true,
});
check("default max_tokens", def.max_tokens, 131072);

// 3. Under-limit value is preserved.
const under = gw.buildCustomRequestBody({
  modelId: "m",
  system: "s",
  user: "u",
  stream: false,
  maxTokens: 4096,
});
check("preserves 4096", under.max_tokens, 4096);
check("stream false honored", under.stream, false);

// 4. reasoning_effort passthrough + omission semantics.
for (const [input, expected] of [
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
  ["max", "max"],
]) {
  check(`effort '${input}'`, gw.normalizeCustomReasoningEffort(input), expected);
}
for (const input of ["none", "omit", "default", "", "   ", undefined]) {
  check(`effort ${JSON.stringify(input)} -> omitted`, gw.normalizeCustomReasoningEffort(input), undefined);
}
let threw = false;
try {
  gw.normalizeCustomReasoningEffort("ultra");
} catch {
  threw = true;
}
check("invalid effort throws (no silent downgrade)", threw, true);

// 5. System message omitted when blank; roles ordered.
const noSys = gw.buildCustomRequestBody({ modelId: "m", system: "  ", user: "u", stream: true });
check("blank system dropped", noSys.messages, [{ role: "user", content: "u" }]);
const withSys = gw.buildCustomRequestBody({ modelId: "m", system: "S", user: "U", stream: true });
check("system precedes user", withSys.messages, [
  { role: "system", content: "S" },
  { role: "user", content: "U" },
]);

// 6. Effort lands in the body when supplied.
const withEffort = gw.buildCustomRequestBody({
  modelId: "m",
  system: "s",
  user: "u",
  stream: true,
  reasoningEffort: "xhigh",
});
check("reasoning_effort in body", withEffort.reasoning_effort, "xhigh");

// 8. response_format is OPT-IN (the Agent Plan gateway ignores it, so the
//    default must stay off; a standard endpoint can turn it on).
const noSchema = gw.buildCustomRequestBody({
  modelId: "m", system: "s", user: "u", stream: true,
});
check("no response_format by default", "response_format" in noSchema, false);

const withSchema = gw.buildCustomRequestBody({
  modelId: "m", system: "s", user: "u", stream: true,
  jsonSchema: { type: "object", properties: { x: { type: "integer" } }, required: ["x"], additionalProperties: false },
});
check("response_format present when schema given", "response_format" in withSchema, true);
check("response_format type", withSchema.response_format.type, "json_schema");
check("json_schema strict", withSchema.response_format.json_schema.strict, true);
check("json_schema name", withSchema.response_format.json_schema.name, gw.VOXEL_BUILD_JSON_SCHEMA_NAME);
check("schema passed through", withSchema.response_format.json_schema.schema.required, ["x"]);
// Locked params must survive alongside a schema.
check("max_tokens still locked with schema", withSchema.max_tokens, 131072);
check("thinking still enabled with schema", withSchema.thinking, { type: "enabled" });

console.log(`\n=== exported constants ===`);
check("LOCKED_MAX_TOKENS", gw.LOCKED_MAX_TOKENS, 131072);
check("LOCKED_THINKING", gw.LOCKED_THINKING, { type: "enabled" });

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
