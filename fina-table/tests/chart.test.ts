import { describe, expect, it } from "vitest";

import { buildChartOption, defaultChartSpec, type ChartSpec } from "../src/chart";

const ROWS = [
  { day: "2024-09-01", instrument: "I1", portfolio: "P1", delta: 1, gamma: 10, open: 1, high: 3, low: 0.5, close: 2, volume: 100 },
  { day: "2024-09-02", instrument: "I2", portfolio: "P1", delta: 2, gamma: 20, open: 2, high: 4, low: 1, close: 3, volume: 200 },
  { day: "2024-09-03", instrument: "I1", portfolio: "P2", delta: 3, gamma: 30, open: 3, high: 5, low: 2, close: 4, volume: 300 },
];

const spec = (patch: Partial<ChartSpec>): ChartSpec => ({ ...defaultChartSpec(), ...patch });
const opt = (patch: Partial<ChartSpec>) => buildChartOption(spec(patch), ROWS) as Record<string, any>;

describe("buildChartOption", () => {
  it("builds a single line series over the category axis", () => {
    const o = opt({ type: "line", category: "day", value: "delta" });
    expect(o.series).toHaveLength(1);
    expect(o.series[0].type).toBe("line");
    expect(o.xAxis.type).toBe("time"); // ISO dates → temporal axis
    expect(o.series[0].data).toHaveLength(3);
  });

  it("splits into one series per value of the series column", () => {
    const o = opt({ type: "line", category: "instrument", value: "delta", seriesBy: "portfolio" });
    expect(o.xAxis.type).toBe("category");
    expect(o.series.map((s: any) => s.name)).toEqual(["P1", "P2"]);
    expect(o.series[0].data).toHaveLength(2);
  });

  it("stacks when type is stack", () => {
    const o = opt({ type: "stack", category: "instrument", value: "delta", seriesBy: "portfolio" });
    expect(o.series.every((s: any) => s.type === "bar" && s.stack === "total")).toBe(true);
  });

  it("supports a second y-axis", () => {
    const o = opt({ type: "line", category: "day", value: "delta", axis2: "gamma" });
    expect(o.yAxis).toHaveLength(2);
    expect(o.series.find((s: any) => s.name === "gamma").yAxisIndex).toBe(1);
  });

  it("adds a zoom bar unless disabled", () => {
    expect((opt({ type: "line", category: "day", value: "delta" }).dataZoom as unknown[]).length).toBe(2);
    expect(opt({ type: "line", category: "day", value: "delta", showZoom: false }).dataZoom).toBeUndefined();
  });

  it("auto-scales the y-axis and expands the grid", () => {
    const o = opt({ type: "bar", category: "instrument", value: "delta" });
    expect(o.yAxis[0].scale).toBe(true);
    expect(o.grid.containLabel).toBe(true);
  });

  it("builds a pie from the category/value pair", () => {
    const o = opt({ type: "pie", category: "instrument", value: "delta" });
    expect(o.series[0].type).toBe("pie");
    expect(o.series[0].data).toHaveLength(3);
    expect(o.series[0].data[0]).toEqual({ name: "I1", value: 1 });
  });

  it("builds a heatmap with a visual map", () => {
    const o = opt({ type: "heatmap", category: "day", value: "delta", seriesBy: "instrument" });
    expect(o.series[0].type).toBe("heatmap");
    expect(o.visualMap).toBeTruthy();
    expect(o.series[0].data).toHaveLength(3);
  });

  it("splits candlestick into a price pane and a separate volume pane", () => {
    const o = opt({ type: "candlestick", category: "day", ohlcv: "open,high,low,close,volume" });
    // two stacked grids — not one shared grid where volume would dominate
    expect(o.grid).toHaveLength(2);
    expect(o.xAxis).toHaveLength(2);
    expect(o.yAxis).toHaveLength(2);
    expect(o.xAxis[0].gridIndex).toBe(0);
    expect(o.xAxis[1].gridIndex).toBe(1);
    expect(o.yAxis[0].gridIndex).toBe(0);
    expect(o.yAxis[1].gridIndex).toBe(1);
    // category axis even for dates: a time axis would need [time, o, c, l, h]
    expect(o.xAxis[0].type).toBe("category");

    const candle = o.series.find((s: any) => s.type === "candlestick");
    expect(candle.xAxisIndex).toBe(0);
    expect(candle.yAxisIndex).toBe(0);
    expect(candle.data).toHaveLength(3);
    // [open, close, low, high] — ECharts candlestick order
    expect(candle.data[0]).toEqual([1, 2, 0.5, 3]);

    const volume = o.series.find((s: any) => s.type === "bar");
    expect(volume.xAxisIndex).toBe(1);
    expect(volume.yAxisIndex).toBe(1);
    // the zoom bar drives both panes
    expect(o.dataZoom[0].xAxisIndex).toEqual([0, 1]);
  });

  it("uses a single grid when no volume column is configured", () => {
    const o = opt({ type: "candlestick", category: "day", ohlcv: "open,high,low,close" });
    expect(o.grid).toHaveLength(1);
    expect(o.xAxis).toHaveLength(1);
    expect(o.series).toHaveLength(1);
    expect(o.series[0].type).toBe("candlestick");
  });
});
