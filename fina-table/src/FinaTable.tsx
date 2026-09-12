import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import type { FieldDefinition } from "./panels";
import type { CellStyle, ColumnFormat, FilterCondition, SSRMRequest, SSRMResponse } from "./types";
import { configSpecFilter, useSSRM, type OLAPSpec } from "./use-ssrm";
import { cx, formatCellValue, formatDateValue, formatNumber, splitPivotAlias } from "./utils";
import { formatWithSpec } from "./format";
import { FilterPopover } from "./filter-popover";
import { ConfigMenu } from "./config-menu";
import type { SourceOption } from "./data-source-panel";
import { defaultChartSpec, type ChartSpec } from "./chart";
import { ChartView } from "./chart-view";
import { ChartSettings } from "./chart-settings";
import {
  ChevronDown,
  ChevronRight,
  ChartIcon,
  ConfigIcon,
  MoonIcon,
  RefreshIcon,
  SettingsIcon,
  SunIcon,
  TableIcon,
} from "./icons";
import "./styles.css";

export type FinaTableTheme = "light" | "dark" | "system";

export interface FinaTableProps {
  /** OLAP server endpoint (default `/api/getRows`). */
  endpoint?: string;
  /** Table the grid reads (defaults to `sources[0].tableName`). */
  tableName?: string;
  /** Selectable data sources shown in the config menu panel 1. */
  sources?: SourceOption[];
  fields: FieldDefinition[];
  pageSize?: number;
  debounceMs?: number;
  height?: number | string;
  theme?: FinaTableTheme;
  onThemeChange?: (theme: "light" | "dark") => void;
  /** When false, the header's config dropdown is hidden. Default true. */
  showPanels?: boolean;
  title?: string;
  headerActions?: ReactNode;
  /** Per-column cell formatter overrides: `(value, row) => ReactNode`. */
  columnFormatters?: Record<string, (value: unknown, row: Record<string, unknown>) => ReactNode>;
  onRows?: (request: SSRMRequest, response: SSRMResponse) => void;
}

export function FinaTable(props: FinaTableProps) {
  const {
    fields,
    height = "65vh",
    endpoint,
    onRows,
    columnFormatters,
  } = props;

  const sources = useMemo<SourceOption[]>(
    () => props.sources ?? (props.tableName ? [{ label: props.tableName, tableName: props.tableName }] : []),
    [props.sources, props.tableName],
  );
  const [tableName, setTableName] = useState<string>(props.tableName ?? sources[0]?.tableName ?? "");
  useEffect(() => {
    if (props.tableName) setTableName(props.tableName);
  }, [props.tableName]);

  const ssrm = useSSRM({
    endpoint,
    tableName,
    pageSize: props.pageSize,
    debounceMs: props.debounceMs,
    onRows,
  });

  // ---- theme ---------------------------------------------------------------
  // Never read platform state during initial render: SSR prerenders "light",
  // so hydration would mismatch on dark systems. Resolve the real preference
  // in an effect after mount.
  const theme = props.theme ?? "system";
  const [mode, setMode] = useState<"light" | "dark">(theme === "system" ? "light" : theme);
  useEffect(() => {
    if (theme === "system") {
      setMode(prefersDark());
      const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
      const onChange = () => setMode(mq.matches ? "dark" : "light");
      mq?.addEventListener?.("change", onChange);
      return () => mq?.removeEventListener?.("change", onChange);
    }
    setMode(theme);
  }, [theme]);

  const toggleTheme = () => {
    const next = mode === "light" ? "dark" : "light";
    setMode(next);
    props.onThemeChange?.(next);
  };

  // ---- config dropdown -----------------------------------------------------
  const [configOpen, setConfigOpen] = useState(false);
  const [configAnchor, setConfigAnchor] = useState<DOMRect | null>(null);
  const [configBtn, setConfigBtn] = useState<HTMLButtonElement | null>(null);

  // ---- chart view ----------------------------------------------------------
  const [view, setView] = useState<"table" | "chart">("table");
  const [chartSpec, setChartSpec] = useState<ChartSpec>(defaultChartSpec);
  const [chartSettingsOpen, setChartSettingsOpen] = useState(false);
  const [chartAnchor, setChartAnchor] = useState<DOMRect | null>(null);
  const [chartBtn, setChartBtn] = useState<HTMLButtonElement | null>(null);

  // ---- grid -----------------------------------------------------------------
  // The config panels must offer the columns the server actually returned (the
  // `fields` prop may only describe the initially selected table). We accumulate
  // every column seen for the current table/source (a grouped response only
  // carries the current level), then union with declared fields — unless the
  // table is completely different, in which case the loaded schema wins.
  const sourceKey = `${tableName}|${JSON.stringify(ssrm.spec.dataSource ?? null)}`;
  const [seen, setSeen] = useState<{ key: string; cols: string[] }>({ key: sourceKey, cols: [] });
  useEffect(() => {
    setSeen((prev) => (prev.key === sourceKey ? prev : { key: sourceKey, cols: [] }));
  }, [sourceKey]);
  useEffect(() => {
    if (ssrm.columns.length === 0) return;
    setSeen((prev) => {
      const cols = [...prev.cols];
      let changed = false;
      for (const col of ssrm.columns) {
        if (!cols.includes(col)) {
          cols.push(col);
          changed = true;
        }
      }
      return changed ? { ...prev, cols } : prev;
    });
  }, [ssrm.columns]);

  const panelFields = useMemo<FieldDefinition[]>(() => {
    const declaredMap = new Map(fields.map((f) => [f.field, f]));
    const loaded = seen.key === sourceKey && seen.cols.length > 0 ? seen.cols : ssrm.columns;
    const declaredHit = loaded.some((f) => declaredMap.has(f));
    const order =
      loaded.length === 0
        ? fields.map((f) => f.field)
        : declaredHit
          ? [...fields.map((f) => f.field), ...loaded.filter((f) => !declaredMap.has(f))]
          : loaded;
    const samples = ssrm.displayRows.slice(0, 50).map((d) => d.row);
    return order.map((field) => declaredMap.get(field) ?? { field, label: field, kind: inferFieldKind(field, samples) });
  }, [fields, seen, sourceKey, ssrm.columns, ssrm.displayRows]);

  const labelByField = useMemo(() => new Map(panelFields.map((f) => [f.field, f])), [panelFields]);

  const toggleView = () => {
    if (view === "table") {
      setChartSpec((prev) => seedChartSpec(prev, ssrm.spec, panelFields));
      setView("chart");
    } else {
      setView("table");
      setChartSettingsOpen(false);
    }
  };
  const colDefs = useMemo(() => {
    const measureFields = ssrm.spec.valueCols.map((v) => v.field);
    return ssrm.columns.map((field) => {
      const def = labelByField.get(field);
      const pivot = ssrm.spec.pivotMode ? splitPivotAlias(field, measureFields) : null;
      const measureDef = pivot ? labelByField.get(pivot.measure) : undefined;
      const measureField = pivot ? pivot.measure : field;
      const valueCol = ssrm.spec.valueCols.find((v) => v.field === measureField);
      return {
        field,
        label: def?.label ?? field,
        kind: pivot ? measureDef?.kind : def?.kind,
        formatter: pivot ? columnFormatters?.[pivot.measure] : columnFormatters?.[field],
        format: valueCol?.format,
        style: valueCol?.style,
        pivot: pivot ? { value: pivot.value, measureLabel: measureDef?.label ?? pivot.measure } : null,
      };
    });
  }, [ssrm.columns, ssrm.spec.pivotMode, ssrm.spec.valueCols, labelByField, columnFormatters]);

  // Group-column depth per field (index into spec.rowGroups), used to decide
  // whether a cell is a group label column.
  const groupDepthByField = useMemo(() => {
    const m = new Map<string, number>();
    ssrm.spec.rowGroups.forEach((g, i) => m.set(g.field, i));
    return m;
  }, [ssrm.spec.rowGroups]);

  // Merged group labels: within a run of rows sharing the same ancestor group
  // values, only the FIRST row shows the group column text; the rest are blank.
  const mergeFlags = useMemo(
    () => computeRowGroupFlags(ssrm.displayRows, ssrm.spec.rowGroups.map((g) => g.field)),
    [ssrm.displayRows, ssrm.spec.rowGroups],
  );

  // Two-layer pivot header: layer 1 = pivot group values, layer 2 = measures.
  const pivotColDefs = useMemo(() => colDefs.filter((c) => c.pivot), [colDefs]);
  const plainColDefs = useMemo(() => colDefs.filter((c) => !c.pivot), [colDefs]);
  const pivotGroups = useMemo(() => {
    const out: { value: string; count: number }[] = [];
    for (const c of pivotColDefs) {
      const v = c.pivot!.value;
      const last = out[out.length - 1];
      if (last && last.value === v) last.count++;
      else out.push({ value: v, count: 1 });
    }
    return out;
  }, [pivotColDefs]);
  const pivotHeader = pivotColDefs.length > 0;

  // Sticky group-context bar: when the top visible row has any group label
  // merged away (we are mid-block, possibly across scroll pages), pin a thin
  // bar holding the FULL group chain to the top of the grid.
  const scrollElRef = useRef<HTMLDivElement | null>(null);
  const theadRef = useRef<HTMLTableSectionElement | null>(null);
  const rowHeightRef = useRef(0);
  const [theadH, setTheadH] = useState(0);
  const [ctxIndex, setCtxIndex] = useState<number | null>(null);

  useEffect(() => {
    const head = theadRef.current;
    if (!head) return;
    const measure = () => setTheadH(head.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(head);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const row = scrollElRef.current?.querySelector<HTMLTableRowElement>("tbody tr:not(.ft-ctx-row)");
    if (row) rowHeightRef.current = row.getBoundingClientRect().height || row.offsetHeight || 0;
  }, [ssrm.displayRows, ssrm.spec.rowGroups]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const threshold = Math.max(120, el.clientHeight * 0.5);
    if (el.scrollHeight - el.scrollTop - el.clientHeight < threshold && ssrm.hasMore && !ssrm.loading) {
      ssrm.loadMore();
    }
    const flags = mergeFlags;
    if (flags.length === 0) {
      setCtxIndex((prev) => (prev == null ? null : null));
      return;
    }
    const rh = rowHeightRef.current || 24;
    const idx = Math.min(
      flags.length - 1,
      Math.max(0, Math.round(el.scrollTop / rh)),
    );
    const suppressed = flags[idx]!.some((f) => !f);
    const next = suppressed ? idx : null;
    setCtxIndex((prev) => (prev === next ? prev : next));
  };

  const showConfig = props.showPanels ?? true;
  const displayCount = ssrm.displayRows.length;

  return (
    <div className="fina-table" data-theme={mode} data-testid="fina-table">
      <div className="ft-toolbar">
        <div className="ft-toolbar-left">
          {showConfig && (
            <button
              ref={setConfigBtn}
              type="button"
              className="ft-icon-btn ft-config-btn"
              data-active={configOpen}
              aria-label="Table configuration"
              aria-expanded={configOpen}
              aria-haspopup="dialog"
              onClick={() => {
                if (!configOpen && configBtn) setConfigAnchor(configBtn.getBoundingClientRect());
                setConfigOpen((v) => !v);
              }}
            >
              <ConfigIcon width={13} height={13} />
            </button>
          )}
          {props.title && <strong style={{ fontSize: 12 }}>{props.title}</strong>}
          <span className="ft-badge">
            <strong>{tableName || "—"}</strong>
          </span>
          <span className="ft-badge">
            {ssrm.spec.rowGroups.length} row group{ssrm.spec.rowGroups.length === 1 ? "" : "s"}
            {ssrm.spec.rowGroups.length > 0 && (
              <>
                {" · "}
                {ssrm.spec.rowGroups.map((g) => g.field).join(" / ")}
              </>
            )}
          </span>
          <span className="ft-badge">
            {ssrm.spec.valueCols.length} value col{ssrm.spec.valueCols.length === 1 ? "" : "s"}
          </span>
          {ssrm.spec.pivotMode && ssrm.spec.pivotField && <span className="ft-badge">pivot: {ssrm.spec.pivotField}</span>}
        </div>
        <div className="ft-toolbar-mid">
          <span style={{ fontSize: 11, color: "var(--ft-fg-faint)" }}>
            infinite scroll · group tree remembered
          </span>
        </div>
        <div className="ft-toolbar-right">
          {props.headerActions}
          {ssrm.loading && (
            <span className="ft-spin" role="status" aria-label="Loading" data-testid="loading-spinner" />
          )}
          <button type="button" className="ft-icon-btn" aria-label="Refresh" title="Refresh" onClick={ssrm.refresh} disabled={ssrm.loading}>
            <RefreshIcon width={12} height={12} />
          </button>
          <button
            type="button"
            className="ft-icon-btn"
            aria-label={view === "table" ? "Switch to chart view" : "Switch to table view"}
            title={view === "table" ? "Chart view" : "Table view"}
            onClick={toggleView}
            data-testid="view-toggle"
          >
            {view === "table" ? <ChartIcon width={13} height={13} /> : <TableIcon width={13} height={13} />}
          </button>
          {view === "chart" && (
            <button
              ref={setChartBtn}
              type="button"
              className="ft-icon-btn"
              data-active={chartSettingsOpen}
              aria-label="Chart settings"
              title="Chart settings"
              data-testid="chart-settings-toggle"
              onClick={() => {
                if (!chartSettingsOpen && chartBtn) setChartAnchor(chartBtn.getBoundingClientRect());
                setChartSettingsOpen((v) => !v);
              }}
            >
              <SettingsIcon width={13} height={13} />
            </button>
          )}
          <button type="button" className="ft-icon-btn" aria-label={mode === "light" ? "Switch to dark theme" : "Switch to light theme"} title="Toggle theme" onClick={toggleTheme} data-testid="theme-toggle">
            {mode === "light" ? <MoonIcon width={12} height={12} /> : <SunIcon width={12} height={12} />}
          </button>
        </div>
      </div>

      {view === "table" ? (
      <div className="ft-scroll" style={{ height }} onScroll={onScroll} data-testid="ft-scroll" ref={scrollElRef}>
<table className="ft-table">
          <thead ref={theadRef} className={pivotHeader ? "ft-thead ft-thead-pivot" : "ft-thead"}>
            {pivotHeader ? (
              <>
                <tr>
                  {plainColDefs.map((col, i) => (
                    <th key={col.field} className="ft-th ft-th-sortable" rowSpan={2}>
                      <div className="ft-th-inner ft-th-sortable" data-testid={`th-${col.field}`} onClick={() => cycleSort(ssrm.setSpec, col.field)}>
                        <span className="ft-th-label">{col.label}</span>
                        {ssrm.spec.sort[0]?.colId === col.field && (
                          <span className="ft-sort-ind" data-testid={`sort-${col.field}`}>
                            {ssrm.spec.sort[0]!.sort === "asc" ? "↑" : "↓"}
                          </span>
                        )}
                      </div>
                    </th>
                  ))}
                  {pivotGroups.map((g) => (
                    <th key={g.value} colSpan={g.count} className="ft-th ft-th-pivot-top" data-testid={`pivot-group-${normalize(g.value)}`}>
                      <span className="ft-th-inner ft-th-pivot-label">{g.value}</span>
                    </th>
                  ))}
                </tr>
                <tr>
                  {pivotColDefs.map((col) => (
                    <th key={col.field} className="ft-th">
                      <div className="ft-th-inner" data-testid={`th-${col.field}`}>
                        <span className="ft-th-label">{col.pivot!.measureLabel}</span>
                      </div>
                    </th>
                  ))}
                </tr>
              </>
            ) : (
              <tr>
                {colDefs.map((col, i) => {
                  const sort = ssrm.spec.sort[0]?.colId === col.field ? ssrm.spec.sort[0]!.sort : null;
                  const cond = ssrm.spec.filter[col.field];
                  const condition = cond && cond.filterType !== "combined" ? cond : null;
                  return (
                    <th key={col.field} className="ft-th">
                      <div
                        className="ft-th-inner ft-th-sortable"
                        data-testid={`th-${col.field}`}
                        onClick={() => cycleSort(ssrm.setSpec, col.field)}
                      >
                        <span className="ft-th-label">{col.label}</span>
                        {sort && (
                          <span className="ft-sort-ind" data-testid={`sort-${col.field}`} aria-label={`Sorted ${sort}`}>
                            {sort === "asc" ? "↑" : "↓"}
                          </span>
                        )}
                        <FilterPopover
                          field={col.field}
                          label={col.label}
                          kind={col.kind}
                          condition={condition as never}
                          onApply={(c) => setColumnFilter(ssrm.setSpec, col.field, c)}
                          onClear={() => clearColumnFilter(ssrm.setSpec, col.field)}
                        />
                      </div>
                    </th>
                  );
                })}
              </tr>
            )}
          </thead>
          <tbody>
            {ctxIndex != null && (
              <tr className="ft-ctx-row" style={{ top: theadH }} data-testid="group-context">
                {colDefs.map((col, ci) => {
                  const depth = groupDepthByField.get(col.field);
                  const row = ssrm.displayRows[ctxIndex]!;
                  return (
                    <td key={col.field} className={cx("ft-td", depth != null ? "ft-ctx-label" : "ft-ctx-blank")}>
                      {depth != null && (
                        <span className="ft-group-cell" style={{ paddingLeft: 4 + depth * 16 }} data-testid={`ctx-${col.field}`}>
                          {formatCellValue(row.row[col.field])}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            )}
            {ssrm.displayRows.map((d, i) => {
              if (d.isGrandTotal) {
                return (
                  <tr key={d.key} className="ft-tr ft-tr-grand-total" data-testid="grand-total-row">
                    {colDefs.map((col, ci) => (
                      <td key={col.field} className="ft-td ft-td-grand-total">
                        {ci === 0 ? (
                          <span className="ft-grand-total-label" data-testid="grand-total-label">
                            Grand Total
                          </span>
                        ) : (
                          renderValue(d.row[col.field], col.kind, col.formatter, d.row, col.format, col.style)
                        )}
                      </td>
                    ))}
                  </tr>
                );
              }
              const flags = mergeFlags[i]!;
              return (
                <tr
                  key={d.key}
                  className={cx(d.isGroup ? "ft-tr ft-tr-group" : "ft-tr", !d.isGroup && i % 2 === 1 && "ft-tr-alt", "ft-tr-hover")}
                >
                  {colDefs.map((col, ci) => {
                    const gd = groupDepthByField.get(col.field);
                    if (gd != null) {
                      if (d.isGroup && d.groupField === col.field) {
                        // own group column: toggle + value (block head always labelled)
                        return (
                          <td key={col.field} className="ft-td">
                            <span className="ft-group-cell" style={{ paddingLeft: 4 + d.depth * 16 }}>
                              <button
                                type="button"
                                className="ft-expand"
                                role="treeitem"
                                aria-expanded={d.expanded}
                                aria-label={d.expanded ? `Collapse ${col.label} ${d.groupValue}` : `Expand ${col.label} ${d.groupValue}`}
                                data-testid={`toggle-${d.groupField}-${normalize(d.groupValue)}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  ssrm.toggleGroup(d.nodeKey!);
                                }}
                              >
                                {d.expanded ? <ChevronDown width={12} height={12} /> : <ChevronRight width={12} height={12} />}
                              </button>
                              <span className="ft-group-value" data-testid={`group-${col.field}-${normalize(d.groupValue)}`}>
                                {d.groupValue}
                              </span>
                            </span>
                          </td>
                        );
                      }
                      return flags[gd] ? (
                        <td key={col.field} className="ft-td">
                          {renderValue(d.row[col.field], col.kind, col.formatter, d.row, col.format, col.style)}
                        </td>
                      ) : (
                        // merged-away group label: blank cell, no repetition
                        <td key={col.field} className="ft-td ft-merged-blank" data-testid={`merged-${col.field}`} />
                      );
                    }
                    return (
                      <td key={col.field} className="ft-td">
                        {renderValue(d.row[col.field], col.kind, col.formatter, d.row, col.format, col.style)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>

        {ssrm.loading && ssrm.displayRows.length === 0 && (
          <div className="ft-loading-cover" data-testid="initial-loading">
            loading…
          </div>
        )}
        {!ssrm.loading && ssrm.error && ssrm.displayRows.length === 0 && (
          <div className="ft-error" data-testid="grid-error">
            {ssrm.error.message}
          </div>
        )}
        {!ssrm.loading && !ssrm.error && ssrm.displayRows.length === 0 && (
          <div className="ft-empty" data-testid="grid-empty">
            No rows.
          </div>
        )}
        {ssrm.hasMore && !ssrm.loading && (
          <div className="ft-sentinel" data-testid="scroll-sentinel" />
        )}
      </div>
      ) : (
        <div className="ft-chart-wrap" style={{ height }} data-testid="chart-wrap">
          <ChartView spec={chartSpec} rows={ssrm.displayRows.map((d) => d.row)} />
        </div>
      )}

      <div className="ft-footer">
        <span data-testid="row-count">{displayCount} rows</span>
        {ssrm.hasMore ? (
          <span>scrolling loads more…</span>
        ) : (
          <span>all rows loaded</span>
        )}
        {ssrm.expandedGroups.size > 0 && <span>{ssrm.expandedGroups.size} group(s) expanded</span>}
        {ssrm.expandedGroups.size > 0 && (
          <button type="button" className="ft-icon-btn" style={{ height: 22, fontSize: 11 }} onClick={ssrm.collapseAll}>
            collapse all
          </button>
        )}
      </div>

      {showConfig && configOpen && configBtn && (
        <ConfigMenu
          anchorRect={configAnchor}
          spec={ssrm.spec}
          setSpec={ssrm.setSpec}
          fields={panelFields}
          tableName={tableName}
          sources={sources}
          endpoint={endpoint}
          dataSource={ssrm.spec.dataSource}
          onChangeTableName={(t) => setTableName(t)}
          onChangeDataSource={(ds) => ssrm.setSpec((prev) => ({ ...prev, dataSource: ds }))}
          onClose={() => setConfigOpen(false)}
        />
      )}

      {view === "chart" && chartSettingsOpen && chartBtn && (
        <ChartSettings
          anchorRect={chartAnchor}
          spec={chartSpec}
          setSpec={(updater) => setChartSpec(updater)}
          fields={panelFields}
          onClose={() => setChartSettingsOpen(false)}
        />
      )}
    </div>
  );
}

/** Seed sensible default axes the first time the chart view is opened. */
function seedChartSpec(prev: ChartSpec, spec: OLAPSpec, fields: FieldDefinition[]): ChartSpec {
  if (prev.category || prev.value) return prev;
  const category =
    spec.rowGroups[0]?.field ?? fields.find((f) => !f.kind || f.kind === "string")?.field ?? null;
  const value = spec.valueCols[0]?.field ?? fields.find((f) => f.kind === "number")?.field ?? null;
  const seriesBy = spec.rowGroups[1]?.field ?? null;
  return { ...prev, category, value, seriesBy };
}

// ---------- cell rendering ----------

type ColKind = FieldDefinition["kind"];

interface RenderCol {
  field: string;
  label: string;
  kind: ColKind;
  formatter?: (value: unknown, row: Record<string, unknown>) => ReactNode;
  format?: ColumnFormat;
  style?: CellStyle;
  pivot?: { value: string; measureLabel: string } | null;
}

/**
 * Compute per-row "show label" flags for the group columns. Row i shows the
 * label of group column d iff it is the FIRST row of its group-d block —
 * i.e. the previous row differs at some ancestor level k <= d. Rows sharing
 * the same value for all of columns 0..d only paint d on the block head, so
 * group labels are not repeated down an expanded subtree.
 */
export function computeRowGroupFlags(
  rows: Array<{ row: Record<string, unknown> }>,
  groupFields: string[],
): boolean[][] {
  const out: boolean[][] = [];
  let prev: unknown[] | null = null;
  for (const { row } of rows) {
    const vals = groupFields.map((f) => row[f]);
    let firstDiff = -1;
    if (prev) {
      for (let k = 0; k < vals.length; k++) {
        if (vals[k] !== prev[k]) {
          firstDiff = k;
          break;
        }
      }
    }
    out.push(vals.map((_, k) => prev === null || (firstDiff >= 0 && firstDiff <= k)));
    prev = vals;
  }
  return out;
}

function renderValue(
  value: unknown,
  kind: ColKind,
  formatter?: (value: unknown, row: Record<string, unknown>) => ReactNode,
  row?: Record<string, unknown>,
  format?: ColumnFormat,
  style?: CellStyle,
): ReactNode {
  const styleObj = styleToCss(style);
  const styleCls = style?.bold ? "ft-cell-bold" : undefined;
  if (formatter) {
    const formatted = formatter(value, row ?? {});
    if (formatted !== undefined) {
      return (
        <span className={styleCls} style={styleObj}>
          {formatted}
        </span>
      );
    }
  }
  const specOut = formatWithSpec(value, format);
  if (specOut !== undefined) {
    return (
      <span className={styleCls} style={styleObj}>
        {specOut}
      </span>
    );
  }
  if (kind === "number") {
    const cls = cx(
      "ft-num",
      typeof value === "number" && value > 0 && "ft-num-pos",
      typeof value === "number" && value < 0 && "ft-num-neg",
      styleCls,
    );
    return (
      <span className={cls} style={styleObj}>
        {formatNumber(value)}
      </span>
    );
  }
  if (kind === "date" || kind === "datetime") {
    return (
      <span className={cx("ft-date", styleCls)} style={styleObj}>
        {formatDateValue(value, kind === "datetime")}
      </span>
    );
  }
  return (
    <span className={styleCls} style={styleObj}>
      {formatCellValue(value)}
    </span>
  );
}

function styleToCss(style?: CellStyle): CSSProperties | undefined {
  if (!style) return undefined;
  const css: CSSProperties = {};
  if (style.fg) css.color = style.fg;
  if (style.bg) css.background = style.bg;
  if (style.align) css.textAlign = style.align;
  if (style.bold) css.fontWeight = 600;
  return css;
}

/** Best-effort column kind from sample row values (config-panel defaults). */
function inferFieldKind(field: string, rows: Array<Record<string, unknown>>): FieldDefinition["kind"] {
  for (const row of rows) {
    const value = row[field];
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "number") return "number";
    if (typeof value === "boolean") return "string";
    const s = String(value);
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return "datetime";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return "date";
    if (!Number.isNaN(Number(s))) return "number";
    return "string";
  }
  return "string";
}

function normalize(v: string | null): string {
  return (v ?? "").replace(/\W+/g, "_");
}

// ---------- spec helpers ----------

function cycleSort(setSpec: (u: (prev: OLAPSpec) => OLAPSpec) => void, field: string) {
  setSpec((prev) => {
    const existing = prev.sort[0];
    if (!existing || existing.colId !== field) return { ...prev, sort: [{ colId: field, sort: "asc" }] };
    if (existing.sort === "asc") return { ...prev, sort: [{ colId: field, sort: "desc" }] };
    return { ...prev, sort: [] };
  });
}

export function setColumnFilter(setSpec: (u: (prev: OLAPSpec) => OLAPSpec) => void, field: string, condition: FilterCondition) {
  setSpec((prev) => ({ ...prev, filter: configSpecFilter(prev, field, condition) }));
}

export function clearColumnFilter(setSpec: (u: (prev: OLAPSpec) => OLAPSpec) => void, field: string) {
  setSpec((prev) => {
    const filter = { ...prev.filter };
    delete filter[field];
    return { ...prev, filter };
  });
}

function prefersDark(): "light" | "dark" {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}