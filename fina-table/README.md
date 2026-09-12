# fina-table

Self-contained React grid for **ag-grid Server-Side Row Model (SSRM)** OLAP
engines — specifically the [fina-olap](https://pypi.org/project/fina-olap)
Python server that compiles SSRM payloads into DuckDB SQL over parquet.

Everything is server-controlled: the client sends SSRM requests (`startRow`/
`endRow`, row-group columns, group keys for the drill path, value columns with
per-level aggregations, pivot columns, filters, sorting) and renders the row
horizon the server returns.

No external UI framework is required — styles ship inside the bundle (tsup
`injectStyle`), so there is nothing to import besides the component.

## Why

- **Server-driven OLAP.** Aggregations run inside DuckDB, so the browser never
  downloads raw leaves. Grouping levels and per-level aggregation overrides
  (`aggFuncsByLevel`) are plain request fields.
- **Infinite scroll (no pager).** The grid pages off the end of the scroll
  container. Because rows below an expanded group belong to their own blocks
  on the page, sub-group rows spanning a page boundary render inline — the
  group tree is not clipped by page one.
- **Remembered grouping.** Expanding and collapsing groups mutates a stable
  group tree that survives refetches (sort/filter/spec changes); a
  `collapse all` resets it. There is no legacy drill/rollUp navigation.
- **Theme.** Light and dark modes via a toolbar toggle (CSS custom properties
  on `data-theme`).
- **Interoperable.** Sends the same SSRM wire format ag-grid uses, so fina-table
  can talk to any compatible server (fina-olap or otherwise).

## Install

```bash
npm install fina-table react
```

## Usage

```tsx
import { FinaTable, type FieldDefinition } from "fina-table";

const fields: FieldDefinition[] = [
  { field: "portfolio", label: "Portfolio" },
  { field: "instrument", label: "Instrument" },
  { field: "leg", label: "Leg" },
  { field: "delta", label: "Delta", kind: "number" },
];

export function Dashboard() {
  return (
    <FinaTable
      endpoint="/api/getRows"
      tableName="trades"
      fields={fields}
      pageSize={50}
      height="62vh"
      title="Trades"
    />
  );
}
```

The left-corner config dropdown holds four self-contained panels:

- **Data sources** — pick the table the grid queries.
- **Row group** — add ordered grouping levels (portfolio / instrument / …);
  group rows aggregate their children and expand in place, remembering the
  tree while you scroll.
- **Pivot column** — pivot on a field.
- **Value column** — add measures (e.g. Delta) with a default aggregation and
  optional per-level overrides (`aggFuncsByLevel`).

Headers support server-side sorting (asc → desc → none on click) and column
filters. The footer shows the loaded row count; with more rows pending it
reads `scrolling loads more…`.

## API

- `FinaTable` — the ready-made grid (toolbar, config dropdown, sort/filter
  headers, group rows, infinite scroll, theme toggle).
  Props: `endpoint`, `tableName`, `fields` (`FieldDefinition[]`), `pageSize`,
  `height`, `title`, `sources` (`SourceOption[]`), `headerActions`,
  `showConfig`.
- `useSSRM` — headless hook exposing:
  - `spec` / `setSpec` / `refresh` — the OLAP spec and its reducer;
  - `columns`, `blocks` (block store keyed by drill path), `expandedGroups`,
    `displayRows` (flattened tree rows with `isGroup`, `depth`, `expanded`,
    `nodeKey`);
  - `hasMore` / `loadMore` (infinite scroll), `toggleGroup(nodeKey)` /
    `collapseAll()` (stable group tree);
  - `rows`, `lastRow`, `request`, `loading`, `error`, `pageSize`.
- `fetchRows` / `datasource` — thin POST client (endpoint, abort, errors);
  `makeSsrmRequestBuilder` etc. live in `request`.
- `types` — the full SSRM wire types incl. OLAP extensions.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run test:run    # vitest (duck fixtures at tests/fake-server.ts)
npm run build       # tsup -> dist (esm + cjs + d.ts + d.cts, CSS injected)
```

## License

MIT