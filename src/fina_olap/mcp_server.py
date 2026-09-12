"""fina-olap MCP v2 tool server: stdio + Streamable HTTP.

Tools wrap the same ``OlapEngine`` behind the HTTP GET / POST routes so a
client can either query the engine through the REST SSRM endpoint or through
MCP tools (e.g. to prepare fixture data, inspect schemas, or run ad-hoc OLAP
questions from an agent).

Run locally:   ``fina-olap-mcp``            (stdio)
Expose HTTP:   ``fina-olap --http 0.0.0.0:8000``   → ``/mcp`` Streamable HTTP + ``/api/*`` SSRM
Or import:     ``app = fina_olap.mcp_server.app`` (Starlette, for Vercel)
"""

from __future__ import annotations

import os
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.responses import JSONResponse

from .engine import DEFAULT_ROW_COUNT, DEFAULT_TABLE, OlapEngine, hive_for, resolve_source
from .export import export_store as export_from_store
from .fixture import summary
from .gcs import load_local_env, object_store_status
from .schema import SSRMRequest
from .storage import (
    ALLOWED_STORES,
    clear_storage_override,
    get_storage_config,
    set_storage_override,
    storage_overrides,
    storage_status,
)
from .upsert import partition_columns
from .upsert import upsert_store as upsert_into_store

load_local_env()

allowed_hosts = [
    host.strip()
    for host in os.getenv(
        "ALLOWED_HOSTS",
        "localhost,127.0.0.1,[::1],localhost:*,127.0.0.1:*,[::1]:*,fina-olap.vercel.app,fina-olap.vercel.app:*",
    ).split(",")
    if host.strip()
]

mcp = FastMCP(
    "fina-olap",
    stateless_http=True,
    transport_security=TransportSecuritySettings(allowed_hosts=allowed_hosts),
)

_engine = OlapEngine()


@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(_request: Any) -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "service": "fina-olap",
            "store": storage_status(),
            "object_store": object_store_status(),
            "fixture": summary(os.getenv("FINA_OLAP_FIXTURE", "data/sample.parquet")),
        }
    )


@mcp.tool()
def generate_fixture(row_count: int = DEFAULT_ROW_COUNT) -> dict[str, Any]:
    """Generate (or refresh) the deterministic sample OLAP parquet fixture used as the default SSRM data store."""
    path = _engine.ensure_default_fixture(row_count)
    return {"path": str(path), **summary(path)}


@mcp.tool()
def dataset_schema(payload: dict[str, Any]) -> dict[str, Any]:
    """Return the DESCRIBE schema (name, type, numeric) of the table a payload will query."""
    request = SSRMRequest.model_validate(payload)
    columns = _engine.schema_for(request)
    return {"table": request.tableName or "trades", "columns": columns}


@mcp.tool()
def list_datasets() -> list[dict[str, Any]]:
    """List parquet datasets the engine can serve from local roots/env-configured stores."""
    results: list[dict[str, Any]] = []
    fixtures = []
    root = get_storage_config().root
    if root:
        import glob

        fixtures = sorted(glob.glob(f"{os.path.join(root, '*')}.parquet")) or sorted(
            glob.glob(f"{os.path.join(root, '*')}/*.parquet")
        )
    if not fixtures:
        fixture = os.getenv("FINA_OLAP_FIXTURE", "data/sample.parquet")
        if __import__("pathlib").Path(fixture).exists():
            fixtures = [fixture]
    for path in fixtures:
        results.append({"path": path, **summary(path)})
    return results


@mcp.tool()
def get_rows(payload: dict[str, Any]) -> dict[str, Any]:
    """Execute an ag-grid SSRM payload against Parquet via DuckDB and return rows/lastRow."""
    response = _engine.query(payload)
    return _as_dict(response)


@mcp.tool()
def status() -> dict[str, Any]:
    """Engine status: active store config, object-store connectivity, fixture availability."""
    return {
        "store": storage_status(),
        "object_store": object_store_status(),
        "fixture": summary(os.getenv("FINA_OLAP_FIXTURE", "data/sample.parquet")),
    }


@mcp.tool()
def store_config() -> dict[str, Any]:
    """Read the effective store configuration (backend, local root, bucket, partition glob, hive flag).

    ``overrides`` lists fields switched at runtime via ``store_configure`` (they
    sit on top of the env-var base and persist until ``store_configure(clear=true)``).
    """
    return {"store": storage_status()}


@mcp.tool()
def store_configure(
    store: str = "",
    parquet_root: str = "",
    bucket: str = "",
    path: str = "",
    partition_glob: str = "",
    hive_partitioning: str = "",
    clear: bool = False,
) -> dict[str, Any]:
    """Configure the store at runtime (process-local; env vars remain the boot default).

    Only non-empty fields are changed; pass ``clear=true`` to reset all runtime
    overrides back to the env base first. ``hive_partitioning`` accepts 1/0/
    true/false. Returns the effective config after the change.
    """
    if store and store not in ALLOWED_STORES:
        raise ValueError(f"store must be one of {', '.join(ALLOWED_STORES)}; got {store!r}")
    if clear:
        clear_storage_override()
    changes: dict[str, Any] = {}
    if store:
        changes["store"] = store
    if parquet_root:
        changes["root"] = parquet_root
    if bucket:
        changes["bucket"] = bucket
    if path:
        changes["default_path"] = path
    if partition_glob:
        changes["partition_glob"] = partition_glob
    if hive_partitioning:
        changes["hive_partitioning"] = hive_partitioning
    if changes:
        set_storage_override(**changes)
    return {"store": storage_status()}


@mcp.tool()
def store_resolve(table_name: str = DEFAULT_TABLE) -> dict[str, Any]:
    """Preview how a table resolves under the current store config (source, hive flag, partition columns)."""
    request = SSRMRequest.model_validate({"tableName": table_name})
    source = resolve_source(request)
    cfg = get_storage_config()
    return {
        "table_name": table_name,
        "store": cfg.store,
        "source": source,
        "object_store": source.startswith(("s3://", "gs://", "http://", "https://")),
        "hive_partitioning": hive_for(request, source),
        "partition_glob": cfg.partition_glob,
        "partition_columns": partition_columns(cfg.partition_glob),
        "overrides": storage_overrides(),
    }


@mcp.tool()
def upsert_store(
    table_name: str = DEFAULT_TABLE,
    key: str = "",
    file_path: str = "",
    data_format: str = "auto",
    rows: list[dict[str, Any]] | None = None,
    appender: bool = False,
    chunk_size: int = 0,
) -> dict[str, Any]:
    """Upsert CSV/JSON/Parquet data into the store's ``table_name``.

    Pass a ``file_path`` (format auto-detected from the extension, or set
    ``data_format``) or inline ``rows`` (list of JSON objects). ``key`` is a
    column (or comma-separated columns) that identifies a stored row: matching
    keys update, unknown keys insert. The store is rewritten in place (flat
    layout, or hive-partitioned dirs when FINA_OLAP_PARTITION_GLOB is set) and
    the result reports before/after row counts plus matched/inserted splits.

    ``appender=true`` switches the flat-layout write from DuckDB COPY to an
    Arrow appender (pyarrow ParquetWriter): pass ``chunk_size`` to write the
    merged result in fixed-size chunks, appended row group by row group. Appender
    mode requires a flat local store (no hive partition glob, no object store).
    """
    if not key:
        raise ValueError("upsert_store requires key: the column(s) identifying a stored row")
    if appender and chunk_size < 0:
        raise ValueError("chunk_size must be >= 0")
    return upsert_into_store(
        _engine,
        table_name=table_name,
        key=key,
        file_path=file_path or None,
        data_format=data_format,
        rows=rows,
        appender=appender,
        chunk_size=chunk_size,
    )


@mcp.tool()
def store_export(
    table_name: str = DEFAULT_TABLE,
    out_path: str = "",
    data_format: str = "auto",
    columns: str = "",
    filters: dict[str, Any] | None = None,
    limit: int = 0,
) -> dict[str, Any]:
    """Export ``table_name`` to a CSV / JSON / JSONL / Parquet file.

    ``data_format`` overrides the extension sniffing on ``out_path`` (auto, csv,
    json, jsonl/ndjson, parquet). ``columns`` is a comma-separated subset.
    ``filters`` uses the same ag-grid filterModel shape as SSRM payloads (text /
    number / date / set / combined conditions); ``limit`` caps the rows. Returns
    the written path, format, column list and exported row count.
    """
    if not out_path:
        raise ValueError("store_export requires out_path")
    if limit < 0:
        raise ValueError("limit must be >= 0")
    return export_from_store(
        _engine,
        table_name=table_name,
        out_path=out_path,
        data_format=data_format,
        columns=columns,
        filters=filters,
        limit=limit,
    )


def _as_dict(response: Any) -> dict[str, Any]:
    return response.model_dump(exclude_none=False)


app = mcp.streamable_http_app()


def main() -> None:
    """Entry point for the stdio transport (`fina-olap-mcp`)."""
    mcp.run()


if __name__ == "__main__":
    main()
