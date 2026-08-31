// Transport for user-configured providers.
//
// Handles all three API flavours behind one entry point and captures a complete
// request/response record for the debug log. The SSRF guard is applied to every
// outbound URL exactly as the original custom channel did — a configurable
// provider list widens what an operator can point at, so weakening the guard
// here would turn a convenience feature into a server-side request forgery
// vector.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { randomUUID } from "node:crypto";
import type { ClientRequest, IncomingHttpHeaders, RequestOptions } from "node:http";

import { attachAbortSignal } from "@/lib/ai/providers/abort";
import {
  resolveCustomApiTarget,
  type ProviderEndpointKind,
  type ResolvedCustomApiTarget,
} from "@/lib/ai/providers/customApiGuard";
import {
  authHeadersForProvider,
  buildProviderRequestBody,
  normalizeUsage,
} from "@/lib/ai/providerRequest";
import type {
  ProviderExchangeLog,
  ProviderUsage,
} from "@/lib/ai/providerExchangeLog";
import type { ProviderConfig, ProviderModelConfig } from "@/lib/ai/providerConfig";
import { resolveOutboundUserAgent } from "@/lib/ai/userAgent";

/** Header names whose values must never reach a log, a client, or a disk. */
const REDACTED_HEADERS = new Set(["authorization", "x-api-key", "api-key", "proxy-authorization"]);

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = REDACTED_HEADERS.has(name.toLowerCase()) ? "«redacted»" : value;
  }
  return result;
}

/**
 * Full record of one provider round-trip, used by the debug log panel.
 * `requestHeaders` is always redacted before it leaves this module.
 *
 * Re-exported for convenience; the definition lives in a client-safe module so
 * UI components can import it without dragging node builtins into their graph.
 */
export type { ProviderExchangeLog, ProviderUsage };

type NodeHttpResponse = {
  status: number;
  headers: Headers;
  body: AsyncIterable<string | Buffer | Uint8Array>;
};

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

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    result[name] = value;
  });
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

function request(params: {
  target: ResolvedCustomApiTarget;
  method: "POST" | "GET";
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
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

    const options: RequestOptions = {
      method: params.method,
      // Connect to the address the guard already validated, so DNS cannot be
      // re-resolved to a private IP between the check and the connection.
      hostname: params.target.address,
      family: params.target.family,
      port,
      path: `${params.target.url.pathname}${params.target.url.search}`,
      headers: params.headers,
    };

    const abort = () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      req.destroy(error);
    };
    const cleanup = () => params.signal.removeEventListener("abort", abort);

    params.onProviderRequest?.();

    const onResponse = (res: import("node:http").IncomingMessage) => {
      res.once("end", cleanup);
      res.once("close", cleanup);
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
      cleanup();
      reject(error);
    });
    params.signal.addEventListener("abort", abort, { once: true });
    if (params.body !== undefined) req.write(params.body);
    req.end();
  });
}

async function consumeSse(
  body: AsyncIterable<string | Buffer | Uint8Array>,
  onEvent: (evt: { event?: string; data: string }) => void,
  onRaw?: (chunk: string) => void,
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
      if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
    }
    const data = dataLines.join("\n");
    if (!data) return;
    onEvent({ event, data });
  };

  for await (const chunk of body) {
    const text = chunkToUtf8(chunk);
    onRaw?.(text);
    buffer += text;
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

/**
 * Pulls the assistant text / reasoning text out of one streamed frame for
 * whichever flavour produced it. Reasoning is routed separately so chain-of-
 * thought never corrupts the JSON payload we later parse.
 *
 * Exported for tests: the three flavours emit genuinely different frame shapes
 * and getting one wrong silently truncates output, so each is asserted directly
 * rather than only through a live round-trip.
 */
export function applyStreamFrame(
  apiKind: ProviderConfig["apiKind"],
  data: string,
  sink: {
    onText: (delta: string) => void;
    onReasoning: (delta: string) => void;
    onUsage: (usage: ProviderUsage) => void;
  },
): void {
  if (data === "[DONE]") return;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }

  if (apiKind === "anthropic") {
    const type = parsed.type;
    if (type === "content_block_delta") {
      const delta = parsed.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        sink.onText(delta.text);
      } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
        sink.onReasoning(delta.thinking);
      }
      return;
    }
    if (type === "message_start") {
      const message = parsed.message as Record<string, unknown> | undefined;
      const usage = normalizeUsage(message?.usage);
      if (usage) sink.onUsage(usage);
      return;
    }
    if (type === "message_delta") {
      const usage = normalizeUsage(parsed.usage);
      if (usage) sink.onUsage(usage);
    }
    return;
  }

  if (apiKind === "openai_responses") {
    const type = parsed.type;
    if (type === "response.output_text.delta" && typeof parsed.delta === "string") {
      sink.onText(parsed.delta);
      return;
    }
    if (
      (type === "response.reasoning_summary_text.delta" ||
        type === "response.reasoning_text.delta") &&
      typeof parsed.delta === "string"
    ) {
      sink.onReasoning(parsed.delta);
      return;
    }
    if (type === "response.completed") {
      const response = parsed.response as Record<string, unknown> | undefined;
      const usage = normalizeUsage(response?.usage);
      if (usage) sink.onUsage(usage);
    }
    return;
  }

  // openai_chat
  const choices = parsed.choices as
    | { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }[]
    | undefined;
  const delta = choices?.[0]?.delta;
  if (delta) {
    if (typeof delta.content === "string" && delta.content) sink.onText(delta.content);
    // Ark sends reasoning_content as a SIBLING of content; some gateways use
    // `reasoning`. Both must bypass the text channel.
    const reasoning =
      typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
          ? delta.reasoning
          : null;
    if (reasoning) sink.onReasoning(reasoning);
  }
  const usage = normalizeUsage(parsed.usage);
  if (usage) sink.onUsage(usage);
}

/** Extracts text/reasoning from a non-streamed response of any flavour. */
export function extractNonStreamed(
  apiKind: ProviderConfig["apiKind"],
  json: unknown,
): { text: string; reasoningText: string; usage: ProviderUsage | null } {
  const root = (json ?? {}) as Record<string, unknown>;

  if (apiKind === "anthropic") {
    const content = root.content as { type?: string; text?: string; thinking?: string }[] | undefined;
    let text = "";
    let reasoningText = "";
    for (const block of content ?? []) {
      if (block.type === "text" && typeof block.text === "string") text += block.text;
      if (block.type === "thinking" && typeof block.thinking === "string") {
        reasoningText += block.thinking;
      }
    }
    return { text, reasoningText, usage: normalizeUsage(root.usage) };
  }

  if (apiKind === "openai_responses") {
    let text = "";
    let reasoningText = "";
    if (typeof root.output_text === "string") text += root.output_text;
    const output = root.output as
      | {
          type?: string;
          content?: { type?: string; text?: string }[];
          summary?: { type?: string; text?: string }[];
        }[]
      | undefined;
    for (const item of output ?? []) {
      if (item.type === "message") {
        for (const part of item.content ?? []) {
          if (part.type === "output_text" && typeof part.text === "string" && !root.output_text) {
            text += part.text;
          }
        }
      }
      if (item.type === "reasoning") {
        for (const part of item.summary ?? []) {
          if (typeof part.text === "string") reasoningText += part.text;
        }
      }
    }
    return { text, reasoningText, usage: normalizeUsage(root.usage) };
  }

  const choices = root.choices as
    | { message?: { content?: unknown; reasoning_content?: unknown } }[]
    | undefined;
  const message = choices?.[0]?.message;
  const content = message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => String(part ?? "")).join("")
        : "";
  const reasoningText =
    typeof message?.reasoning_content === "string" ? message.reasoning_content : "";
  return { text, reasoningText, usage: normalizeUsage(root.usage) };
}

const ENDPOINT_FOR_KIND: Record<ProviderConfig["apiKind"], ProviderEndpointKind> = {
  openai_chat: "chat_completions",
  openai_responses: "responses",
  anthropic: "messages",
};

export type ConfiguredProviderResult = {
  text: string;
  reasoningText: string;
  usage: ProviderUsage | null;
  log: ProviderExchangeLog;
};

/**
 * Sends one generation request through a configured provider.
 *
 * Unlike the catalog providers there is no token-budget ladder: an operator
 * configured these values explicitly, and silently retrying with a different
 * `max_tokens` than what the UI displays would make the debug log a lie.
 */
export async function configuredProviderGenerateText(params: {
  provider: ProviderConfig;
  model: ProviderModelConfig;
  system: string;
  user: string;
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onUsage?: (usage: ProviderUsage) => void;
  onLog?: (log: ProviderExchangeLog) => void;
  onTrace?: (message: string) => void;
}): Promise<ConfiguredProviderResult> {
  const { provider } = params;
  const built = buildProviderRequestBody({
    provider,
    model: params.model,
    system: params.system,
    user: params.user,
    jsonSchema: params.jsonSchema,
  });

  const target = await resolveCustomApiTarget(provider.baseUrl, {
    endpoint: ENDPOINT_FOR_KIND[provider.apiKind],
    appendV1: provider.appendV1,
  });

  // Custom Body outranks the presets by design, but overriding a locked value
  // can make the gateway reject the request — so say so instead of letting the
  // operator hunt for why their preset did not take effect.
  for (const override of built.overrides) {
    params.onTrace?.(
      `Custom Body overrode '${override.key}': ${JSON.stringify(override.previous)} -> ` +
        `${JSON.stringify(override.next)}.`,
    );
  }

  const bodyText = JSON.stringify(built.body);
  const outboundHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: built.stream ? "text/event-stream" : "application/json",
    "User-Agent": resolveOutboundUserAgent(provider.userAgent),
    "X-Conversation-Id": provider.conversationId.trim() || randomUUID(),
    Host: target.url.host,
    "Content-Length": Buffer.byteLength(bodyText).toString(),
    ...authHeadersForProvider(provider.apiKind, provider.apiKey),
    // Operator headers last so they can override the defaults above.
    ...built.headers,
  };

  const log: ProviderExchangeLog = {
    url: target.url.toString(),
    method: "POST",
    requestHeaders: redactHeaders(outboundHeaders),
    requestBody: built.body,
    overrides: built.overrides.length > 0 ? built.overrides : undefined,
    startedAt: Date.now(),
  };
  const finish = (): ProviderExchangeLog => {
    log.durationMs = Date.now() - log.startedAt;
    params.onLog?.(log);
    return log;
  };

  const controller = new AbortController();
  const detachAbort = attachAbortSignal(controller, params.signal);

  let res: NodeHttpResponse;
  try {
    res = await request({
      target,
      method: "POST",
      headers: outboundHeaders,
      body: bodyText,
      signal: controller.signal,
    });
  } catch (error) {
    detachAbort();
    log.error =
      error instanceof Error && error.name === "AbortError"
        ? `${provider.label} request aborted`
        : `${provider.label} request failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
    finish();
    throw new Error(log.error);
  }

  log.status = res.status;
  log.responseHeaders = headersToRecord(res.headers);

  try {
    if (res.status < 200 || res.status >= 300) {
      const errorBody = await readResponseText(res.body).catch(() => "");
      log.responseBodyRaw = errorBody;
      log.error = `${provider.label} error ${res.status}: ${errorBody}`;
      finish();
      throw new Error(log.error);
    }

    if (built.stream) {
      let text = "";
      let reasoningText = "";
      let raw = "";
      let usage: ProviderUsage | null = null;

      await consumeSse(
        res.body,
        (evt) =>
          applyStreamFrame(provider.apiKind, evt.data, {
            onText: (delta) => {
              text += delta;
              params.onDelta?.(delta);
            },
            onReasoning: (delta) => {
              reasoningText += delta;
              params.onReasoningDelta?.(delta);
            },
            onUsage: (value) => {
              usage = value;
              params.onUsage?.(value);
            },
          }),
        (chunk) => {
          raw += chunk;
        },
      );

      log.responseBodyRaw = raw;
      log.responseText = text;
      log.reasoningText = reasoningText;
      log.usage = usage;
      finish();
      return { text, reasoningText, usage, log };
    }

    const raw = await readResponseText(res.body);
    log.responseBodyRaw = raw;
    let json: unknown = null;
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      log.error = `${provider.label} returned a non-JSON response`;
      finish();
      throw new Error(log.error);
    }
    log.responseBodyJson = json;

    const extracted = extractNonStreamed(provider.apiKind, json);
    log.responseText = extracted.text;
    log.reasoningText = extracted.reasoningText;
    log.usage = extracted.usage;
    if (extracted.usage) params.onUsage?.(extracted.usage);
    finish();
    return { ...extracted, log };
  } finally {
    detachAbort();
  }
}

export type FetchedModel = { id: string; displayName?: string };

/**
 * Pulls the provider's model list. Shapes differ per flavour, so all common
 * layouts are accepted rather than failing on an unexpected envelope.
 */
export async function fetchProviderModels(params: {
  provider: Pick<
    ProviderConfig,
    "apiKind" | "baseUrl" | "apiKey" | "appendV1" | "userAgent" | "headers" | "label"
  >;
  signal?: AbortSignal;
}): Promise<{ models: FetchedModel[]; log: ProviderExchangeLog }> {
  const { provider } = params;
  const target = await resolveCustomApiTarget(provider.baseUrl, {
    endpoint: "models",
    appendV1: provider.appendV1,
  });

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": resolveOutboundUserAgent(provider.userAgent),
    Host: target.url.host,
    ...authHeadersForProvider(provider.apiKind, provider.apiKey),
  };
  for (const header of provider.headers ?? []) {
    if (header.enabled && header.name.trim()) headers[header.name.trim()] = header.value;
  }

  const log: ProviderExchangeLog = {
    url: target.url.toString(),
    method: "GET",
    requestHeaders: redactHeaders(headers),
    requestBody: null,
    startedAt: Date.now(),
  };

  const controller = new AbortController();
  const detachAbort = attachAbortSignal(controller, params.signal);

  try {
    const res = await request({
      target,
      method: "GET",
      headers,
      signal: controller.signal,
    });
    log.status = res.status;
    log.responseHeaders = headersToRecord(res.headers);

    const raw = await readResponseText(res.body);
    log.responseBodyRaw = raw;

    if (res.status < 200 || res.status >= 300) {
      log.error = `${provider.label} model list error ${res.status}: ${raw}`;
      log.durationMs = Date.now() - log.startedAt;
      throw new Error(log.error);
    }

    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      log.error = `${provider.label} returned a non-JSON model list`;
      log.durationMs = Date.now() - log.startedAt;
      throw new Error(log.error);
    }
    log.responseBodyJson = json;
    log.durationMs = Date.now() - log.startedAt;

    const root = json as Record<string, unknown>;
    const candidates =
      (Array.isArray(root.data) && root.data) ||
      (Array.isArray(root.models) && root.models) ||
      (Array.isArray(json) && json) ||
      [];

    const models: FetchedModel[] = [];
    for (const entry of candidates as unknown[]) {
      if (typeof entry === "string") {
        models.push({ id: entry });
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const id =
        (typeof record.id === "string" && record.id) ||
        (typeof record.name === "string" && record.name) ||
        (typeof record.model === "string" && record.model) ||
        null;
      if (!id) continue;
      const displayName =
        (typeof record.display_name === "string" && record.display_name) ||
        (typeof record.displayName === "string" && record.displayName) ||
        undefined;
      models.push({ id, displayName });
    }

    // Stable order keeps the UI list from reshuffling between refreshes.
    models.sort((a, b) => a.id.localeCompare(b.id));
    return { models, log };
  } finally {
    detachAbort();
  }
}
