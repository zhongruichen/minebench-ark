"use client";

import { useMemo, useState } from "react";
import { getPalette } from "@/lib/blocks/palettes";
import {
  exportVoxelBuild,
  type VoxelBuildExportFormat,
} from "@/lib/voxel/export";
import type { VoxelBuild } from "@/lib/voxel/types";
import type { BattleEntrant, EntrantResult } from "@/components/battle/Battle";

type Props = {
  entrants: BattleEntrant[];
  results: Record<string, EntrantResult>;
  winners: string[];
  prompt: string;
  palette: "simple" | "advanced";
};

type Scope = "winners" | "all" | "custom";
type ExportKind = VoxelBuildExportFormat | "json" | "html" | "report";

const EXPORT_KINDS: ReadonlyArray<{ kind: ExportKind; label: string; detail: string }> = [
  { kind: "json", label: "Build JSON", detail: "raw voxel spec" },
  { kind: "glb", label: "GLB", detail: "Blender / 3D" },
  { kind: "stl", label: "STL", detail: "mesh" },
  { kind: "schem", label: "Schematic", detail: "WorldEdit" },
  { kind: "html", label: "HTML viewer", detail: "single file, offline" },
  { kind: "report", label: "Comparison report", detail: "markdown summary" },
];

function sanitize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/**
 * Multi-select export for battle results.
 *
 * Exports run sequentially on the main thread with a short yield between files.
 * A worker per file would be faster, but exporting N large builds concurrently
 * is the reliable way to exhaust memory on a phone — and this runs right after
 * several multi-million-block builds are already resident.
 */
export function BattleExportBar({ entrants, results, winners, prompt, palette }: Props) {
  const [scope, setScope] = useState<Scope>("winners");
  const [customIds, setCustomIds] = useState<string[]>([]);
  const [kind, setKind] = useState<ExportKind>("json");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const successful = useMemo(
    () => entrants.filter((entrant) => results[entrant.id]?.status === "success"),
    [entrants, results],
  );

  const targets = useMemo(() => {
    if (scope === "all") return successful;
    if (scope === "winners") {
      return successful.filter((entrant) => winners.includes(entrant.id));
    }
    return successful.filter((entrant) => customIds.includes(entrant.id));
  }, [customIds, scope, successful, winners]);

  const buildFor = (id: string): VoxelBuild | null => results[id]?.voxelBuild ?? null;

  const runExport = async () => {
    if (busy) return;
    if (targets.length === 0) {
      setStatus("Nothing selected to export.");
      return;
    }

    setBusy(true);
    setStatus(`Exporting ${targets.length} item${targets.length === 1 ? "" : "s"}…`);

    try {
      if (kind === "report") {
        download(
          new Blob([buildReport({ entrants, results, winners, prompt, targets })], {
            type: "text/markdown;charset=utf-8",
          }),
          `minebench-battle-${sanitize(prompt)}-${timestamp()}.md`,
        );
        setStatus("Report downloaded.");
        return;
      }

      const paletteDefs = getPalette(palette);
      let index = 0;

      for (const entrant of targets) {
        index += 1;
        const build = buildFor(entrant.id);
        if (!build) continue;

        setStatus(`Exporting ${index}/${targets.length}: ${entrant.label}…`);
        // Yield so the status text actually paints between heavy exports.
        await new Promise((resolve) => window.setTimeout(resolve, 0));

        const stem = [
          "minebench",
          sanitize(entrant.label),
          sanitize(prompt),
          timestamp(),
        ]
          .filter(Boolean)
          .join("-");

        if (kind === "json") {
          download(
            new Blob([JSON.stringify(build)], { type: "application/json" }),
            `${stem}.json`,
          );
          continue;
        }

        if (kind === "html") {
          const res = await fetch("/api/export/html", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ build, prompt, model: entrant.label }),
          });
          if (!res.ok) {
            setStatus(`HTML export failed for ${entrant.label}.`);
            return;
          }
          download(await res.blob(), `${stem}.html`);
          continue;
        }

        const artifact = exportVoxelBuild(build, paletteDefs, kind);
        const bytes = new Uint8Array(artifact.bytes);
        download(
          new Blob([bytes], { type: artifact.mimeType }),
          `${stem}.${artifact.extension}`,
        );
      }

      setStatus(`Exported ${targets.length} item${targets.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  };

  if (successful.length === 0) return null;

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border/70 bg-panel/40 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Export scope</span>
          <select
            className="mb-field h-9 w-40 text-xs"
            value={scope}
            disabled={busy}
            onChange={(e) => setScope(e.target.value as Scope)}
          >
            <option value="winners">Winners ({winners.length})</option>
            <option value="all">All successful ({successful.length})</option>
            <option value="custom">Custom selection</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Format</span>
          <select
            className="mb-field h-9 w-48 text-xs"
            value={kind}
            disabled={busy}
            onChange={(e) => setKind(e.target.value as ExportKind)}
          >
            {EXPORT_KINDS.map((option) => (
              <option key={option.kind} value={option.kind}>
                {`${option.label} — ${option.detail}`}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="mb-btn h-9 px-3 text-xs font-medium"
          disabled={busy || targets.length === 0}
          onClick={() => void runExport()}
        >
          {busy ? "Exporting…" : `Export ${targets.length}`}
        </button>

        {status ? <span className="pb-2 text-[11px] text-muted">{status}</span> : null}
      </div>

      {scope === "custom" ? (
        <div className="flex flex-wrap gap-2 rounded border border-border/50 bg-bg/60 p-2">
          {successful.map((entrant) => (
            <label key={entrant.id} className="flex items-center gap-1 text-[11px]">
              <input
                type="checkbox"
                checked={customIds.includes(entrant.id)}
                disabled={busy}
                onChange={() =>
                  setCustomIds((prev) =>
                    prev.includes(entrant.id)
                      ? prev.filter((id) => id !== entrant.id)
                      : [...prev, entrant.id],
                  )
                }
              />
              {entrant.label}
            </label>
          ))}
          <button
            type="button"
            className="mb-btn h-7 px-2 text-[11px]"
            disabled={busy}
            onClick={() =>
              setCustomIds(
                customIds.length === successful.length
                  ? []
                  : successful.map((entrant) => entrant.id),
              )
            }
          >
            {customIds.length === successful.length ? "Clear all" : "Select all"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function buildReport(params: {
  entrants: BattleEntrant[];
  results: Record<string, EntrantResult>;
  winners: string[];
  prompt: string;
  targets: BattleEntrant[];
}): string {
  const lines: string[] = [
    "# MineBench battle report",
    "",
    `- **Prompt**: ${params.prompt}`,
    `- **Generated**: ${new Date().toISOString()}`,
    `- **Models compared**: ${params.entrants.length}`,
    `- **Winners**: ${
      params.winners.length === 0
        ? "(none selected)"
        : params.targets
            .filter((entrant) => params.winners.includes(entrant.id))
            .map((entrant) => entrant.label)
            .join(", ") || "(none in scope)"
    }`,
    "",
    "| Model | Provider | Wire model | Status | Blocks | Duration | Tokens | Reasoning tok |",
    "|---|---|---|---|---:|---:|---:|---:|",
  ];

  for (const entrant of params.entrants) {
    const result = params.results[entrant.id];
    const duration =
      result?.startedAt && result?.finishedAt ? result.finishedAt - result.startedAt : undefined;
    lines.push(
      `| ${params.winners.includes(entrant.id) ? "★ " : ""}${entrant.label} | ${
        entrant.providerLabel
      } | \`${entrant.modelId}\` | ${result?.status ?? "idle"} | ${
        result?.metrics?.blockCount?.toLocaleString() ?? "—"
      } | ${duration ? `${(duration / 1000).toFixed(1)}s` : "—"} | ${
        result?.usage?.totalTokens?.toLocaleString() ?? "—"
      } | ${result?.usage?.reasoningTokens?.toLocaleString() ?? "—"} |`,
    );
  }

  const failures = params.entrants.filter(
    (entrant) => params.results[entrant.id]?.status === "error",
  );
  if (failures.length > 0) {
    lines.push("", "## Failures", "");
    for (const entrant of failures) {
      lines.push(`### ${entrant.label}`, "", "```", params.results[entrant.id]?.error ?? "", "```", "");
    }
  }

  return lines.join("\n");
}
