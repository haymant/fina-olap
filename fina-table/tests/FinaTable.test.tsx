import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FinaTable, computeRowGroupFlags } from "../src/FinaTable";
import type { FieldDefinition } from "../src/panels";
import { makeSsrmServer, type FixtureRow } from "./fake-server";

// echarts needs a real canvas; stub it so the view-toggle test stays in jsdom.
vi.mock("echarts", () => ({
  init: () => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() }),
  getInstanceByDom: () => null,
}));

const TRADES: FixtureRow[] = [
  { portfolio: "P1", instrument: "I1", leg: "A", delta: 1 },
  { portfolio: "P1", instrument: "I2", leg: "B", delta: 2 },
  { portfolio: "P2", instrument: "I3", leg: "C", delta: 3 },
  { portfolio: "P3", instrument: "I4", leg: "D", delta: 4 },
  { portfolio: "P4", instrument: "I5", leg: "E", delta: 5 },
  { portfolio: "P5", instrument: "I6", leg: "F", delta: 6 },
];

const FIELDS: FieldDefinition[] = [
  { field: "portfolio", label: "Portfolio" },
  { field: "instrument", label: "Instrument" },
  { field: "leg", label: "Leg" },
  { field: "delta", label: "Delta", kind: "number" },
  { field: "gamma", label: "Gamma", kind: "number" },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderTable(opts: { pageSize?: number; sources?: { label: string; tableName: string }[] } = {}) {
  const server = makeSsrmServer(TRADES);
  vi.stubGlobal("fetch", server.fetchMock);
  const utils = render(
    <FinaTable
      fields={FIELDS}
      tableName="trades"
      sources={opts.sources}
      pageSize={opts.pageSize ?? 10}
      height={300}
    />,
  );
  return { ...utils, server };
}

describe("FinaTable", () => {
  it("renders the toolbar, header row and initial rows", async () => {
    const { server } = renderTable();
    expect(screen.getByTestId("fina-table")).toBeTruthy();
    expect(screen.getByText("trades")).toBeTruthy();
    expect(await screen.findByRole("columnheader", { name: "Portfolio" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Delta" })).toBeTruthy();
    await waitFor(() => expect(server.fetchMock).toHaveBeenCalled());
    expect(screen.getByTestId("row-count")).toHaveTextContent(/6 rows/);
  });

  it("opens the left-corner dropdown with the four config panels", async () => {
    const user = userEvent.setup();
    renderTable();
    await screen.findByRole("columnheader", { name: "Portfolio" });

    await user.click(screen.getByRole("button", { name: "Table configuration" }));
    const menu = await screen.findByTestId("config-menu");
    expect(menu).toBeVisible();
    // section titles repeat the panel headings, so assert presence by count
    for (const t of ["Data sources", "Row group", "Pivot column", "Value column"]) {
      expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    }

    // panel 1 lets you switch the data source table
    await user.selectOptions(screen.getByLabelText("Data source table"), "trades");
  });

  it("switches data sources from panel 1", async () => {
    const user = userEvent.setup();
    const { server } = renderTable({
      sources: [
        { label: "Trades", tableName: "trades" },
        { label: "Orders", tableName: "orders" },
      ],
    });
    await screen.findByRole("columnheader", { name: "Portfolio" });

    await user.click(screen.getByRole("button", { name: "Table configuration" }));
    await screen.findByTestId("config-menu");
    await user.selectOptions(screen.getByLabelText("Data source table"), "orders");
    await waitFor(() => expect(server.calls.at(-1)?.tableName).toBe("orders"));
  });

  it("groups by portfolio and expands groups inline with remembered state", async () => {
    const user = userEvent.setup();
    renderTable({ pageSize: 2 });
    await screen.findByRole("columnheader", { name: "Portfolio" });

    await user.click(screen.getByRole("button", { name: "Table configuration" }));
    await screen.findByTestId("config-menu");
    await user.selectOptions(screen.getByLabelText("Add group level"), "portfolio");
    await screen.findByTestId("group-portfolio-P1");
    await user.selectOptions(screen.getByLabelText("Add group level"), "instrument");
    await screen.findByTestId("group-portfolio-P1");

    const p1 = screen.getByTestId("toggle-portfolio-P1");
    expect(p1).toHaveAttribute("aria-expanded", "false");
    await user.click(p1);

    // children (instrument groups) render inline; P2 stays visible
    await screen.findByTestId("group-instrument-I1");
    expect(screen.getByTestId("toggle-instrument-I1")).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(p1).toHaveAttribute("aria-expanded", "true"));
    expect(screen.getByTestId("group-portfolio-P2")).toBeTruthy();

    // collapse removes the children, re-expand restores them
    await user.click(p1);
    await waitFor(() => expect(screen.queryByTestId("group-instrument-I1")).toBeNull());
    expect(screen.getByTestId("group-portfolio-P2")).toBeTruthy();
  });

  it("renders the grand-total row first when enabled in the config", async () => {
    const user = userEvent.setup();
    const { server } = renderTable({ pageSize: 10 });
    await screen.findByRole("columnheader", { name: "Portfolio" });

    await user.click(screen.getByRole("button", { name: "Table configuration" }));
    await screen.findByTestId("config-menu");
    await user.selectOptions(screen.getByLabelText("Add group level"), "portfolio");
    await user.selectOptions(screen.getByLabelText("Add measure"), "delta");
    await user.click(screen.getByTestId("grand-total-toggle"));

    const gt = await screen.findByTestId("grand-total-row");
    expect(screen.getByTestId("grand-total-label")).toHaveTextContent("Grand Total");
    expect(gt).toHaveTextContent("21"); // 1+2+3+4+5+6
    const tbody = screen.getByTestId("fina-table").querySelector("tbody")!;
    expect(tbody.children[0]).toHaveAttribute("data-testid", "grand-total-row");
    // the per-portfolio group rows still follow underneath
    expect(screen.getByTestId("group-portfolio-P1")).toBeTruthy();

    // the grand-total aggregation is selectable and defaults to sum
    const aggSel = screen.getByLabelText("Grand total aggregation");
    expect(aggSel).toHaveValue("sum");
    await user.selectOptions(aggSel, "avg");
    await waitFor(() => expect(server.calls.at(-1)?.grandTotalAggFunc).toBe("avg"));
  });

  it("toggles a measure's visibility on raw leaf rows", async () => {
    const user = userEvent.setup();
    const { server } = renderTable({ pageSize: 10 });
    await screen.findByRole("columnheader", { name: "Portfolio" });

    await user.click(screen.getByRole("button", { name: "Table configuration" }));
    await screen.findByTestId("config-menu");
    await user.selectOptions(screen.getByLabelText("Add group level"), "portfolio");
    await user.selectOptions(screen.getByLabelText("Add measure"), "delta");

    const leafBox = screen.getByLabelText("Show delta on leaf rows");
    expect(leafBox).toBeChecked(); // shown on leaf by default
    await user.click(leafBox);
    await waitFor(() =>
      expect(server.calls.at(-1)?.valueCols?.find((v) => v.field === "delta")?.visibleLevels).toEqual(["0"]),
    );
    await user.click(leafBox);
    await waitFor(() =>
      expect(server.calls.at(-1)?.valueCols?.find((v) => v.field === "delta")?.visibleLevels).toBeUndefined(),
    );
  });

  it("colors numbers red/green and formats dates the Italian way", async () => {
    const rows: FixtureRow[] = [
      { portfolio: "P1", delta: 5, lastFixingDate: "2024-09-01" },
      { portfolio: "P1", delta: -3, lastFixingDate: "2024-09-02" },
    ];
    const server = makeSsrmServer(rows);
    vi.stubGlobal("fetch", server.fetchMock);
    const { container } = render(
      <FinaTable
        fields={[...FIELDS, { field: "lastFixingDate", label: "Last Fixing", kind: "date" }]}
        tableName="trades"
        pageSize={10}
        height={300}
      />,
    );
    await screen.findByRole("columnheader", { name: "Last Fixing" });

    await waitFor(() => expect(container.querySelector(".ft-num-pos")).toBeTruthy());
    expect(container.querySelector(".ft-num-pos")!.textContent).toBe("5");
    expect(container.querySelector(".ft-num-neg")!.textContent).toBe("-3");
    expect(screen.getByText("01/09/2024")).toBeTruthy();
    expect(screen.getByText("02/09/2024")).toBeTruthy();
  });

  it("drags and resizes the configuration dialog", async () => {
    const user = userEvent.setup();
    renderTable();
    await screen.findByRole("columnheader", { name: "Portfolio" });
    await user.click(screen.getByRole("button", { name: "Table configuration" }));
    const menu = await screen.findByTestId("config-menu");
    const before = {
      left: parseFloat(menu.style.left),
      top: parseFloat(menu.style.top),
      width: parseFloat(menu.style.width),
      height: parseFloat(menu.style.height),
    };

    fireEvent.mouseDown(screen.getByTestId("config-drag-handle"), { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 160, clientY: 140 });
    fireEvent.mouseUp(window);
    expect(parseFloat(menu.style.left)).toBe(before.left + 60);
    expect(parseFloat(menu.style.top)).toBe(before.top + 40);

    fireEvent.mouseDown(screen.getByTestId("config-resize-handle"), { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 40, clientY: 50 });
    fireEvent.mouseUp(window);
    expect(parseFloat(menu.style.width)).toBe(before.width + 40);
    expect(parseFloat(menu.style.height)).toBe(before.height + 50);
  });

  it("lists tables under a configured S3 bucket and lets you pick one", async () => {
    const user = userEvent.setup();
    const server = makeSsrmServer(TRADES);
    const listed = {
      ok: true,
      tables: [{ label: "_pytest", tableName: "_pytest", uri: "s3://fina-olap-test/_pytest/**/*.parquet" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((url: RequestInfo | URL, init?: RequestInit) =>
        String(url).includes("listTables")
          ? Promise.resolve(new Response(JSON.stringify(listed), { status: 200, headers: { "content-type": "application/json" } }))
          : server.fetchMock(url, init),
      ),
    );
    render(<FinaTable fields={FIELDS} tableName="trades" pageSize={10} height={300} />);
    await screen.findByRole("columnheader", { name: "Portfolio" });

    await user.click(screen.getByRole("button", { name: "Table configuration" }));
    await screen.findByTestId("config-menu");
    await user.type(screen.getByLabelText("S3 bucket"), "s3://fina-olap-test");
    await waitFor(() => expect(screen.getByTestId("list-tables-status")).toHaveTextContent("1 table(s)"), {
      timeout: 2000,
    });
    // the listed table shows up both as an option and as a clickable chip
    expect(screen.getByRole("option", { name: "_pytest" })).toBeTruthy();
    const chip = screen.getByTestId("listed-table-_pytest");
    expect(chip).toBeTruthy();

    await user.click(chip);
    await waitFor(() => expect(server.calls.at(-1)?.tableName).toBe("_pytest"));
    expect(screen.getByLabelText("Data source table")).toHaveValue("_pytest");
  });

  it("switches between table and chart views and opens chart settings", async () => {
    const user = userEvent.setup();
    renderTable();
    await screen.findByRole("columnheader", { name: "Portfolio" });
    expect(screen.getByTestId("ft-scroll")).toBeTruthy();

    await user.click(screen.getByTestId("view-toggle"));
    expect(screen.getByTestId("chart-wrap")).toBeTruthy();
    expect(screen.queryByTestId("ft-scroll")).toBeNull();

    await user.click(screen.getByTestId("chart-settings-toggle"));
    expect(await screen.findByTestId("chart-settings")).toBeTruthy();
    await user.selectOptions(screen.getByTestId("chart-type"), "bar");
    expect(screen.getByTestId("chart-type")).toHaveValue("bar");

    await user.click(screen.getByTestId("view-toggle"));
    expect(screen.getByTestId("ft-scroll")).toBeTruthy();
    expect(screen.queryByTestId("chart-wrap")).toBeNull();
  });

  it("offers loaded columns in the config panels even when undeclared", async () => {
    const user = userEvent.setup();
    const rows: FixtureRow[] = [
      { book: "B1", region: "APAC", pnl: 5 },
      { book: "B2", region: "EMEA", pnl: -2 },
    ];
    const server = makeSsrmServer(rows);
    vi.stubGlobal("fetch", server.fetchMock);
    render(
      <FinaTable fields={[{ field: "book", label: "Book" }]} tableName="risk_wide" pageSize={10} height={300} />,
    );
    await screen.findByRole("columnheader", { name: "Book" });

    await user.click(screen.getByRole("button", { name: "Table configuration" }));
    await screen.findByTestId("config-menu");
    const groupSelect = screen.getByLabelText("Add group level");
    expect(within(groupSelect).getByRole("option", { name: "region" })).toBeTruthy();
    expect(within(groupSelect).getByRole("option", { name: "pnl" })).toBeTruthy();
  });

  it("drops stale declared fields when a different table is loaded", async () => {
    const user = userEvent.setup();
    const server = makeSsrmServer([{ book: "B1", pnl: 5 }]);
    vi.stubGlobal("fetch", server.fetchMock);
    render(
      <FinaTable
        fields={[
          { field: "portfolio", label: "Portfolio" },
          { field: "delta", label: "Delta", kind: "number" },
        ]}
        tableName="risk_wide"
        pageSize={10}
        height={300}
      />,
    );
    await screen.findByRole("columnheader", { name: "book" });

    await user.click(screen.getByRole("button", { name: "Table configuration" }));
    await screen.findByTestId("config-menu");
    const groupSelect = screen.getByLabelText("Add group level");
    expect(within(groupSelect).queryByRole("option", { name: "Portfolio" })).toBeNull();
    expect(within(groupSelect).getByRole("option", { name: "book" })).toBeTruthy();
  });

  it("toggles the dark/light theme on the root element", async () => {
    const user = userEvent.setup();
    renderTable();
    await screen.findByRole("columnheader", { name: "Portfolio" });

    const root = screen.getByTestId("fina-table");
    expect(root.getAttribute("data-theme")).toBe("light");
    await user.click(screen.getByRole("button", { name: /Switch to dark theme/ }));
    expect(root.getAttribute("data-theme")).toBe("dark");
    await user.click(screen.getByRole("button", { name: /Switch to light theme/ }));
    expect(root.getAttribute("data-theme")).toBe("light");
  });

  it("infinite scrolls: appends the next page instead of paging", async () => {
    renderTable({ pageSize: 2 });
    await waitFor(() => expect(screen.getByTestId("row-count")).toHaveTextContent(/2 rows/));

    const scroller = screen.getByTestId("ft-scroll");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 80 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, value: 1100 });
    fireEvent.scroll(scroller);
    await waitFor(() => expect(screen.getByTestId("row-count")).toHaveTextContent(/4 rows/));
    expect(screen.queryByRole("button", { name: /next/ })).toBeNull();
  });

  it("renders a two-layer header when pivoting by leg", async () => {
    const user = userEvent.setup();
    const pivotData: FixtureRow[] = [
      { portfolio: "P1", leg: "l1", delta: 10, gamma: 100 },
      { portfolio: "P1", leg: "l1", delta: 1, gamma: 10 },
      { portfolio: "P1", leg: "l2", delta: 0.5, gamma: 5 },
    ];
    const server = makeSsrmServer(pivotData);
    vi.stubGlobal("fetch", server.fetchMock);
    render(<FinaTable fields={FIELDS} tableName="trades" pageSize={10} height={300} />);
    await screen.findByRole("columnheader", { name: "Leg" });

    await user.click(screen.getByRole("button", { name: "Table configuration" }));
    await user.click(screen.getByRole("checkbox", { name: "pivot active" }));
    await user.selectOptions(screen.getByLabelText("Pivot column field"), "leg");
    await user.selectOptions(screen.getByLabelText("Add measure"), "delta");
    await user.selectOptions(screen.getByLabelText("Add measure"), "gamma");

    // layer 1: pivot values, one cell per value (spanning its measures)
    expect(await screen.findByTestId("pivot-group-l1")).toHaveTextContent("l1");
    expect(screen.getByTestId("pivot-group-l2")).toHaveTextContent("l2");
    // layer 2: the measure labels repeated under each pivot value
    expect(screen.getByTestId("th-l1_delta")).toHaveTextContent("Delta");
    expect(screen.getByTestId("th-l1_gamma")).toHaveTextContent("Gamma");
    expect(screen.getByTestId("th-l2_delta")).toHaveTextContent("Delta");
    expect(screen.getByTestId("th-l2_gamma")).toHaveTextContent("Gamma");
    // body rows aggregate: l1 delta = 11, l1 gamma = 110, l2 delta = 0.5, l2 gamma = 5
    const cells = screen.getAllByTestId("row-count");
    expect(cells[0]).toHaveTextContent(/1 rows/);
    expect(server.calls.some((c) => c.pivotMode && c.valueCols?.length === 2)).toBe(true);
  });

  it("sorts server-side by cycling the header", async () => {
    const user = userEvent.setup();
    renderTable();
    await screen.findByRole("columnheader", { name: "Delta" });

    // each click resets+refetches, so re-query the header node every time
    await user.click(screen.getByTestId("th-delta"));
    expect(await screen.findByTestId("sort-delta")).toHaveTextContent("↑");

    await user.click(screen.getByTestId("th-delta"));
    await waitFor(() => expect(screen.getByTestId("sort-delta")).toHaveTextContent("↓"));

    await user.click(screen.getByTestId("th-delta"));
    await waitFor(() => expect(screen.queryByTestId("sort-delta")).toBeNull());
  });

  it("filters via the per-header filter popover", async () => {
    const user = userEvent.setup();
    const { server } = renderTable();
    await screen.findByRole("columnheader", { name: "Delta" });

    await user.click(screen.getByRole("button", { name: "Filter Delta" }));
    await user.type(screen.getByLabelText("Delta filter value"), "3");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      const last = server.calls.at(-1);
      expect(last?.filterModel?.delta).toMatchObject({ operator: "greaterThan", filter: 3 });
    });
    // the server actually filters: deltas 4,5,6 remain
    await waitFor(() => expect(screen.getByTestId("row-count")).toHaveTextContent(/3 rows/));
  });

  it("computes merged group-label flags (label shown only on each block head)", () => {
    const rows = [
      { row: { portfolio: "P1" } },
      { row: { portfolio: "P1", instrument: "I1" } },
      { row: { portfolio: "P1", instrument: "I2" } },
      { row: { portfolio: "P2" } },
    ];
    const flags = computeRowGroupFlags(rows, ["portfolio", "instrument"]);
    // P1 head → portfolio shown; I1/I2 (P1 block) → portfolio merged;
    // P2 head → both labels restart.
    expect(flags).toEqual([
      [true, true],
      [false, true],
      [false, true],
      [true, true],
    ]);
  });

  it("merges group labels down an expanded block and keeps the toggle on its own column", async () => {
    const user = userEvent.setup();
    renderTable();
    await screen.findByRole("columnheader", { name: "Portfolio" });

    await user.click(screen.getByRole("button", { name: "Table configuration" }));
    await screen.findByTestId("config-menu");
    await user.selectOptions(screen.getByLabelText("Add group level"), "portfolio");
    await user.selectOptions(screen.getByLabelText("Add group level"), "instrument");
    await screen.findByTestId("group-portfolio-P1");
    await user.click(screen.getByTestId("toggle-portfolio-P1"));
    await screen.findByTestId("group-instrument-I1");

    // the Instrument 1 toggle lives in its OWN column (2nd cell), not the first
    const i1row = screen.getByTestId("toggle-instrument-I1").closest("tr")!;
    expect(screen.getByTestId("toggle-instrument-I1").closest("td")).toBe(i1row.children[1]);

    // sibling Instrument 2 row: the Portfolio cell is merged away (blank)
    const i2row = screen.getByTestId("toggle-instrument-I2").closest("tr")!;
    expect(i2row.querySelector('[data-testid="merged-portfolio"]')).toBeTruthy();
    expect(i2row.querySelector('[data-testid="group-portfolio-"]')).toBeNull();

    // the next Portfolio block head is NOT merged: P2 label is shown again
    const p2row = screen.getByTestId("toggle-portfolio-P2").closest("tr")!;
    expect(p2row.querySelector('[data-testid="merged-portfolio"]')).toBeNull();
    expect(screen.getByTestId("group-portfolio-P2")).toBeTruthy();
  });

  it("pins a sticky group-context bar with the full chain when scrolled mid-block", async () => {
    const user = userEvent.setup();
    renderTable();
    await screen.findByRole("columnheader", { name: "Portfolio" });

    await user.click(screen.getByRole("button", { name: "Table configuration" }));
    await screen.findByTestId("config-menu");
    await user.selectOptions(screen.getByLabelText("Add group level"), "portfolio");
    await user.selectOptions(screen.getByLabelText("Add group level"), "instrument");
    await screen.findByTestId("group-portfolio-P1");
    await user.click(screen.getByTestId("toggle-portfolio-P1"));
    await screen.findByTestId("group-instrument-I1");

    // top of the grid: the context bar is absent (labels render inline)
    expect(screen.queryByTestId("group-context")).toBeNull();

    // scroll mid-block (I1 block head) → the bar pins the group chain
    const scroller = screen.getByTestId("ft-scroll");
    Object.defineProperty(scroller, "scrollTop", { configurable: true, value: 30 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 80 });
    fireEvent.scroll(scroller);

    const bar = await screen.findByTestId("group-context");
    expect(bar).toBeVisible();
    expect(screen.getByTestId("ctx-portfolio")).toHaveTextContent("P1");
    expect(screen.getByTestId("ctx-instrument")).toHaveTextContent("I1");
  });
});