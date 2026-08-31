// Server-side validation for user-configured providers.
//
// These configs arrive from the browser, so every field is validated before any
// of it influences an outbound request. Bounds are deliberately generous but
// finite: the goal is to reject malformed/hostile payloads and cap memory, not
// to second-guess an operator's legitimate endpoint.

import { z } from "zod";
import {
  PROVIDER_API_KINDS,
  REASONING_EFFORT_CHOICES,
  THINKING_MODES,
  type ProviderConfig,
} from "@/lib/ai/providerConfig";

const customParamSchema = z.object({
  key: z.string().trim().min(1).max(120),
  type: z.enum(["auto", "string", "number", "boolean", "json"]),
  value: z.string().max(20_000),
  enabled: z.boolean(),
});

const customHeaderSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    // RFC 7230 token: blocks header injection via CR/LF or separators.
    .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "Invalid header name"),
  value: z.string().max(4000).regex(/^[^\r\n]*$/, "Header value must not contain newlines"),
  enabled: z.boolean(),
});

const providerModelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  modelId: z.string().trim().min(1).max(240),
  displayName: z.string().trim().max(160).optional(),
  enabled: z.boolean(),
  maxTokens: z.number().int().positive().max(4_000_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  reasoningEffort: z.enum(REASONING_EFFORT_CHOICES).optional(),
  thinkingMode: z.enum(THINKING_MODES).optional(),
  thinkingBudgetTokens: z.number().int().positive().max(4_000_000).optional(),
  params: z.array(customParamSchema).max(64).optional(),
});

export const providerConfigSchema = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(160),
  apiKind: z.enum(PROVIDER_API_KINDS),
  baseUrl: z.string().trim().url().max(4000),
  // May be empty: gateways can authenticate by IP, mTLS, or a custom header.
  apiKey: z.string().max(4000),
  appendV1: z.boolean(),
  lockedEnvelope: z.boolean(),
  structuredOutput: z.boolean(),
  stream: z.boolean(),
  userAgent: z.string().trim().max(400),
  conversationId: z.string().trim().max(200),
  maxTokens: z.number().int().positive().max(4_000_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  reasoningEffort: z.enum(REASONING_EFFORT_CHOICES),
  thinkingMode: z.enum(THINKING_MODES),
  thinkingBudgetTokens: z.number().int().positive().max(4_000_000).optional(),
  params: z.array(customParamSchema).max(64),
  headers: z.array(customHeaderSchema).max(32),
  models: z.array(providerModelSchema).max(64),
}) satisfies z.ZodType<ProviderConfig, z.ZodTypeDef, unknown>;

export type ValidatedProviderConfig = z.infer<typeof providerConfigSchema>;
