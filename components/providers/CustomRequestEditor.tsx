"use client";

import { useState } from "react";
import {
  inferCustomParamValue,
  type CustomHeader,
  type CustomParam,
  type CustomParamType,
} from "@/lib/ai/providerConfig";

/**
 * Custom Request editor: extra outbound headers and extra request-body keys.
 *
 * Layout mirrors the mobile reference: each entry stacks a single-line key field
 * (with a trash affordance) above a multi-line value field, then a full-width
 * add button. Values are textareas because the useful ones are long — a JSON
 * object, a long token, a base64 blob — and a one-line input hides all of it.
 */

const PARAM_TYPES: ReadonlyArray<{ value: CustomParamType; label: string }> = [
  { value: "auto", label: "auto" },
  { value: "string", label: "string" },
  { value: "number", label: "number" },
  { value: "boolean", label: "boolean" },
  { value: "json", label: "json" },
];

/** Renders how a value will actually be sent, so surprises surface before a run. */
function previewValue(param: CustomParam): { text: string; kind: string } | null {
  if (!param.value.trim()) return null;
  try {
    let parsed: unknown;
    switch (param.type) {
      case "number": {
        const n = Number(param.value);
        if (!Number.isFinite(n)) return { text: "invalid number", kind: "error" };
        parsed = n;
        break;
      }
      case "boolean": {
        const v = param.value.trim().toLowerCase();
        if (["true", "1", "yes", "on"].includes(v)) parsed = true;
        else if (["false", "0", "no", "off"].includes(v)) parsed = false;
        else return { text: "invalid boolean", kind: "error" };
        break;
      }
      case "json": {
        parsed = JSON.parse(param.value);
        break;
      }
      case "string":
        parsed = param.value;
        break;
      default:
        parsed = inferCustomParamValue(param.value);
    }
    const json = JSON.stringify(parsed);
    return {
      text: json.length > 120 ? `${json.slice(0, 120)}…` : json,
      kind: parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed,
    };
  } catch {
    return { text: "invalid JSON", kind: "error" };
  }
}

function TrashIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px]"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export function CustomRequestEditor({
  headers,
  params,
  disabled,
  onHeadersChange,
  onParamsChange,
}: {
  headers: CustomHeader[];
  params: CustomParam[];
  disabled?: boolean;
  onHeadersChange: (headers: CustomHeader[]) => void;
  onParamsChange: (params: CustomParam[]) => void;
}) {
  const [showTypes, setShowTypes] = useState(false);

  return (
    <div className="flex flex-col gap-4 rounded border border-border/50 bg-bg/60 p-3">
      <div>
        <div className="text-xs font-medium">Custom Request</div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          Applies to every model from this provider. These values are the last word
          on any key they name — they override this provider&apos;s own settings and
          the locked-envelope preset. Use them to add parameters MineBench has no
          field for.
        </p>
      </div>

      {/* ---- headers ---- */}
      <section className="flex flex-col gap-2">
        <div className="text-xs font-medium text-muted">Custom Headers</div>

        {headers.map((header, index) => {
          const update = (patch: Partial<CustomHeader>) =>
            onHeadersChange(
              headers.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
            );
          const invalidName =
            header.name.trim().length > 0 &&
            !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(header.name.trim());
          const invalidValue = /[\r\n]/.test(header.value);

          return (
            <div key={`header-${index}`} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <input
                  className="mb-field h-10 min-w-0 flex-1"
                  placeholder="Header-Name"
                  value={header.name}
                  disabled={disabled}
                  aria-label={`Header name ${index + 1}`}
                  onChange={(e) => update({ name: e.target.value })}
                />
                <label
                  className="flex shrink-0 items-center gap-1 text-[10px] text-muted"
                  title="Include this header"
                >
                  <input
                    type="checkbox"
                    checked={header.enabled}
                    disabled={disabled}
                    onChange={(e) => update({ enabled: e.target.checked })}
                  />
                  on
                </label>
                <button
                  type="button"
                  className="mb-btn flex h-10 w-10 shrink-0 items-center justify-center"
                  disabled={disabled}
                  aria-label={`Remove header ${header.name || index + 1}`}
                  onClick={() => onHeadersChange(headers.filter((_, i) => i !== index))}
                >
                  <TrashIcon />
                </button>
              </div>
              <textarea
                className="mb-field min-h-[44px] w-full resize-y py-2 font-mono text-xs"
                placeholder="value"
                rows={1}
                value={header.value}
                disabled={disabled}
                aria-label={`Header value ${index + 1}`}
                onChange={(e) => update({ value: e.target.value })}
              />
              {invalidName ? (
                <p className="text-[10px] text-danger">
                  Header names allow letters, digits and{" "}
                  <code>! # $ % &amp; &apos; * + . ^ _ ` | ~ -</code> only.
                </p>
              ) : null}
              {invalidValue ? (
                <p className="text-[10px] text-danger">
                  Header values cannot contain line breaks.
                </p>
              ) : null}
            </div>
          );
        })}

        <button
          type="button"
          className="mb-btn h-10 w-full text-xs"
          disabled={disabled}
          onClick={() => onHeadersChange([...headers, { name: "", value: "", enabled: true }])}
        >
          + Add Header
        </button>
      </section>

      {/* ---- body ---- */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-medium text-muted">Custom Body</div>
          <label className="flex items-center gap-1 text-[10px] text-muted">
            <input
              type="checkbox"
              checked={showTypes}
              onChange={(e) => setShowTypes(e.target.checked)}
            />
            show types
          </label>
        </div>
        <p className="text-[11px] leading-relaxed text-muted">
          Types are detected automatically: <code>{"{...}"}</code> and{" "}
          <code>[...]</code> parse as JSON, <code>true</code>/<code>false</code>/
          <code>null</code> as literals, bare numbers as numbers, anything else as
          text. Dot paths write nested keys (<code>stream_options.include_usage</code>
          ). Enable <em>show types</em> to force one.
        </p>

        {params.map((param, index) => {
          const update = (patch: Partial<CustomParam>) =>
            onParamsChange(
              params.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
            );
          const preview = previewValue(param);

          return (
            <div key={`param-${index}`} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <input
                  className="mb-field h-10 min-w-0 flex-1"
                  placeholder="key (e.g. reasoning_effort)"
                  value={param.key}
                  disabled={disabled}
                  aria-label={`Body key ${index + 1}`}
                  onChange={(e) => update({ key: e.target.value })}
                />
                {showTypes ? (
                  <select
                    className="mb-field h-10 w-[92px] shrink-0 text-xs"
                    value={param.type}
                    disabled={disabled}
                    aria-label={`Body value type ${index + 1}`}
                    onChange={(e) => update({ type: e.target.value as CustomParamType })}
                  >
                    {PARAM_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                ) : null}
                <label
                  className="flex shrink-0 items-center gap-1 text-[10px] text-muted"
                  title="Include this parameter"
                >
                  <input
                    type="checkbox"
                    checked={param.enabled}
                    disabled={disabled}
                    onChange={(e) => update({ enabled: e.target.checked })}
                  />
                  on
                </label>
                <button
                  type="button"
                  className="mb-btn flex h-10 w-10 shrink-0 items-center justify-center"
                  disabled={disabled}
                  aria-label={`Remove parameter ${param.key || index + 1}`}
                  onClick={() => onParamsChange(params.filter((_, i) => i !== index))}
                >
                  <TrashIcon />
                </button>
              </div>
              <textarea
                className="mb-field min-h-[60px] w-full resize-y py-2 font-mono text-xs"
                placeholder={'value (e.g. max, 128000, {"type": "enabled"})'}
                rows={2}
                value={param.value}
                disabled={disabled}
                aria-label={`Body value ${index + 1}`}
                onChange={(e) => update({ value: e.target.value })}
              />
              {preview ? (
                <p
                  className={`font-mono text-[10px] ${
                    preview.kind === "error" ? "text-danger" : "text-muted"
                  }`}
                >
                  {preview.kind === "error"
                    ? preview.text
                    : `sends as ${preview.kind}: ${preview.text}`}
                </p>
              ) : null}
            </div>
          );
        })}

        <button
          type="button"
          className="mb-btn h-10 w-full text-xs"
          disabled={disabled}
          onClick={() =>
            onParamsChange([...params, { key: "", type: "auto", value: "", enabled: true }])
          }
        >
          + Add Body
        </button>
      </section>
    </div>
  );
}
