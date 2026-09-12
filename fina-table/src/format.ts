import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import type { ColumnFormat } from "./types";

dayjs.extend(utc);

const EXCEL_EPOCH = dayjs.utc("1899-12-30");

/**
 * Apply a per-measure `ColumnFormat` to a value. Returns `undefined` when no
 * format is configured (so callers fall back to the default renderer).
 * Dayjs handles date/datetime/excel/epoch/custom patterns; `Intl` handles
 * number/currency/percent; `phone` is a lightweight grouping formatter.
 */
export function formatWithSpec(value: unknown, format?: ColumnFormat): string | undefined {
  if (!format) return undefined;
  if (value === null || value === undefined) return "—";

  switch (format.type) {
    case "text":
      return String(value);

    case "number": {
      const n = Number(value);
      if (Number.isNaN(n)) return String(value);
      return new Intl.NumberFormat(format.pattern || "en-US", {
        minimumFractionDigits: format.minimumFractionDigits,
        maximumFractionDigits: format.maximumFractionDigits ?? 2,
      }).format(n);
    }

    case "currency": {
      const n = Number(value);
      if (Number.isNaN(n)) return String(value);
      return new Intl.NumberFormat(format.pattern || "en-US", {
        style: "currency",
        currency: format.currency || "USD",
        minimumFractionDigits: format.minimumFractionDigits,
        maximumFractionDigits: format.maximumFractionDigits ?? 2,
      }).format(n);
    }

    case "percent": {
      const n = Number(value);
      if (Number.isNaN(n)) return String(value);
      return new Intl.NumberFormat(format.pattern || "en-US", {
        style: "percent",
        minimumFractionDigits: format.minimumFractionDigits,
        maximumFractionDigits: format.maximumFractionDigits ?? 2,
      }).format(n);
    }

    case "date":
      return toDayjs(value)?.format(format.pattern || "DD/MM/YYYY") ?? String(value);

    case "datetime":
      return toDayjs(value)?.format(format.pattern || "DD/MM/YYYY HH:mm:ss") ?? String(value);

    case "excel": {
      const n = Number(value);
      if (Number.isNaN(n)) return String(value);
      return EXCEL_EPOCH.add(n, "day").format(format.pattern || "DD/MM/YYYY");
    }

    case "epoch": {
      const n = Number(value);
      if (Number.isNaN(n)) return String(value);
      const unit = format.unit ?? "auto";
      const ms = unit === "s" ? n * 1000 : unit === "ms" ? n : Math.abs(n) < 1e12 ? n * 1000 : n;
      const pattern = format.pattern && /[YMDHms]/.test(format.pattern) ? format.pattern : "DD/MM/YYYY HH:mm:ss";
      return dayjs.utc(ms).format(pattern);
    }

    case "phone":
      return formatPhone(String(value));

    case "custom": {
      // A dayjs pattern when the value parses as a date, else a plain template.
      const d = toDayjs(value);
      return d ? d.format(format.pattern || "YYYY-MM-DD") : String(value);
    }

    default:
      return undefined;
  }
}

/** Parse ISO dates, space-separated datetimes, Date instances or epoch millis (UTC). */
function toDayjs(value: unknown): dayjs.Dayjs | null {
  if (dayjs.isDayjs(value)) return value.utc();
  let s: string | number | Date;
  if (value instanceof Date) s = value;
  else if (typeof value === "number") s = value;
  else {
    s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(" ", "T");
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = `${s}T00:00:00Z`;
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !/([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) s = `${s}Z`;
  }
  const d = dayjs.utc(s);
  return d.isValid() ? d : null;
}

/** Lightweight phone grouping: keep a leading `+`, groups of 3, tail grouped. */
export function formatPhone(input: string): string {
  const trimmed = input.trim();
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return input;
  const grouped = digits.replace(/(\d{3})(?=\d)/g, "$1 ").trim();
  return (plus ? "+" : "") + grouped;
}
