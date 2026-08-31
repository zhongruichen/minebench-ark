"use client";

import { useCallback, useMemo, useState } from "react";
import {
  PROVIDER_API_KIND_LABELS,
  PROVIDER_API_KINDS,
  PROVIDER_PRESETS,
  REASONING_EFFORT_CHOICES,
  THINKING_MODES,
  type ProviderApiKind,
  type ProviderConfig,
  type ProviderModelConfig,
  type ReasoningEffortChoice,
  type ThinkingMode,
} from "@/lib/ai/providerConfig";
import {
  createModelConfig,
  createProvider,
  newId,
  providerConfigIssues,
  selectionKey,
} from "@/lib/ai/providerStore";
import { CustomRequestEditor } from "@/components/providers/CustomRequestEditor";
import { readClientErrorResponse } from "@/lib/clientErrorResponse";

type Props = {
  providers: ProviderConfig[];
  selected: string[];
  disabled?: boolean;
  onChange: (providers: ProviderConfig[]) => void;
  onSelectedChange: (selected: string[]) => void;
};

const THINKING_MODE_LABELS: Record<ThinkingMode, string> = {
  omit: "Omit thinking field",
  enabled: 'thinking: {type:"enabled"}',
  disabled: 'thinking: {type:"disabled"}',
  budget: 'thinking: {type:"enabled", budget_tokens}',
};

function numberOrUndefined(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function ProviderManager({
  providers,
  selected,
  disabled,
  onChange,
  onSelectedChange,
}: Props) {
  const [openProviderId, setOpenProviderId] = useState<string | null>(null);
  const [fetchState, setFetchState] = useState<
    Record<string, { status: "loading" } | { status: "error"; message: string } | { status: "done"; count: number }>
  >({});
  const [modelFilter, setModelFilter] = useState<Record<string, string>>({});

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const updateProvider = useCallback(
    (id: string, patch: Partial<ProviderConfig>) => {
      onChange(
        providers.map((provider) => (provider.id === id ? { ...provider, ...patch } : provider)),
      );
    },
    [onChange, providers],
  );

  const updateModel = useCallback(
    (providerId: string, modelId: string, patch: Partial<ProviderModelConfig>) => {
      onChange(
        providers.map((provider) =>
          provider.id === providerId
            ? {
                ...provider,
                models: provider.models.map((model) =>
                  model.id === modelId ? { ...model, ...patch } : model,
                ),
              }
            : provider,
        ),
      );
    },
    [onChange, providers],
  );

  const addProvider = (preset?: (typeof PROVIDER_PRESETS)[number]) => {
    const provider = preset
      ? createProvider({
          ...preset.config,
          models: preset.models.map((modelId) => createModelConfig(modelId)),
        })
      : createProvider();
    onChange([...providers, provider]);
    setOpenProviderId(provider.id);
  };

  const removeProvider = (id: string) => {
    onChange(providers.filter((provider) => provider.id !== id));
    // Drop selections that pointed at the removed provider, otherwise battle
    // mode would try to run a model that no longer exists.
    onSelectedChange(selected.filter((key) => !key.startsWith(`${id}:`)));
  };

  const toggleSelection = (providerId: string, modelConfigId: string) => {
    const key = selectionKey(providerId, modelConfigId);
    onSelectedChange(
      selectedSet.has(key) ? selected.filter((entry) => entry !== key) : [...selected, key],
    );
  };

  const fetchModels = async (provider: ProviderConfig) => {
    setFetchState((prev) => ({ ...prev, [provider.id]: { status: "loading" } }));
    try {
      const res = await fetch("/api/providers/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Send the config as-is: the server needs the key and the /v1 decision
        // to build the same URL the generation path will use.
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) {
        const message = await readClientErrorResponse(res, "Failed to fetch model list");
        setFetchState((prev) => ({ ...prev, [provider.id]: { status: "error", message } }));
        return;
      }
      const data = (await res.json()) as { models: { id: string; displayName?: string }[] };
      const existing = new Set(provider.models.map((model) => model.modelId));
      const added = data.models
        .filter((model) => !existing.has(model.id))
        .map((model) => ({ ...createModelConfig(model.id, model.displayName), enabled: false }));
      if (added.length > 0) {
        updateProvider(provider.id, { models: [...provider.models, ...added] });
      }
      setFetchState((prev) => ({
        ...prev,
        [provider.id]: { status: "done", count: data.models.length },
      }));
    } catch (error) {
      setFetchState((prev) => ({
        ...prev,
        [provider.id]: {
          status: "error",
          message: error instanceof Error ? error.message : "Failed to fetch model list",
        },
      }));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="mb-btn h-9 px-3 text-xs"
          disabled={disabled}
          onClick={() => addProvider()}
        >
          + Add provider
        </button>
        {PROVIDER_PRESETS.map((preset) => (
          <button
            key={preset.key}
            type="button"
            className="mb-btn h-9 px-3 text-xs"
            disabled={disabled}
            title={preset.hint}
            onClick={() => addProvider(preset)}
          >
            + {preset.label}
          </button>
        ))}
      </div>

      {providers.length === 0 ? (
        <p className="rounded-md border border-border/60 bg-bg/40 px-3 py-4 text-xs text-muted">
          No providers configured. Add one above — start from a preset for a known
          endpoint, or use <strong>Add provider</strong> for a fully custom one.
          Keys are stored in this browser only and are sent per request.
        </p>
      ) : null}

      {providers.map((provider) => {
        const isOpen = openProviderId === provider.id;
        const issues = providerConfigIssues(provider);
        const state = fetchState[provider.id];
        const filter = (modelFilter[provider.id] ?? "").trim().toLowerCase();
        const visibleModels = filter
          ? provider.models.filter(
              (model) =>
                model.modelId.toLowerCase().includes(filter) ||
                (model.displayName ?? "").toLowerCase().includes(filter),
            )
          : provider.models;
        const selectedCount = provider.models.filter((model) =>
          selectedSet.has(selectionKey(provider.id, model.id)),
        ).length;

        return (
          <div
            key={provider.id}
            className="rounded-md border border-border/60 bg-bg/40"
          >
            <div className="flex flex-wrap items-center gap-2 p-3">
              <button
                type="button"
                className="mb-btn h-8 w-8 shrink-0 text-xs"
                aria-expanded={isOpen}
                aria-label={isOpen ? "Collapse provider" : "Expand provider"}
                onClick={() => setOpenProviderId(isOpen ? null : provider.id)}
              >
                {isOpen ? "−" : "+"}
              </button>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {provider.label || "Untitled provider"}
                </div>
                <div className="truncate text-[11px] text-muted">
                  {PROVIDER_API_KIND_LABELS[provider.apiKind]}
                  {provider.lockedEnvelope ? " · locked envelope" : ""}
                  {` · ${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`}
                  {selectedCount > 0 ? ` · ${selectedCount} selected` : ""}
                </div>
              </div>
              {issues.length > 0 ? (
                <span
                  className="rounded border border-danger/40 bg-danger/[0.08] px-2 py-0.5 text-[10px] text-danger"
                  title={issues.join(" ")}
                >
                  {issues.length} issue{issues.length === 1 ? "" : "s"}
                </span>
              ) : null}
              <button
                type="button"
                className="mb-btn h-8 px-2 text-xs"
                disabled={disabled}
                onClick={() => removeProvider(provider.id)}
              >
                Remove
              </button>
            </div>

            {isOpen ? (
              <div className="grid grid-cols-1 gap-3 border-t border-border/60 p-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted">Label</span>
                    <input
                      className="mb-field h-10 w-full"
                      value={provider.label}
                      disabled={disabled}
                      onChange={(e) => updateProvider(provider.id, { label: e.target.value })}
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted">API type</span>
                    <select
                      className="mb-field h-10 w-full"
                      value={provider.apiKind}
                      disabled={disabled}
                      onChange={(e) =>
                        updateProvider(provider.id, {
                          apiKind: e.target.value as ProviderApiKind,
                        })
                      }
                    >
                      {PROVIDER_API_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {PROVIDER_API_KIND_LABELS[kind]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted">
                    Base URL{" "}
                    <span className="font-normal">
                      (host, or a full endpoint URL)
                    </span>
                  </span>
                  <input
                    className="mb-field h-10 w-full"
                    value={provider.baseUrl}
                    disabled={disabled}
                    placeholder="https://api.example.com"
                    onChange={(e) => updateProvider(provider.id, { baseUrl: e.target.value })}
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted">
                    API key <span className="font-normal">(optional)</span>
                  </span>
                  <input
                    className="mb-field h-10 w-full"
                    type="password"
                    autoComplete="off"
                    value={provider.apiKey}
                    disabled={disabled}
                    placeholder="Leave blank if the gateway needs no key"
                    onChange={(e) => updateProvider(provider.id, { apiKey: e.target.value })}
                  />
                </label>

                <div className="grid grid-cols-1 gap-2 rounded border border-border/50 bg-bg/60 p-3">
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={provider.appendV1}
                      disabled={disabled}
                      onChange={(e) => updateProvider(provider.id, { appendV1: e.target.checked })}
                    />
                    <span>
                      <span className="block text-xs font-medium">
                        Append <code>/v1</code> to the base URL
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">
                        On for hosts published without a version segment
                        (<code>https://api.openai.com</code> →{" "}
                        <code>/v1/chat/completions</code>). Off for gateways with a
                        non-standard prefix such as <code>/api/plan/v3</code>, where
                        injecting <code>/v1</code> returns 404. An existing{" "}
                        <code>/v1</code> is never doubled.
                      </span>
                    </span>
                  </label>

                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={provider.lockedEnvelope}
                      disabled={disabled}
                      onChange={(e) =>
                        updateProvider(provider.id, { lockedEnvelope: e.target.checked })
                      }
                    />
                    <span>
                      <span className="block text-xs font-medium">
                        Locked-envelope gateway mode
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">
                        Pins <code>max_tokens=131072</code>, forces{" "}
                        <code>thinking:&#123;type:&quot;enabled&quot;&#125;</code> and{" "}
                        <code>stream_options.include_usage</code>. These pins are applied
                        after your custom parameters, so the contract holds regardless
                        of other settings.
                      </span>
                    </span>
                  </label>

                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={provider.structuredOutput}
                      disabled={disabled}
                      onChange={(e) =>
                        updateProvider(provider.id, { structuredOutput: e.target.checked })
                      }
                    />
                    <span>
                      <span className="block text-xs font-medium">
                        Send <code>response_format</code> / json_schema
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">
                        Off by default. Some gateways validate the field then ignore it,
                        which yields prose instead of JSON — prompt discipline alone is
                        more reliable there.
                      </span>
                    </span>
                  </label>

                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={provider.stream}
                      disabled={disabled}
                      onChange={(e) => updateProvider(provider.id, { stream: e.target.checked })}
                    />
                    <span>
                      <span className="block text-xs font-medium">Stream responses (SSE)</span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">
                        Required for live progress and incremental previews.
                      </span>
                    </span>
                  </label>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted">
                      max_tokens{" "}
                      {provider.lockedEnvelope ? (
                        <span className="font-normal">(clamped to 131072)</span>
                      ) : (
                        <span className="font-normal">(blank = provider default)</span>
                      )}
                    </span>
                    <input
                      className="mb-field h-10 w-full"
                      type="number"
                      min={1}
                      value={provider.maxTokens ?? ""}
                      disabled={disabled}
                      onChange={(e) =>
                        updateProvider(provider.id, { maxTokens: numberOrUndefined(e.target.value) })
                      }
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted">
                      temperature <span className="font-normal">(blank = omit)</span>
                    </span>
                    <input
                      className="mb-field h-10 w-full"
                      type="number"
                      step="0.1"
                      min={0}
                      max={2}
                      value={provider.temperature ?? ""}
                      disabled={disabled}
                      onChange={(e) =>
                        updateProvider(provider.id, {
                          temperature: numberOrUndefined(e.target.value),
                        })
                      }
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted">reasoning_effort</span>
                    <select
                      className="mb-field h-10 w-full"
                      value={provider.reasoningEffort}
                      disabled={disabled}
                      onChange={(e) =>
                        updateProvider(provider.id, {
                          reasoningEffort: e.target.value as ReasoningEffortChoice,
                        })
                      }
                    >
                      {REASONING_EFFORT_CHOICES.map((choice) => (
                        <option key={choice} value={choice}>
                          {choice === "none" ? "Omit parameter" : choice}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted">thinking field</span>
                    <select
                      className="mb-field h-10 w-full"
                      value={provider.lockedEnvelope ? "enabled" : provider.thinkingMode}
                      disabled={disabled || provider.lockedEnvelope}
                      onChange={(e) =>
                        updateProvider(provider.id, {
                          thinkingMode: e.target.value as ThinkingMode,
                        })
                      }
                    >
                      {THINKING_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {THINKING_MODE_LABELS[mode]}
                        </option>
                      ))}
                    </select>
                  </label>

                  {provider.thinkingMode === "budget" && !provider.lockedEnvelope ? (
                    <label className="flex flex-col gap-1">
                      <span className="text-xs font-medium text-muted">
                        thinking budget_tokens
                      </span>
                      <input
                        className="mb-field h-10 w-full"
                        type="number"
                        min={1024}
                        value={provider.thinkingBudgetTokens ?? ""}
                        disabled={disabled}
                        onChange={(e) =>
                          updateProvider(provider.id, {
                            thinkingBudgetTokens: numberOrUndefined(e.target.value),
                          })
                        }
                      />
                    </label>
                  ) : null}

                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted">User-Agent</span>
                    <input
                      className="mb-field h-10 w-full"
                      value={provider.userAgent}
                      disabled={disabled}
                      onChange={(e) => updateProvider(provider.id, { userAgent: e.target.value })}
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted">
                      X-Conversation-Id <span className="font-normal">(blank = auto)</span>
                    </span>
                    <input
                      className="mb-field h-10 w-full"
                      value={provider.conversationId}
                      disabled={disabled}
                      placeholder="auto-generated per request"
                      onChange={(e) =>
                        updateProvider(provider.id, { conversationId: e.target.value })
                      }
                    />
                  </label>
                </div>

                <CustomRequestEditor
                  headers={provider.headers}
                  params={provider.params}
                  disabled={disabled}
                  onHeadersChange={(headers) => updateProvider(provider.id, { headers })}
                  onParamsChange={(params) => updateProvider(provider.id, { params })}
                />

                <div className="rounded border border-border/50 bg-bg/60 p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium">Models</span>
                    <button
                      type="button"
                      className="mb-btn h-8 px-2 text-xs"
                      disabled={disabled || state?.status === "loading"}
                      onClick={() => void fetchModels(provider)}
                    >
                      {state?.status === "loading" ? "Fetching…" : "Fetch model list"}
                    </button>
                    <button
                      type="button"
                      className="mb-btn h-8 px-2 text-xs"
                      disabled={disabled}
                      onClick={() =>
                        updateProvider(provider.id, {
                          models: [...provider.models, createModelConfig("")],
                        })
                      }
                    >
                      + Add model
                    </button>
                    {provider.models.length > 4 ? (
                      <input
                        className="mb-field h-8 w-40 text-xs"
                        placeholder="Filter models…"
                        value={modelFilter[provider.id] ?? ""}
                        onChange={(e) =>
                          setModelFilter((prev) => ({ ...prev, [provider.id]: e.target.value }))
                        }
                      />
                    ) : null}
                  </div>

                  {state?.status === "error" ? (
                    <p className="mb-2 rounded border border-danger/30 bg-danger/[0.08] px-2 py-1 text-[11px] text-danger">
                      {state.message}
                    </p>
                  ) : null}
                  {state?.status === "done" ? (
                    <p className="mb-2 text-[11px] text-muted">
                      Provider returned {state.count} model{state.count === 1 ? "" : "s"}. Newly
                      discovered models start disabled — tick the ones you want.
                    </p>
                  ) : null}

                  {provider.models.length === 0 ? (
                    <p className="text-[11px] text-muted">
                      No models yet. Fetch the list, or add one manually.
                    </p>
                  ) : null}

                  <div className="flex flex-col gap-2">
                    {visibleModels.map((model) => {
                      const key = selectionKey(provider.id, model.id);
                      return (
                        <div
                          key={model.id}
                          className="rounded border border-border/40 bg-bg/40 p-2"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <label
                              className="flex items-center gap-1 text-[11px]"
                              title="Include in battle runs"
                            >
                              <input
                                type="checkbox"
                                checked={selectedSet.has(key)}
                                disabled={disabled || !model.enabled || !model.modelId.trim()}
                                onChange={() => toggleSelection(provider.id, model.id)}
                              />
                              battle
                            </label>
                            <label
                              className="flex items-center gap-1 text-[11px]"
                              title="Available for selection"
                            >
                              <input
                                type="checkbox"
                                checked={model.enabled}
                                disabled={disabled}
                                onChange={(e) =>
                                  updateModel(provider.id, model.id, {
                                    enabled: e.target.checked,
                                  })
                                }
                              />
                              enabled
                            </label>
                            <input
                              className="mb-field h-9 min-w-0 flex-1 text-xs"
                              value={model.modelId}
                              disabled={disabled}
                              placeholder="model id (sent on the wire)"
                              onChange={(e) =>
                                updateModel(provider.id, model.id, { modelId: e.target.value })
                              }
                            />
                            <input
                              className="mb-field h-9 w-36 text-xs"
                              value={model.displayName ?? ""}
                              disabled={disabled}
                              placeholder="display name"
                              onChange={(e) =>
                                updateModel(provider.id, model.id, {
                                  displayName: e.target.value,
                                })
                              }
                            />
                            <button
                              type="button"
                              className="mb-btn h-9 px-2 text-xs"
                              disabled={disabled}
                              onClick={() => {
                                onChange(
                                  providers.map((entry) =>
                                    entry.id === provider.id
                                      ? {
                                          ...entry,
                                          models: entry.models.filter(
                                            (candidate) => candidate.id !== model.id,
                                          ),
                                        }
                                      : entry,
                                  ),
                                );
                                onSelectedChange(selected.filter((entry) => entry !== key));
                              }}
                            >
                              ✕
                            </button>
                          </div>

                          <details className="mt-2">
                            <summary className="cursor-pointer text-[11px] text-muted">
                              Per-model overrides
                            </summary>
                            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                              <label className="flex flex-col gap-1">
                                <span className="text-[10px] text-muted">max_tokens</span>
                                <input
                                  className="mb-field h-9 w-full text-xs"
                                  type="number"
                                  min={1}
                                  placeholder="inherit"
                                  value={model.maxTokens ?? ""}
                                  disabled={disabled}
                                  onChange={(e) =>
                                    updateModel(provider.id, model.id, {
                                      maxTokens: numberOrUndefined(e.target.value),
                                    })
                                  }
                                />
                              </label>
                              <label className="flex flex-col gap-1">
                                <span className="text-[10px] text-muted">temperature</span>
                                <input
                                  className="mb-field h-9 w-full text-xs"
                                  type="number"
                                  step="0.1"
                                  min={0}
                                  max={2}
                                  placeholder="inherit"
                                  value={model.temperature ?? ""}
                                  disabled={disabled}
                                  onChange={(e) =>
                                    updateModel(provider.id, model.id, {
                                      temperature: numberOrUndefined(e.target.value),
                                    })
                                  }
                                />
                              </label>
                              <label className="flex flex-col gap-1">
                                <span className="text-[10px] text-muted">reasoning_effort</span>
                                <select
                                  className="mb-field h-9 w-full text-xs"
                                  value={model.reasoningEffort ?? ""}
                                  disabled={disabled}
                                  onChange={(e) =>
                                    updateModel(provider.id, model.id, {
                                      reasoningEffort: e.target.value
                                        ? (e.target.value as ReasoningEffortChoice)
                                        : undefined,
                                    })
                                  }
                                >
                                  <option value="">inherit</option>
                                  {REASONING_EFFORT_CHOICES.map((choice) => (
                                    <option key={choice} value={choice}>
                                      {choice === "none" ? "Omit parameter" : choice}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </div>
                          </details>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {issues.length > 0 ? (
                  <ul className="list-inside list-disc rounded border border-danger/30 bg-danger/[0.08] px-3 py-2 text-[11px] text-danger">
                    {issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Re-exported so callers can build a provider without importing the store. */
export { createProvider, newId };
