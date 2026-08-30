// Adapter for OpenAI-compatible third-party gateways that require a LOCKED
// request envelope. Built for endpoints such as:
//   https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions
//
// IMPORTANT SCOPE NOTE: the limitations below are properties of THIS gateway
// (Volcengine Ark's *Agent Plan* prefix, `/api/plan/v3`), NOT of Ark as a
// platform. Ark's standard inference endpoint (`/api/v3`) documents full
// structured-output support (json_schema + json_object, beta). They are
// different surfaces with different keys and different model allowlists:
//   * `/api/plan/v3` accepts only agent-plan models (e.g. `ark-code-latest`);
//     requesting `doubao-seed-1-6-251015` there returns
//     `UnsupportedModel: does not support the agent plan feature`.
//   * A plan-scoped key returns 401 on `/api/v3`, so the documented
//     structured-output path is not reachable with it.
// If you point this adapter at a standard `/api/v3` deployment with a matching
// key, prefer `openaiCompatible.ts` instead — that path does send
// `response_format` and can use real structured output.
//
// Behaviour verified against the live plan endpoint (see docs/CUSTOM_PROVIDER.md
// section 2 for the full experiment matrix):
//   * `response_format` is SHAPE-VALIDATED BUT NOT IMPLEMENTED. Sending
//     `response_format: "a string"` correctly fails with
//     `expected an object`, proving the field is parsed — yet a valid
//     json_schema object is accepted and then ignored, returning prose.
//     Unsupported JSON Schema keywords also fail to raise the error the Ark
//     docs promise, and unknown params (`guided_json`, `response_schema`, ...)
//     are likewise accepted silently. Measured: 0/3 runs produced parseable
//     JSON with json_schema, vs 3/3 with prompt discipline alone. So we never
//     send it and rely on prompt discipline + tolerant extraction.
//   * `reasoning_content` arrives as a SIBLING of `content` in stream deltas.
//     It must be routed to a separate channel, otherwise chain-of-thought text
//     corrupts the JSON payload.
//   * `max_tokens` is LOCKED (default 131072) — no token-budget ladder. The
//     upstream accepts it, so descending retries would only waste quota.
//   * `thinking: { type: "enabled" }` is MANDATORY and always sent verbatim.
//   * `model` is echoed back as "auto"; never use it for validation.
//
// Extra headers (X-Conversation-Id, User-Agent) are passed through so the
// gateway's per-conversation routing and client attribution keep working.

import { attachAbortSignal } from "@/lib/ai/providers/abort";
import {
  resolveCustomApiTarget,
  type ResolvedCustomApiTarget,
} from "@/lib/ai/providers/customApiGuard";
import { extractChatCompletionText, withMaxOutputTokens } from "@/lib/ai/providers/shared";
import type { ProviderTelemetryCallbacks } from "@/lib/ai/types";
import http from "node:http";
import https from "node:https";
import type { ClientRequest, IncomingHttpHeaders, RequestOptions } from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";

/** Locked defaults required by the target gateway. */
export const LOCKED_MAX_TOKENS = 131_072;
export const LOCKED_THINKING = { type: "enabled" as const };

export const CUSTOM_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type CustomReasoningEffort = (typeof CUSTOM_REASONING_EFFORTS)[number];

export function isCustomReasoningEffort(value: string): value is CustomReasoningEffort {
  return (CUSTOM_REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * Normalizes a user-supplied reasoning value.
 * Returns `undefined` when the parameter should be omitted entirely
 * (the reference contract explicitly allows omitting `reasoning_effort`).
 */
export function normalizeCustomReasoningEffort(value?: string): CustomReasoningEffort | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "none" || normalized === "omit" || normalized === "default") return undefined;
  if (!isCustomReasoningEffort(normalized)) {
    throw new Error(
      `Unsupported reasoning effort '${value}'. Supported: ${CUSTOM_REASONING_EFFORTS.join(", ")}, or omit.`,
    );
  }
  return normalized;
}

type ChatResponse = {
  choices?: { message?: { content?: unknown; reasoning_content?: unknown } }[];
  usage?: CustomUsage | null;
};

type StreamChunk = {
  choices?: {
    delta?: { content?: unknown; reasoning_content?: unknown };
    finish_reason?: string | null;
  }[];
  usage?: CustomUsage | null;
};

export type CustomUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
};

type NodeHttpResponse = {
  status: number;
  headers: Headers;
  body: AsyncIterable<string | Buffer | Uint8Array>;
};

function requestIdFromHeaders(headers: Headers): string | null {
  return (
    headers.get("x-request-id") ??
    headers.get("request-id") ??
    headers.get("x-tt-logid") ??
    null
  );
}

function headersFromNodeResponse(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
      continue;
    }
    if (typeof value === "string") result.set(name, value);
  }
  return result;
}

function chunkToUtf8(chunk: string | Buffer | Uint8Array): string {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
}

async function readResponseText(
  body: AsyncIterable<string | Buffer | Uint8Array>,
): Promise<string> {
  let text = "";
  for await (const chunk of body) text += chunkToUtf8(chunk);
  return text;
}

async function consumeSseStream(
  body: AsyncIterable<string | Buffer | Uint8Array>,
  onEvent: (evt: { event?: string; data: string }) => void,
): Promise<void> {
  let buffer = "";

  const emitFrame = (frame: string) => {
    const lines = frame.split(/\r?\n/);
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    const data = dataLines.join("\n");
    if (!data) return;
    onEvent({ event, data });
  };

  for await (const chunk of body) {
    buffer += chunkToUtf8(chunk);
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) emitFrame(frame);
  }

  if (buffer.trim()) {
    for (const frame of buffer.split(/\r?\n\r?\n/)) {
      if (frame.trim()) emitFrame(frame);
    }
  }
}

function postJson(params: {
  target: ResolvedCustomApiTarget;
  apiKey: string;
  body: string;
  signal: AbortSignal;
  stream: boolean;
  conversationId?: string;
  userAgent?: string;
  extraHeaders?: Record<string, string>;
  onProviderRequest?: () => void;
}): Promise<NodeHttpResponse> {
  return new Promise<NodeHttpResponse>((resolve, reject) => {
    if (params.signal.aborted) {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }

    const isHttps = params.target.url.protocol === "https:";
    const port = params.target.url.port
      ? Number.parseInt(params.target.url.port, 10)
      : isHttps
        ? 443
        : 80;

    // Header order/name-casing mirrors the reference client (Kelivo).
    const headers: Record<string, string> = {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
      Accept: params.stream ? "text/event-stream" : "application/json",
      "X-Conversation-Id": params.conversationId ?? randomUUID(),
      "User-Agent": params.userAgent ?? "Kelivo",
      Host: params.target.url.host,
      "Content-Length": Buffer.byteLength(params.body).toString(),
      ...(params.extraHeaders ?? {}),
    };

    const options: RequestOptions = {
      method: "POST",
      hostname: params.target.address,
      family: params.target.family,
      port,
      path: `${params.target.url.pathname}${params.target.url.search}`,
      headers,
    };

    const cleanup = (abort: () => void) => {
      params.signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      req.destroy(error);
    };

    params.onProviderRequest?.();

    const onResponse = (res: import("node:http").IncomingMessage) => {
      res.once("end", () => cleanup(abort));
      res.once("close", () => cleanup(abort));
      resolve({
        status: res.statusCode ?? 0,
        headers: headersFromNodeResponse(res.headers),
        body: res,
      });
    };

    const req = (isHttps
      ? https.request(
          {
            ...options,
            servername:
              net.isIP(params.target.hostname) === 0 ? params.target.hostname : undefined,
          },
          onResponse,
        )
      : http.request(options, onResponse)) as ClientRequest;

    req.once("error", (error) => {
      cleanup(abort);
      reject(error);
    });
    params.signal.addEventListener("abort", abort, { once: true });
    req.write(params.body);
    req.end();
  });
}

export type CustomProviderRequestSnapshot = {
  url: string;
  model: string;
  maxTokens: number;
  thinking: { type: "enabled" };
  reasoningEffort?: CustomReasoningEffort;
  stream: boolean;
  streamOptions: { include_usage: true };
};

/**
 * Builds the request body. Exported so tests and the frontend "inspect request"
 * panel can render the exact envelope without duplicating the locking rules.
 */
export const VOXEL_BUILD_JSON_SCHEMA_NAME = "voxel_build_response";

export function buildCustomRequestBody(params: {
  modelId: string;
  system: string;
  user: string;
  stream: boolean;
  maxTokens?: number;
  reasoningEffort?: CustomReasoningEffort;
  temperature?: number;
  /**
   * Opt-in structured output. Left off for the Agent Plan gateway, which
   * shape-validates `response_format` and then ignores it. Enable it when
   * pointing at a standard Ark `/api/v3` deployment (or any gateway that
   * genuinely implements json_schema).
   */
  jsonSchema?: Record<string, unknown>;
}): Record<string, unknown> {
  const messages: { role: string; content: string }[] = [];
  if (params.system.trim()) messages.push({ role: "system", content: params.system });
  messages.push({ role: "user", content: params.user });

  return {
    model: params.modelId,
    messages,
    stream: params.stream,
    // LOCKED — hard-capped at LOCKED_MAX_TOKENS; never negotiated down.
    max_tokens: Math.min(params.maxTokens ?? LOCKED_MAX_TOKENS, LOCKED_MAX_TOKENS),
    // LOCKED — must always be present and enabled.
    thinking: LOCKED_THINKING,
    stream_options: { include_usage: true },
    ...(params.reasoningEffort ? { reasoning_effort: params.reasoningEffort } : {}),
    ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
    ...(params.jsonSchema
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: VOXEL_BUILD_JSON_SCHEMA_NAME,
              strict: true,
              schema: params.jsonSchema,
            },
          },
        }
      : {}),
  };
}

export async function customGatewayGenerateText(
  params: {
    modelId: string;
    apiKey?: string;
    baseUrl?: string;
    system: string;
    user: string;
    /** Locked to 131072 unless explicitly overridden. */
    maxOutputTokens?: number;
    reasoningEffort?: string;
    temperature?: number;
    /**
     * Pass a schema to enable structured output. Ignored by the Agent Plan
     * gateway (see the scope note at the top of this file), so callers targeting
     * that endpoint should leave it undefined.
     */
    jsonSchema?: Record<string, unknown>;
    serviceLabel?: string;
    conversationId?: string;
    userAgent?: string;
    extraHeaders?: Record<string, string>;
    signal?: AbortSignal;
    onDelta?: (delta: string) => void;
    /** Chain-of-thought channel, kept separate from the JSON payload. */
    onReasoningDelta?: (delta: string) => void;
    onUsage?: (usage: CustomUsage) => void;
    onRequestSnapshot?: (snapshot: CustomProviderRequestSnapshot) => void;
    onTrace?: (message: string) => void;
    onAcceptedOutputTokens?: (tokens: number) => void;
  } & ProviderTelemetryCallbacks,
): Promise<{ text: string; reasoningText: string; usage: CustomUsage | null }> {
  const serviceLabel = params.serviceLabel ?? "Custom Gateway";
  const apiKey = params.apiKey ?? process.env.CUSTOM_API_KEY;
  if (!apiKey) throw new Error(`Missing ${serviceLabel} API key`);

  const rawBaseUrl = params.baseUrl ?? process.env.CUSTOM_API_BASE_URL;
  if (!rawBaseUrl) throw new Error(`Missing ${serviceLabel} API server URL`);

  // exactPath: keep `/api/plan/v3` verbatim — do NOT inject `/v1`.
  const target = await resolveCustomApiTarget(rawBaseUrl, { exactPath: true });

  const reasoningEffort = normalizeCustomReasoningEffort(params.reasoningEffort);
  // HARD CAP: the gateway rejects anything above LOCKED_MAX_TOKENS, and callers
  // (generateVoxelBuild) may pass a larger project-wide default. Clamp instead
  // of trusting the caller so the locked contract always holds.
  const requestedTokens = params.maxOutputTokens ?? LOCKED_MAX_TOKENS;
  const maxTokens =
    Number.isFinite(requestedTokens) && requestedTokens > 0
      ? Math.min(Math.floor(requestedTokens), LOCKED_MAX_TOKENS)
      : LOCKED_MAX_TOKENS;
  const stream = Boolean(params.onDelta || params.onReasoningDelta);

  const body = buildCustomRequestBody({
    modelId: params.modelId,
    system: params.system,
    user: params.user,
    stream,
    maxTokens,
    reasoningEffort,
    temperature: params.temperature,
    jsonSchema: params.jsonSchema,
  });

  params.onRequestSnapshot?.({
    url: target.url.toString(),
    model: params.modelId,
    maxTokens,
    thinking: LOCKED_THINKING,
    reasoningEffort,
    stream,
    streamOptions: { include_usage: true },
  });

  const controller = new AbortController();
  const detachAbort = attachAbortSignal(controller, params.signal);

  let res: NodeHttpResponse;
  try {
    // Single attempt: max_tokens is locked, so a budget ladder is pointless.
    res = await postJson({
      target,
      apiKey,
      body: JSON.stringify(body),
      signal: controller.signal,
      stream,
      conversationId: params.conversationId,
      userAgent: params.userAgent,
      extraHeaders: params.extraHeaders,
      onProviderRequest: params.onProviderRequest,
    });
  } catch (err) {
    detachAbort();
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`${serviceLabel} request aborted`);
    }
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "unknown";
    throw new Error(`${serviceLabel} request failed (${code})`);
  }

  try {
    if (res.status < 200 || res.status >= 300) {
      const errBody = await readResponseText(res.body).catch(() => "");
      const rid = requestIdFromHeaders(res.headers);
      throw new Error(
        `${serviceLabel} error ${res.status}${rid ? ` (request ${rid})` : ""}: ${errBody.slice(0, 2000)}`,
      );
    }

    params.onAcceptedOutputTokens?.(maxTokens);
    params.onAcceptedRequestConfiguration?.({
      apiMode: "chat_completions",
      maxOutputTokens: maxTokens,
      thinkingMode: reasoningEffort ? `thinking=enabled,effort=${reasoningEffort}` : "thinking=enabled",
      temperature: params.temperature ?? "default",
      textVerbosity: "default",
      responseFormat: params.jsonSchema ? "json_schema" : "text",
    });
    params.onTrace?.(
      withMaxOutputTokens(
        `${serviceLabel} chat completions in use (thinking enabled${
          reasoningEffort ? `, reasoning_effort=${reasoningEffort}` : ""
        }, ${
          params.jsonSchema
            ? "response_format=json_schema"
            : "no response_format — using tolerant JSON extraction"
        })`,
        maxTokens,
      ),
    );

    if (stream) {
      let text = "";
      let reasoningText = "";
      let usage: CustomUsage | null = null;

      await consumeSseStream(res.body, (evt) => {
        if (evt.data === "[DONE]") return;
        let parsed: StreamChunk | null = null;
        try {
          parsed = JSON.parse(evt.data) as StreamChunk;
        } catch {
          return;
        }
        if (parsed?.usage) {
          usage = parsed.usage;
        }
        const delta = parsed?.choices?.[0]?.delta;
        if (!delta) return;

        // Route reasoning to its own channel so it never pollutes the payload.
        const reasoningChunk = delta.reasoning_content;
        if (typeof reasoningChunk === "string" && reasoningChunk) {
          reasoningText += reasoningChunk;
          params.onReasoningDelta?.(reasoningChunk);
        }

        const contentChunk = delta.content;
        if (typeof contentChunk === "string" && contentChunk) {
          text += contentChunk;
          params.onDelta?.(contentChunk);
        }
      });

      if (usage) params.onUsage?.(usage);
      return { text, reasoningText, usage };
    }

    const raw = await readResponseText(res.body);
    const data = JSON.parse(raw) as ChatResponse;
    const text = extractChatCompletionText(data);
    const reasoningRaw = data.choices?.[0]?.message?.reasoning_content;
    const reasoningText = typeof reasoningRaw === "string" ? reasoningRaw : "";
    const usage = data.usage ?? null;
    if (usage) params.onUsage?.(usage);
    return { text, reasoningText, usage };
  } finally {
    detachAbort();
  }
}
