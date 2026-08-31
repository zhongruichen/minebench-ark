// Browser-side persistence and helpers for user-configured providers.
//
// Provider configs (including API keys) live ONLY in the browser's
// localStorage; the server receives them per request and never writes them to
// disk or a database. That mirrors how the existing provider keys are handled
// and keeps the trust boundary unchanged.

import {
  ARK_PLAN_PRESET,
  type ProviderConfig,
  type ProviderModelConfig,
} from "@/lib/ai/providerConfig";

export const PROVIDER_STORE_KEY = "mb_provider_configs_v1";

export type ProviderStore = {
  providers: ProviderConfig[];
  /** Model selections for battle mode: `${providerId}:${modelConfigId}`. */
  selected: string[];
};

export function selectionKey(providerId: string, modelConfigId: string): string {
  return `${providerId}:${modelConfigId}`;
}

export function parseSelectionKey(key: string): { providerId: string; modelConfigId: string } | null {
  const index = key.indexOf(":");
  if (index <= 0 || index === key.length - 1) return null;
  return { providerId: key.slice(0, index), modelConfigId: key.slice(index + 1) };
}

/** crypto.randomUUID is unavailable on older/insecure-origin browsers. */
export function newId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${random}`;
}

export function createProvider(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    ...ARK_PLAN_PRESET,
    id: newId("prov"),
    label: "New provider",
    baseUrl: "",
    apiKey: "",
    lockedEnvelope: false,
    maxTokens: undefined,
    reasoningEffort: "none",
    thinkingMode: "omit",
    models: [],
    params: [],
    headers: [],
    ...overrides,
  };
}

export function createModelConfig(modelId: string, displayName?: string): ProviderModelConfig {
  return {
    id: newId("model"),
    modelId,
    displayName,
    enabled: true,
  };
}

const EMPTY_STORE: ProviderStore = { providers: [], selected: [] };

/**
 * Reads the store, tolerating older/partial shapes: a provider config gains
 * fields over time and a user's saved copy must never hard-fail the page.
 */
export function loadProviderStore(): ProviderStore {
  if (typeof window === "undefined") return EMPTY_STORE;
  try {
    const raw = window.localStorage.getItem(PROVIDER_STORE_KEY);
    if (!raw) return EMPTY_STORE;
    const parsed = JSON.parse(raw) as Partial<ProviderStore> | null;
    if (!parsed || !Array.isArray(parsed.providers)) return EMPTY_STORE;

    const providers = parsed.providers.map((provider) => ({
      ...ARK_PLAN_PRESET,
      ...provider,
      // Normalize the collections so the UI can map over them unconditionally.
      params: Array.isArray(provider?.params) ? provider.params : [],
      headers: Array.isArray(provider?.headers) ? provider.headers : [],
      models: Array.isArray(provider?.models)
        ? provider.models.map((model) => ({ ...model, enabled: model?.enabled !== false }))
        : [],
    })) as ProviderConfig[];

    return {
      providers,
      selected: Array.isArray(parsed.selected) ? parsed.selected.filter((k) => typeof k === "string") : [],
    };
  } catch {
    return EMPTY_STORE;
  }
}

export function saveProviderStore(store: ProviderStore): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROVIDER_STORE_KEY, JSON.stringify(store));
  } catch {
    // Quota exceeded or storage disabled: the in-memory state stays correct for
    // this session, which is better than throwing out of a state setter.
  }
}

/** Selections whose provider/model no longer exists, so callers can prune. */
export function validSelections(store: ProviderStore): string[] {
  const known = new Set<string>();
  for (const provider of store.providers) {
    for (const model of provider.models) {
      if (model.enabled) known.add(selectionKey(provider.id, model.id));
    }
  }
  return store.selected.filter((key) => known.has(key));
}

/** Human-readable problems that would make a generation request fail. */
export function providerConfigIssues(provider: ProviderConfig): string[] {
  const issues: string[] = [];
  if (!provider.label.trim()) issues.push("Label is required.");
  if (!provider.baseUrl.trim()) {
    issues.push("Base URL is required.");
  } else {
    try {
      const url = new URL(provider.baseUrl.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        issues.push("Base URL must use http or https.");
      }
    } catch {
      issues.push("Base URL is not a valid URL.");
    }
  }
  if (provider.models.length === 0) issues.push("Add at least one model.");
  if (provider.models.some((model) => !model.modelId.trim())) {
    issues.push("Every model needs a model id.");
  }
  for (const param of provider.params) {
    if (!param.enabled) continue;
    if (param.type === "number" && !Number.isFinite(Number(param.value))) {
      issues.push(`Parameter '${param.key}' is not a valid number.`);
    }
    if (param.type === "json") {
      try {
        JSON.parse(param.value);
      } catch {
        issues.push(`Parameter '${param.key}' is not valid JSON.`);
      }
    }
  }
  return issues;
}
