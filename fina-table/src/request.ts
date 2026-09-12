import type {
  AggregationFn,
  FilterCondition,
  FilterModel,
  LodConfig,
  RowGroupCol,
  SortItem,
  SSRMRequest,
  ValueCol,
} from "./types";

/** Builds self-consistent SSRM requests. All ops are immutable. */
export const createRequest = (init?: Partial<SSRMRequest>): SSRMRequest => ({
  startRow: 0,
  endRow: 100,
  rowGroupCols: [],
  groupKeys: [],
  pivotMode: false,
  pivotCols: [],
  valueCols: [],
  sortModel: [],
  filterModel: {},
  ...init,
});

export const addGroup = (req: SSRMRequest, field: string, displayName?: string): SSRMRequest => {
  if (req.rowGroupCols!.some((g) => g.field === field)) return req;
  return { ...req, rowGroupCols: [...req.rowGroupCols!, { id: `g_${field}`, field, displayName }] };
};

export const removeGroup = (req: SSRMRequest, field: string): SSRMRequest => {
  const idx = req.rowGroupCols!.findIndex((g) => g.field === field);
  if (idx < 0) return req;
  const rowGroupCols = req.rowGroupCols!.filter((g) => g.field !== field);
  const groupKeys = req.groupKeys!.slice(0, idx);
  return { ...req, rowGroupCols, groupKeys };
};

export const moveGroup = (req: SSRMRequest, field: string, dir: -1 | 1): SSRMRequest => {
  const groups = [...req.rowGroupCols!];
  const idx = groups.findIndex((g) => g.field === field);
  const target = idx + dir;
  if (idx < 0 || target < 0 || target >= groups.length) return req;
  const [col] = groups.splice(idx, 1);
  groups.splice(target, 0, col!);
  return { ...req, rowGroupCols: groups, groupKeys: [] };
};

/** Fold a group path back into the request (context re-expansion). */
export const withGroupPath = (req: SSRMRequest, groupKeys: string[]): SSRMRequest => ({
  ...req,
  groupKeys: groupKeys.slice(0, req.rowGroupCols!.length),
});

export const setSort = (req: SSRMRequest, colId: string, sort: "asc" | "desc" | null): SSRMRequest => {
  if (!sort) return { ...req, sortModel: req.sortModel!.filter((s) => s.colId !== colId) };
  const rest = req.sortModel!.filter((s) => s.colId !== colId);
  return { ...req, sortModel: [...rest, { colId, sort } satisfies SortItem] };
};

export const setFilter = (req: SSRMRequest, field: string, condition: FilterCondition | null): SSRMRequest => {
  const filterModel: FilterModel = { ...req.filterModel };
  if (condition === null) delete filterModel[field];
  else filterModel[field] = condition;
  return { ...req, filterModel };
};

export const addValue = (req: SSRMRequest, field: string, aggFunc: AggregationFn | "none" = "sum"): SSRMRequest => {
  if (req.valueCols!.some((v) => v.field === field)) return req;
  return {
    ...req,
    valueCols: [...req.valueCols!, { id: `v_${field}`, field, aggFunc } satisfies ValueCol],
  };
};

export const removeValue = (req: SSRMRequest, field: string): SSRMRequest => ({
  ...req,
  valueCols: req.valueCols!.filter((v) => v.field !== field),
});

export const setValueAgg = (req: SSRMRequest, field: string, aggFunc: AggregationFn | "none"): SSRMRequest => ({
  ...req,
  valueCols: req.valueCols!.map((v) => (v.field === field ? { ...v, aggFunc } : v)),
});

/** Per-level aggregation override, e.g. aggAtLevel(req, "portfolio", "first"). */
export const aggAtLevel = (
  req: SSRMRequest,
  field: string,
  level: string,
  fn: AggregationFn | "none" | null,
): SSRMRequest => ({
  ...req,
  valueCols: req.valueCols!.map((v) => {
    if (v.field !== field) return v;
    const aggFuncsByLevel = { ...(v.aggFuncsByLevel ?? {}) };
    if (fn === null) delete aggFuncsByLevel[level];
    else aggFuncsByLevel[level] = fn;
    return { ...v, aggFuncsByLevel };
  }),
});

export const setVisibleLevels = (req: SSRMRequest, field: string, levels: string[] | null): SSRMRequest => ({
  ...req,
  valueCols: req.valueCols!.map((v) => {
    if (v.field !== field) return v;
    if (!levels || levels.length === 0) {
      const { visibleLevels: _omit, ...rest } = v;
      void _omit;
      return rest;
    }
    return { ...v, visibleLevels: [...levels] };
  }),
});

export const withLod = (req: SSRMRequest, lod: LodConfig | null): SSRMRequest => ({
  ...req,
  lodConfig: lod ?? undefined,
});

export const togglePivot = (req: SSRMRequest, pivotField: string, on?: boolean): SSRMRequest => {
  const enable = on ?? !req.pivotMode;
  return {
    ...req,
    pivotMode: enable,
    pivotCols: enable ? [{ id: `p_${pivotField}`, field: pivotField }] : [],
  };
};