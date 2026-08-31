// Single source of truth for the outbound client attribution header.
//
// Third-party gateways frequently gate features (or route traffic) on the
// User-Agent string, so it must be identical everywhere: the runtime provider
// adapters, the standalone probe/bench scripts, and the UI defaults. Changing
// it in one place only would produce a fleet where some requests are attributed
// differently than others — which is exactly the class of bug that is painful
// to notice and painful to debug.
//
// Override per request from the UI (or via CUSTOM_API_USER_AGENT) when a
// specific gateway needs something else.
export const DEFAULT_OUTBOUND_USER_AGENT = "claude-cli/2.1.179 (external, cli)";

/** Resolves the UA to send: explicit value > env override > project default. */
export function resolveOutboundUserAgent(explicit?: string | null): string {
  const trimmedExplicit = explicit?.trim();
  if (trimmedExplicit) return trimmedExplicit;
  const fromEnv = process.env.CUSTOM_API_USER_AGENT?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_OUTBOUND_USER_AGENT;
}
