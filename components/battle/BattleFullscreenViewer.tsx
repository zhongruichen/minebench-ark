"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { VoxelViewerCard } from "@/components/voxel/VoxelViewerCard";
import type { VoxelBuild } from "@/lib/voxel/types";
import type { BattleEntrant } from "@/components/battle/Battle";

type Props = {
  entrants: BattleEntrant[];
  activeId: string;
  builds: Record<string, VoxelBuild | null>;
  gridSize: 64 | 256 | 512;
  palette: "simple" | "advanced";
  prompt: string;
  winners: string[];
  onToggleWinner: (id: string) => void;
  onActiveIdChange: (id: string) => void;
  onClose: () => void;
};

type Layout = "single" | "split";

/**
 * Fullscreen comparison overlay.
 *
 * Rendered as a fixed overlay rather than the Fullscreen API: the browser API
 * would drop the React portal's event handlers on some mobile browsers, and a
 * fixed overlay behaves identically for the purpose here while remaining
 * keyboard- and screen-reader-navigable.
 */
export function BattleFullscreenViewer({
  entrants,
  activeId,
  builds,
  gridSize,
  palette,
  prompt,
  winners,
  onToggleWinner,
  onActiveIdChange,
  onClose,
}: Props) {
  const [layout, setLayout] = useState<Layout>("single");
  const [compareId, setCompareId] = useState<string | null>(null);

  const activeIndex = useMemo(
    () => Math.max(0, entrants.findIndex((entrant) => entrant.id === activeId)),
    [activeId, entrants],
  );

  const step = useCallback(
    (delta: number) => {
      if (entrants.length === 0) return;
      const next = (activeIndex + delta + entrants.length) % entrants.length;
      onActiveIdChange(entrants[next].id);
    },
    [activeIndex, entrants, onActiveIdChange],
  );

  // Default the split pane to the next entrant so toggling is immediately useful.
  useEffect(() => {
    if (layout !== "split") return;
    if (compareId && compareId !== activeId && builds[compareId]) return;
    const candidate = entrants.find((entrant) => entrant.id !== activeId);
    setCompareId(candidate?.id ?? null);
  }, [activeId, builds, compareId, entrants, layout]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        step(1);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
        return;
      }
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        setLayout((prev) => (prev === "single" ? "split" : "single"));
        return;
      }
      if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        onToggleWinner(activeId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeId, onClose, onToggleWinner, step]);

  // Prevent the page behind the overlay from scrolling.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const active = entrants[activeIndex];
  const compare = compareId ? entrants.find((entrant) => entrant.id === compareId) : null;
  if (!active) return null;

  const panes = layout === "split" && compare ? [active, compare] : [active];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Fullscreen build comparison"
      className="fixed inset-0 z-50 flex flex-col bg-bg/98 backdrop-blur"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <button type="button" className="mb-btn h-8 px-2 text-xs" onClick={() => step(-1)}>
          ← Prev
        </button>
        <button type="button" className="mb-btn h-8 px-2 text-xs" onClick={() => step(1)}>
          Next →
        </button>

        <select
          className="mb-field h-8 min-w-0 max-w-[240px] flex-1 text-xs"
          value={active.id}
          onChange={(e) => onActiveIdChange(e.target.value)}
        >
          {entrants.map((entrant) => (
            <option key={entrant.id} value={entrant.id}>
              {`${entrant.label} — ${entrant.providerLabel}`}
            </option>
          ))}
        </select>

        <button
          type="button"
          className={`mb-btn h-8 px-2 text-xs ${
            layout === "split" ? "border-accent/60 bg-accent/[0.12]" : ""
          }`}
          aria-pressed={layout === "split"}
          disabled={entrants.length < 2}
          onClick={() => setLayout((prev) => (prev === "single" ? "split" : "single"))}
          title="Toggle split comparison (S)"
        >
          {layout === "split" ? "Split view" : "Single view"}
        </button>

        {layout === "split" && entrants.length > 1 ? (
          <select
            className="mb-field h-8 min-w-0 max-w-[220px] text-xs"
            value={compareId ?? ""}
            onChange={(e) => setCompareId(e.target.value || null)}
          >
            {entrants
              .filter((entrant) => entrant.id !== active.id)
              .map((entrant) => (
                <option key={entrant.id} value={entrant.id}>
                  {`vs ${entrant.label}`}
                </option>
              ))}
          </select>
        ) : null}

        <span className="hidden text-[10px] text-muted sm:inline">
          ←/→ switch · S split · W winner · Esc close
        </span>

        <button
          type="button"
          className="mb-btn ml-auto h-8 px-3 text-xs"
          onClick={onClose}
          autoFocus
        >
          ✕ Close
        </button>
      </div>

      <div
        className="grid min-h-0 flex-1 gap-2 p-2"
        style={{
          gridTemplateColumns: panes.length === 2 ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)",
        }}
      >
        {panes.map((entrant) => {
          const isWinner = winners.includes(entrant.id);
          return (
            <div
              key={entrant.id}
              className={`flex min-h-0 flex-col overflow-hidden rounded-lg border ${
                isWinner ? "border-accent/70" : "border-border/60"
              }`}
            >
              <VoxelViewerCard
                title={entrant.label}
                subtitle={
                  <span className="text-[11px] text-muted">
                    {entrant.providerLabel} · {entrant.modelId}
                  </span>
                }
                voxelBuild={builds[entrant.id] ?? null}
                gridSize={gridSize}
                palette={palette}
                viewerSize="arena"
                autoRotate
                enableBuildExport
                exportLabel={entrant.label}
                exportPrompt={prompt}
                embedded
                actions={
                  <button
                    type="button"
                    className={`mb-btn h-8 px-2 text-[11px] ${
                      isWinner ? "border-accent/60 bg-accent/[0.14]" : ""
                    }`}
                    aria-pressed={isWinner}
                    onClick={() => onToggleWinner(entrant.id)}
                  >
                    {isWinner ? "★ Winner" : "☆ Pick"}
                  </button>
                }
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
