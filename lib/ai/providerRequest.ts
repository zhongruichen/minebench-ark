// Translates a resolved provider configuration into the wire body for each
// supported API flavour, and back-translates responses into plain text.
//
// This is deliberately a pure module (no I/O): the debug log panel renders the
// exact same body the transport sends by calling `buildProviderRequestBody`
// directly, so "what the UI shows" and "what went out" cannot drift.

import type { ProviderUsage } from "@/lib/ai/providerExchangeLog";
import {
  applyCustomParams,
  effectiveModelSettings,
  LOCKED_ENVELOPE_MAX_TOKENS,
  type ProviderApiKind,
  type ProviderConfig,
  type ProviderModelConfig,
  type ReasoningEffortChoice,
  type ThinkingMode,
} from "@/lib/ai/providerConfig";

export const VOXEL_BUILD_JSON_SCHEMA_NAME = "voxel_build_response";

/** Reasoning values the OpenAI `reasoning_effort` field accepts as-is. */
function reasoningEffortValue(effort: ReasoningEffortChoice): string | undefined {
  return effort === "none" ? undefined : effort;
}

function thinkingField(
  mode: ThinkingMode,
  budgetTokens: number | undefined,
): Record<string, unknown> | undefined {
  switch (mode) {
    case "enabled":
      return { type: "enabled" };
    case "disabled":
      return { type: "disabled" };
    case "budget":
      // Anthropic requires a positive budget when thinking is enabled.
      return {
        type: "enabled",
        budget_tokens: Math.max(1024, Math.floor(budgetTokens ?? 32_000)),
      };
    default:
      return undefined;
  }
}

export type BuiltProviderRequest = {
  endpoint: "chat_completions" | "responses" | "messages";
  body: Record<string, unknown>;
  /** Header names/values that the transport must send in addition to auth. */
  headers: Record<string, string>;
  stream: boolean;
};

/**
 * Builds the request for one (provider, model) pair.
 *
 * Ordering matters and is intentional:
 *   1. flavour-specific canonical fields
 *   2. locked-envelope pins (cannot be overridden — the gateway 400s otherwise)
 *   3. user custom params LAST, so an operator can add a field the adapter does
 *      not model yet, but still cannot break a locked contract (step 2 keys are
 *      re-pinned afterwards).
 */
export function buildProviderRequestBody(params: {
  provider: ProviderConfig;
  model: ProviderModelConfig;
  system: string;
  user: string;
  jsonSchema?: Record<string, unknown>;
}): BuiltProviderRequest {
  const { provider, model } = params;
  const settings = effectiveModelSettings(provider, model);
  const stream = provider.stream;
  const useSchema = provider.structuredOutput && Boolean(params.jsonSchema);

  const body: Record<string, unknown> = {};
  let endpoint: BuiltProviderRequest["endpoint"];

  if (provider.apiKind === "anthropic") {
    endpoint = "messages";
    body.model = settings.modelId;
    // Anthropic takes the system prompt as a top-level field, not a message.
    if (params.system.trim()) body.system = params.system;
    body.messages = [{ role: "user", content: params.user }];
    body.max_tokens = Math.floor(settings.maxTokens ?? 64_000);
    if (settings.temperature !== undefined) body.temperature = settings.temperature;
    const thinking = thinkingField(settings.thinkingMode, settings.thinkingBudgetTokens);
    if (thinking) {
      body.thinking = thinking;
      // Anthropic rejects temperature != 1 while extended thinking is on.
      delete body.temperature;
    }
    if (stream) body.stream = true;
  } else if (provider.apiKind === "openai_responses") {
    endpoint = "responses";
    body.model = settings.modelId;
    const input: Record<string, unknown>[] = [];
    if (params.system.trim()) {
      input.push({
        role: "system",
        content: [{ type: "input_text", text: params.system }],
      });
    }
    input.push({ role: "user", content: [{ type: "input_text", text: params.user }] });
    body.input = input;
    if (settings.maxTokens !== undefined) {
      body.max_output_tokens = Math.floor(settings.maxTokens);
    }
    if (settings.temperature !== undefined) body.temperature = settings.temperature;
    const effort = reasoningEffortValue(settings.reasoningEffort);
    if (effort) body.reasoning = { effort };
    if (useSchema && params.jsonSchema) {
      body.text = {
        format: {
          type: "json_schema",
          name: VOXEL_BUILD_JSON_SCHEMA_NAME,
          strict: true,
          schema: params.jsonSchema,
        },
      };
    }
    if (stream) body.stream = true;
  } else {
    endpoint = "chat_completions";
    const messages: { role: string; content: string }[] = [];
    if (params.system.trim()) messages.push({ role: "system", content: params.system });
    messages.push({ role: "user", content: params.user });

    body.model = settings.modelId;
    body.messages = messages;
    body.stream = stream;
    if (settings.maxTokens !== undefined) body.max_tokens = Math.floor(settings.maxTokens);
    if (settings.temperature !== undefined) body.temperature = settings.temperature;

    const thinking = thinkingField(settings.thinkingMode, settings.thinkingBudgetTokens);
    if (thinking) body.thinking = thinking;

    const effort = reasoningEffortValue(settings.reasoningEffort);
    if (effort) body.reasoning_effort = effort;

    if (stream) body.stream_options = { include_usage: true };

    if (useSchema && params.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: VOXEL_BUILD_JSON_SCHEMA_NAME,
          strict: true,
          schema: params.jsonSchema,
        },
      };
    }
  }

  // Operator-supplied params. Applied before the locked pins are re-asserted so
  // that a locked gateway stays valid no matter what was typed into the UI.
  applyCustomParams(body, settings.params);

  if (provider.lockedEnvelope && provider.apiKind === "openai_chat") {
    body.max_tokens = Math.min(
      typeof body.max_tokens === "number" ? body.max_tokens : LOCKED_ENVELOPE_MAX_TOKENS,
      LOCKED_ENVELOPE_MAX_TOKENS,
    );
    body.thinking = { type: "enabled" };
    if (stream) body.stream_options = { include_usage: true };
    // Accepted-then-ignored upstream; sending it only pollutes the trace.
    if (!provider.structuredOutput) delete body.response_format;
  }

  const headers: Record<string, string> = {};
  for (const header of provider.headers ?? []) {
    if (!header.enabled) continue;
    const name = header.name.trim();
    if (!name) continue;
    headers[name] = header.value;
  }

  return { endpoint, body, headers, stream };
}

/** Auth headers for a flavour. Anthropic uses `x-api-key`, not Bearer. */
export function authHeadersForProvider(
  apiKind: ProviderApiKind,
  apiKey: string,
): Record<string, string> {
  const trimmed = apiKey.trim();
  if (!trimmed) return {};
  if (apiKind === "anthropic") {
    return { "x-api-key": trimmed, "anthropic-version": "2023-06-01" };
  }
  return { Authorization: `Bearer ${trimmed}` };
}

export type { ProviderUsage };

/** Normalizes the three flavours' usage shapes into one. */
export function normalizeUsage(raw: unknown): ProviderUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;

  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  // Anthropic: input_tokens/output_tokens. OpenAI Responses: input_tokens too.
  const prompt = num(usage.prompt_tokens) ?? num(usage.input_tokens);
  const completion = num(usage.completion_tokens) ?? num(usage.output_tokens);
  const total =
    num(usage.total_tokens) ??
    (prompt !== undefined && completion !== undefined ? prompt + completion : undefined);

  const cacheRead = num(usage.cache_read_input_tokens);
  const promptDetails = usage.prompt_tokens_details as { cached_tokens?: number } | undefined;
  const completionDetails = usage.completion_tokens_details as
    | { reasoning_tokens?: number }
    | undefined;
  const outputDetails = usage.output_tokens_details as { reasoning_tokens?: number } | undefined;

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    prompt_tokens_details:
      promptDetails ?? (cacheRead !== undefined ? { cached_tokens: cacheRead } : null),
    completion_tokens_details: completionDetails ?? outputDetails ?? null,
  };
}
