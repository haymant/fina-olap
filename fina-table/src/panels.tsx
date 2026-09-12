import { useState, type ReactNode } from "react";

import type { AggregationFn, CellStyle, ColumnFormat, FormatType, LodConfig, LodType, SortItem, ValueCol } from "./types";
import type { OLAPSpec } from "./use-ssrm";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, XIcon } from "./icons";
import { cx } from "./utils";

export interface FieldDefinition {
  field: string;
  label?: string;
  kind?: "string" | "number" | "date" | "datetime";
}

/** Type-aware default aggregation for a newly-added measure. */
export function defaultAggForKind(kind: FieldDefinition["kind"]): AggregationFn | "none" {
  if (kind === "number") return "sum";
  if (kind === "date" || kind === "datetime") return "max";
  return "none";
}

export const FORMAT_TYPES: FormatType[] = [
  "text",
  "number",
  "currency",
  "percent",
  "date",
  "datetime",
  "excel",
  "epoch",
  "phone",
  "custom",
];

/** Format types that accept a textual pattern/locale field. */
const PATTERNED: FormatType[] = ["number", "currency", "percent", "date", "datetime", "excel", "epoch", "custom"];
const FRACTIONAL: FormatType[] = ["number", "currency", "percent"];

export interface PanelProps {
  spec: OLAPSpec;
  setSpec: (updater: (prev: OLAPSpec) => OLAPSpec) => void;
  fields: FieldDefinition[];
}

export const AGG_FNS: AggregationFn[] = [
  "sum",
  "avg",
  "min",
  "max",
  "count",
  "first",
  "last",
  "stddev",
  "variance",
  "median",
];
export const LOD_TYPES: LodType[] = ["fixed", "include", "exclude"];

export const Panel = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="ft-panel">
    <h3 className="ft-panel-title">{title}</h3>
    {children}
  </section>
);

export const Select = ({
  className,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) => (
  <select className={cx("ft-select", className)} {...rest} />
);

export function GroupingPanel({ spec, setSpec, fields }: PanelProps) {
  const available = fields.filter((f) => !spec.rowGroups.some((g) => g.field === f.field));
  return (
    <Panel title="Row group">
      {spec.rowGroups.length === 0 && (
        <p style={{ margin: "0 0 6px", color: "var(--ft-fg-muted)", fontSize: 12 }}>
          No grouping — rows are raw.
        </p>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {spec.rowGroups.map((g, i) => (
          <span key={g.field} className="ft-chip" data-testid={`group-chip-${g.field}`}>
            {g.field}
            <button
              type="button"
              className="ft-chip-btn"
              aria-label={`Move group ${g.field} up`}
              disabled={i === 0}
              onClick={() => move(spec, setSpec, g.field, -1)}
            >
              <ArrowUp />
            </button>
            <button
              type="button"
              className="ft-chip-btn"
              aria-label={`Move group ${g.field} down`}
              disabled={i === spec.rowGroups.length - 1}
              onClick={() => move(spec, setSpec, g.field, 1)}
            >
              <ArrowDown />
            </button>
            <button
              type="button"
              className="ft-chip-btn"
              aria-label={`Remove group ${g.field}`}
              onClick={() =>
                setSpec((prev) => ({ ...prev, rowGroups: prev.rowGroups.filter((x) => x.field !== g.field) }))
              }
            >
              <XIcon />
            </button>
          </span>
        ))}
      </div>
      <label className="ft-check">
        <input
          type="checkbox"
          data-testid="grand-total-toggle"
          checked={spec.grandTotal}
          onChange={(e) => setSpec((prev) => ({ ...prev, grandTotal: e.target.checked }))}
        />
        include grand total
      </label>
      {spec.grandTotal && (
        <div className="ft-field-row" style={{ marginTop: 6 }}>
          <span style={{ width: 88, fontSize: 12, color: "var(--ft-fg-muted)", whiteSpace: "nowrap" }}>
            total agg:
          </span>
          <Select
            aria-label="Grand total aggregation"
            value={spec.grandTotalAgg}
            onChange={(e) => setSpec((prev) => ({ ...prev, grandTotalAgg: e.target.value as AggregationFn }))}
          >
            {AGG_FNS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </div>
      )}
      <Select
        aria-label="Add group level"
        value=""
        onChange={(e) => {
          if (!e.target.value) return;
          const field = e.target.value;
          setSpec((prev) => ({ ...prev, rowGroups: [...prev.rowGroups, { id: `g_${field}`, field }] }));
        }}
      >
        <option value="">+ add row dimension…</option>
        {available.map((f) => (
          <option key={f.field} value={f.field}>
            {f.label ?? f.field}
          </option>
        ))}
      </Select>
    </Panel>
  );
}

export function ValuePanel({ spec, setSpec, fields }: PanelProps) {
  const available = fields.filter((f) => !spec.valueCols.some((v) => v.field === f.field));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (field: string) => setExpanded((prev) => ({ ...prev, [field]: !prev[field] }));
  return (
    <Panel title="Value column">
      {spec.valueCols.length === 0 && (
        <p style={{ margin: "0 0 6px", color: "var(--ft-fg-muted)", fontSize: 12 }}>
          No measures selected.
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
        {spec.valueCols.map((v) => {
          const levelAggs = spec.rowGroups.map((g, level) => {
            const current = v.aggFuncsByLevel?.[g.field] ?? v.aggFuncsByLevel?.[String(level)];
            return (
              <div key={g.field} className="ft-field-row">
                <span style={{ width: 88, fontSize: 12, color: "var(--ft-fg-muted)", whiteSpace: "nowrap" }}>
                  at {g.field}:
                </span>
                <Select
                  aria-label={`Aggregation at level ${g.field} for ${v.field}`}
                  value={current ?? ""}
                  onChange={(e) => {
                    const fn = (e.target.value as AggregationFn | "none") || null;
                    setLevelAgg(spec, setSpec, v, g.field, fn);
                  }}
                >
                  <option value="">default ({v.aggFunc ?? "sum"})</option>
                  <option value="none">none — no aggregation at this level</option>
                  {AGG_FNS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </Select>
              </div>
            );
          });
          return (
            <div key={v.field} className="ft-panel ft-value-card" data-testid={`value-col-${v.field}`} style={{ padding: "8px 10px" }}>
              <div className="ft-field-row">
                <button
                  type="button"
                  className="ft-chip-btn"
                  aria-label={`${expanded[v.field] ? "Collapse" : "Expand"} format for ${v.field}`}
                  aria-expanded={Boolean(expanded[v.field])}
                  data-testid={`value-card-toggle-${v.field}`}
                  onClick={() => toggle(v.field)}
                >
                  {expanded[v.field] ? <ChevronDown width={12} height={12} /> : <ChevronRight width={12} height={12} />}
                </button>
                <strong style={{ fontSize: 12, flex: 1 }}>{v.field}</strong>
                <Select
                  aria-label={`Aggregation for ${v.field}`}
                  value={v.aggFunc ?? "sum"}
                  onChange={(e) => setAgg(spec, setSpec, v, e.target.value as AggregationFn | "none")}
                >
                  <option value="none">none (no aggregation)</option>
                  {AGG_FNS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </Select>
                {spec.rowGroups.length > 0 && (
                  <label className="ft-check" title="Show this measure on raw leaf rows (uncheck = aggregate only)">
                    <input
                      type="checkbox"
                      aria-label={`Show ${v.field} on leaf rows`}
                      checked={v.visibleLevels == null || v.visibleLevels.length === 0}
                      onChange={(e) =>
                        setVisibility(
                          spec,
                          setSpec,
                          v,
                          e.target.checked ? null : spec.rowGroups.map((_, i) => String(i)),
                        )
                      }
                    />
                    on leaf
                  </label>
                )}
                <button
                  type="button"
                  className="ft-chip-btn"
                  aria-label={`Remove measure ${v.field}`}
                  onClick={() => setSpec((prev) => ({ ...prev, valueCols: prev.valueCols.filter((x) => x.field !== v.field) }))}
                >
                  <XIcon />
                </button>
              </div>
              {spec.rowGroups.length > 0 && levelAggs}
              {expanded[v.field] && (
                <div className="ft-value-format" data-testid={`value-card-body-${v.field}`}>
                  <div className="ft-field-row">
                    <span className="ft-format-label">format</span>
                    <Select
                      aria-label={`Format type for ${v.field}`}
                      value={v.format?.type ?? "text"}
                      onChange={(e) => setFormat(spec, setSpec, v, { type: e.target.value as FormatType })}
                    >
                      <option value="text">text (default)</option>
                      {FORMAT_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {PATTERNED.includes(v.format?.type ?? "text") && (
                    <div className="ft-field-row">
                      <span className="ft-format-label">
                        {v.format?.type === "currency" ? "locale" : "pattern"}
                      </span>
                      <input
                        className="ft-input"
                        aria-label={`Format pattern for ${v.field}`}
                        placeholder={patternHint(v.format?.type)}
                        value={v.format?.pattern ?? ""}
                        onChange={(e) => setFormat(spec, setSpec, v, { pattern: e.target.value })}
                      />
                    </div>
                  )}
                  {v.format?.type === "currency" && (
                    <div className="ft-field-row">
                      <span className="ft-format-label">currency</span>
                      <input
                        className="ft-input"
                        aria-label={`Currency for ${v.field}`}
                        placeholder="USD"
                        value={v.format?.currency ?? ""}
                        onChange={(e) => setFormat(spec, setSpec, v, { currency: e.target.value.toUpperCase() })}
                      />
                    </div>
                  )}
                  {v.format?.type === "epoch" && (
                    <div className="ft-field-row">
                      <span className="ft-format-label">unit</span>
                      <Select
                        aria-label={`Epoch unit for ${v.field}`}
                        value={v.format?.unit ?? "auto"}
                        onChange={(e) => setFormat(spec, setSpec, v, { unit: e.target.value as "auto" | "s" | "ms" })}
                      >
                        <option value="auto">auto</option>
                        <option value="s">seconds</option>
                        <option value="ms">milliseconds</option>
                      </Select>
                    </div>
                  )}
                  {FRACTIONAL.includes(v.format?.type ?? "text") && (
                    <div className="ft-field-row">
                      <span className="ft-format-label">decimals</span>
                      <input
                        className="ft-input"
                        type="number"
                        min={0}
                        max={8}
                        style={{ width: 56 }}
                        aria-label={`Maximum fraction digits for ${v.field}`}
                        value={v.format?.maximumFractionDigits ?? 2}
                        onChange={(e) => setFormat(spec, setSpec, v, { maximumFractionDigits: Number(e.target.value) })}
                      />
                    </div>
                  )}
                  <div className="ft-field-row">
                    <span className="ft-format-label">style</span>
                    <input
                      className="ft-input"
                      type="color"
                      style={{ width: 30, height: 22, padding: 0 }}
                      aria-label={`Foreground for ${v.field}`}
                      value={v.style?.fg ?? "#0f172a"}
                      onChange={(e) => setStyle(spec, setSpec, v, { fg: e.target.value })}
                    />
                    <input
                      className="ft-input"
                      type="color"
                      style={{ width: 30, height: 22, padding: 0 }}
                      aria-label={`Background for ${v.field}`}
                      value={v.style?.bg ?? "#ffffff"}
                      onChange={(e) => setStyle(spec, setSpec, v, { bg: e.target.value })}
                    />
                    <label className="ft-check">
                      <input
                        type="checkbox"
                        aria-label={`Bold ${v.field}`}
                        checked={Boolean(v.style?.bold)}
                        onChange={(e) => setStyle(spec, setSpec, v, { bold: e.target.checked })}
                      />
                      bold
                    </label>
                    <Select
                      aria-label={`Alignment for ${v.field}`}
                      value={v.style?.align ?? "right"}
                      onChange={(e) => setStyle(spec, setSpec, v, { align: e.target.value as CellStyle["align"] })}
                    >
                      <option value="left">left</option>
                      <option value="right">right</option>
                      <option value="center">center</option>
                    </Select>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Select
        aria-label="Add measure"
        value=""
        onChange={(e) => {
          if (!e.target.value) return;
          const field = e.target.value;
          const def = fields.find((f) => f.field === field);
          setSpec((prev) => ({
            ...prev,
            valueCols: [
              ...prev.valueCols,
              { id: `v_${field}`, field, aggFunc: defaultAggForKind(def?.kind) } satisfies ValueCol,
            ],
          }));
        }}
      >
        <option value="">+ add measure…</option>
        {available.map((f) => (
          <option key={f.field} value={f.field}>
            {f.label ?? f.field}
          </option>
        ))}
      </Select>
    </Panel>
  );
}

export function PivotPanel({ spec, setSpec, fields }: PanelProps) {
  return (
    <Panel title="Pivot column">
      <div className="ft-field-row">
        <label className="ft-check">
          <input
            type="checkbox"
            checked={spec.pivotMode}
            onChange={(e) =>
              setSpec((prev) => ({
                ...prev,
                pivotMode: e.target.checked,
                pivotField: e.target.checked ? (prev.pivotField ?? fields[0]?.field ?? null) : null,
              }))
            }
          />
          pivot active
        </label>
        <Select
          aria-label="Pivot column field"
          value={spec.pivotField ?? ""}
          disabled={!spec.pivotMode}
          onChange={(e) => setSpec((prev) => ({ ...prev, pivotField: e.target.value || null }))}
        >
          <option value="">pivot on…</option>
          {fields.map((f) => (
            <option key={f.field} value={f.field}>
              {f.label ?? f.field}
            </option>
          ))}
        </Select>
      </div>
    </Panel>
  );
}

export function LodPanel({ spec, setSpec, fields }: PanelProps) {
  const lod = spec.lod;
  return (
    <Panel title="Level-of-Detail">
      <label className="ft-check" style={{ display: "flex", marginBottom: 6 }}>
        <input
          type="checkbox"
          checked={Boolean(lod)}
          onChange={(e) => setSpec((prev) => ({ ...prev, lod: e.target.checked ? defaultLod(prev, fields) : undefined }))}
        />
        LOD join enabled
      </label>
      {lod && (
        <>
          <div className="ft-field-row">
            <Select
              value={lod.type}
              onChange={(e) =>
                setSpec((prev) => ({ ...prev, lod: { ...lod, type: e.target.value as LodType } satisfies LodConfig }))
              }
            >
              {LOD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
            <label className="ft-check">
              prefix:
              <input
                className="ft-input"
                value={lod.prefix ?? "_lod_"}
                onChange={(e) =>
                  setSpec((prev) => ({ ...prev, lod: { ...lod, prefix: e.target.value } satisfies LodConfig }))
                }
                style={{ width: 64 }}
              />
            </label>
          </div>
          <div style={{ margin: "6px 0" }}>
            <span style={{ fontSize: 11, color: "var(--ft-fg-muted)" }}>group keys: </span>
            {fields.map((f) => (
              <label key={f.field} className="ft-check" style={{ marginRight: 8 }}>
                <input
                  type="checkbox"
                  checked={lod.groupKeys.includes(f.field)}
                  onChange={(e) =>
                    setSpec((prev) => {
                      const groupKeys = e.target.checked
                        ? [...lod.groupKeys, f.field]
                        : lod.groupKeys.filter((k) => k !== f.field);
                      return { ...prev, lod: { ...lod, groupKeys } satisfies LodConfig };
                    })
                  }
                />
                {f.field}
              </label>
            ))}
          </div>
          <div style={{ margin: "6px 0" }}>
            <span style={{ fontSize: 11, color: "var(--ft-fg-muted)" }}>metrics: </span>
            {fields
              .filter((f) => f.kind === "number")
              .map((f) => (
                <label key={f.field} className="ft-check" style={{ marginRight: 8 }}>
                  <input
                    type="checkbox"
                    checked={f.field in (lod.metrics ?? {})}
                    onChange={(e) =>
                      setSpec((prev) => {
                        const metrics = { ...(lod.metrics ?? {}) };
                        if (e.target.checked) metrics[f.field] = "sum";
                        else delete metrics[f.field];
                        return { ...prev, lod: { ...lod, metrics } satisfies LodConfig };
                      })
                    }
                  />{" "}
                  {f.field}
                </label>
              ))}
          </div>
        </>
      )}
    </Panel>
  );
}

export function SortPanel({ spec, setSpec, fields }: PanelProps) {
  return (
    <Panel title="Sort">
      <div className="ft-field-row">
        <Select
          aria-label="Sort field"
          value={spec.sort[0]?.colId ?? ""}
          onChange={(e) => {
            if (!e.target.value) return;
            setSpec((prev) => ({ ...prev, sort: [{ colId: e.target.value, sort: "asc" } satisfies SortItem] }));
          }}
        >
          <option value="">sort by…</option>
          {fields.map((f) => (
            <option key={f.field} value={f.field}>
              {f.label ?? f.field}
            </option>
          ))}
        </Select>
        {spec.sort[0] && (
          <Select
            value={spec.sort[0]!.sort}
            onChange={(e) =>
              setSpec((prev) => ({ ...prev, sort: [{ ...spec.sort[0]!, sort: e.target.value as "asc" | "desc" }] }))
            }
          >
            <option value="asc">asc</option>
            <option value="desc">desc</option>
          </Select>
        )}
      </div>
    </Panel>
  );
}

// ---------- helpers ----------

function move(prev: OLAPSpec, setSpec: PanelProps["setSpec"], field: string, dir: -1 | 1) {
  setSpec((state) => {
    const rowGroups = [...state.rowGroups];
    const idx = rowGroups.findIndex((g) => g.field === field);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= rowGroups.length) return state;
    const [col] = rowGroups.splice(idx, 1);
    rowGroups.splice(target, 0, col!);
    return { ...state, rowGroups };
  });
}

function setAgg(spec: OLAPSpec, setSpec: PanelProps["setSpec"], v: ValueCol, fn: AggregationFn | "none") {
  void spec;
  setSpec((prev) => ({
    ...prev,
    valueCols: prev.valueCols.map((x) => (x.field === v.field ? { ...x, aggFunc: fn } : x)),
  }));
}

function setFormat(
  spec: OLAPSpec,
  setSpec: PanelProps["setSpec"],
  v: ValueCol,
  patch: Partial<ColumnFormat>,
) {
  void spec;
  setSpec((prev) => ({
    ...prev,
    valueCols: prev.valueCols.map((x) =>
      x.field === v.field ? { ...x, format: { type: "text", ...(x.format ?? {}), ...patch } } : x,
    ),
  }));
}

function setStyle(spec: OLAPSpec, setSpec: PanelProps["setSpec"], v: ValueCol, patch: CellStyle) {
  void spec;
  setSpec((prev) => ({
    ...prev,
    valueCols: prev.valueCols.map((x) => (x.field === v.field ? { ...x, style: { ...(x.style ?? {}), ...patch } } : x)),
  }));
}

function patternHint(type?: FormatType): string {
  switch (type) {
    case "number":
      return "en-US";
    case "currency":
      return "en-US";
    case "percent":
      return "en-US";
    case "date":
      return "DD/MM/YYYY";
    case "datetime":
      return "DD/MM/YYYY HH:mm:ss";
    case "excel":
      return "DD/MM/YYYY";
    case "epoch":
      return "DD/MM/YYYY HH:mm:ss";
    case "custom":
      return "YYYY-MM-DD";
    default:
      return "";
  }
}

function setLevelAgg(
  spec: OLAPSpec,
  setSpec: PanelProps["setSpec"],
  v: ValueCol,
  level: string,
  fn: AggregationFn | "none" | null,
) {
  void spec;
  setSpec((prev) => ({
    ...prev,
    valueCols: prev.valueCols.map((x) => {
      if (x.field !== v.field) return x;
      const aggFuncsByLevel = { ...(x.aggFuncsByLevel ?? {}) };
      if (fn === null) delete aggFuncsByLevel[level];
      else aggFuncsByLevel[level] = fn;
      return { ...x, aggFuncsByLevel };
    }),
  }));
}

function setVisibility(
  spec: OLAPSpec,
  setSpec: PanelProps["setSpec"],
  v: ValueCol,
  levels: string[] | null,
) {
  void spec;
  setSpec((prev) => ({
    ...prev,
    valueCols: prev.valueCols.map((x) => {
      if (x.field !== v.field) return x;
      if (!levels || levels.length === 0) {
        const { visibleLevels: _omit, ...rest } = x;
        void _omit;
        return rest;
      }
      return { ...x, visibleLevels: [...levels] };
    }),
  }));
}

function defaultLod(prev: OLAPSpec, fields: FieldDefinition[]): LodConfig {
  const numerical = fields.filter((f) => f.kind === "number").map((f) => f.field);
  const metrics: Record<string, AggregationFn> = {};
  for (const f of numerical.slice(0, 2)) metrics[f] = "sum";
  return {
    type: "fixed",
    groupKeys: prev.rowGroups.map((g) => g.field).slice(0, 1),
    metrics,
    prefix: "_lod_",
  };
}