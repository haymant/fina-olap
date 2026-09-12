/**
 * Chart configuration + ECharts option builder. Kept free of the echarts
 * runtime so it is trivially unit-testable; `ChartView` feeds the result to
 * `echarts.setOption`.
 */

export type ChartType = "line" | "bar" | "stack" | "candlestick" | "heatmap" | "pie";

export const CHART_TYPES: ChartType[] = ["line", "bar", "stack", "candlestick", "heatmap", "pie"];

export interface ChartSpec {
  type: ChartType;
  /** x-axis / slice dimension. */
  category: string | null;
  /** y-axis measure. */
  value: string | null;
  /** dimension whose distinct values become separate series (optional). */
  seriesBy: string | null;
  /** optional second y-axis measure. */
  axis2: string | null;
  /** date/numeric column driving the zoom bar (defaults to the category). */
  zoomBy: string | null;
  /** comma-separated O,H,L,C[,V] columns for candlestick. */
  ohlcv: string;
  smooth: boolean;
  showZoom: boolean;
}

export const defaultChartSpec = (): ChartSpec => ({
  type: "line",
  category: null,
  value: null,
  seriesBy: null,
  axis2: null,
  zoomBy: null,
  ohlcv: "open,high,low,close,volume",
  smooth: false,
  showZoom: true,
});

export type ChartRow = Record<string, unknown>;

const toNum = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?/;

function looksTemporal(rows: ChartRow[], field: string): boolean {
  for (const row of rows) {
    const v = row[field];
    if (v == null) continue;
    return ISO_DATE.test(String(v));
  }
  return false;
}

function unique(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const s = v == null ? "" : String(v);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Build an ECharts option for a `ChartSpec` over flattened rows. Values are
 * aggregate-agnostic (the grid has already aggregated); auto-scaling is on
 * (`yAxis.scale`) with a tight `grid.containLabel` so the plot fills the space.
 */
export function buildChartOption(spec: ChartSpec, rows: ChartRow[]): Record<string, unknown> {
  const grid = {
    left: 8,
    right: 8,
    top: 30,
    bottom: spec.showZoom ? 52 : 14,
    containLabel: true,
  };
  const tooltip = { trigger: spec.type === "pie" || spec.type === "heatmap" ? "item" : "axis" };
  const zoom = spec.showZoom ? [{ type: "inside", xAxisIndex: 0, filterMode: "none" }, { type: "slider", xAxisIndex: 0, bottom: 10 }] : undefined;

  if (spec.type === "pie") {
    const field = spec.category;
    const data = rows.map((r) => ({ name: field ? String(r[field] ?? "") : "", value: toNum(spec.value ? r[spec.value] : null) ?? 0 }));
    return {
      tooltip,
      legend: { type: "scroll", top: 4 },
      series: [{ type: "pie", radius: ["35%", "70%"], center: ["50%", "52%"], data, label: { formatter: "{b}: {c}" } }],
    };
  }

  if (spec.type === "heatmap") {
    const xs = unique(rows.map((r) => (spec.category ? r[spec.category] : null)));
    const ys = unique(rows.map((r) => (spec.seriesBy ? r[spec.seriesBy] : null)));
    const data = rows.map((r) => {
      const x = spec.category ? String(r[spec.category] ?? "") : "";
      const y = spec.seriesBy ? String(r[spec.seriesBy] ?? "") : "";
      return [xs.indexOf(x), ys.indexOf(y), toNum(spec.value ? r[spec.value] : null) ?? 0];
    });
    return {
      tooltip,
      grid,
      xAxis: { type: "category", data: xs, splitArea: { show: true } },
      yAxis: { type: "category", data: ys, splitArea: { show: true } },
      visualMap: { min: 0, max: Math.max(1, ...data.map((d) => Number(d[2]))), calculable: true, orient: "horizontal", left: "center", bottom: 0 },
      series: [{ type: "heatmap", data, label: { show: false }, emphasis: { itemStyle: { shadowBlur: 8 } } }],
    };
  }

  // line / bar / stack / candlestick share an x axis
  const xField = spec.zoomBy || spec.category;
  const temporal = xField ? looksTemporal(rows, xField) : false;
  const categories = xField && !temporal ? unique(rows.map((r) => r[xField])) : [];
  const xAxis = xField
    ? { type: temporal ? "time" : "category", data: temporal ? undefined : categories, boundaryGap: spec.type === "bar" || spec.type === "stack" }
    : { type: "category", data: rows.map((_, i) => String(i)), boundaryGap: true };

  const pairs = (group: ChartRow[], field: string | null): Array<[unknown, number]> =>
    group.map((r, i) => {
      const x = xField ? r[xField] : i;
      return [x, toNum(field ? r[field] : null) ?? 0];
    });

  const series: Array<Record<string, unknown>> = [];
  const isStack = spec.type === "stack";
  const baseType = spec.type === "candlestick" ? "candlestick" : isStack ? "bar" : spec.type;

  if (spec.type === "candlestick") {
    const cols = spec.ohlcv.split(",").map((c) => c.trim()).filter(Boolean);
    const [o, h, l, c, vol] = cols;
    series.push({
      type: "candlestick",
      name: "OHLC",
      data: rows.map((r) => [toNum(o ? r[o] : null), toNum(h ? r[h] : null), toNum(l ? r[l] : null), toNum(c ? r[c] : null)]),
    });
    if (vol) {
      series.push({ type: "bar", name: vol, yAxisIndex: 1, data: rows.map((r, i) => [xField ? r[xField] : i, toNum(r[vol])]) });
    }
  } else {
    const seriesField = spec.seriesBy;
    const groups = seriesField ? unique(rows.map((r) => r[seriesField])) : [null];
    for (const g of groups) {
      const group = g == null || !seriesField ? rows : rows.filter((r) => String(r[seriesField] ?? "") === g);
      series.push({
        type: baseType,
        name: g ?? (spec.value ?? "value"),
        smooth: spec.smooth && baseType === "line",
        stack: isStack ? "total" : undefined,
        areaStyle: spec.smooth && baseType === "line" ? {} : undefined,
        data: pairs(group, spec.value),
      });
    }
    if (spec.axis2) {
      series.push({ type: "line", name: spec.axis2, yAxisIndex: 1, smooth: spec.smooth, data: pairs(rows, spec.axis2) });
    }
  }

  const yAxis: Array<Record<string, unknown>> = [{ type: "value", scale: true }];
  if (spec.axis2 || spec.type === "candlestick") yAxis.push({ type: "value", scale: true });

  return {
    tooltip,
    legend: { type: "scroll", top: 4 },
    grid,
    xAxis,
    yAxis,
    dataZoom: zoom,
    series,
  };
}
