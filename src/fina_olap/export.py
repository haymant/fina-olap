"""Filtered export of a store table to CSV / JSON / JSONL / Parquet.

Exports read the table exactly like an SSRM request (``resolve_source`` + hive
column discovery), apply optional ag-grid ``filterModel`` filters with the same
semantics as the OLAP query builder (so a UI export matches what it displays),
then stream the result out through DuckDB ``COPY``:

- ``csv``       — ``(FORMAT CSV, HEADER)``
- ``json``      — ``(FORMAT JSON, ARRAY true)`` (a JSON array of objects)
- ``jsonl``/``ndjson`` — ``(FORMAT JSON)`` (one JSON object per line)
- ``parquet``/``pq``    — ``(FORMAT PARQUET)``
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import duckdb

from .builder import DuckDBSqlBuilder
from .engine import DEFAULT_TABLE, OlapEngine, hive_for, resolve_source
from .gcs import configure_duckdb_object_store
from .schema import SSRMRequest

_EXPORT_FORMATS = ("csv", "json", "jsonl", "ndjson", "parquet", "pq")
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _copy_options(fmt: str) -> str:
    if fmt == "csv":
        return "(FORMAT CSV, HEADER)"
    if fmt == "json":
        return "(FORMAT JSON, ARRAY true)"
    if fmt in ("jsonl", "ndjson"):
        return "(FORMAT JSON)"
    return "(FORMAT PARQUET)"


def export_store(
    engine: OlapEngine,
    *,
    table_name: str = DEFAULT_TABLE,
    out_path: str,
    data_format: str = "auto",
    columns: str | list[str] = "",
    filters: dict[str, Any] | None = None,
    limit: int = 0,
) -> dict[str, Any]:
    """Export ``table_name`` to ``out_path`` as CSV / JSON / JSONL / Parquet.

    ``data_format`` overrides extension sniffing on ``out_path``. ``columns`` is
    a comma-separated list (or a list) of columns to include (default: all).
    ``filters`` uses the same ag-grid ``filterModel`` shape the engine accepts in
    SSRM payloads (text / number / date / set / combined conditions). ``limit``
    caps the exported row count (0 = unlimited).
    """
    request = SSRMRequest.model_validate({"tableName": table_name})
    source = resolve_source(request)
    remote = source.startswith(("s3://", "gs://", "http://", "https://"))

    con = duckdb.connect(":memory:")
    if remote:
        configure_duckdb_object_store(con)
    OlapEngine._register(con, "x", source, hive_for(request, source))

    fmt = (data_format or "auto").lower().lstrip(".")
    if fmt == "auto":
        fmt = Path(out_path).suffix.lower().lstrip(".")
    if fmt not in _EXPORT_FORMATS:
        raise ValueError(f"unsupported export format {fmt!r} (expected csv, json, jsonl or parquet)")

    available = {str(r[0]) for r in con.execute("DESCRIBE x").fetchall()}
    col_list = _resolve_columns(columns, available)
    select = ", ".join(_quote_ident(c) for c in col_list) if col_list != list(available) else "*"

    builder = DuckDBSqlBuilder(
        SSRMRequest.model_validate({"tableName": table_name, "filterModel": filters or {}}), "x", con
    )
    where_sql, where_params = builder._build_where()

    limit_sql = f" LIMIT {int(limit)}" if limit and limit > 0 else ""
    count_sql = f"SELECT count(*) FROM (SELECT {select} FROM x{where_sql}{limit_sql})"
    count_row = con.execute(count_sql, where_params).fetchone()
    rows_exported = int(count_row[0]) if count_row is not None else 0

    copy_sql = f"COPY (SELECT {select} FROM x{where_sql}{limit_sql}) TO {_quote_literal(out_path)} {_copy_options(fmt)}"
    con.execute(copy_sql, where_params)

    return {
        "table": table_name,
        "target_source": source,
        "data_format": fmt,
        "out_path": out_path,
        "rows_exported": rows_exported,
        "columns": col_list,
        "writer": "duckdb-copy",
    }


def _resolve_columns(columns: str | list[str], available: set[str]) -> list[str]:
    if not columns:
        return sorted(available)
    col_list = [c.strip() for c in columns.split(",") if c.strip()] if isinstance(columns, str) else list(columns)
    if not col_list:
        return sorted(available)
    for col in col_list:
        if not _IDENT.fullmatch(col):
            raise ValueError(f"invalid export column identifier: {col!r}")
    missing = [c for c in col_list if c not in available]
    if missing:
        raise ValueError(f"export: column(s) {missing} not present in the table (columns: {sorted(available)})")
    return col_list
