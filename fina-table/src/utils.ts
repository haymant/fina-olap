import type { SSRMRequest, SSRMResponse } from "./types";

/** Join truthy class names (tiny `cn`—no external dependency). */
export const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(" ");

/** Stable map key for a group path (ag-grid groupKeys). */
export const pathKeyOf = (path: readonly string[]): string => path.join("::");

/** Reverse of pathKeyOf; "" maps to the root block. */
export const pathFromKey = (key: string): string[] => (key === "" ? [] : key.split("::"));

/** Canonical row key within a block: block path + position. */
export const rowKeyOf = (blockKey: string, index: number, fallback?: unknown): string =>
  `${blockKey}#${index}:${fallback == null ? "" : String(fallback)}`;

const NULL_LABEL = "—";

/** Default cell formatting shared across cells (data-grid compatible). */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return NULL_LABEL;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? new Intl.NumberFormat("en-US").format(value)
      : new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value);
  }
  return String(value);
}

/** Default numeric formatting for measure columns (grouped thousands, ≤4 dp). */
export function formatNumber(value: unknown): string {
  if (typeof value !== "number" || Number.isNaN(value)) return formatCellValue(value);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
}

/**
 * Default date/datetime formatting (Italian locale, UTC-stable). Accepts ISO
 * strings, `Date` instances or epoch millis; falls back to the raw value when
 * it cannot be parsed.
 */
export function formatDateValue(value: unknown, withTime = false): string {
  if (value === null || value === undefined) return NULL_LABEL;
  let d: Date;
  if (value instanceof Date) {
    d = value;
  } else if (typeof value === "number") {
    d = new Date(value);
  } else {
    let s = String(value).trim();
    // Normalise to ISO-UTC: bare dates get midnight; "YYYY-MM-DD hh:mm:ss"
    // gets a T separator; naive datetimes get a trailing Z.
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(" ", "T");
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = `${s}T00:00:00Z`;
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !/([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) s = `${s}Z`;
    d = new Date(s);
  }
  if (Number.isNaN(d.getTime())) return formatCellValue(value);
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  };
  if (withTime) {
    opts.hour = "2-digit";
    opts.minute = "2-digit";
    opts.second = "2-digit";
    opts.hour12 = false;
  }
  return new Intl.DateTimeFormat("it-IT", opts).format(d);
}

/**
 * Resolve the row's column layout order: server-declared row fields take
 * precedence, otherwise derive from the request grained by pivot/LOD outputs.
 */
export function deriveColumns(payload: SSRMResponse, request: SSRMRequest): string[] {
  // Pivot mode: only the server-generated pivot aliases (+ group fields) are
  // real columns — plain valueCol fields must NOT leak in from the fallback.
  const pivotFields = payload.pivotResultFields ?? [];
  if (request.pivotMode && pivotFields.length > 0) {
    return [...(request.rowGroupCols ?? []).map((g) => g.field), ...pivotFields];
  }
  if (payload.rowResultFields && payload.rowResultFields.length > 0) {
    return payload.rowResultFields;
  }
  const fields = new Set<string>();
  for (const g of request.rowGroupCols ?? []) fields.add(g.field);
  for (const v of request.valueCols ?? []) fields.add(v.field);
  for (const p of pivotFields) fields.add(p);
  for (const l of payload.lodFields ?? []) fields.add(l);
  for (const r of payload.rows) for (const k of Object.keys(r)) fields.add(k);
  return [...fields];
}

/**
 * Split a pivoted column alias (e.g. `funding_delta`) back into its group
 * value (`funding`) and measure field (`delta`) by stripping the measure
 * suffix. Returns null when the alias matches no known measure column.
 */
export function splitPivotAlias(
  alias: string,
  measureFields: string[],
): { value: string; measure: string } | null {
  for (const measure of measureFields) {
    const suffix = `_${measure}`;
    if (alias.endsWith(suffix) && alias.length > suffix.length) {
      return { value: alias.slice(0, alias.length - suffix.length), measure };
    }
  }
  return null;
}