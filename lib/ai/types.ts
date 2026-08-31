import type { ModelKey } from "@/lib/ai/modelCatalog";
import type { ProviderConfig } from "@/lib/ai/providerConfig";
import type { ProviderExchangeLog } from "@/lib/ai/providerExchangeLog";
import type { VoxelBuild } from "@/lib/voxel/types";

export type PaletteMode = "simple" | "advanced";

export type ProviderApiKeys = {
  openai?: string;
  anthropic?: string;
  gemini?: string;
  moonshot?: string;
  deepseek?: string;
  minimax?: string;
  xai?: string;
  meta?: string;
  zai?: string;
  openrouter?: string;
  custom?: string;
};

export type AcceptedProviderRequestConfiguration = {
  apiMode: string;
  maxOutputTokens: number;
  reasoningMaxTokens?: number;
  thinkingMode: string;
  temperature: number | "default" | "n/a";
  textVerbosity: string;
  responseFormat: string;
};

// The provider-accepted configuration plus routing identity, recorded as
// structured research provenance alongside the prose trace line
export type AcceptedRequestConfigurationRecord = AcceptedProviderRequestConfiguration & {
  providerRoute: "direct" | "openrouter";
  resolvedModelId: string;
};

export type ProviderTelemetryCallbacks = {
  // Fired immediately before each outbound generation request
  onProviderRequest?: () => void;
  // Fired after the provider accepts the settings used for a response
  onAcceptedRequestConfiguration?: (
    configuration: AcceptedProviderRequestConfiguration,
  ) => void;
};

export type GenerateModelRequest =
  | {
      id: string;
      kind: "catalog";
      modelKey: ModelKey;
    }
  | {
      /**
       * A model belonging to a user-configured provider. The provider config
       * travels with the request because it is owned by the browser (localStorage),
       * not the server — the server validates it and never persists it.
       */
      id: string;
      kind: "configured";
      providerId: string;
      modelConfigId: string;
    }
  | {
      id: string;
      kind: "custom";
      provider: "custom";
      displayName: string;
      modelId: string;
      baseUrl: string;
      /**
       * Locked-envelope gateway mode: preserves the baseUrl path verbatim
       * (no `/v1` injection), pins max_tokens, always sends
       * thinking:{type:"enabled"}, and skips response_format.
       */
      customGatewayMode?: boolean;
      /**
       * Send response_format=json_schema. Leave off for gateways that accept
       * the field but ignore it (e.g. Ark's /api/plan/v3); enable for standard
       * endpoints that genuinely implement structured output.
       */
      customGatewayStructuredOutput?: boolean;
      reasoningEffort?: string;
      conversationId?: string;
      userAgent?: string;
    }
  | {
      id: string;
      kind: "custom";
      provider: "openrouter";
      displayName: string;
      modelId: string;
    };

export type GenerateRequest = {
  prompt: string;
  gridSize: 64 | 256 | 512;
  palette: PaletteMode;
  modelKeys?: ModelKey[];
  models?: GenerateModelRequest[];
  providerKeys?: ProviderApiKeys;
  /** Configurations referenced by `kind: "configured"` model requests. */
  providerConfigs?: ProviderConfig[];
};

export type GenerateEvent =
  | { type: "hello"; ts: number; pad?: string }
  | { type: "ping"; ts: number }
  | { type: "start"; modelKey: string }
  | { type: "retry"; modelKey: string; attempt: number; reason?: string }
  | { type: "delta"; modelKey: string; delta: string }
  | { type: "reasoning"; modelKey: string; delta: string }
  | {
      type: "usage";
      modelKey: string;
      usage: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        reasoningTokens?: number;
        cachedTokens?: number;
      };
    }
  | { type: "trace"; modelKey: string; message: string }
  | {
      /**
       * Full request/response record for the debug log panel. Emitted for
       * configured providers so a failing generation can be diagnosed without
       * server log access. Auth headers are redacted upstream.
       */
      type: "exchange";
      modelKey: string;
      exchange: ProviderExchangeLog;
    }
  | {
      type: "result";
      modelKey: string;
      voxelBuild: VoxelBuild;
      metrics: {
        blockCount: number;
        warnings: string[];
        generationTimeMs: number;
        jsonBytes: number;
      };
    }
  | { type: "error"; modelKey: string; message: string; rawText?: string };
