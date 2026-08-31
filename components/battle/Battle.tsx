"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProviderManager } from "@/components/providers/ProviderManager";
import {
  ExchangeLogPanel,
  type ExchangeLogEntry,
} from "@/components/providers/ExchangeLogPanel";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
import { BattleFullscreenViewer } from "@/components/battle/BattleFullscreenViewer";
import { BattleExportBar } from "@/components/battle/BattleExportBar";
import type { GenerateEvent, GenerateModelRequest } from "@/lib/ai/types";
import type { ProviderConfig } from "@/lib/ai/providerConfig";
import {
  loadProviderStore,
  parseSelectionKey,
  saveProviderStore,
  selectionKey,
  validSelections,
} from "@/lib/ai/providerStore";
import { readClientErrorResponse } from "@/lib/clientErrorResponse";
import { extractBestVoxelBuildJson } from "@/lib/ai/jsonExtract";
import type { VoxelBuild } from "@/lib/voxel/types";

type Palette = "simple" | "advanced";
type GridSize = 64 | 256 | 512;

export type BattleEntrant = {
  /** Stable per-run id; also the `modelKey` in stream events. */
  id: string;
  providerId: string;
  modelConfigId: string;
  label: string;
  providerLabel: string;
  modelId: string;
};

type EntrantResult = {
  status: "idle" | "loading" | "success" | "error";
  voxelBuild: VoxelBuild | null;
  error?: string;
  rawText: string;
  reasoningText: string;
  traces: string[];
  attempt?: number;
  retryReason?: string;
  startedAt?: number;
  finishedAt?: number;
  metrics?: {
    blockCount: number;
    warnings: string[];
    generationTimeMs: number;
    jsonBytes?: number;
  };
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cachedTokens?: number;
  };
};

const EMPTY_RESULT: EntrantResult = {
  status: "idle",
  voxelBuild: null,
  rawText: "",
  reasoningText: "",
  traces: [],
};

const MAX_RAW_TEXT_CHARS = 120_000;
const MAX_LOG_ENTRIES = 60;
const DEFAULT_PROMPT = "a medieval stone lighthouse on a rocky island";

function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function Battle() {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [gridSize, setGridSize] = useState<GridSize>(256);
  const [palette, setPalette] = useState<Palette>("advanced");
  const [captureLog, setCaptureLog] = useState(true);

  const [running, setRunning] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [entrants, setEntrants] = useState<BattleEntrant[]>([]);
  const [results, setResults] = useState<Record<string, EntrantResult>>({});
  const [logs, setLogs] = useState<ExchangeLogEntry[]>([]);
  const [winners, setWinners] = useState<string[]>([]);
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(true);
  const [showLog, setShowLog] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());

  const abortRef = useRef<AbortController | null>(null);

  // Load persisted config once on mount. localStorage is unavailable during SSR,
  // so this cannot be initial state without causing a hydration mismatch.
  useEffect(() => {
    const store = loadProviderStore();
    setProviders(store.providers);
    setSelected(validSelections(store));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveProviderStore({ providers, selected });
  }, [hydrated, providers, selected]);

  // Drives the live elapsed-time counters without a timer per card.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const selectedEntrants = useMemo((): BattleEntrant[] => {
    const list: BattleEntrant[] = [];
    for (const key of selected) {
      const parsed = parseSelectionKey(key);
      if (!parsed) continue;
      const provider = providers.find((candidate) => candidate.id === parsed.providerId);
      if (!provider) continue;
      const model = provider.models.find((candidate) => candidate.id === parsed.modelConfigId);
      if (!model || !model.enabled || !model.modelId.trim()) continue;
      list.push({
        id: key,
        providerId: provider.id,
        modelConfigId: model.id,
        label: model.displayName?.trim() || model.modelId,
        providerLabel: provider.label,
        modelId: model.modelId,
      });
    }
    return list;
  }, [providers, selected]);

  const patchResult = useCallback(
    (id: string, patch: Partial<EntrantResult> | ((prev: EntrantResult) => Partial<EntrantResult>)) => {
      setResults((prev) => {
        const current = prev[id] ?? EMPTY_RESULT;
        const resolved = typeof patch === "function" ? patch(current) : patch;
        return { ...prev, [id]: { ...current, ...resolved } };
      });
    },
    [],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  const run = useCallback(async () => {
    if (running) return;
    if (!prompt.trim()) {
      setRequestError("Enter a prompt.");
      return;
    }
    if (selectedEntrants.length < 1) {
      setRequestError("Select at least one model (tick 'battle' on a provider's model).");
      return;
    }

    setRequestError(null);
    setWinners([]);
    setLogs([]);
    setEntrants(selectedEntrants);
    setResults(
      Object.fromEntries(
        selectedEntrants.map((entrant) => [
          entrant.id,
          { ...EMPTY_RESULT, status: "loading" as const, startedAt: Date.now() },
        ]),
      ),
    );
    setRunning(true);
    setShowConfig(false);

    const controller = new AbortController();
    abortRef.current = controller;

    // Only the providers actually referenced are sent, so an unrelated
    // half-finished config cannot fail validation for the whole run.
    const usedProviderIds = new Set(selectedEntrants.map((entrant) => entrant.providerId));
    const models: GenerateModelRequest[] = selectedEntrants.map((entrant) => ({
      id: entrant.id,
      kind: "configured",
      providerId: entrant.providerId,
      modelConfigId: entrant.modelConfigId,
    }));

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          prompt: prompt.trim(),
          gridSize,
          palette,
          models,
          providerConfigs: providers.filter((provider) => usedProviderIds.has(provider.id)),
          includeExchangeLog: captureLog,
        }),
      });

      if (!res.ok) {
        setRequestError(await readClientErrorResponse(res, "Generation request failed"));
        setRunning(false);
        return;
      }
      if (!res.body) {
        setRequestError("Server returned an empty stream.");
        setRunning(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const handleEvent = (event: GenerateEvent) => {
        switch (event.type) {
          case "start":
            patchResult(event.modelKey, { status: "loading", startedAt: Date.now() });
            break;
          case "retry":
            patchResult(event.modelKey, {
              attempt: event.attempt,
              retryReason: event.reason,
            });
            break;
          case "delta":
            patchResult(event.modelKey, (prev) => ({
              rawText:
                prev.rawText.length > MAX_RAW_TEXT_CHARS
                  ? prev.rawText
                  : prev.rawText + event.delta,
            }));
            break;
          case "reasoning":
            patchResult(event.modelKey, (prev) => ({
              reasoningText:
                prev.reasoningText.length > MAX_RAW_TEXT_CHARS
                  ? prev.reasoningText
                  : prev.reasoningText + event.delta,
            }));
            break;
          case "trace":
            patchResult(event.modelKey, (prev) => ({
              traces: [...prev.traces, event.message].slice(-40),
            }));
            break;
          case "usage":
            patchResult(event.modelKey, { usage: event.usage });
            break;
          case "exchange": {
            const entrant = selectedEntrants.find(
              (candidate) => candidate.id === event.modelKey,
            );
            setLogs((prev) =>
              [
                ...prev,
                {
                  ...event.exchange,
                  modelKey: event.modelKey,
                  modelLabel: entrant
                    ? `${entrant.providerLabel} / ${entrant.label}`
                    : event.modelKey,
                },
              ].slice(-MAX_LOG_ENTRIES),
            );
            break;
          }
          case "result":
            patchResult(event.modelKey, {
              status: "success",
              voxelBuild: event.voxelBuild,
              metrics: event.metrics,
              finishedAt: Date.now(),
            });
            break;
          case "error":
            patchResult(event.modelKey, (prev) => ({
              status: "error",
              error: event.message,
              rawText: event.rawText ?? prev.rawText,
              finishedAt: Date.now(),
            }));
            break;
          default:
            break;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            handleEvent(JSON.parse(line) as GenerateEvent);
          } catch {
            // A partial/corrupt line must not kill the whole stream.
          }
        }
      }
      if (buffer.trim()) {
        try {
          handleEvent(JSON.parse(buffer) as GenerateEvent);
        } catch {
          // ignore trailing partial frame
        }
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        setRequestError(error instanceof Error ? error.message : "Generation failed");
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      // Anything still marked loading never produced a terminal event.
      setResults((prev) => {
        const next = { ...prev };
        for (const [id, result] of Object.entries(next)) {
          if (result.status === "loading") {
            next[id] = {
              ...result,
              status: "error",
              error: result.error ?? "Stream ended before this model finished.",
              finishedAt: Date.now(),
            };
          }
        }
        return next;
      });
    }
  }, [
    captureLog,
    gridSize,
    palette,
    patchResult,
    prompt,
    providers,
    running,
    selectedEntrants,
  ]);

  const toggleWinner = (id: string) => {
    setWinners((prev) => (prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id]));
  };

  const successful = entrants.filter((entrant) => results[entrant.id]?.status === "success");
  const fullscreenEntrant = entrants.find((entrant) => entrant.id === fullscreenId) ?? null;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-3 py-4 sm:px-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Battle</h1>
        <p className="text-xs leading-relaxed text-muted">
          Run one prompt across many models from your configured providers, compare
          the results side by side, pick winners, and export the ones you like.
          Every request and response can be inspected in the debug log.
        </p>
      </header>

      <section className="rounded-lg border border-border/70 bg-panel/40 p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Providers &amp; models</h2>
          <button
            type="button"
            className="mb-btn h-8 px-2 text-xs"
            aria-expanded={showConfig}
            onClick={() => setShowConfig((prev) => !prev)}
          >
            {showConfig ? "Hide" : `Show (${selectedEntrants.length} selected)`}
          </button>
        </div>
        {showConfig ? (
          <ProviderManager
            providers={providers}
            selected={selected}
            disabled={running}
            onChange={setProviders}
            onSelectedChange={setSelected}
          />
        ) : null}
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-border/70 bg-panel/40 p-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Prompt</span>
          <textarea
            className="mb-field min-h-[72px] w-full resize-y py-2"
            value={prompt}
            maxLength={800}
            disabled={running}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Grid</span>
            <select
              className="mb-field h-10 w-28"
              value={gridSize}
              disabled={running}
              onChange={(e) => setGridSize(Number(e.target.value) as GridSize)}
            >
              <option value={64}>64</option>
              <option value={256}>256</option>
              <option value={512}>512</option>
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Palette</span>
            <select
              className="mb-field h-10 w-32"
              value={palette}
              disabled={running}
              onChange={(e) => setPalette(e.target.value as Palette)}
            >
              <option value="simple">simple</option>
              <option value="advanced">advanced</option>
            </select>
          </label>

          <label className="flex items-center gap-2 pb-2 text-xs">
            <input
              type="checkbox"
              checked={captureLog}
              disabled={running}
              onChange={(e) => setCaptureLog(e.target.checked)}
            />
            Capture debug log
          </label>

          <div className="ml-auto flex items-center gap-2">
            {running ? (
              <button type="button" className="mb-btn h-10 px-4 text-sm" onClick={stop}>
                Stop
              </button>
            ) : null}
            <button
              type="button"
              className="mb-btn h-10 px-4 text-sm font-medium"
              disabled={running || selectedEntrants.length === 0}
              onClick={() => void run()}
            >
              {running
                ? "Running…"
                : `Run battle (${selectedEntrants.length} model${
                    selectedEntrants.length === 1 ? "" : "s"
                  })`}
            </button>
          </div>
        </div>

        {requestError ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger/[0.08] px-3 py-2 text-xs text-danger"
          >
            {requestError}
          </div>
        ) : null}
      </section>

      {entrants.length > 0 ? (
        <>
          <BattleExportBar
            entrants={entrants}
            results={results}
            winners={winners}
            prompt={prompt}
            palette={palette}
          />

          <section
            className="grid gap-3"
            style={{
              gridTemplateColumns:
                entrants.length === 1
                  ? "minmax(0, 1fr)"
                  : "repeat(auto-fit, minmax(min(100%, 340px), 1fr))",
            }}
          >
            {entrants.map((entrant) => {
              const result = results[entrant.id] ?? EMPTY_RESULT;
              const isWinner = winners.includes(entrant.id);
              const elapsed =
                result.startedAt !== undefined
                  ? (result.finishedAt ?? nowTick) - result.startedAt
                  : undefined;

              return (
                <div
                  key={entrant.id}
                  className={`flex flex-col gap-2 rounded-lg border p-2 transition-colors ${
                    isWinner
                      ? "border-accent/70 bg-accent/[0.06]"
                      : "border-border/70 bg-panel/30"
                  }`}
                >
                  <VoxelViewerCard
                    title={entrant.label}
                    subtitle={
                      <span className="text-[11px] text-muted">
                        {entrant.providerLabel} · {entrant.modelId}
                      </span>
                    }
                    voxelBuild={result.voxelBuild}
                    gridSize={gridSize}
                    palette={palette}
                    isLoading={result.status === "loading"}
                    attempt={result.attempt}
                    retryReason={result.retryReason}
                    elapsedMs={elapsed}
                    metrics={result.metrics}
                    error={result.error}
                    enableBuildJsonToggle
                    enableBuildExport
                    exportLabel={entrant.label}
                    exportPrompt={prompt}
                    jsonBytes={result.metrics?.jsonBytes ?? null}
                    actions={
                      <div className="flex flex-wrap items-center gap-1">
                        <button
                          type="button"
                          className={`mb-btn h-8 px-2 text-[11px] ${
                            isWinner ? "border-accent/60 bg-accent/[0.14]" : ""
                          }`}
                          aria-pressed={isWinner}
                          disabled={result.status !== "success"}
                          onClick={() => toggleWinner(entrant.id)}
                        >
                          {isWinner ? "★ Winner" : "☆ Pick"}
                        </button>
                        <button
                          type="button"
                          className="mb-btn h-8 px-2 text-[11px]"
                          disabled={result.status !== "success"}
                          onClick={() => setFullscreenId(entrant.id)}
                        >
                          ⛶ Fullscreen
                        </button>
                      </div>
                    }
                  />

                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
                    <span>{formatDuration(elapsed)}</span>
                    {result.metrics ? (
                      <span>{result.metrics.blockCount.toLocaleString()} blocks</span>
                    ) : null}
                    {result.usage?.totalTokens ? (
                      <span>{result.usage.totalTokens.toLocaleString()} tok</span>
                    ) : null}
                    {result.usage?.reasoningTokens ? (
                      <span>{result.usage.reasoningTokens.toLocaleString()} reasoning</span>
                    ) : null}
                  </div>

                  {result.reasoningText ? (
                    <details>
                      <summary className="cursor-pointer text-[11px] text-muted">
                        Reasoning ({result.reasoningText.length.toLocaleString()} chars)
                      </summary>
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-border/40 bg-bg/60 p-2 font-mono text-[10px] leading-relaxed">
                        {result.reasoningText}
                      </pre>
                    </details>
                  ) : null}

                  {result.traces.length > 0 ? (
                    <details>
                      <summary className="cursor-pointer text-[11px] text-muted">
                        Trace ({result.traces.length})
                      </summary>
                      <ul className="mt-1 flex flex-col gap-0.5 rounded border border-border/40 bg-bg/60 p-2 font-mono text-[10px] leading-relaxed">
                        {result.traces.map((trace, index) => (
                          <li key={index}>{trace}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              );
            })}
          </section>

          {successful.length > 1 ? (
            <p className="text-[11px] text-muted">
              {winners.length === 0
                ? "Tip: pick one or more winners with ☆, then use the export bar above."
                : `${winners.length} winner${winners.length === 1 ? "" : "s"} selected.`}
            </p>
          ) : null}
        </>
      ) : null}

      <section className="rounded-lg border border-border/70 bg-panel/40 p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">
            Debug log{logs.length > 0 ? ` (${logs.length})` : ""}
          </h2>
          <button
            type="button"
            className="mb-btn h-8 px-2 text-xs"
            aria-expanded={showLog}
            onClick={() => setShowLog((prev) => !prev)}
          >
            {showLog ? "Hide" : "Show"}
          </button>
        </div>
        {showLog ? (
          <ExchangeLogPanel entries={logs} onClear={() => setLogs([])} />
        ) : null}
      </section>

      {fullscreenEntrant ? (
        <BattleFullscreenViewer
          entrants={entrants.filter((entrant) => results[entrant.id]?.status === "success")}
          activeId={fullscreenEntrant.id}
          builds={Object.fromEntries(
            entrants.map((entrant) => [entrant.id, results[entrant.id]?.voxelBuild ?? null]),
          )}
          gridSize={gridSize}
          palette={palette}
          prompt={prompt}
          winners={winners}
          onToggleWinner={toggleWinner}
          onActiveIdChange={setFullscreenId}
          onClose={() => setFullscreenId(null)}
        />
      ) : null}
    </div>
  );
}

export type { EntrantResult };
