"use client";

import { useMemo, useState } from "react";
import type { ProviderExchangeLog } from "@/lib/ai/providerExchangeLog";

export type ExchangeLogEntry = ProviderExchangeLog & {
  /** Which model produced this exchange. */
  modelKey: string;
  modelLabel: string;
};

type Props = {
  entries: ExchangeLogEntry[];
  onClear?: () => void;
};

type TabKey = "request" | "response" | "raw" | "reasoning";

const TAB_LABELS: Record<TabKey, string> = {
  request: "Request",
  response: "Response",
  raw: "Raw body",
  reasoning: "Reasoning",
};

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatBytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(2)} MB`;
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="mb-btn h-7 px-2 text-[11px]"
      disabled={!text}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard can be blocked by permissions; the text stays selectable.
          setCopied(false);
        }
      }}
    >
      {copied ? "Copied" : (label ?? "Copy")}
    </button>
  );
}

export function ExchangeLogPanel({ entries, onClear }: Props) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [tab, setTab] = useState<TabKey>("request");
  const [wrap, setWrap] = useState(true);

  // Newest first: when debugging you almost always want the last attempt.
  const ordered = useMemo(() => [...entries].reverse(), [entries]);
  const active = ordered[Math.min(activeIndex, ordered.length - 1)];

  if (ordered.length === 0) {
    return (
      <p className="rounded-md border border-border/60 bg-bg/40 px-3 py-4 text-xs text-muted">
        No requests logged yet. Enable <strong>Capture debug log</strong> and run a
        generation — the full request and response body of every provider call
        will appear here.
      </p>
    );
  }

  const content = ((): string => {
    if (!active) return "";
    switch (tab) {
      case "request":
        return [
          `${active.method} ${active.url}`,
          "",
          "--- headers ---",
          formatJson(active.requestHeaders),
          "",
          "--- body ---",
          active.requestBody === null ? "(no body)" : formatJson(active.requestBody),
        ].join("\n");
      case "response":
        return [
          `status: ${active.status ?? "(none)"}`,
          active.error ? `error: ${active.error}` : null,
          "",
          "--- headers ---",
          formatJson(active.responseHeaders ?? {}),
          "",
          "--- parsed ---",
          active.responseBodyJson !== undefined
            ? formatJson(active.responseBodyJson)
            : "(streamed response — see Raw body)",
          "",
          "--- assistant text ---",
          active.responseText ?? "(none)",
          "",
          "--- usage ---",
          formatJson(active.usage ?? null),
        ]
          .filter((line) => line !== null)
          .join("\n");
      case "raw":
        return active.responseBodyRaw ?? "(empty)";
      case "reasoning":
        return active.reasoningText || "(no reasoning content returned)";
      default:
        return "";
    }
  })();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="mb-field h-9 min-w-0 flex-1 text-xs"
          value={activeIndex}
          onChange={(e) => setActiveIndex(Number(e.target.value))}
        >
          {ordered.map((entry, index) => (
            <option key={`${entry.modelKey}-${entry.startedAt}-${index}`} value={index}>
              {`#${ordered.length - index} · ${entry.modelLabel} · ${
                entry.error ? "ERROR" : entry.status ?? "—"
              } · ${entry.durationMs ?? 0}ms`}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="mb-btn h-9 px-2 text-xs"
          onClick={() => setWrap((prev) => !prev)}
          title="Toggle line wrapping"
        >
          {wrap ? "No wrap" : "Wrap"}
        </button>
        {onClear ? (
          <button type="button" className="mb-btn h-9 px-2 text-xs" onClick={onClear}>
            Clear
          </button>
        ) : null}
      </div>

      {active ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <span className="font-mono">{active.method}</span>
            <span className="truncate font-mono">{active.url}</span>
            {active.usage?.total_tokens ? (
              <span>{active.usage.total_tokens.toLocaleString()} tokens</span>
            ) : null}
            {active.responseBodyRaw ? (
              <span>{formatBytes(active.responseBodyRaw.length)} raw</span>
            ) : null}
          </div>

          {active.error ? (
            <p className="rounded border border-danger/30 bg-danger/[0.08] px-2 py-1 text-[11px] text-danger">
              {active.error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-1">
            {(Object.keys(TAB_LABELS) as TabKey[]).map((key) => (
              <button
                key={key}
                type="button"
                className={`mb-btn h-8 px-2 text-[11px] ${
                  tab === key ? "border-accent/60 bg-accent/[0.12]" : ""
                }`}
                aria-pressed={tab === key}
                onClick={() => setTab(key)}
              >
                {TAB_LABELS[key]}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-1">
              <CopyButton text={content} label="Copy view" />
              <CopyButton
                text={formatJson(active.requestBody)}
                label="Copy request JSON"
              />
            </div>
          </div>

          <pre
            className={`max-h-[420px] overflow-auto rounded border border-border/50 bg-bg/70 p-2 font-mono text-[10px] leading-relaxed ${
              wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"
            }`}
          >
            {content}
          </pre>
        </>
      ) : null}
    </div>
  );
}
