import { describe, expect, it } from "vitest";

import {
  aggAtLevel,
  createRequest,
  removeGroup,
  setFilter,
  setSort,
  setVisibleLevels,
  togglePivot,
  addGroup,
  addValue,
  removeValue,
  moveGroup,
  withLod,
  withGroupPath,
} from "../src/request";
import type { LodConfig } from "../src/types";

describe("request builders", () => {
  it("createRequest produces a well-formed default request", () => {
    const req = createRequest();
    expect(req.startRow).toBe(0);
    expect(req.endRow).toBe(100);
    expect(req.rowGroupCols).toEqual([]);
    expect(req.groupKeys).toEqual([]);
    expect(req.pivotMode).toBe(false);
    expect(req.valueCols).toEqual([]);
  });

  it("addGroup is idempotent and orders by insertion", () => {
    let req = createRequest();
    req = addGroup(req, "portfolio");
    req = addGroup(req, "instrument");
    req = addGroup(req, "portfolio");
    expect(req.rowGroupCols!.map((g) => g.field)).toEqual(["portfolio", "instrument"]);
  });

  it("removeGroup truncates the group path at the removed level", () => {
    let req = createRequest();
    req = addGroup(req, "portfolio");
    req = addGroup(req, "instrument");
    req = withGroupPath(req, ["Portfolio 1", "Instrument 2"]);
    expect(req.groupKeys).toEqual(["Portfolio 1", "Instrument 2"]);
    req = removeGroup(req, "portfolio");
    expect(req.rowGroupCols!.map((g) => g.field)).toEqual(["instrument"]);
    expect(req.groupKeys).toEqual([]);
  });

  it("moveGroup reorders sibling group columns and clears the path", () => {
    let req = createRequest();
    req = addGroup(req, "portfolio");
    req = addGroup(req, "instrument");
    req = addGroup(req, "leg");
    req = moveGroup(req, "leg", -1);
    expect(req.rowGroupCols!.map((g) => g.field)).toEqual(["portfolio", "leg", "instrument"]);
    req = moveGroup(req, "portfolio", 1);
    expect(req.rowGroupCols!.map((g) => g.field)).toEqual(["leg", "portfolio", "instrument"]);
  });

  it("setSort toggles the same column in place", () => {
    let req = createRequest();
    req = setSort(req, "delta", "asc");
    req = setSort(req, "delta", "desc");
    expect(req.sortModel).toEqual([{ colId: "delta", sort: "desc" }]);
    req = setSort(req, "delta", null);
    expect(req.sortModel).toEqual([]);
  });

  it("setFilter upserts and deletes per column", () => {
    let req = createRequest();
    req = setFilter(req, "instrument", { filterType: "text", operator: "contains", filter: "Inst" });
    expect(req.filterModel?.instrument).toMatchObject({ operator: "contains" });
    req = setFilter(req, "instrument", null);
    expect(req.filterModel).toEqual({});
  });

  it("addValue is idempotent; removeValue drops the measure", () => {
    let req = createRequest();
    req = addValue(req, "delta");
    req = addValue(req, "delta", "avg");
    expect(req.valueCols).toHaveLength(1);
    expect(req.valueCols![0]).toEqual({ id: "v_delta", field: "delta", aggFunc: "sum" });
    req = addValue(req, "gamma");
    expect(req.valueCols!.map((v) => v.field)).toEqual(["delta", "gamma"]);
    req = removeValue(req, "delta");
    expect(req.valueCols!.map((v) => v.field)).toEqual(["gamma"]);
  });

  it("setAggFuncs by level and visible levels", () => {
    let req = createRequest();
    req = addValue(req, "delta");
    const col0 = () => req.valueCols![0]!;
    req = aggAtLevel(req, "delta", "portfolio", "first");
    expect(col0().aggFuncsByLevel).toEqual({ portfolio: "first" });
    req = aggAtLevel(req, "delta", "portfolio", null);
    expect(col0().aggFuncsByLevel).toEqual({});
    req = setVisibleLevels(req, "delta", ["1"]);
    expect(col0().visibleLevels).toEqual(["1"]);
    req = setVisibleLevels(req, "delta", null);
    expect(col0().visibleLevels).toBeUndefined();
  });

  it("withLod embeds the LOD config", () => {
    const lod: LodConfig = { type: "fixed", groupKeys: ["portfolio"], metrics: { delta: "sum" }, prefix: "_lod_" };
    const req = withLod(createRequest(), lod);
    expect(req.lodConfig).toEqual(lod);
    const bare = withLod(createRequest(), null);
    expect(bare.lodConfig).toBeUndefined();
  });

  it("togglePivot enables pivot on a field and clears when toggled twice", () => {
    let req = togglePivot(createRequest(), "leg");
    expect(req.pivotMode).toBe(true);
    expect(req.pivotCols!.map((p) => p.field)).toEqual(["leg"]);
    req = togglePivot(req, "leg");
    expect(req.pivotMode).toBe(false);
    expect(req.pivotCols).toEqual([]);
  });
});