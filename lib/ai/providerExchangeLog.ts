// Wire type for the request/response debug log.
//
// Kept in its own module (rather than beside the transport that produces it)
// because the log is rendered by client components. Importing it from
// `providers/configuredProvider.ts` would pull `node:http`, `node:dns`, and
// friends into the browser bundle's type graph.

export type ProviderExchangeLog = {
  url: string;
  method: "POST" | "GET";
  /** Auth headers are replaced with a placeholder before this leaves the server. */
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  status?: number;
  responseHeaders?: Record<string, string>;
  /** Raw response text: concatenated SSE frames when streaming. */
  responseBodyRaw?: string;
  /** Parsed JSON response for non-streamed calls. */
  responseBodyJson?: unknown;
  /** Assembled assistant text. */
  responseText?: string;
  /** Assembled chain-of-thought, kept out of responseText. */
  reasoningText?: string;
  usage?: ProviderUsage | null;
  startedAt: number;
  durationMs?: number;
  error?: string;
};

export type ProviderUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
};
