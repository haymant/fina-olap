import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { buildSSRMRequest, defaultSpec, flattenTree, useSSRM, type SsrmBlock } from "../src/use-ssrm";
import { makeSsrmServer, type FixtureRow } from "./fake-server";

const TRADES: FixtureRow[] = [
  { portfolio: "P1", instrument: "I1", leg: "A", delta: 1 },
  { portfolio: "P1", instrument: "I2", leg: "B", delta: 2 },
  { portfolio: "P1", instrument: "I3", leg: "C", delta: 3 },
  { portfolio: "P2", instrument: "I4", leg: "D", delta: 4 },
  { portfolio: "P3", instrument: "I5", leg: "E", delta: 5 },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

const PORTFOLIO_GROUP = [
  { id: "g_portfolio", field: "portfolio" },
  { id: "g_instrument", field: "instrument" },
];
const DELTA_MEASURE = [{ id: "v_delta", field: "delta", aggFunc: "sum" as const }];

describe("useSSRM (grouped tree + infinite scroll)", () => {
  it("loads the root block and derives columns", async () => {
    const server = makeSsrmServer(TRADES);
    vi.stubGlobal("fetch", server.fetchMock);
    const { result } = renderHook(() => useSSRM({ pageSize: 10 }));

    await waitFor(() => expect(result.current.rows.length).toBe(5));
    expect(result.current.columns).toEqual(
      expect.arrayContaining(["portfolio", "instrument", "leg", "delta"]),
    );
    expect(result.current.displayRows.every((d) => !d.isGroup)).toBe(true);
    expect(server.calls[0]?.groupKeys).toEqual([]);
  });

  it("rewrites the tree when grouping is configured", async () => {
    const server = makeSsrmServer(TRADES);
    vi.stubGlobal("fetch", server.fetchMock);
    const { result } = renderHook(() => useSSRM({ pageSize: 10 }));

    await waitFor(() => expect(result.current.rows.length).toBe(5));
    act(() =>
      result.current.setSpec((prev) => ({
        ...prev,
        rowGroups: PORTFOLIO_GROUP,
        valueCols: DELTA_MEASURE,
      })),
    );

    await waitFor(() => expect(result.current.displayRows.length).toBe(3));
    expect(result.current.displayRows.map((d) => ({ f: d.groupField, v: d.groupValue }))).toEqual([
      { f: "portfolio", v: "P1" },
      { f: "portfolio", v: "P2" },
      { f: "portfolio", v: "P3" },
    ]);
    // aggregated measures land on group rows
    const p1 = result.current.displayRows.find((d) => d.groupValue === "P1")!;
    expect(p1.row.delta).toBe(6);
    expect(p1.nodeKey).toBe("P1");
  });

  it("expands a group inline, fetching its children, and remembers the state", async () => {
    const server = makeSsrmServer(TRADES);
    vi.stubGlobal("fetch", server.fetchMock);
    const { result } = renderHook(() => useSSRM({ pageSize: 2 }));

    await waitFor(() => expect(result.current.rows.length).toBe(2));
    act(() =>
      result.current.setSpec((prev) => ({
        ...prev,
        rowGroups: PORTFOLIO_GROUP,
        valueCols: DELTA_MEASURE,
      })),
    );
    await waitFor(() => expect(result.current.displayRows.length).toBe(2)); // P1, P2

    act(() => result.current.toggleGroup("P1"));
    await waitFor(() => expect(result.current.expandedGroups.has("P1")).toBe(true));

    // children fetched for ["P1"] (page 1 of 2, page size) and rendered inline between P1 and P2
    await waitFor(() =>
      expect(result.current.displayRows.map((d) => d.groupValue ?? d.row.leg)).toEqual([
        "P1", "I1", "I2", "P2",
      ]),
    );
    expect(server.calls.some((c) => JSON.stringify(c.groupKeys) === '["P1"]')).toBe(true);

    // loadMore fills the deepest still-incomplete block first (the expanded sub-group)…
    act(() => result.current.loadMore());
    await waitFor(() =>
      expect(result.current.displayRows.map((d) => d.groupValue ?? d.row.leg)).toEqual([
        "P1", "I1", "I2", "I3", "P2",
      ]),
    );
    // …then the root block, preserving the remembered expansion (cross-page sub-group)
    act(() => result.current.loadMore());
    await waitFor(() =>
      expect(result.current.displayRows.map((d) => d.groupValue ?? d.row.leg)).toEqual([
        "P1", "I1", "I2", "I3", "P2", "P3",
      ]),
    );
    expect(result.current.expandedGroups.has("P1")).toBe(true);
    expect(result.current.rows).toHaveLength(3);
  });

  it("marks the server grand-total row at the root when spec.grandTotal is on", async () => {
    const server = makeSsrmServer(TRADES);
    vi.stubGlobal("fetch", server.fetchMock);
    const { result } = renderHook(() => useSSRM({ pageSize: 10 }));

    await waitFor(() => expect(result.current.rows.length).toBe(5));
    act(() =>
      result.current.setSpec((prev) => ({
        ...prev,
        rowGroups: PORTFOLIO_GROUP,
        valueCols: DELTA_MEASURE,
        grandTotal: true,
      })),
    );

    await waitFor(() => expect(result.current.displayRows[0]?.isGrandTotal).toBe(true));
    expect(result.current.displayRows[0]!.row.portfolio).toBeNull();
    expect(result.current.displayRows[0]!.row.delta).toBe(15); // 1+2+3+4+5
    expect(result.current.displayRows[1]!.isGroup).toBe(true);
    expect(result.current.displayRows[1]!.groupValue).toBe("P1");
    expect(result.current.request.grandTotalAggFunc).toBe("sum");
  });

  it("honours the spec grand-total aggregation function", async () => {
    const server = makeSsrmServer(TRADES);
    vi.stubGlobal("fetch", server.fetchMock);
    const { result } = renderHook(() => useSSRM({ pageSize: 10 }));

    await waitFor(() => expect(result.current.rows.length).toBe(5));
    act(() =>
      result.current.setSpec((prev) => ({
        ...prev,
        rowGroups: PORTFOLIO_GROUP,
        valueCols: DELTA_MEASURE,
        grandTotal: true,
        grandTotalAgg: "avg",
      })),
    );

    await waitFor(() => expect(result.current.displayRows[0]?.isGrandTotal).toBe(true));
    expect(result.current.displayRows[0]!.row.delta).toBe(3); // 15 / 5
    expect(result.current.request.grandTotalAggFunc).toBe("avg");
  });

  it("collapses without re-fetching and re-expands from the cached block", async () => {
    const server = makeSsrmServer(TRADES);
    vi.stubGlobal("fetch", server.fetchMock);
    const { result } = renderHook(() => useSSRM({ pageSize: 10 }));

    await waitFor(() => expect(result.current.rows.length).toBe(5));
    act(() =>
      result.current.setSpec((prev) => ({ ...prev, rowGroups: PORTFOLIO_GROUP, valueCols: DELTA_MEASURE })),
    );
    await waitFor(() => expect(result.current.displayRows.length).toBe(3));

    act(() => result.current.toggleGroup("P1"));
    await waitFor(() => expect(result.current.displayRows.length).toBe(6)); // P1 + I1,I2,I3
    const childRequests = server.calls.filter((c) => JSON.stringify(c.groupKeys) === '["P1"]').length;

    act(() => result.current.toggleGroup("P1")); // collapse
    expect(result.current.expandedGroups.has("P1")).toBe(false);
    expect(result.current.displayRows.length).toBe(3);

    act(() => result.current.toggleGroup("P1")); // re-expand
    await waitFor(() => expect(result.current.displayRows.length).toBe(6));
    expect(server.calls.filter((c) => JSON.stringify(c.groupKeys) === '["P1"]')).toHaveLength(
      childRequests,
    );
  });

  it("pages deep into an expanded sub-group (cross-page sub-group rendering)", async () => {
    const server = makeSsrmServer(TRADES);
    vi.stubGlobal("fetch", server.fetchMock);
    const { result } = renderHook(() => useSSRM({ pageSize: 2 }));

    await waitFor(() => expect(result.current.rows.length).toBe(2));
    act(() =>
      result.current.setSpec((prev) => ({
        ...prev,
        rowGroups: [{ id: "g_portfolio", field: "portfolio" }],
        valueCols: DELTA_MEASURE,
      })),
    );
    await waitFor(() => expect(result.current.displayRows.length).toBe(2)); // P1, P2

    act(() => result.current.toggleGroup("P1"));
    await waitFor(() => expect(result.current.expandedGroups.has("P1")).toBe(true));
    // root page [P1, P2] + child page [I1, I2] (P1 has 3 leaves, page size 2)
    await waitFor(() => expect(result.current.displayRows.length).toBe(4));
    expect(result.current.displayRows.map((d) => d.groupValue ?? d.row.leg)).toEqual([
      "P1", "A", "B", "P2",
    ]);

    // loadMore must target the deeper sub-group block, not the root.
    act(() => result.current.loadMore());
    await waitFor(() =>
      expect(result.current.displayRows.map((d) => d.groupValue ?? d.row.leg)).toEqual([
        "P1", "A", "B", "C", "P2",
      ]),
    );

    const p1Page2 = server.calls.find(
      (c) => JSON.stringify(c.groupKeys) === '["P1"]' && c.startRow === 2,
    );
    expect(p1Page2).toBeTruthy();
  });

  it("resets blocks and expansion when the spec changes", async () => {
    const server = makeSsrmServer(TRADES);
    vi.stubGlobal("fetch", server.fetchMock);
    const { result } = renderHook(() => useSSRM({ pageSize: 10 }));

    await waitFor(() => expect(result.current.rows.length).toBe(5));
    act(() =>
      result.current.setSpec((prev) => ({ ...prev, rowGroups: PORTFOLIO_GROUP, valueCols: DELTA_MEASURE })),
    );
    await waitFor(() => expect(result.current.displayRows.length).toBe(3));
    act(() => result.current.toggleGroup("P1"));
    await waitFor(() => expect(result.current.expandedGroups.has("P1")).toBe(true));

    act(() => result.current.setSpec((prev) => ({ ...prev, valueCols: [...prev.valueCols] })));
    await waitFor(() => expect(result.current.expandedGroups.size).toBe(0));
    expect(Object.keys(result.current.blocks)).toEqual([""]);
    await waitFor(() => expect(result.current.displayRows.length).toBe(3));
  });

  it("flattenTree collapses descendants when an ancestor is closed", () => {
    const blocks: Record<string, SsrmBlock> = {
      "": { path: [], rows: [{ portfolio: "P1" }, { portfolio: "P2" }], lastRow: 1, loading: false, error: null },
      P1: { path: ["P1"], rows: [{ instrument: "I1" }], lastRow: 0, loading: false, error: null },
      "P1::I1": { path: ["P1", "I1"], rows: [{ leg: "A" }], lastRow: 0, loading: false, error: null },
    };
    const flat = flattenTree(blocks, PORTFOLIO_GROUP, new Set(["P1", "P1::I1"]));
    expect(flat.map((d) => d.groupValue ?? d.row.leg)).toEqual(["P1", "I1", "A", "P2"]);
    const collapsed = flattenTree(blocks, PORTFOLIO_GROUP, new Set(["P1"]));
    expect(collapsed.map((d) => d.groupValue ?? d.row.leg)).toEqual(["P1", "I1", "P2"]);
  });
});

describe("buildSSRMRequest", () => {
  it("emits the OLAP extensions on the wire", () => {
    const spec = defaultSpec();
    const req = buildSSRMRequest(spec, ["P1"], 2, 10, "trades");
    expect(req.rowGroupCols).toEqual([]);
    expect(req.groupKeys).toEqual(["P1"]);
    expect(req.startRow).toBe(20);
    expect(req.endRow).toBe(30);
    expect(req.filterModel).toEqual({});
    expect(req.sortModel).toEqual([]);
    expect(req.includeGrandTotal).toBe(false);
    expect(req.tableName).toBe("trades");
  });
});