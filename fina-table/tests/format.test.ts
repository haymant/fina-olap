import { describe, expect, it } from "vitest";

import { formatPhone, formatWithSpec } from "../src/format";
import { formatCellValue, formatDateValue, formatNumber } from "../src/utils";

describe("default cell formatters", () => {
  describe("numeric", () => {
    it("groups thousands and keeps up to 4 decimals", () => {
      expect(formatNumber(1234567.891)).toBe("1,234,567.891");
      expect(formatNumber(42)).toBe("42");
    });

    it("formats negative and positive numbers", () => {
      expect(formatNumber(-42.5)).toBe("-42.5");
      expect(formatNumber(0)).toBe("0");
    });

    it("passes through non-numbers via formatCellValue", () => {
      expect(formatNumber(null)).toBe("—");
      expect(formatNumber("n/a")).toBe("n/a");
    });
  });

  describe("date", () => {
    it("renders ISO calendar dates the Italian way", () => {
      expect(formatDateValue("2024-09-01")).toBe("01/09/2024");
      expect(formatDateValue(new Date("2024-09-01T00:00:00Z"))).toBe("01/09/2024");
    });

    it("does not shift the day across timezones (UTC-stable)", () => {
      expect(formatDateValue("2024-01-01")).toBe("01/01/2024");
    });

    it("falls back to the raw value when unparseable", () => {
      expect(formatDateValue("not-a-date")).toBe("not-a-date");
      expect(formatDateValue(null)).toBe("—");
    });
  });

  describe("datetime", () => {
    it("includes the wall clock time", () => {
      expect(formatDateValue("2024-09-01T13:45:30Z", true)).toBe("01/09/2024, 13:45:30");
    });

    it("accepts a space-separated timestamp and epoch millis", () => {
      expect(formatDateValue("2024-09-01 13:45:30", true)).toBe("01/09/2024, 13:45:30");
      expect(formatDateValue(Date.UTC(2024, 8, 1, 13, 45, 30), true)).toBe("01/09/2024, 13:45:30");
    });
  });

  describe("string", () => {
    it("renders text verbatim and nulls as the em dash", () => {
      expect(formatCellValue("flow")).toBe("flow");
      expect(formatCellValue("")).toBe("");
      expect(formatCellValue(null)).toBe("—");
      expect(formatCellValue(undefined)).toBe("—");
    });
  });
});

describe("column format spec", () => {
  it("returns undefined when no format is configured", () => {
    expect(formatWithSpec(1)).toBeUndefined();
  });

  it("formats numbers with a locale and decimals", () => {
    expect(formatWithSpec(1234.5, { type: "number", maximumFractionDigits: 2 })).toBe("1,234.5");
    expect(formatWithSpec(3.14159, { type: "number", maximumFractionDigits: 3 })).toBe("3.142");
  });

  it("formats currency", () => {
    expect(formatWithSpec(1234.5, { type: "currency", currency: "USD" })).toBe("$1,234.50");
    expect(formatWithSpec(1234.5, { type: "currency", currency: "EUR", pattern: "de-DE" })).toContain("1.234,50");
  });

  it("formats percent", () => {
    expect(formatWithSpec(0.1234, { type: "percent", maximumFractionDigits: 1 })).toBe("12.3%");
  });

  it("formats date with a dayjs pattern (UTC-stable)", () => {
    expect(formatWithSpec("2024-09-01", { type: "date", pattern: "YYYY/MM/DD" })).toBe("2024/09/01");
    expect(formatWithSpec("2024-09-01", { type: "date" })).toBe("01/09/2024");
  });

  it("formats datetime", () => {
    expect(formatWithSpec("2024-09-01T13:45:30Z", { type: "datetime" })).toBe("01/09/2024 13:45:30");
  });

  it("converts Excel serial dates", () => {
    expect(formatWithSpec(45536, { type: "excel" })).toBe("01/09/2024");
  });

  it("converts epoch seconds and millis", () => {
    expect(formatWithSpec(1725198330, { type: "epoch", unit: "s" })).toBe("01/09/2024 13:45:30");
    expect(formatWithSpec(1725198330000, { type: "epoch", unit: "ms" })).toBe("01/09/2024 13:45:30");
    expect(formatWithSpec(1725198330, { type: "epoch", unit: "auto" })).toBe("01/09/2024 13:45:30");
  });

  it("groups phone numbers and keeps the leading plus", () => {
    expect(formatPhone("+14155552671")).toBe("+141 555 526 71");
    expect(formatWithSpec("+14155552671", { type: "phone" })).toBe("+141 555 526 71");
  });

  it("renders nulls as the em dash for any format", () => {
    expect(formatWithSpec(null, { type: "number" })).toBe("—");
  });
});
