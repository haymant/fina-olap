import { useEffect, useRef, useState } from "react";

import type { FieldDefinition } from "./panels";
import { Panel, Select } from "./panels";
import type { ListedTable } from "./datasource";
import { listTables } from "./datasource";
import type { DataSourceRef } from "./types";
import { TableIcon } from "./icons";

export interface SourceOption {
  label: string;
  tableName: string;
  endpoint?: string;
}

export interface DataSourcePanelProps {
  tableName: string;
  sources: SourceOption[];
  endpoint?: string;
  fields: FieldDefinition[];
  dataSource?: DataSourceRef;
  onChangeTableName: (tableName: string) => void;
  onChangeDataSource?: (dataSource: DataSourceRef | undefined) => void;
}

/** Panel 1 — which table / endpoint / S3 bucket the grid reads from. */
export function DataSourcePanel({
  tableName,
  sources,
  endpoint,
  dataSource,
  onChangeTableName,
  onChangeDataSource,
}: DataSourcePanelProps) {
  const [uri, setUri] = useState(dataSource?.uri ?? "");
  const [bucket, setBucket] = useState(dataSource?.bucket ?? "");
  const [path, setPath] = useState(dataSource?.path ?? "");
  const [hive, setHive] = useState(dataSource?.hivePartitioning ?? true);
  const [tables, setTables] = useState<ListedTable[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef(true);

  // Push the source config into the spec (skip the initial mount).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!onChangeDataSource) return;
    if (!uri.trim() && !bucket.trim() && !path.trim()) {
      onChangeDataSource(undefined);
      return;
    }
    if (uri.trim()) {
      onChangeDataSource({ uri: uri.trim(), hivePartitioning: hive });
      return;
    }
    onChangeDataSource({
      bucket: bucket.trim() || undefined,
      path: path.trim() || undefined,
      glob: "**/*.parquet",
      hivePartitioning: hive,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, bucket, path, hive]);

  // Auto-list candidate tables when the source (local path / bucket / prefix) changes.
  const currentSource = (): DataSourceRef | null => {
    if (uri.trim()) return { uri: uri.trim(), hivePartitioning: hive };
    if (bucket.trim()) {
      return { bucket: bucket.trim(), path: path.trim() || undefined, glob: "**/*.parquet", hivePartitioning: hive };
    }
    return null;
  };

  const runList = () => {
    const target = currentSource();
    if (!target) {
      setTables([]);
      return;
    }
    setLoading(true);
    setError(null);
    listTables(target, { endpoint })
      .then((rows) => setTables(rows))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!uri.trim() && !bucket.trim()) {
      setTables([]);
      return;
    }
    const timer = setTimeout(runList, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, bucket, path, endpoint]);

  const options: SourceOption[] = [
    ...sources,
    ...tables
      .filter((t) => !sources.some((s) => s.tableName === t.tableName))
      .map((t) => ({ label: t.tableName, tableName: t.tableName })),
  ];
  const known = options.some((s) => s.tableName === tableName);

  const pickTable = (name: string) => {
    onChangeTableName(name);
    const listed = tables.find((t) => t.tableName === name);
    if (listed && onChangeDataSource) {
      onChangeDataSource({ uri: listed.uri, hivePartitioning: hive });
    } else if (onChangeDataSource) {
      // switching to a static source: don't keep a stale bucket/prefix override
      onChangeDataSource(undefined);
    }
  };

  return (
    <Panel title="Data sources">
      <div className="ft-field-row" style={{ marginBottom: 6 }}>
        <TableIcon width={14} height={14} />
        <span style={{ fontSize: 12, color: "var(--ft-fg-muted)" }}>table</span>
      </div>
      <Select aria-label="Data source table" value={known ? tableName : "__custom__"} onChange={(e) => pickTable(e.target.value)}>
        <option value="__custom__" disabled>
          {tableName || "(none)"} (custom)
        </option>
        {options.map((s) => (
          <option key={s.tableName} value={s.tableName}>
            {s.label}
          </option>
        ))}
      </Select>

      <div className="ft-field-row" style={{ marginTop: 8 }}>
        <span className="ft-format-label">path</span>
        <input
          className="ft-input"
          style={{ flex: 1 }}
          aria-label="Local path or file URI"
          placeholder="file:///data/lake or /mnt/lake"
          title="A parquet file, a directory (its *.parquet), or a glob like /data/lake/**/*.parquet"
          value={uri}
          onChange={(e) => setUri(e.target.value)}
        />
      </div>
      <div className="ft-field-row" style={{ marginTop: 6 }}>
        <span className="ft-format-label">bucket</span>
        <input
          className="ft-input"
          style={{ flex: 1 }}
          aria-label="S3 bucket"
          placeholder="s3://my-bucket or gs://my-bucket"
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
        />
      </div>
      <div className="ft-field-row" style={{ marginTop: 6 }}>
        <span className="ft-format-label">prefix</span>
        <input
          className="ft-input"
          style={{ flex: 1 }}
          aria-label="S3 path prefix"
          placeholder="warehouse/trades"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <label className="ft-check" title="Read hive-style key=value partition directories">
          <input type="checkbox" aria-label="Hive partitioning" checked={hive} onChange={(e) => setHive(e.target.checked)} />
          hive
        </label>
      </div>
      <div className="ft-field-row" style={{ marginTop: 6 }}>
        <button
          type="button"
          className="ft-icon-btn"
          style={{ fontSize: 11 }}
          aria-label="List tables"
          onClick={runList}
          disabled={loading || (!uri.trim() && !bucket.trim())}
        >
          {loading ? "listing…" : "List tables"}
        </button>
        <span style={{ fontSize: 11, color: "var(--ft-fg-muted)" }} data-testid="list-tables-status">
          {error
            ? `error: ${error}`
            : uri.trim() || bucket.trim()
              ? `${tables.length} table(s)`
              : "no path or bucket configured"}
        </span>
      </div>
      {tables.length > 0 && (
        <div className="ft-field-row" style={{ marginTop: 6, flexWrap: "wrap", gap: 6 }} data-testid="listed-tables">
          {tables.map((t) => (
            <button
              key={t.tableName}
              type="button"
              className="ft-chip ft-chip-selectable"
              data-testid={`listed-table-${t.tableName}`}
              data-active={t.tableName === tableName}
              title={t.uri}
              onClick={() => pickTable(t.tableName)}
            >
              {t.tableName}
            </button>
          ))}
        </div>
      )}
      <div style={{ marginTop: 6, fontSize: 11, color: "var(--ft-fg-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {endpoint ?? "/api/getRows"}
      </div>
    </Panel>
  );
}
