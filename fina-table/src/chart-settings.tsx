import { useEffect, useRef, useState } from "react";

import type { FieldDefinition } from "./panels";
import { CHART_TYPES, type ChartSpec, type ChartType } from "./chart";
import { usePanelInteraction, type PanelRect } from "./use-panel-interaction";
import { SlidersIcon } from "./icons";

export interface ChartSettingsProps {
  anchorRect: DOMRect | null;
  spec: ChartSpec;
  setSpec: (updater: (prev: ChartSpec) => ChartSpec) => void;
  fields: FieldDefinition[];
  onClose: () => void;
}

/** Draggable/resizable chart configuration panel (axes, series, zoom, type). */
export function ChartSettings({ anchorRect, spec, setSpec, fields, onClose }: ChartSettingsProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<PanelRect | null>(null);

  useEffect(() => {
    if (!anchorRect) {
      setRect(null);
      return;
    }
    const width = Math.min(360, window.innerWidth - 24);
    const height = Math.min(440, window.innerHeight - 16);
    const left = Math.max(8, Math.min(anchorRect.right - width, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(anchorRect.bottom + 4, window.innerHeight - height - 8));
    setRect({ left, top, width, height });
  }, [anchorRect]);

  const { onDragStart, onResizeStart } = usePanelInteraction(rect ?? { left: 0, top: 0, width: 360, height: 440 }, setRect, {
    minWidth: 300,
    minHeight: 260,
    maxWidth: typeof window === "undefined" ? 360 : window.innerWidth - 16,
    maxHeight: typeof window === "undefined" ? 440 : window.innerHeight - 16,
  });

  useEffect(() => {
    const onDown = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!rect) return null;

  const fieldOption = (f: FieldDefinition) => (
    <option key={f.field} value={f.field}>
      {f.label ?? f.field}
    </option>
  );

  return (
    <div
      className="ft-menu ft-config-menu ft-chart-settings"
      ref={ref}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, maxWidth: "none", maxHeight: "none" }}
      data-testid="chart-settings"
      role="dialog"
      aria-label="Chart settings"
    >
      <div className="ft-menu-head" onMouseDown={onDragStart} data-testid="chart-drag-handle" style={{ cursor: "move" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <SlidersIcon width={14} height={14} />
          Chart settings
        </span>
        <button type="button" className="ft-chip-btn" aria-label="Close chart settings" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="ft-menu-body" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        <Row label="type">
          <select
            className="ft-select"
            aria-label="Chart type"
            data-testid="chart-type"
            value={spec.type}
            onChange={(e) => setSpec((prev) => ({ ...prev, type: e.target.value as ChartType }))}
          >
            {CHART_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Row>

        {spec.type !== "candlestick" && (
          <>
            <Row label="category">
              <select
                className="ft-select"
                aria-label="Chart category column"
                data-testid="chart-category"
                value={spec.category ?? ""}
                onChange={(e) => setSpec((prev) => ({ ...prev, category: e.target.value || null }))}
              >
                <option value="">(row index)</option>
                {fields.map(fieldOption)}
              </select>
            </Row>
            <Row label="value">
              <select
                className="ft-select"
                aria-label="Chart value column"
                data-testid="chart-value"
                value={spec.value ?? ""}
                onChange={(e) => setSpec((prev) => ({ ...prev, value: e.target.value || null }))}
              >
                <option value="">(none)</option>
                {fields.map(fieldOption)}
              </select>
            </Row>
            <Row label="series">
              <select
                className="ft-select"
                aria-label="Chart series column"
                data-testid="chart-series"
                value={spec.seriesBy ?? ""}
                onChange={(e) => setSpec((prev) => ({ ...prev, seriesBy: e.target.value || null }))}
              >
                <option value="">(single series)</option>
                {fields.map(fieldOption)}
              </select>
            </Row>
            <Row label="2nd axis">
              <select
                className="ft-select"
                aria-label="Chart second axis column"
                data-testid="chart-axis2"
                value={spec.axis2 ?? ""}
                onChange={(e) => setSpec((prev) => ({ ...prev, axis2: e.target.value || null }))}
              >
                <option value="">(none)</option>
                {fields.map(fieldOption)}
              </select>
            </Row>
          </>
        )}

        {spec.type === "candlestick" && (
          <Row label="OHLCV">
            <input
              className="ft-input"
              style={{ flex: 1 }}
              aria-label="Candlestick OHLCV columns"
              data-testid="chart-ohlcv"
              placeholder="open,high,low,close,volume"
              value={spec.ohlcv}
              onChange={(e) => setSpec((prev) => ({ ...prev, ohlcv: e.target.value }))}
            />
          </Row>
        )}

        <Row label="zoom by">
          <select
            className="ft-select"
            aria-label="Chart zoom column"
            data-testid="chart-zoom"
            value={spec.zoomBy ?? ""}
            onChange={(e) => setSpec((prev) => ({ ...prev, zoomBy: e.target.value || null }))}
          >
            <option value="">(category)</option>
            {fields.map(fieldOption)}
          </select>
        </Row>
        <Row label="options">
          <label className="ft-check">
            <input
              type="checkbox"
              aria-label="Show zoom bar"
              checked={spec.showZoom}
              onChange={(e) => setSpec((prev) => ({ ...prev, showZoom: e.target.checked }))}
            />
            zoom bar
          </label>
          <label className="ft-check">
            <input
              type="checkbox"
              aria-label="Smooth lines"
              checked={spec.smooth}
              onChange={(e) => setSpec((prev) => ({ ...prev, smooth: e.target.checked }))}
            />
            smooth
          </label>
        </Row>
      </div>
      <div className="ft-menu-resize" onMouseDown={onResizeStart} data-testid="chart-resize-handle" aria-hidden />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ft-field-row">
      <span className="ft-format-label" style={{ width: 68 }}>
        {label}
      </span>
      {children}
    </div>
  );
}
