# fina-olap

ag-grid server-side row model (SSRM) OLAP engine over Parquet, DuckDB-powered.

`fina-olap` turns a (nearly) stock ag-grid SSRM request — row groups, group keys,
pivots, value columns, sorting, filtering, pagination — into a single DuckDB SQL
query over a Parquet store on S3 / GCS / local disk, and returns rows with the
exact SSRM contract (`rows`, `lastRow`, `pivotResultFields`, ...). It ships three
surfaces backed by the same engine:

| Surface | Where | Typical use |
| --- | --- | --- |
| **REST SSRM** | `POST /api/getRows`, `POST /api/getSchema`, `GET /api/health` | ag-grid SSRM datasource (`fina-table`) |
| **MCP v2** | stdio (`fina-olap-mcp`) or Streamable HTTP (`/mcp`, Vercel) | agents generating fixtures, inspecting schemas, ad-hoc OLAP |
| **CLI** | `fina-olap` | serve HTTP, run stdio MCP, generate fixtures, run a payload |

## OLAP extensions

Beyond the stock ag-grid model, `fina-olap` supports level-aware analytics used
by `fina-table`:

- **Custom grouping level** — `valueCols[].aggFuncsByLevel` selects the
  aggregation per grouping depth: `{"leg": "first"}` (keyed by level column),
  `{"0": "avg"}` (keyed by 0-based level index) or `["sum", null, "avg"]`.
- **Per-level metric visibility** — `valueCols[].visibleLevels` (e.g. `[0]`)
  suppresses a metric at levels not listed: aggregated group levels render
  `NULL`, and fully-drilled leaf rows omit the column (`SELECT * EXCLUDE (...)`)
  so a measure can be hidden on raw leaves while remaining aggregate-only.
- **Grand total** — `includeGrandTotal: true` prepends a leading row with all
  group keys `NULL` and an aggregate per measure over all filtered records.
  `grandTotalAggFunc` selects that aggregate (default `"sum"`); it is independent
  of `aggFuncsByLevel` / `visibleLevels`, so `"none"` at a grouping level never
  blanks the grand total.
- **LOD configuration** — `lodConfig { type: fixed|include|exclude, groupKeys,
  metrics: {measure: fn}, prefix }` joins a secondary level-of-detail aggregate
  (a tableau-style LOD expression) onto every row via a `LEFT JOIN` on the
  dimension columns, so each row can compare `sum(delta)` against
  portfolio-level `_lod_delta`.

## Quick start

```bash
uv sync
uv run fina-olap --http --port 8000          # SSRM REST + MCP HTTP on one port
uv run fina-olap-mcp                          # MCP stdio tool server
curl -X POST localhost:8000/api/getRows \
  -H 'content-type: application/json' \
  -d '{"rowGroupCols":[{"id":"p","field":"portfolio"}],
       "valueCols":[{"id":"d","aggFunc":"sum","field":"delta"}],
       "groupKeys":[]}'
```

With no Parquet configured, requests run against a deterministic sample fixture
(`data/sample.parquet`, generated on first use / via `fina-olap gen-fixture`).

## Data sources

The backing store is selected by the `FINA_OLAP_STORE` switch (`local` | `s3` |
`gcs` | `auto`), and the Parquet partition layout by `FINA_OLAP_PARTITION_GLOB`
+ `FINA_OLAP_HIVE_PARTITIONING`. Resolution order for the Parquet backing:

1. `dataSource.uri` — explicit `s3://`, `gs://`, or local path
2. `dataSource.bucket` / `path(glob)` — bucket-constructed source
3. `FINA_OLAP_STORE=s3|gcs` (forced) — `S3_PATH_TEMPLATE`, or
   `FINA_OLAP_BUCKET` (+ `FINA_OLAP_PATH`) and the partition glob. Fails loudly
   when the store is unconfigured — no silent fixture fallback.
4. `FINA_OLAP_STORE=local` (forced) — `FINA_OLAP_PARQUET_ROOT` (aliases
   `OLAP_PARQUET_ROOT` / `DATA_DIR`) + partition glob, then the generated fixture.
5. `auto` (default) — legacy cascade: template → local root → generated fixture
   (`FINA_OLAP_FIXTURE`, default `data/sample.parquet`).

Partition configuration:

- `FINA_OLAP_PARTITION_GLOB` — on-store layout with `{tableName}` templating,
  e.g. `{tableName}/region=*/date=*/*.parquet`. Default: `{tableName}*.parquet`
  (flat files directly under the root).
- `FINA_OLAP_HIVE_PARTITIONING` — `1|0`; when enabled, DuckDB exposes hive
  partition columns (`region`, `date`, …) as normal columns. Default: on for
  `s3`/`gcs`, off for local; may be overridden via `dataSource.hivePartitioning`
  per payload.

Remote stores use DuckDB `httpfs` with an S3-compatible secret (GCS via
`S3_API_KEY`/`S3_API_SECRET` or AWS via `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`
+ `AWS_ENDPOINT_URL`), configured automatically when store env vars are present.
`GET /api/health` (and the MCP `status` tool) report the active store config.

### Runtime store configuration (MCP tools)

The same settings can be switched at runtime via MCP tools, so a UI can point
the engine at a different store without a restart. Overrides layer on top of
the env base and reset with `clear=true` (env vars stay the process default):

- `store_config` — read the effective config (fields + which are overridden).
- `store_configure` — set `store`, `parquet_root`, `bucket`, `path`,
  `partition_glob`, `hive_partitioning`; `clear=true` resets all overrides.
- `store_resolve` — preview how a table resolves (`source`, hive flag,
  partition columns) under the current config.

### Upsert (CSV / JSON / Parquet → store)

`upsert_store(table_name, key, rows[, file_path][, data_format][, appender][, chunk_size])`
merges rows (or a CSV/JSON/Parquet file) into the store's Parquet layout. `key`
is a column or comma-separated columns that identify a stored row: matching keys
update, unknown keys insert, and the full store is rewritten in place — flat
files are replaced atomically (temp + rename), hive-partitioned stores are
rewritten with `COPY ... PARTITION_BY`. The target table is created if absent.
Return value reports before/after row counts, matched/inserted split, the
written location, writer used and the resulting schema. Error cases: no key /
missing key column / unsupported `data_format` / incoming file missing a target
key column.

Appender mode: pass `appender=true` to switch the flat-store write from DuckDB
`COPY` to an Arrow `ParquetWriter` (pyarrow); each `write_table` call appends one
row group, and `chunk_size` splits the merged result so it is written chunk by
chunk (result reports `row_groups`). Appender mode requires a flat local store —
it is rejected for hive-partitioned globs and object-store targets.

### Export (store → CSV / JSON / JSONL / Parquet)

`store_export(table_name, out_path[, data_format][, columns][, filters][, limit])`
dumps a table through the same read path an SSRM query uses (`resolve_source` +
hive columns), applies the same ag-grid `filterModel` semantics as the live
query builder (so an export matches what the grid shows), then streams out via
DuckDB `COPY`:

- `csv` → `(FORMAT CSV, HEADER)`
- `json` → `(FORMAT JSON, ARRAY true)` — a JSON array of objects
- `jsonl`/`ndjson` → `(FORMAT JSON)` — one object per line
- `parquet` → a single Parquet file

`data_format` overrides extension sniffing on `out_path`; `columns` is a
comma-separated subset; `filters` is the ag-grid `filterModel` (text / number /
date / set / combined AND-OR conditions); `limit` caps the rows. Returns the
written path, format, exported row count and column list.

## Deployment

Vercel serverless: the function in `api/index.py` serves both `/api/*` (SSRM
REST, passthrough) and `/mcp` (rewritten to `/api/mcp`, restored to `/mcp` for
the FastAPI mount). Local: `uv run fina-olap --http` exposes `/api/*` and `/mcp`
on the same port.

## Tests

```bash
uv run pytest            # builder SQL * engine E2E * schema * HTTP * MCP stdio
```

## Repo layout

```
api/                  Vercel ASGI adapter
src/fina_olap/        sdist/wheel (PyPI: fina-olap)
  builder.py          SSRM -> DuckDB SQL compiler
  engine.py           source resolution + query execution
  schema.py           pydantic SSRM request/response model
  fixture.py          deterministic sample parquet generator
  gcs.py              DuckDB httpfs object-store configuration
  mcp_server.py       FastMCP stdio + Streamable HTTP tools
  server.py           FastAPI app (REST + /mcp mount)
  vercel.py           Vercel path-rewrite ASGI wrapper
fina-table/           React headless table lib (separate npm package)
demo/                 Next.js sample app using fina-table
```