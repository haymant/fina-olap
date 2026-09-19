import { useEffect, useRef } from "react";

import { buildChartOption, type ChartRow, type ChartSpec } from "./chart";

/**
 * Structural subset of the echarts API. We deliberately avoid a static
 * `import type ... from "echarts"` so echarts stays a fully optional peer
 * dependency — consumers who never render the chart view get no TS module
 * error and no dependency, and the runtime import below stays lazy.
 */
type EChartsModule = {
  init: (el: HTMLElement) => EChartsInstance;
};
type EChartsInstance = {
  setOption: (option: unknown, notMerge?: boolean) => void;
  resize: () => void;
  dispose: () => void;
};

/**
 * ECharts host. echarts is imported lazily (dynamic `import`) so apps that
 * never open the chart view don't pay for it, and the peer dep stays optional.
 */
export function ChartView({ spec, rows }: { spec: ChartSpec; rows: ChartRow[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsInstance | null>(null);
  const latest = useRef({ spec, rows });
  latest.current = { spec, rows };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let disposed = false;
    void (async () => {
      try {
        const echarts = await import("echarts");
        if (disposed || !ref.current) return;
        const chart = echarts.init(ref.current);
        chartRef.current = chart;
        chart.setOption(buildChartOption(latest.current.spec, latest.current.rows) as never, true);
      } catch {
        // echarts unavailable or no canvas (e.g. jsdom) — render an empty host
      }
    })();
    const onResize = () => chartRef.current?.resize();
    window.addEventListener("resize", onResize);
    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      try {
        chartRef.current?.dispose();
      } catch {
        /* ignore */
      }
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    try {
      chartRef.current?.setOption(buildChartOption(spec, rows) as never, true);
    } catch {
      /* ignore */
    }
  }, [spec, rows]);

  return <div className="ft-chart" data-testid="chart-view" ref={ref} />;
}
