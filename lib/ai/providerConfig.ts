// Shared contract for user-configured AI providers.
//
// The original `custom` channel supported exactly ONE endpoint with a fixed
// shape. This module generalizes it to an arbitrary list of provider
// configurations, each of which selects an API flavour and carries its own
// models, parameters, and header policy. It is imported by both the browser
// (config UI, localStorage persistence) and the server (request validation,
// dispatch), so it must stay free of node-only and dom-only imports.

import { DEFAULT_OUTBOUND_USER_AGENT } from "@/lib/ai/userAgent";

/**
 * Wire protocol spoken by a provider.
 *  - `openai_chat`     POST {base}/chat/completions   (OpenAI Chat Completions)
 *  - `openai_responses` POST {base}/responses         (OpenAI Responses API)
 *  - `anthropic`       POST {base}/messages           (Anthropic Messages API)
 */
export const PROVIDER_API_KINDS = ["openai_chat", "openai_responses", "anthropic"] as const;
export type ProviderApiKind = (typeof PROVIDER_API_KINDS)[number];

export const PROVIDER_API_KIND_LABELS: Record<ProviderApiKind, string> = {
  openai_chat: "OpenAI-compatible (chat/completions)",
  openai_responses: "OpenAI Responses API (/responses)",
  anthropic: "Anthropic Messages API (/messages)",
};

/** Reasoning effort values accepted by the Ark plan gateway and OpenAI models. */
export const REASONING_EFFORT_CHOICES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffortChoice = (typeof REASONING_EFFORT_CHOICES)[number];

/**
 * How the `thinking` / reasoning field is emitted.
 *  - `omit`     no thinking field at all
 *  - `enabled`  `thinking: {type:"enabled"}` (Ark plan gateway contract)
 *  - `disabled` `thinking: {type:"disabled"}`
 *  - `budget`   `thinking: {type:"enabled", budget_tokens:N}` (Anthropic style)
 */
export const THINKING_MODES = ["omit", "enabled", "disabled", "budget"] as const;
export type ThinkingMode = (typeof THINKING_MODES)[number];

/**
 * Value type for an extra request-body parameter.
 *
 * `auto` (the default) infers the JSON type from the text, so a user can paste
 * `{"type":"enabled"}`, `128000`, or `max` without first choosing a type. The
 * explicit types remain for the cases inference would get wrong — most often
 * forcing `string` for a value that merely looks numeric (a version like
 * `"1.0"`, or an id with leading zeros).
 */
export type CustomParamType = "auto" | "string" | "number" | "boolean" | "json";

export type CustomParam = {
  /** Dot paths are supported (`stream_options.include_usage`). */
  key: string;
  type: CustomParamType;
  value: string;
  enabled: boolean;
};

/** An extra outbound HTTP header. */
export type CustomHeader = {
  name: string;
  value: string;
  enabled: boolean;
};

/**
 * Per-model overrides. Every field is optional: unset means "inherit the
 * provider default", which keeps a battle across many models of one provider
 * configurable from a single place while still allowing one outlier model to
 * differ.
 */
export type ProviderModelConfig = {
  id: string;
  /** Wire model id sent to the provider. */
  modelId: string;
  /** Human label shown in the UI; falls back to modelId. */
  displayName?: string;
  enabled: boolean;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffortChoice;
  thinkingMode?: ThinkingMode;
  thinkingBudgetTokens?: number;
  params?: CustomParam[];
};

export type ProviderConfig = {
  id: string;
  label: string;
  apiKind: ProviderApiKind;
  baseUrl: string;
  /** May be empty: some gateways authenticate by IP, mTLS, or a custom header. */
  apiKey: string;
  /**
   * Explicit operator decision, never inferred from the URL shape. See
   * `buildProviderEndpointUrl` for why guessing is unsafe.
   */
  appendV1: boolean;
  /**
   * Preserve the URL path verbatim and pin the locked envelope
   * (max_tokens/thinking/stream_options). Required by fixed-contract gateways
   * such as Ark `/api/plan/v3`.
   */
  lockedEnvelope: boolean;
  /** Send `response_format: json_schema`. Off by default — many gateways lie. */
  structuredOutput: boolean;
  stream: boolean;
  userAgent: string;
  /** Blank = a fresh UUID per request. */
  conversationId: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort: ReasoningEffortChoice;
  thinkingMode: ThinkingMode;
  thinkingBudgetTokens?: number;
  params: CustomParam[];
  headers: CustomHeader[];
  models: ProviderModelConfig[];
};

export const LOCKED_ENVELOPE_MAX_TOKENS = 131_072;

/**
 * Ark Agent Plan gateway. Its contract is fixed:
 * `max_tokens` pinned at 131072, `thinking:{type:"enabled"}` mandatory, path
 * kept verbatim (no `/v1`), `response_format` accepted-then-ignored.
 */
export const ARK_PLAN_PRESET: Omit<ProviderConfig, "id" | "models"> = {
  label: "Ark Agent Plan (plan/v3)",
  apiKind: "openai_chat",
  baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions",
  apiKey: "",
  appendV1: false,
  lockedEnvelope: true,
  structuredOutput: false,
  stream: true,
  userAgent: DEFAULT_OUTBOUND_USER_AGENT,
  conversationId: "",
  maxTokens: LOCKED_ENVELOPE_MAX_TOKENS,
  temperature: undefined,
  reasoningEffort: "medium",
  thinkingMode: "enabled",
  thinkingBudgetTokens: undefined,
  params: [],
  headers: [],
};

export const PROVIDER_PRESETS: ReadonlyArray<{
  key: string;
  label: string;
  hint: string;
  config: Omit<ProviderConfig, "id" | "models">;
  models: string[];
}> = [
  {
    key: "ark_plan",
    label: "Ark Agent Plan (plan/v3)",
    hint: "Locked envelope: max_tokens=131072, thinking enabled, path verbatim.",
    config: ARK_PLAN_PRESET,
    models: ["ark-code-latest"],
  },
  {
    key: "openai",
    label: "OpenAI",
    hint: "Chat Completions with /v1 appended.",
    config: {
      ...ARK_PLAN_PRESET,
      label: "OpenAI",
      apiKind: "openai_chat",
      baseUrl: "https://api.openai.com",
      appendV1: true,
      lockedEnvelope: false,
      structuredOutput: true,
      maxTokens: 32_768,
      reasoningEffort: "none",
      thinkingMode: "omit",
    },
    models: [],
  },
  {
    key: "anthropic",
    label: "Anthropic",
    hint: "Messages API; thinking uses a token budget.",
    config: {
      ...ARK_PLAN_PRESET,
      label: "Anthropic",
      apiKind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      appendV1: true,
      lockedEnvelope: false,
      structuredOutput: false,
      maxTokens: 64_000,
      reasoningEffort: "none",
      thinkingMode: "budget",
      thinkingBudgetTokens: 32_000,
    },
    models: [],
  },
  {
    key: "openai_responses",
    label: "OpenAI Responses API",
    hint: "POST /responses instead of /chat/completions.",
    config: {
      ...ARK_PLAN_PRESET,
      label: "OpenAI Responses",
      apiKind: "openai_responses",
      baseUrl: "https://api.openai.com",
      appendV1: true,
      lockedEnvelope: false,
      structuredOutput: true,
      maxTokens: 32_768,
      reasoningEffort: "medium",
      thinkingMode: "omit",
    },
    models: [],
  },
];

/**
 * Infers the JSON value from raw text, the way a user typing into a key/value
 * box expects: `{...}`/`[...]` parse as JSON, `true`/`false`/`null` as
 * literals, bare numbers as numbers, everything else stays a string.
 *
 * Only strict, unambiguous forms convert. Notably a numeric-looking string is
 * only converted when it round-trips exactly (`String(Number(v)) === v`), so
 * `007`, `1.50`, and `1e999` stay strings rather than silently changing value.
 */
export function inferCustomParamValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const first = trimmed[0];
  if (first === "{" || first === "[") {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      // Malformed JSON object/array: fall through and send it as a string
      // rather than rejecting the whole request.
      return raw;
    }
  }

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;

  if (/^-?\d+(\.\d+)?$/.test(trimmed) && String(Number(trimmed)) === trimmed) {
    return Number(trimmed);
  }

  return raw;
}

/** Parses a {@link CustomParam} value into the JSON value to send. */
export function parseCustomParamValue(param: CustomParam): unknown {
  switch (param.type) {
    case "number": {
      const parsed = Number(param.value);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Parameter '${param.key}' is not a valid number: ${param.value}`);
      }
      return parsed;
    }
    case "boolean": {
      const normalized = param.value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off"].includes(normalized)) return false;
      throw new Error(`Parameter '${param.key}' is not a valid boolean: ${param.value}`);
    }
    case "json": {
      try {
        return JSON.parse(param.value) as unknown;
      } catch {
        throw new Error(`Parameter '${param.key}' is not valid JSON: ${param.value}`);
      }
    }
    case "string":
      return param.value;
    default:
      return inferCustomParamValue(param.value);
  }
}

/**
 * Assigns a possibly-dotted key into a body object, creating intermediate
 * objects. Enables `stream_options.include_usage` style params without a
 * dedicated UI for nesting.
 */
export function assignDeep(target: Record<string, unknown>, key: string, value: unknown): void {
  const segments = key.split(".").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return;

  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const existing = cursor[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
}

/**
 * A key whose value a custom parameter replaced.
 *
 * Surfaced to the caller (trace + debug log) because a silent override is a
 * debugging trap: someone pins `max_tokens` in Custom Body, the gateway rejects
 * it, and nothing in the UI explains why the locked value did not apply.
 */
export type CustomParamOverride = {
  key: string;
  previous: unknown;
  next: unknown;
};

/** Reads a possibly-dotted key, returning `undefined` when absent. */
function readDeep(source: Record<string, unknown>, key: string): unknown {
  const segments = key.split(".").map((segment) => segment.trim()).filter(Boolean);
  let cursor: unknown = source;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Applies every enabled param, in order, to a request body.
 *
 * Custom params are the LAST word on any key they name — including keys the
 * adapter or the locked-envelope preset already set. That is the point of the
 * feature: it is the escape hatch for parameters MineBench has no preset for,
 * and for correcting one it gets wrong for a given gateway.
 *
 * Returns the collisions so callers can report them.
 */
export function applyCustomParams(
  body: Record<string, unknown>,
  params: readonly CustomParam[] | undefined,
): CustomParamOverride[] {
  const overrides: CustomParamOverride[] = [];
  for (const param of params ?? []) {
    if (!param.enabled) continue;
    const key = param.key.trim();
    if (!key) continue;

    const next = parseCustomParamValue(param);
    const previous = readDeep(body, key);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(next)) {
      overrides.push({ key, previous, next });
    }
    assignDeep(body, key, next);
  }
  return overrides;
}

/** Merges provider-level defaults with a model's overrides. */
export type EffectiveModelSettings = {
  modelId: string;
  displayName: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort: ReasoningEffortChoice;
  thinkingMode: ThinkingMode;
  thinkingBudgetTokens?: number;
  params: CustomParam[];
};

export function effectiveModelSettings(
  provider: Pick<
    ProviderConfig,
    | "maxTokens"
    | "temperature"
    | "reasoningEffort"
    | "thinkingMode"
    | "thinkingBudgetTokens"
    | "params"
    | "lockedEnvelope"
  >,
  model: ProviderModelConfig,
): EffectiveModelSettings {
  const requestedMaxTokens = model.maxTokens ?? provider.maxTokens;
  // The locked envelope is a hard ceiling, not a default: a caller-supplied
  // larger value would be rejected by the gateway with a 400.
  const maxTokens = provider.lockedEnvelope
    ? Math.min(requestedMaxTokens ?? LOCKED_ENVELOPE_MAX_TOKENS, LOCKED_ENVELOPE_MAX_TOKENS)
    : requestedMaxTokens;

  return {
    modelId: model.modelId,
    displayName: model.displayName?.trim() || model.modelId,
    maxTokens,
    temperature: model.temperature ?? provider.temperature,
    reasoningEffort: model.reasoningEffort ?? provider.reasoningEffort,
    // Locked-envelope gateways require thinking to be on, always.
    thinkingMode: provider.lockedEnvelope
      ? "enabled"
      : (model.thinkingMode ?? provider.thinkingMode),
    thinkingBudgetTokens: model.thinkingBudgetTokens ?? provider.thinkingBudgetTokens,
    // Model params win on key collision because they are the more specific scope.
    params: [...(provider.params ?? []), ...(model.params ?? [])],
  };
}
