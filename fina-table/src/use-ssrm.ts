import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchRows } from "./datasource";
import type {
  AggregationFn,
  DataSourceRef,
  RowGroupCol,
  SortItem,
  FilterModel,
  FilterCondition,
  ValueCol,
  SSRMRequest,
  SSRMResponse,
} from "./types";
import { deriveColumns, pathFromKey, pathKeyOf, rowKeyOf } from "./utils";

export interface OLAPSpec {
  rowGroups: RowGroupCol[];
  valueCols: ValueCol[];
  pivotField: string | null;
  pivotMode: boolean;
  lod: SSRMRequest["lodConfig"];
  sort: SortItem[];
  filter: FilterModel;
  grandTotal: boolean;
  /** Aggregation for the grand-total row (all records). Default "sum". */
  grandTotalAgg: AggregationFn;
  /** Optional remote (S3/GCS/local) parquet source override. */
  dataSource?: DataSourceRef;
}

export const defaultSpec = (): OLAPSpec => ({
  rowGroups: [],
  valueCols: [],
  pivotField: null,
  pivotMode: false,
  lod: undefined,
  sort: [],
  filter: {},
  grandTotal: false,
  grandTotalAgg: "sum",
  dataSource: undefined,
});

/** Upsert a simple filter condition into a spec's filter model. */
export function configSpecFilter(prev: OLAPSpec, field: string, condition: FilterCondition): FilterModel {
  return { ...prev.filter, [field]: condition };
}

export const buildSSRMRequest = (
  spec: OLAPSpec,
  groupKeys: string[],
  pageIndex: number,
  pageSize: number,
  tableName?: string,
): SSRMRequest => {
  const startRow = pageIndex * pageSize;
  const req: SSRMRequest = {
    startRow,
    endRow: startRow + pageSize,
    rowGroupCols: spec.rowGroups,
    groupKeys,
    valueCols: spec.valueCols,
    pivotMode: spec.pivotMode,
    pivotCols: spec.pivotField ? [{ id: `p_${spec.pivotField}`, field: spec.pivotField }] : [],
    sortModel: spec.sort,
    filterModel: spec.filter,
    lodConfig: spec.lod,
    includeGrandTotal: spec.grandTotal,
    grandTotalAggFunc: spec.grandTotalAgg,
  };
  if (spec.dataSource) req.dataSource = spec.dataSource;
  if (tableName) req.tableName = tableName;
  return req;
};

/**
 * One paged SSRM block: the rows under a group path (root = path []).
 * `lastRow === -1` signals more rows (the server LIMIT s+1 trick).
 */
export interface SsrmBlock {
  path: string[];
  rows: Array<Record<string, unknown>>;
  lastRow: number;
  loading: boolean;
  error: Error | null;
}

/**
 * A flattened, renderable row. Group rows (depth < rowGroupCols.length)
 * carry their expansion key so the client can render children inline and
 * keep the expansion state across page fetches.
 */
export interface DisplayRow {
  key: string;
  row: Record<string, unknown>;
  /** Block path (groupKeys) that produced this row. */
  path: string[];
  /** = path.length. */
  depth: number;
  isGroup: boolean;
  /** Root-level grand-total row (all group keys NULL) prepended by the server. */
  isGrandTotal: boolean;
  groupField: string | null;
  groupValue: string | null;
  /** Expansion-map key (= path + own group value); null on leaf rows. */
  nodeKey: string | null;
  expanded: boolean;
  /** The owning block is still loading (placeholder row). */
  loading: boolean;
  /** The owning block still has more rows on the server. */
  hasMore: boolean;
}

export interface UseSSRMResult {
  spec: OLAPSpec;
  setSpec: (updater: (prev: OLAPSpec) => OLAPSpec) => void;
  refresh: () => void;

  columns: string[];
  blocks: Record<string, SsrmBlock>;
  expandedGroups: Set<string>;
  displayRows: DisplayRow[];

  /** Top-level block rows (compat with the original single-page hook). */
  rows: Array<Record<string, unknown>>;
  lastRow: number;
  request: SSRMRequest;
  loading: boolean;
  error: Error | null;

  hasMore: boolean;
  loadMore: () => void;
  toggleGroup: (nodeKey: string) => void;
  collapseAll: () => void;
  pageSize: number;
}

export interface UseSSRMOptions {
  endpoint?: string;
  tableName?: string;
  pageSize?: number;
  /** Debounce (ms) applied only to whole-spec (root) reloads. Default 0. */
  debounceMs?: number;
  onRows?: (request: SSRMRequest, response: SSRMResponse) => void;
}

/** Reducers for the tree renderers. */
export function flattenTree(
  blocks: Record<string, SsrmBlock>,
  groups: RowGroupCol[],
  expanded: Set<string>,
  grandTotal = false,
): DisplayRow[] {
  const out: DisplayRow[] = [];
  const root = blocks[""];
  if (!root) return out;

  const visit = (block: SsrmBlock) => {
    const depth = block.path.length;
    const isGroupLevel = depth < groups.length;
    const bkey = pathKeyOf(block.path);
    const labelField = depth > 0 ? groups[depth - 1]?.field : undefined;
    for (let i = 0; i < block.rows.length; i++) {
      const row = block.rows[i]!;
      const order = i;
      if (grandTotal && depth === 0 && isGrandTotalRow(row, groups)) {
        out.push({
          key: rowKeyOf(bkey, order, undefined),
          row,
          path: block.path,
          depth,
          isGroup: false,
          isGrandTotal: true,
          groupField: null,
          groupValue: null,
          nodeKey: null,
          expanded: false,
          loading: block.loading,
          hasMore: block.lastRow === -1,
        });
        continue;
      }
      if (!isGroupLevel) {
        out.push({
          key: rowKeyOf(bkey, order, labelField ? row[labelField] : undefined),
          row,
          path: block.path,
          depth,
          isGroup: false,
          isGrandTotal: false,
          groupField: null,
          groupValue: null,
          nodeKey: null,
          expanded: false,
          loading: block.loading,
          hasMore: block.lastRow === -1,
        });
        continue;
      }
      const groupField = groups[depth]!.field;
      const groupValue = row[groupField] == null ? "" : String(row[groupField]);
      const nodeKey = pathKeyOf([...block.path, groupValue]);
      const isExpanded = expanded.has(nodeKey);
      out.push({
        key: rowKeyOf(bkey, order, groupValue),
        row,
        path: block.path,
        depth,
        isGroup: true,
        isGrandTotal: false,
        groupField,
        groupValue,
        nodeKey,
        expanded: isExpanded,
        loading: block.loading,
        hasMore: block.lastRow === -1,
      });
      if (!isExpanded) continue;
      const child = blocks[nodeKey];
      if (child) {
        visit(child);
      } else {
        // Expansion requested but the child block hasn't resolved yet.
        out.push({
          key: `${nodeKey}#pending`,
          row: {},
          path: [...block.path, groupValue],
          depth: depth + 1,
          isGroup: false,
          isGrandTotal: false,
          groupField: null,
          groupValue: null,
          nodeKey: null,
          expanded: false,
          loading: true,
          hasMore: false,
        });
      }
    }
  };

  visit(root);
  return out;
}

/** A server grand-total row has every row-group column NULL. */
function isGrandTotalRow(row: Record<string, unknown>, groups: RowGroupCol[]): boolean {
  return groups.length > 0 && groups.every((g) => row[g.field] == null);
}

const ROOT_KEY = pathKeyOf([]);

export function useSSRM(options: UseSSRMOptions = {}): UseSSRMResult {
  const endpoint = options.endpoint;
  const tableName = options.tableName;
  const pageSize = options.pageSize ?? 100;
  const debounceMs = options.debounceMs ?? 0;

  const [spec, setSpecState] = useState<OLAPSpec>(defaultSpec);
  const [blocks, setBlocks] = useState<Record<string, SsrmBlock>>({});
  const [expandedGroups, setExpanded] = useState<Set<string>>(new Set());
  const [columns, setColumns] = useState<string[]>([]);
  const [rootError, setRootError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  const specRef = useRef(spec);
  const blocksRef = useRef(blocks);
  const expandedRef = useRef(expandedGroups);
  const pageSizeRef = useRef(pageSize);
  const optionsRef = useRef(options);
  const lastRequestRef = useRef<SSRMRequest>(
    buildSSRMRequest(spec, [], 0, pageSize, tableName),
  );
  specRef.current = spec;
  blocksRef.current = blocks;
  expandedRef.current = expandedGroups;
  pageSizeRef.current = pageSize;
  optionsRef.current = options;

  const resetSeq = useRef(0);
  const blockSeq = useRef<Record<string, number>>({});

  const setSpec = useCallback((updater: (prev: OLAPSpec) => OLAPSpec) => setSpecState(updater), []);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  /** Fetch (or append a page to) the block under a group path. */
  const attachBlock = useCallback((path: string[], pageIndex: number, append = false) => {
    const key = pathKeyOf(path);
    blockSeq.current[key] = (blockSeq.current[key] ?? 0) + 1;
    const token = blockSeq.current[key];
    const gen = resetSeq.current;
    const req = buildSSRMRequest(specRef.current, path, pageIndex, pageSizeRef.current, optionsRef.current.tableName);

    setBlocks((prev) => {
      const existing = prev[key];
      return {
        ...prev,
        [key]: existing
          ? { ...existing, loading: true, error: null }
          : { path, rows: [], lastRow: -1, loading: true, error: null },
      };
    });

    const run = async () => {
      try {
        const payload = await fetchRows(req, optionsRef.current);
        if (gen !== resetSeq.current || token !== blockSeq.current[key]) return;
        setBlocks((prev) => {
          const cur = prev[key];
          const existing = cur ? cur.rows : [];
          const rows = append ? [...existing, ...payload.rows] : payload.rows;
          return { ...prev, [key]: { path, rows, lastRow: payload.lastRow, loading: false, error: null } };
        });
        if (key === ROOT_KEY) {
          // Keep the previous columns when a (filtered/empty) root response
          // carries no fields, so the header never collapses on an empty page.
          const next = deriveColumns(payload, req);
          setColumns((prev) => (next.length > 0 ? next : prev));
          setRootError(null);
          lastRequestRef.current = req;
        }
        optionsRef.current.onRows?.(req, payload);
      } catch (err) {
        if (gen !== resetSeq.current || token !== blockSeq.current[key]) return;
        setBlocks((prev) => {
          const cur = prev[key];
          return cur ? { ...prev, [key]: { ...cur, loading: false, error: err as Error } } : prev;
        });
        if (key === ROOT_KEY) setRootError(err as Error);
      }
    };
    void run();
  }, []);

  // Whole-tree reset whenever the spec / page size / data source changes.
  useEffect(() => {
    resetSeq.current++;
    const gen = resetSeq.current;
    setBlocks({ [ROOT_KEY]: { path: [], rows: [], lastRow: -1, loading: true, error: null } });
    setExpanded(new Set());
    setRootError(null);
    const timer = setTimeout(
      () => attachBlock([], 0),
      debounceMs,
    );
    return () => {
      clearTimeout(timer);
      void gen;
    };
  }, [spec, pageSize, endpoint, tableName, debounceMs, tick, attachBlock]);

  const toggleGroup = useCallback(
    (nodeKey: string) => {
      const wasExpanded = expandedRef.current.has(nodeKey);
      if (wasExpanded) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(nodeKey);
          return next;
        });
      } else {
        if (!blocksRef.current[nodeKey]) attachBlock(pathFromKey(nodeKey), 0, false);
        setExpanded((prev) => {
          const next = new Set(prev);
          next.add(nodeKey);
          return next;
        });
      }
    },
    [attachBlock],
  );

  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  const displayRows = useMemo(
    () => flattenTree(blocks, spec.rowGroups, expandedGroups, spec.grandTotal),
    [blocks, spec.rowGroups, expandedGroups, spec.grandTotal],
  );

  /** Append the next page of the deepest currently-rendered block that has more. */
  const loadMore = useCallback(() => {
    const flat = flattenTree(
      blocksRef.current,
      specRef.current.rowGroups,
      expandedRef.current,
      specRef.current.grandTotal,
    );
    const appendPage = (key: string) => {
      const block = blocksRef.current[key];
      if (!block || block.lastRow !== -1 || block.loading || block.error) return;
      const nextIndex = Math.ceil(block.rows.length / pageSizeRef.current);
      attachBlock(pathFromKey(key), nextIndex, true);
    };
    let bestKey: string | null = null;
    let bestDepth = -1;
    for (const d of flat) {
      const own = blocksRef.current[pathKeyOf(d.path)];
      if (own && own.lastRow === -1 && !own.loading && !own.error && d.depth >= bestDepth) {
        bestKey = pathKeyOf(d.path);
        bestDepth = d.depth;
      }
    }
    if (bestKey !== null) appendPage(bestKey);
  }, [attachBlock]);

  const hasMore = useMemo(() => {
    const root = blocks[ROOT_KEY];
    if (!root || root.loading) return false;
    if (root.lastRow === -1) return true;
    for (const key of expandedGroups) {
      const b = blocks[key];
      if (b && b.lastRow === -1) return true;
    }
    return false;
  }, [blocks, expandedGroups]);

  const root = blocks[ROOT_KEY];
  const loading = root?.loading ?? false;
  const error = rootError ?? root?.error ?? null;

  return {
    spec,
    setSpec,
    refresh,
    columns,
    blocks,
    expandedGroups,
    displayRows,
    rows: root?.rows ?? [],
    lastRow: root?.lastRow ?? -1,
    request: lastRequestRef.current,
    loading,
    error,
    hasMore,
    loadMore,
    toggleGroup,
    collapseAll,
    pageSize,
  };
}