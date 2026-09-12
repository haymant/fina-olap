import { vi } from "vitest";
import type { FilterCondition, SSRMRequest } from "../src/types";

export type FixtureRow = Record<string, string | number | boolean | null>;

/**
 * A mock of the fina-olap SSRM server. Mirrors the real grouping/pivot
 * semantics:
 *  - depth 0 < rowGroupCols: group rows (distinct values of the level field,
 *    SUM-agg measures over that group, earlier level fields filled from groupKeys)
 *  - depth >= rowGroupCols: leaf rows (raw) filtered by the group path
 *  - pivotMode: aliased columns `{pivotValue}_{measure}` per value col, in
 *    `product(pivot values) x valueCols` order (mirrors fina_olap builder)
 *  - page block with `lastRow === -1` while more rows remain
 */
export function makeSsrmServer(dataset: FixtureRow[]) {
  const calls: SSRMRequest[] = [];
  const fetchMock = vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body ?? "{}")) as SSRMRequest;
    calls.push(req);
    return fakeResponse(req, dataset);
  });
  return { calls, fetchMock };
}

export function fakeResponse(req: SSRMRequest, dataset: FixtureRow[]): Response {
  const groups = req.rowGroupCols ?? [];
  const keys = req.groupKeys ?? [];
  const pageSize = Math.max(1, req.endRow - req.startRow);
  const matched = applyFilterModel(dataset, req.filterModel).filter((r) =>
    keys.every((k, i) => String(r[groups[i]?.field ?? ""]) === String(k)),
  );

  let rows: FixtureRow[] = [];
  let pivotResultFields: string[] = [];
  const depth = keys.length;

  const pivotFields = (req.pivotCols ?? []).map((c) => c.field).filter(Boolean);
  const valueCols = req.valueCols ?? [];
  if (req.pivotMode && pivotFields.length > 0 && valueCols.length > 0) {
    // distinct pivot values per pivot column, sorted like DuckDB
    const valuesPerField = pivotFields.map((f) => [
      ...new Set(matched.map((r) => String(r[f] ?? "")).filter((v) => v !== "")),
    ].sort());
    const combos = product(valuesPerField);
    const row: FixtureRow = {};
    for (let i = 0; i < depth; i++) row[groups[i]!.field] = keys[i]!;
    for (const combo of combos) {
      const comboStr = combo.join("_");
      for (const v of valueCols) {
        const subset = matched.filter((r) => combo.every((c, i) => String(r[pivotFields[i]!]) === c));
        const n = subset.map((r) => Number(r[v.field]) || 0);
        const alias = `${comboStr}_${v.field}`;
        row[alias] = n.reduce((a, b) => a + b, 0);
        pivotResultFields.push(alias);
      }
    }
    rows = [row];
  } else if (depth < groups.length) {
    const field = groups[depth]!.field;
    const byValue = new Map<string, FixtureRow[]>();
    for (const r of matched) {
      const v = String(r[field] ?? "");
      const arr = byValue.get(v) ?? [];
      arr.push(r);
      byValue.set(v, arr);
    }
    for (const [value, subset] of byValue) {
      const row: FixtureRow = {};
      for (let i = 0; i < depth; i++) row[groups[i]!.field] = keys[i]!;
      row[field] = value;
      for (const v of req.valueCols ?? []) {
        const n = subset.map((r) => Number(r[v.field]) || 0);
        row[v.field] = n.reduce((a, b) => a + b, 0);
      }
      rows.push(row);
    }
  } else {
    rows = matched;
  }
  rows = [...rows].sort((a, b) => {
    const ka = String(a[groups[depth - 1]?.field ?? ""]);
    const kb = String(b[groups[depth - 1]?.field ?? ""]);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // Grand total: mirrors the server UNION — leading row with all group keys
  // NULL and a whole-table aggregate per value col (own agg, default sum).
  if (
    req.includeGrandTotal &&
    depth === 0 &&
    !(req.pivotMode && pivotFields.length > 0) &&
    (groups.length > 0 || valueCols.length > 0)
  ) {
    const agg = (req.grandTotalAggFunc ?? "sum").toLowerCase();
    const gt: FixtureRow = {};
    for (const g of groups) gt[g.field] = null;
    for (const v of valueCols) {
      const nums = matched.map((r) => Number(r[v.field]) || 0);
      gt[v.field] = aggregate(nums, agg);
    }
    rows = [gt, ...rows];
  }

  const total = rows.length;
  const page = rows.slice(req.startRow, req.startRow + pageSize);
  const remaining = total - (req.startRow + page.length);
  const lastRow = remaining > 0 ? -1 : (req.startRow + page.length - 1);

  const rowResultFields = [
    ...groups.map((g) => g.field),
    ...valueCols.map((v) => v.field),
    ...(page[0] ? Object.keys(page[0]).filter((k) => !rowResultFieldsOf(req).includes(k)) : []),
  ];

  return new Response(
    JSON.stringify({
      success: true,
      rows: page,
      lastRow,
      rowResultFields: dedupe(rowResultFields),
      pivotResultFields,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function product(groups: string[][]): string[][] {
  let out: string[][] = [[]];
  for (const g of groups) {
    const next: string[][] = [];
    for (const prefix of out) for (const v of g) next.push([...prefix, v]);
    out = next;
  }
  return out;
}

/** Whole-table aggregate mirroring the server's grand-total aggregation. */
function aggregate(nums: number[], agg: string): number {
  if (nums.length === 0) return 0;
  switch (agg) {
    case "avg":
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "count":
      return nums.length;
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
    case "first":
      return nums[0]!;
    case "last":
      return nums[nums.length - 1]!;
    default:
      return nums.reduce((a, b) => a + b, 0);
  }
}

function rowResultFieldsOf(req: SSRMRequest): string[] {
  return [
    ...(req.rowGroupCols ?? []).map((g) => g.field),
    ...(req.valueCols ?? []).map((v) => v.field),
  ];
}

function dedupe(fields: string[]): string[] {
  return [...new Set(fields)];
}

/** Client-side mirror of the server SQL filterModel (ag-grid `operator` shape). */
function applyFilterModel(dataset: FixtureRow[], filterModel: SSRMRequest["filterModel"]): FixtureRow[] {
  if (!filterModel) return dataset;
  return dataset.filter((r) =>
    Object.entries(filterModel).every(([field, item]) => {
      if ("conditions" in item) return true; // combined filters unsupported in the mock
      return matchesFilter(r[field], item);
    }),
  );
}

function matchesFilter(value: unknown, c: FilterCondition): boolean {
  const v = String(value);
  const f = String(c.filter);
  switch (c.operator) {
    case "equals":
      return v === f;
    case "notEquals":
    case "notEqual":
      return v !== f;
    case "contains":
      return v.includes(f);
    case "notContains":
      return !v.includes(f);
    case "startsWith":
      return v.startsWith(f);
    case "endsWith":
      return v.endsWith(f);
    case "greaterThan":
      return Number(value) > Number(c.filter);
    case "greaterThanOrEqual":
      return Number(value) >= Number(c.filter);
    case "lessThan":
      return Number(value) < Number(c.filter);
    case "lessThanOrEqual":
      return Number(value) <= Number(c.filter);
    case "inRange":
    case "between":
      return Number(value) >= Number(c.filter) && Number(value) <= Number(c.filterTo);
    default:
      return true;
  }
}