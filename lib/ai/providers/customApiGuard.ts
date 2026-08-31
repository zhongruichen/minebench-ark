import dns from "node:dns/promises";
import net from "node:net";

// Resolves and validates user-supplied custom API endpoints before any request
// leaves the server: URL shape, credential and localhost bans, DNS resolution,
// and private/reserved address rejection to prevent SSRF

export type ResolvedCustomApiTarget = {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
};

function normalizeBaseUrl(raw?: string): string {
  const candidate = raw ?? process.env.CUSTOM_API_BASE_URL;
  if (!candidate) {
    throw new Error("Missing custom API server URL");
  }
  const base = candidate
    .trim()
    .replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) {
    return base.slice(0, -"/chat/completions".length);
  }
  return base;
}

function buildChatCompletionsUrl(raw?: string): URL {
  const base = normalizeBaseUrl(raw);
  return new URL(base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`);
}

// Exact-path variant: preserves the operator-supplied path verbatim instead of
// forcing an OpenAI-style `/v1` segment. Required for third-party gateways that
// expose non-standard prefixes (e.g. `/api/plan/v3`), where injecting `/v1`
// would produce a 404. Only `/chat/completions` is appended when absent.
function buildExactChatCompletionsUrl(raw?: string): URL {
  const candidate = raw ?? process.env.CUSTOM_API_BASE_URL;
  if (!candidate) {
    throw new Error("Missing custom API server URL");
  }
  const base = candidate.trim().replace(/\/+$/, "");
  if (!base) {
    throw new Error("Missing custom API server URL");
  }
  return new URL(base.endsWith("/chat/completions") ? base : `${base}/chat/completions`);
}

/**
 * Endpoint kinds a configured provider can be asked to resolve. Kept as a
 * closed union so a typo cannot silently produce a request to an unintended
 * path on the operator's gateway.
 */
export type ProviderEndpointKind =
  | "chat_completions"
  | "responses"
  | "messages"
  | "models";

const ENDPOINT_SUFFIX: Record<ProviderEndpointKind, string> = {
  chat_completions: "/chat/completions",
  responses: "/responses",
  messages: "/messages",
  models: "/models",
};

/**
 * Builds the endpoint URL for a configured provider.
 *
 * `appendV1` is the operator's explicit switch, not a guess: some gateways
 * publish `https://host/v1` (already versioned), some publish `https://host`
 * and expect `/v1` to be added, and some publish a non-standard prefix such as
 * `/api/plan/v3` where injecting `/v1` yields a 404. Guessing from the URL
 * shape is what broke the original `custom` channel, so the decision is
 * surfaced in the UI and honoured verbatim here.
 *
 * If the base URL already ends in the requested endpoint suffix, it is treated
 * as a fully-qualified endpoint and returned as-is (after the `/v1` decision is
 * applied to the remaining prefix), so pasting a complete chat-completions URL
 * keeps working.
 */
export function buildProviderEndpointUrl(params: {
  baseUrl: string;
  endpoint: ProviderEndpointKind;
  appendV1: boolean;
}): URL {
  const raw = params.baseUrl?.trim().replace(/\/+$/, "");
  if (!raw) throw new Error("Missing custom API server URL");

  const suffix = ENDPOINT_SUFFIX[params.endpoint];

  // Already a fully-qualified endpoint of the requested kind: keep it verbatim.
  // Appending `/v1` after the endpoint would be nonsense, so only the prefix is
  // considered and it is by definition already what the operator wants.
  if (raw.toLowerCase().endsWith(suffix)) return new URL(raw);

  // A base URL carrying a DIFFERENT known endpoint suffix (e.g. someone pasted
  // `/chat/completions` but we now need `/models`) is rebased onto its parent.
  let base = raw;
  for (const knownSuffix of Object.values(ENDPOINT_SUFFIX)) {
    if (base.toLowerCase().endsWith(knownSuffix)) {
      base = base.slice(0, -knownSuffix.length);
      break;
    }
  }
  base = base.replace(/\/+$/, "");
  if (!base) throw new Error("Missing custom API server URL");

  const needsV1 = params.appendV1 && !/\/v\d+$/i.test(base);
  return new URL(`${base}${needsV1 ? "/v1" : ""}${suffix}`);
}

function normalizeIpAddress(address: string): string {
  const normalized = address.trim().replace(/^\[(.*)\]$/, "$1");
  const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(normalized);
  if (embeddedIpv4) {
    return embeddedIpv4;
  }
  return normalized;
}

function expandIpv6Hextets(address: string): string[] | null {
  const normalized = address.trim().replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (net.isIP(normalized) !== 6) return null;

  let candidate = normalized;
  if (candidate.includes(".")) {
    const lastColon = candidate.lastIndexOf(":");
    if (lastColon < 0) return null;
    const ipv4Part = candidate.slice(lastColon + 1);
    if (net.isIP(ipv4Part) !== 4) return null;
    const octets = ipv4Part.split(".").map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    candidate = `${candidate.slice(0, lastColon)}:${high}:${low}`;
  }

  const hasCompression = candidate.includes("::");
  if (hasCompression && candidate.indexOf("::") !== candidate.lastIndexOf("::")) {
    return null;
  }

  const [leftRaw = "", rightRaw = ""] = candidate.split("::");
  const left = leftRaw ? leftRaw.split(":").filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(":").filter(Boolean) : [];
  const isHex = (part: string) => /^[0-9a-f]{1,4}$/.test(part);
  if (left.some((part) => !isHex(part)) || right.some((part) => !isHex(part))) {
    return null;
  }

  if (!hasCompression) {
    if (left.length !== 8) return null;
    return left.map((part) => part.padStart(4, "0"));
  }

  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [
    ...left.map((part) => part.padStart(4, "0")),
    ...Array.from({ length: missing }, () => "0000"),
    ...right.map((part) => part.padStart(4, "0")),
  ];
}

function extractEmbeddedIpv4FromIpv6(address: string): string | null {
  const hextets = expandIpv6Hextets(address);
  if (!hextets) return null;

  const isCompatible =
    hextets.slice(0, 6).every((part) => part === "0000");
  const isMapped =
    hextets.slice(0, 5).every((part) => part === "0000") && hextets[5] === "ffff";
  if (!isCompatible && !isMapped) return null;

  const high = Number.parseInt(hextets[6], 16);
  const low = Number.parseInt(hextets[7], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function isDisallowedIpAddress(address: string): boolean {
  const normalizedAddress = normalizeIpAddress(address);
  const family = net.isIP(normalizedAddress);
  if (family === 4) {
    const parts = normalizedAddress.split(".").map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return true;
    }
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && parts[2] === 100) ||
      (a === 203 && b === 0 && parts[2] === 113) ||
      a >= 224
    );
  }
  if (family === 6) {
    const normalized = normalizedAddress.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8")
    );
  }
  return true;
}

function isDnsLookupError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) return false;
  return (
    "code" in error &&
    (error.code === "ENOTFOUND" ||
      error.code === "EAI_AGAIN" ||
      error.code === "ENODATA" ||
      error.code === "ESERVFAIL")
  );
}

// Operator-controlled allowlist of hostnames whose resolved addresses skip the
// private/reserved-range rejection. Needed when a legitimate public gateway is
// reached through a local DNS proxy or split-horizon resolver that answers with
// addresses inside a reserved block (e.g. iSH/VPN resolvers returning
// 198.18.0.0/15). URL shape, credential, and protocol checks still apply.
//
// Format: CUSTOM_API_TRUSTED_HOSTS="ark.cn-beijing.volces.com,gw.example.com"
function trustedHostnames(): Set<string> {
  const raw = process.env.CUSTOM_API_TRUSTED_HOSTS;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isTrustedHostname(hostname: string): boolean {
  const trusted = trustedHostnames();
  if (trusted.size === 0) return false;
  if (trusted.has(hostname)) return true;
  // Allow one level of explicit suffix matching via a leading dot entry.
  for (const entry of trusted) {
    if (entry.startsWith(".") && hostname.endsWith(entry)) return true;
  }
  return false;
}

export async function resolveCustomApiTarget(
  rawUrl: string,
  options?: {
    exactPath?: boolean;
    /**
     * Resolve a specific endpoint kind via {@link buildProviderEndpointUrl}
     * instead of the legacy chat-completions-only path logic. When set,
     * `appendV1` decides the `/v1` segment explicitly and `exactPath` is
     * ignored (the endpoint builder already preserves the operator path).
     */
    endpoint?: ProviderEndpointKind;
    appendV1?: boolean;
  },
): Promise<ResolvedCustomApiTarget> {
  if (!rawUrl.trim()) {
    throw new Error("Missing custom API server URL");
  }

  let url: URL;
  try {
    url = options?.endpoint
      ? buildProviderEndpointUrl({
          baseUrl: rawUrl,
          endpoint: options.endpoint,
          appendV1: Boolean(options.appendV1),
        })
      : options?.exactPath
        ? buildExactChatCompletionsUrl(rawUrl)
        : buildChatCompletionsUrl(rawUrl);
  } catch {
    throw new Error("Invalid custom API server URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Custom API server URL must use http or https");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("Custom API server URL must use https in production");
  }
  if (url.username || url.password) {
    throw new Error("Custom API server URL must not include embedded credentials");
  }

  const hostname = normalizeIpAddress(url.hostname.trim().toLowerCase());
  if (!hostname) {
    throw new Error("Custom API server URL is missing a hostname");
  }
  if (
    hostname === "localhost" ||
    hostname === "localhost.localdomain" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error("Custom API server URL must not target localhost or local network hosts");
  }
  if (!hostname.includes(".") && net.isIP(hostname) === 0) {
    throw new Error("Custom API server URL must use a public hostname");
  }

  const hostFamily = net.isIP(hostname);
  if (hostFamily !== 0) {
    const normalizedAddress = normalizeIpAddress(hostname);
    if (isDisallowedIpAddress(normalizedAddress)) {
      throw new Error("Custom API server URL must not target private or loopback IPs");
    }
    return {
      url,
      hostname,
      address: normalizedAddress,
      family: net.isIP(normalizedAddress) as 4 | 6,
    };
  }

  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) {
      throw new Error("Custom API server URL hostname did not resolve");
    }

    const normalizedRecords = records.map((record) => ({
      address: normalizeIpAddress(record.address),
      family: net.isIP(normalizeIpAddress(record.address)),
    }));
    // An explicitly trusted hostname may resolve into a reserved range when a
    // local DNS proxy is in play; the operator has vouched for this host.
    const trusted = isTrustedHostname(hostname);
    if (
      !trusted &&
      normalizedRecords.some(
        (record) => record.family === 0 || isDisallowedIpAddress(record.address),
      )
    ) {
      throw new Error("Custom API server URL resolved to a private or loopback address");
    }
    if (trusted && normalizedRecords.every((record) => record.family === 0)) {
      throw new Error("Custom API server URL hostname did not resolve");
    }

    const selected = trusted
      ? (normalizedRecords.find((record) => record.family !== 0) ?? normalizedRecords[0])
      : normalizedRecords[0];
    if (!selected) {
      throw new Error("Custom API server URL hostname did not resolve");
    }

    return {
      url,
      hostname,
      address: selected.address,
      family: selected.family as 4 | 6,
    };
  } catch (error) {
    if (isDnsLookupError(error)) {
      throw new Error("Custom API server URL hostname did not resolve");
    }
    if (error instanceof Error) throw error;
    throw new Error("Failed to validate custom API server URL");
  }
}

export async function assertSafeCustomApiUrl(
  rawUrl: string,
  options?: {
    exactPath?: boolean;
    endpoint?: ProviderEndpointKind;
    appendV1?: boolean;
  },
): Promise<void> {
  await resolveCustomApiTarget(rawUrl, options);
}
