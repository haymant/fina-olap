import { useEffect, useRef, useState } from "react";

import { GroupingPanel, PivotPanel, ValuePanel, type FieldDefinition } from "./panels";
import { DataSourcePanel, type SourceOption } from "./data-source-panel";
import type { OLAPSpec } from "./use-ssrm";
import type { DataSourceRef } from "./types";
import { usePanelInteraction, type PanelRect } from "./use-panel-interaction";
import { StackIcon, SlidersIcon } from "./icons";

export interface ConfigMenuProps {
  anchorRect: DOMRect | null;
  spec: OLAPSpec;
  setSpec: (updater: (prev: OLAPSpec) => OLAPSpec) => void;
  fields: FieldDefinition[];
  tableName: string;
  sources: SourceOption[];
  endpoint?: string;
  dataSource?: DataSourceRef;
  onChangeTableName: (tableName: string) => void;
  onChangeDataSource?: (dataSource: DataSourceRef | undefined) => void;
  onClose: () => void;
}

/**
 * The left-corner dialog: four self-contained configuration panels
 * (data sources / row group / pivot column / value column), styled after
 * the riskcube cubes design. Drag the header to move; drag the corner to resize.
 */
export function ConfigMenu(props: ConfigMenuProps) {
  const {
    anchorRect,
    spec,
    setSpec,
    fields,
    tableName,
    sources,
    endpoint,
    dataSource,
    onChangeTableName,
    onChangeDataSource,
    onClose,
  } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<PanelRect | null>(null);

  useEffect(() => {
    if (!anchorRect) {
      setRect(null);
      return;
    }
    const width = Math.min(560, window.innerWidth - 24);
    const height = Math.min(560, window.innerHeight - 16);
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(anchorRect.bottom + 4, window.innerHeight - height - 8));
    setRect({ left, top, width, height });
  }, [anchorRect]);

  const { onDragStart, onResizeStart } = usePanelInteraction(rect ?? { left: 0, top: 0, width: 560, height: 560 }, setRect, {
    maxWidth: typeof window === "undefined" ? 560 : window.innerWidth - 16,
    maxHeight: typeof window === "undefined" ? 560 : window.innerHeight - 16,
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

  return (
    <div
      className="ft-menu ft-config-menu"
      ref={ref}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, maxWidth: "none", maxHeight: "none" }}
      data-testid="config-menu"
      role="dialog"
      aria-label="Table configuration"
    >
      <div className="ft-menu-head" onMouseDown={onDragStart} data-testid="config-drag-handle" style={{ cursor: "move" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <StackIcon width={14} height={14} />
          Table configuration
        </span>
        <span style={{ fontSize: 11, color: "var(--ft-fg-muted)" }}>4 panels</span>
      </div>
      <div className="ft-menu-body" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <Section index={1} title="Data sources">
          <DataSourcePanel
            tableName={tableName}
            sources={sources}
            endpoint={endpoint}
            fields={fields}
            dataSource={dataSource}
            onChangeTableName={onChangeTableName}
            onChangeDataSource={onChangeDataSource}
          />
        </Section>
        <Section index={2} title="Row group">
          <GroupingPanel spec={spec} setSpec={setSpec} fields={fields} />
        </Section>
        <Section index={3} title="Pivot column">
          <PivotPanel spec={spec} setSpec={setSpec} fields={fields} />
        </Section>
        <Section index={4} title="Value column">
          <ValuePanel spec={spec} setSpec={setSpec} fields={fields} />
        </Section>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="ft-icon-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <div className="ft-menu-resize" onMouseDown={onResizeStart} data-testid="config-resize-handle" aria-hidden />
    </div>
  );
}

function Section({ index, title, children }: { index: number; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="ft-panel-title" style={{ marginBottom: 6 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 16,
              height: 16,
              borderRadius: 4,
              background: "var(--ft-primary-soft)",
              color: "var(--ft-primary)",
              fontSize: 10,
              fontWeight: 700,
            }}
          >
            {index}
          </span>
          {title}
          <SlidersIcon width={11} height={11} />
        </span>
      </div>
      {children}
    </div>
  );
}