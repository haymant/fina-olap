/**
 * Wire types for the fina-olap SSRM protocol.
 *
 * Mirrors the Python models in `fina_olap/schema.py` (SSRMRequest /
 * SSRMResponse) plus the OLAP extensions: per-level aggregation functions,
 * visible-level suppression and Level-of-Detail (LOD) configs.
 */

export type AggregationFn =
  | "sum"
  | "avg"
  | "count"
  | "min"
  | "max"
  | "first"
  | "last"
  | "stddev"
  | "variance"
  | "median";

export interface RowGroupCol {
  id: string;
  field: string;
  displayName?: string;
}

export interface PivotCol {
  id: string;
  field: string;
}

export interface SortItem {
  colId: string;
  sort: "asc" | "desc";
}

export type FilterConditionType = "text" | "number" | "date" | "boolean" | "set";

export interface FilterCondition {
  filterType: FilterConditionType;
  operator: string;
  filter?: string | number | boolean;
  filterTo?: string | number;
  values?: string[];
}

export interface CombinedFilter {
  filterType: "combined";
  operator: "AND" | "OR";
  conditions: FilterCondition[];
}

export type FilterModel = Record<string, FilterCondition | CombinedFilter>;

/** Per-column aggregation spec, optionally keyed by grouping level. */
export type FormatType =
  | "text"
  | "number"
  | "currency"
  | "percent"
  | "date"
  | "datetime"
  | "excel"
  | "epoch"
  | "phone"
  | "custom";

/** Per-measure display format (Intl for number/currency/percent, dayjs for dates). */
export interface ColumnFormat {
  type: FormatType;
  /** Locale for number/currency/percent, dayjs pattern for dates, currency code, or epoch unit. */
  pattern?: string;
  currency?: string;
  /** Epoch input unit (only for `type: "epoch"`). */
  unit?: "auto" | "s" | "ms";
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
}

/** Per-measure cell styling. */
export interface CellStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  align?: "left" | "right" | "center";
}

export interface ValueCol {
  id: string;
  field: string;
  /** Aggregation for this measure; `"none"` suppresses it at aggregated levels. */
  aggFunc?: AggregationFn | "none";
  /**
   * `{ levelFieldOrIndex: fn }` — OVERRIDES the column aggregation at specific
   * grouping levels. Keys are level field names ("portfolio") or 0-based level
   * indices ("1"); applies at deeper density only (does not de-aggregate).
   * The sentinel `"none"` suppresses the metric at that layer entirely.
   */
  aggFuncsByLevel?: Record<string, AggregationFn | "none">;
  /**
   * When set, values of this measure are output ONLY at the listed levels
   * (same key semantics); suppressed otherwise (server returns null).
   */
  visibleLevels?: string[];
  /** Display format for this measure's cells. */
  format?: ColumnFormat;
  /** Font/background/alignment styling for this measure's cells. */
  style?: CellStyle;
  displayName?: string;
  headerName?: string;
  filter?: "number" | "text" | "date";
  sortable?: boolean;
  width?: number;
}

export type LodType = "fixed" | "include" | "exclude";

export interface LodConfig {
  type: LodType;
  groupKeys: string[];
  metrics: Record<string, AggregationFn>;
  /** Column-name prefix for LOD measures in the row payload (default "_lod_"). */
  prefix?: string;
  /** Extra left-join key fields when the LOD grains are composite. */
  extraJoinKeys?: string[];
}

export interface DataSourceRef {
  /** gcs:// path, direct /path/to/file.parquet, or glob expression. */
  uri?: string;
  bucket?: string;
  path?: string;
  glob?: string;
  /** Read hive-style `key=value` partition directories (default true). */
  hivePartitioning?: boolean;
}

export interface SSRMRequest {
  startRow: number;
  endRow: number;
  rowGroupCols?: RowGroupCol[];
  groupKeys?: string[];
  pivotMode?: boolean;
  pivotCols?: PivotCol[];
  valueCols?: ValueCol[];
  sortModel?: SortItem[];
  filterModel?: FilterModel;
  includeGrandTotal?: boolean;
  /** Aggregation for the grand-total row (all records); defaults to "sum". */
  grandTotalAggFunc?: AggregationFn;
  includeTotals?: boolean;
  /** Unique-ify duplicate rows when no explicit group columns are set. */
  distinct?: boolean;
  tableName?: string;
  dataSource?: DataSourceRef;
  lodConfig?: LodConfig;
}

export interface SSRMResponse {
  success: boolean;
  rows: Array<Record<string, unknown>>;
  /** Absolute last-row index; -1 when more rows are available. */
  lastRow: number;
  /** Dynamically generated pivot column field names (e.g. "funding_delta"). */
  pivotResultFields?: string[];
  /** SQL-level aliases for rows (derived from group fields / value cols). */
  rowResultFields?: string[];
  /** LOD measure field names emitted in each row. */
  lodFields?: string[];
  totals?: Array<Record<string, unknown>>;
  metrics?: Record<string, number | string>;
  error?: string;
  version?: string;
}

/** Known variation of the SSRM payload sent by ag-grid (rename radar). */
export interface SSRMRequestVariants {
  rowGroupCols?: { id: string; field: string; displayName?: string }[];
  groupKeys?: string[];
  pivotMode?: boolean;
  pivotCols?: { id: string; field: string }[];
  valueCols?: Array<{
    id: string;
    field: string;
    aggFunc?: string;
    aggFuncsByLevel?: Record<string, string>;
    visibleLevels?: string[];
    displayName?: string;
  }>;
  sortModel?: SortItem[];
  filterModel?: FilterModel;
  startRow?: number;
  endRow?: number;
}