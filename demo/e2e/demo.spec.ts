import { expect, test, type Page } from "@playwright/test";

/**
 * Full-stack smoke tests: browser -> Next rewrite -> uvicorn -> DuckDB over
 * the real generated fixture. Guards the client<->server SSRM contract that
 * neither vitest (fake server) nor pytest (no browser) exercises.
 */

test("loads the demo with live fixture rows", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /fina-olap/ })).toBeVisible();
  await expect(page.getByText(/api: .* rows @/)).toBeVisible();
  await expect(page.getByTestId("th-portfolio")).toBeVisible();
  await expect(page.getByTestId("th-notional")).toBeVisible();
  await expect(page.getByTestId("row-count")).toContainText("rows");
});

test("opens the 4-panel config dropdown and closes it with Escape", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Table configuration" }).click();
  const dialog = page.getByRole("dialog", { name: "Table configuration" });
  await expect(dialog).toBeVisible();
  for (const title of ["Data sources", "Row group", "Pivot column", "Value column"]) {
    await expect(dialog.getByText(title, { exact: true }).nth(0)).toBeVisible();
  }
  await expect(dialog.getByLabel("Add group level")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
});

test("groups by portfolio and instrument and expands the group tree inline", async ({ page }) => {
  await page.goto("/");
  await openConfig(page);

  await select(page, "Add group level", "portfolio");
  await select(page, "Add group level", "instrument");

  const p1 = page.getByRole("treeitem", { name: "Expand Portfolio Portfolio 1", exact: true });
  await expect(p1).toBeVisible();

  await p1.click();
  const i1 = page.getByRole("treeitem", { name: "Expand Instrument Instrument 1", exact: true });
  await expect(i1).toBeVisible();

  await i1.click();
  await expect(page.getByRole("treeitem", { name: "Collapse Instrument Instrument 1", exact: true })).toBeVisible();
  await expect(page.getByText("2 group(s) expanded")).toBeVisible();

  await page.getByRole("button", { name: "collapse all" }).click();
  await expect(page.getByText("2 group(s) expanded")).toBeHidden();
});

test("adds a delta measure and shows per-group aggregates", async ({ page }) => {
  await page.goto("/");
  await openConfig(page);

  await select(page, "Add group level", "portfolio");
  await select(page, "Add measure", "delta");

  await expect(page.getByTestId("th-delta")).toBeVisible();
  const p1 = page.getByRole("treeitem", { name: /Expand Portfolio Portfolio/ });
  await expect(p1.first()).toBeVisible();
});

test("sorts server-side by clicking a header", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("th-delta").click();
  await expect(page.getByTestId("sort-delta")).toHaveText("↑");
  await page.getByTestId("th-delta").click();
  await expect(page.getByTestId("sort-delta")).toHaveText("↓");
  await page.getByTestId("th-delta").click();
  await expect(page.getByTestId("sort-delta")).toBeHidden();
});

test("infinite scrolls: scrolling the container appends more rows", async ({ page }) => {
  await page.goto("/");
  const count = page.getByTestId("row-count");
  await expect(count).toHaveText(/^\d+ rows/);
  const before = await count.textContent();

  const scroller = page.getByTestId("ft-scroll");
  await expect.poll(async () => {
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    return count.textContent();
  }).not.toBe(before);
});

test("pivots by leg into a two-layer header", async ({ page }) => {
  await page.goto("/");
  await openConfig(page);

  await page.getByRole("checkbox", { name: "pivot active" }).check();
  await select(page, "Pivot column field", "leg");
  await select(page, "Add measure", "delta");
  await select(page, "Add measure", "gamma");

  // layer 1: pivot values funding / note / put
  for (const v of ["funding", "note", "put"]) {
    await expect(page.getByTestId(`pivot-group-${v}`)).toBeVisible();
  }
  // layer 2: the measure labels repeated under each pivot value
  for (const v of ["funding", "note", "put"]) {
    await expect(page.getByTestId(`th-${v}_delta`)).toHaveText("Delta");
    await expect(page.getByTestId(`th-${v}_gamma`)).toHaveText("Gamma");
  }
  await expect(page.getByText("pivot: leg")).toBeVisible();
  await expect(page.getByTestId("row-count")).toContainText("rows");
});

test("merges group labels down expanded blocks and pins a full-chain context bar", async ({ page }) => {
  await page.goto("/");
  await openConfig(page);

  await select(page, "Add group level", "portfolio");
  await select(page, "Add group level", "instrument");

  // Portfolio 1 → Instrument 1 → legs (leaf rows)
  const p1 = page.getByRole("treeitem", { name: "Expand Portfolio Portfolio 1", exact: true });
  await p1.click();
  const i1 = page.getByRole("treeitem", { name: "Expand Instrument Instrument 1", exact: true });
  await expect(i1).toBeVisible();
  await i1.click();
  await expect(page.getByTestId("row-count")).toHaveText(/^\d+ rows/);

  // the Instrument 1 toggle sits in its OWN column (2nd cell), not the first
  const i1Toggle = page.getByTestId("toggle-instrument-Instrument_1");
  await expect(i1Toggle).toHaveCount(1);
  const ownCol = await page.evaluate(() => {
    const btn = document.querySelector("[data-testid^=toggle-instrument-]");
    if (!btn) return null;
    const td = btn.closest("td");
    return td ? [...td.parentElement!.children].indexOf(td) : null;
  });
  expect(ownCol).toBe(1);

  // leg rows under Instrument 1 merge their Portfolio AND Instrument cells
  const firstMergedInstrument = page.locator("[data-testid=merged-instrument]").first();
  await expect(firstMergedInstrument).toBeVisible();
  const legRowsBlanks = await page.locator("[data-testid=merged-instrument]").count();
  expect(legRowsBlanks).toBeGreaterThan(0);
  const firstLegRow = firstMergedInstrument.locator("..");
  await expect(firstLegRow.locator("[data-testid=merged-portfolio]")).toHaveCount(1);

  // at the top of the grid the context bar is hidden (labels render inline)
  await expect(page.getByTestId("group-context")).toHaveCount(0);

  // scroll mid-block → a sticky bar pins the FULL group chain
  const scroller = page.getByTestId("ft-scroll");
  const rh = await page.locator("tbody tr:not(.ft-ctx-row)").first().evaluate((el) => el.getBoundingClientRect().height);
  await scroller.evaluate((el, y) => {
    el.scrollTop = y;
  }, Math.round(rh) * 2);

  const bar = page.getByTestId("group-context");
  await expect(bar).toBeVisible();
  await expect(page.getByTestId("ctx-portfolio")).toHaveText("Portfolio 1");
  await expect(page.getByTestId("ctx-instrument")).toHaveText("Instrument 1");
  const sticky = await bar.evaluate((el) => getComputedStyle(el).position);
  expect(sticky).toBe("sticky");

  // back at the top the inline labels are sufficient again
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.getByTestId("group-context")).toHaveCount(0);
});

test("shows a grand total over all records with its own aggregation", async ({ page }) => {
  await page.goto("/");
  await openConfig(page);

  await select(page, "Add group level", "portfolio");
  await select(page, "Add group level", "instrument");
  await select(page, "Add measure", "delta");

  // "none" at BOTH grouping levels must not blank the grand total
  await page.getByLabel("Aggregation at level portfolio for delta").selectOption("none");
  await page.getByLabel("Aggregation at level instrument for delta").selectOption("none");

  // expose and turn on the grand total; its aggregation defaults to sum
  await page.getByTestId("grand-total-toggle").check();
  await expect(page.getByLabel("Grand total aggregation")).toHaveValue("sum");
  await page.getByRole("dialog", { name: "Table configuration" }).getByRole("button", { name: "Close" }).click();

  const gt = page.getByTestId("grand-total-row");
  await expect(gt).toBeVisible();
  await expect(page.getByTestId("grand-total-label")).toHaveText("Grand Total");
  const gtDelta = () => gt.locator("td").nth(2).textContent().then((t) => Number((t ?? "").replace(/,/g, "")));
  const sumDelta = await gtDelta();
  expect(sumDelta).toBeGreaterThan(0);

  // the grand-total aggregation is independent: switching to avg changes the value
  await openConfig(page);
  await page.getByLabel("Grand total aggregation").selectOption("avg");
  await page.getByRole("dialog", { name: "Table configuration" }).getByRole("button", { name: "Close" }).click();
  await expect(gt).toBeVisible();
  const avgDelta = await gtDelta();
  expect(avgDelta).toBeGreaterThan(0);
  expect(avgDelta).toBeLessThan(sumDelta); // avg < sum for thousands of positive deltas

  // expand P1 -> I1: the instrument row suppresses delta, its leg leaves do not
  await page.getByRole("treeitem", { name: "Expand Portfolio Portfolio 1", exact: true }).click();
  const i1 = page.getByRole("treeitem", { name: "Expand Instrument Instrument 1", exact: true });
  await expect(i1).toBeVisible();
  await expect(i1.locator("xpath=ancestor::tr").locator("td").nth(2)).toHaveText("—");

  await i1.click();
  const firstLeaf = page.locator("[data-testid=merged-instrument]").first().locator("..");
  await expect(firstLeaf.locator("td").nth(2)).not.toHaveText("—");
});

test("hides a measure on raw leaf rows when 'show on leaf' is off", async ({ page }) => {
  await page.goto("/");
  await openConfig(page);

  await select(page, "Add group level", "portfolio");
  await select(page, "Add group level", "instrument");
  await select(page, "Add measure", "delta");

  // measures are shown on leaf rows by default
  const leafBox = page.getByLabel("Show delta on leaf rows");
  await expect(leafBox).toBeChecked();
  await leafBox.uncheck();
  await page.getByRole("dialog", { name: "Table configuration" }).getByRole("button", { name: "Close" }).click();

  // grouped rows still aggregate the measure…
  await page.getByRole("treeitem", { name: "Expand Portfolio Portfolio 1", exact: true }).click();
  const i1 = page.getByRole("treeitem", { name: "Expand Instrument Instrument 1", exact: true });
  await expect(i1).toBeVisible();
  await expect(i1.locator("xpath=ancestor::tr").locator("td").nth(2)).not.toHaveText("—");

  // …but the raw leaf (leg) rows no longer render it
  await i1.click();
  const firstLeaf = page.locator("[data-testid=merged-instrument]").first().locator("..");
  await expect(firstLeaf.locator("td").nth(2)).toHaveText("—");
});

test("filters server-side via the per-header filter popover", async ({ page }) => {
  await page.goto("/");
  const count = page.getByTestId("row-count");
  await expect(count).toHaveText(/^[1-9]\d* rows/);
  const before = await count.textContent();

  // hover the header to reveal the (opacity-0 until hover) filter trigger
  await page.getByTestId("th-delta").hover();
  await page.getByRole("button", { name: "Filter Delta" }).click();
  await page.getByLabel("Delta filter value").fill("1000000");
  await page.getByRole("button", { name: "Apply" }).click();

  // the filter is active and the server returns zero rows
  await expect(page.getByRole("button", { name: "Filter Delta" })).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("grid-empty")).toBeVisible();
  await expect(count).toHaveText(/0 rows/);

  // clearing restores the rows
  await page.getByTestId("th-delta").hover();
  await page.getByRole("button", { name: "Filter Delta" }).click();
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByTestId("grid-empty")).toBeHidden();
  await expect.poll(async () => (await count.textContent()) !== "0 rows").toBe(true);
  expect(await count.textContent()).toBe(before);
});

test("drags and resizes the table configuration dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await openConfig(page);
  const menu = page.getByTestId("config-menu");
  const box1 = (await menu.boundingBox())!;
  expect(box1).toBeTruthy();

  // resize from the bottom-right handle
  const handle = (await page.getByTestId("config-resize-handle").boundingBox())!;
  const rx = handle.x + handle.width / 2;
  const ry = handle.y + handle.height / 2;
  await page.getByTestId("config-resize-handle").dispatchEvent("mousedown", { clientX: rx, clientY: ry, bubbles: true });
  await page.mouse.move(rx + 80, ry + 60, { steps: 6 });
  await page.mouse.up();
  const box2 = (await menu.boundingBox())!;
  expect(box2.width).toBeGreaterThan(box1.width + 30);
  expect(box2.height).toBeGreaterThan(box1.height + 20);

  // drag the header horizontally
  const header = (await page.getByTestId("config-drag-handle").boundingBox())!;
  const hx = header.x + header.width / 2;
  const hy = header.y + header.height / 2;
  await page.getByTestId("config-drag-handle").dispatchEvent("mousedown", { clientX: hx, clientY: hy, bubbles: true });
  await page.mouse.move(hx + 120, hy, { steps: 6 });
  await page.mouse.up();
  const box3 = (await menu.boundingBox())!;
  expect(box3.x).toBeGreaterThan(box2.x + 60);
  expect(box3.y).toBe(box2.y);
});

test("opens the per-measure format card and formats a column as currency", async ({ page }) => {
  await page.goto("/");
  await openConfig(page);
  await select(page, "Add group level", "portfolio");
  await select(page, "Add measure", "delta");

  await page.getByTestId("value-card-toggle-delta").click();
  await expect(page.getByTestId("value-card-body-delta")).toBeVisible();
  await page.getByLabel("Format type for delta").selectOption("currency");
  await page.getByLabel("Currency for delta").fill("USD");
  await page.getByLabel("Bold delta").check();
  await page.getByRole("dialog", { name: "Table configuration" }).getByRole("button", { name: "Close" }).click();

  // aggregated delta cells now render as currency
  await expect(page.locator(".ft-tr-group .ft-td").filter({ hasText: "$" }).first()).toBeVisible();
});

test("switches to chart view and configures its axes", async ({ page }) => {
  await page.goto("/");
  await openConfig(page);
  await select(page, "Add group level", "portfolio");
  await page.getByRole("dialog", { name: "Table configuration" }).getByRole("button", { name: "Close" }).click();

  await page.getByTestId("view-toggle").click();
  await expect(page.getByTestId("chart-wrap")).toBeVisible();
  await expect(page.getByTestId("chart-view").locator("canvas").first()).toBeVisible();
  await expect(page.getByTestId("ft-scroll")).toHaveCount(0);

  await page.getByTestId("chart-settings-toggle").click();
  await expect(page.getByTestId("chart-settings")).toBeVisible();
  await page.getByTestId("chart-type").selectOption("bar");
  await page.getByTestId("chart-category").selectOption("portfolio");
  await expect(page.getByTestId("chart-view").locator("canvas").first()).toBeVisible();
  await page.getByLabel("Smooth lines").check();

  // back to the table
  await page.getByTestId("view-toggle").click();
  await expect(page.getByTestId("ft-scroll")).toBeVisible();
  await expect(page.getByTestId("chart-wrap")).toHaveCount(0);
});

test("proxies /api/listTables through Next without a 404", async ({ page }) => {
  await page.goto("/");
  if (!(await objectStoreConfigured(page))) {
    test.skip(true, "no object store configured in this environment");
  }
  await openConfig(page);
  await page.getByLabel("S3 bucket").fill("s3://fina-olap-test");
  const status = page.getByTestId("list-tables-status");
  // wait for the debounced listing to finish (either a count or a real error)
  await expect(status).toContainText(/table\(s\)|error:/, { timeout: 20000 });
  await expect(status).not.toContainText("<!DOCTYPE");
  await expect(status).not.toContainText("404");

  // the listed table is exposed as an option and a clickable chip
  const select = page.getByLabel("Data source table");
  await expect(select.locator("option", { hasText: "_pytest" })).toHaveCount(1, { timeout: 20000 });
  // discovered names must be valid SSRM table identifiers (no "k=v" hive segments)
  for (const text of await select.locator("option").allTextContents()) {
    if (text.endsWith("(custom)")) continue;
    expect(text).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  }
  const chip = page.getByTestId("listed-table-_pytest");
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.locator(".ft-badge strong").first()).toHaveText("_pytest");
});

test("loads parquet from a local filesystem path", async ({ page }) => {
  await page.goto("/");
  // first query generates the fixture at <repo>/data/sample.parquet
  await expect(page.getByTestId("row-count")).toContainText("rows");
  await openConfig(page);
  await page.getByLabel("Local path or file URI").fill("data");
  await expect(page.getByTestId("listed-table-sample")).toBeVisible({ timeout: 20000 });
  await page.getByTestId("listed-table-sample").click();
  await expect(page.locator(".ft-badge strong").first()).toHaveText("sample");
});

async function openConfig(page: Page) {
  const btn = page.getByRole("button", { name: "Table configuration" });
  await btn.click();
  await expect(page.getByRole("dialog", { name: "Table configuration" })).toBeVisible();
}

async function select(page: Page, label: string, value: string) {
  await page.getByLabel(label).selectOption(value);
}

/** True when the backend has real object-store credentials (e.g. AWS in CI). */
async function objectStoreConfigured(page: Page): Promise<boolean> {
  const res = await page.request.get(`${new URL("/", page.url()).origin}/api/health`);
  const body = (await res.json()) as { object_store?: { configured?: boolean } };
  return body.object_store?.configured === true;
}