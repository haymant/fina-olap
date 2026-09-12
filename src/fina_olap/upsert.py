"""Upsert CSV / JSON / Parquet inputs into the Parquet store.

The store keeps its Parquet layout — a flat file (default ``{tableName}*.parquet``)
or hive-partitioned directories per ``FINA_OLAP_PARTITION_GLOB``. An incoming
CSV/JSON/Parquet file (or inline rows) is merged into the target table keyed on
the caller-provided key column(s): matching keys update the stored rows, new
keys insert rows, and the full store is rewritten in place.

For flat stores the table is rewritten atomically (temp file + rename); for
hive-partitioned stores DuckDB's ``COPY ... PARTITION_BY`` rewrites the table
directory so the engine can read it back with the same hive columns exposed.
"""

from __future__ import annotations

import glob as globmod
import os
import re
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd
import pyarrow.parquet as pq

from .engine import DEFAULT_TABLE, OlapEngine, hive_for, resolve_source
from .gcs import configure_duckdb_object_store
from .schema import SSRMRequest
from .storage import StorageConfig, get_storage_config, storage_overrides

_HIVE_TOKEN = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)=\*")
_SKIP_CAST = ("STRUCT(", "MAP(", "UNION(", "JSON")
_REMOTE_PREFIX = ("s3://", "gs://", "http://", "https://")


def _quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _castable(dtype: str) -> bool:
    upper = dtype.upper()
    return not any(token in upper for token in _SKIP_CAST)


def _count(con: duckdb.DuckDBPyConnection, sql: str) -> int:
    """Execute a scalar COUNT query (returns 0 when no row is produced)."""
    row = con.execute(sql).fetchone()
    return int(row[0]) if row is not None else 0


def _key_columns(key: str | list[str], names: list[str]) -> list[str]:
    if not key:
        raise ValueError("upsert requires at least one key column (comma-separated)")
    parts = [k.strip() for k in (key.split(",") if isinstance(key, str) else key)]
    if not parts or any(not p for p in parts):
        raise ValueError("upsert: key column list must be non-empty")
    missing = [p for p in parts if p not in names]
    if missing:
        raise ValueError(f"upsert: key column(s) {missing} not present in the data (columns: {names})")
    return parts


def upsert_store(
    engine: OlapEngine,
    *,
    table_name: str = DEFAULT_TABLE,
    key: str | list[str] = "",
    file_path: str | None = None,
    data_format: str = "auto",
    rows: list[dict[str, Any]] | dict[str, Any] | None = None,
    appender: bool = False,
    chunk_size: int = 0,
) -> dict[str, Any]:
    """Merge ``file_path`` (CSV/JSON/Parquet) or ``rows`` into the store's ``table_name``.

    ``key`` (a column or comma-separated list) identifies a row in the existing
    store: matching keys update, unknown keys insert. Returns counts plus the
    written location/schema so callers can verify the rewrite.

    ``appender`` switches the flat-layout write from DuckDB ``COPY`` to an Arrow
    appender (``pyarrow.parquet.ParquetWriter``): each ``write_table`` call appends
    one row group, so ``chunk_size > 0`` splits the merged result into fixed-size
    chunks written chunk by chunk. Appender mode requires a flat store (no hive
    ``FINA_OLAP_PARTITION_GLOB``) and a local target.
    """
    if not file_path and rows is None:
        raise ValueError("upsert requires either file_path (csv/json/parquet) or rows")

    request = SSRMRequest.model_validate({"tableName": table_name})
    cfg = get_storage_config()
    source = resolve_source(request)
    remote = source.startswith(_REMOTE_PREFIX)

    con = duckdb.connect(":memory:")
    if remote:
        configure_duckdb_object_store(con)

    # ---- target ----------------------------------------------------------
    # With a configured local root we resolve the table against the root
    # *first* so a brand-new table is created at root/<table>.parquet (or the
    # partition base) instead of silently merging into the sample fixture.
    if cfg.root and not remote:
        table_glob = cfg.glob_for(table_name)
        root_matches = globmod.glob(os.path.join(cfg.root, table_glob))
        target_exists = bool(root_matches)
    elif remote:
        target_exists = _probe_target(con, source, request)
    else:
        target_exists = bool(globmod.glob(source)) if globmod.has_magic(source) else Path(source).exists()

    hive = hive_for(request, source)
    target_cols: list[tuple[str, str]] = []
    target_rows = 0
    if target_exists:
        OlapEngine._register(con, "t", source, hive)
        target_cols = [(str(r[0]), str(r[1])) for r in con.execute('DESCRIBE "t"').fetchall()]
        target_rows = _count(con, 'SELECT count(*) FROM "t"')

    # ---- incoming --------------------------------------------------------
    incoming_cols = _read_incoming(con, file_path, data_format, rows)
    incoming_rows = _count(con, "SELECT count(*) FROM incoming")

    known = [name for name, _ in target_cols] if target_exists else incoming_cols
    keys = _key_columns(key, known)
    if target_exists:
        missing = [k for k in keys if k not in incoming_cols]
        if missing:
            raise ValueError(f"upsert: incoming data has no key column(s) {missing}")

    # ---- match counts ----------------------------------------------------
    key_sql = " AND ".join(f"tt.{_quote_ident(k)} IS NOT DISTINCT FROM i.{_quote_ident(k)}" for k in keys)
    matched = (
        _count(
            con,
            f'SELECT count(*) FROM incoming i WHERE EXISTS (SELECT 1 FROM "t" tt WHERE {key_sql})',
        )
        if target_exists
        else 0
    )
    if target_exists:
        inserted = _count(
            con,
            f"SELECT count(*) FROM (SELECT DISTINCT {', '.join('i.' + _quote_ident(k) for k in keys)} "
            f'FROM incoming i WHERE NOT EXISTS (SELECT 1 FROM "t" tt WHERE {key_sql}))',
        )
    else:
        inserted = incoming_rows

    # ---- merge -------------------------------------------------------------
    if target_exists and target_cols:
        select_items = []
        for name, dtype in target_cols:
            q = _quote_ident(name)
            if name in incoming_cols:
                left = f"CAST(i.{q} AS {dtype})" if _castable(dtype) else f"i.{q}"
                select_items.append(f"COALESCE({left}, t.{q}) AS {q}")
            else:
                select_items.append(f"t.{q} AS {q}")
        join_sql = " AND ".join(f"t.{_quote_ident(k)} IS NOT DISTINCT FROM i.{_quote_ident(k)}" for k in keys)
        merged_sql = (
            "CREATE TEMP TABLE merged AS SELECT "
            + ", ".join(select_items)
            + f' FROM "t" t FULL OUTER JOIN incoming i ON {join_sql}'
        )
    else:
        merged_sql = "CREATE TEMP TABLE merged AS SELECT * FROM incoming"
    con.execute(merged_sql)
    target_after = _count(con, "SELECT count(*) FROM merged")

    # ---- write back --------------------------------------------------------
    hive_columns = _hive_columns(cfg.partition_glob, target_cols or [(c, "") for c in incoming_cols])
    written_to, row_groups = _rewrite(
        con, cfg, table_name, source, target_exists, hive_columns, appender=appender, chunk_size=chunk_size
    )

    return {
        "table": table_name,
        "target_source": source,
        "key": keys,
        "target_rows_before": target_rows,
        "incoming_rows": incoming_rows,
        "matched": matched,
        "inserted": inserted,
        "target_rows_after": target_after,
        "written_to": written_to,
        "hive_columns": hive_columns,
        "writer": "appender" if appender else "duckdb-copy",
        "row_groups": row_groups,
        "schema": [{"name": name, "type": dtype} for name, dtype in target_cols]
        or [{"name": name, "type": "?"} for name in incoming_cols],
        "source_layer": "override" if storage_overrides() else "env",
    }


def _probe_target(
    con: duckdb.DuckDBPyConnection,
    source: str,
    request: SSRMRequest,
) -> bool:
    """Remote targets cannot be stat-examined cheaply — probe via a read attempt."""
    try:
        OlapEngine._register(con, "t", source, hive_for(request, source))
        con.execute('DESCRIBE "t"')
        return True
    except Exception:
        return False


def _read_incoming(
    con: duckdb.DuckDBPyConnection,
    file_path: str | None,
    data_format: str,
    rows: list[dict[str, Any]] | dict[str, Any] | None,
) -> list[str]:
    if rows is not None:
        frame = pd.DataFrame(rows if isinstance(rows, list) else [rows])
        con.register("incoming", frame)
        return [str(r[0]) for r in con.execute("DESCRIBE incoming").fetchall()]

    assert file_path is not None
    fmt = (data_format or "auto").lower().lstrip(".")
    if fmt == "auto":
        fmt = Path(file_path).suffix.lower().lstrip(".") or "parquet"
    if fmt == "csv":
        sql = f"CREATE TEMP TABLE incoming AS SELECT * FROM read_csv_auto({_quote_literal(file_path)})"
    elif fmt in ("parquet", "pq"):
        sql = (
            f"CREATE TEMP TABLE incoming AS SELECT * FROM "
            f"read_parquet({_quote_literal(file_path)}, hive_partitioning = TRUE)"
        )
    elif fmt in ("json", "jsonl", "ndjson"):
        sql = f"CREATE TEMP TABLE incoming AS SELECT * FROM read_json_auto({_quote_literal(file_path)})"
    else:
        raise ValueError(f"unsupported data_format {fmt!r} (expected csv, json or parquet)")
    con.execute(sql)
    return [str(r[0]) for r in con.execute("DESCRIBE incoming").fetchall()]


def _hive_columns(partition_glob: str | None, merged: list[tuple[str, str]]) -> list[str]:
    """Partition columns declared by ``FINA_OLAP_PARTITION_GLOB`` that exist in the data."""
    available = {name for name, _ in merged}
    return [c for c in partition_columns(partition_glob) if c in available]


def partition_columns(partition_glob: str | None) -> list[str]:
    """Declared hive partition columns from a ``FINA_OLAP_PARTITION_GLOB`` pattern."""
    if not partition_glob:
        return []
    return [m.group(1) for m in _HIVE_TOKEN.finditer(partition_glob)]


def _table_base(source: str) -> str:
    """Base directory for a partitioned layout: strip the trailing wildcard segments."""
    parts = source.split("/")
    nonstar = [i for i, part in enumerate(parts) if "*" not in part]
    cut = nonstar[-1] + 1 if nonstar else len(parts)
    return "/".join(parts[:cut])


def _new_partition_base(cfg: StorageConfig, table: str) -> str:
    pattern = cfg.partition_glob or ""
    if cfg.root:
        return _table_base(os.path.join(cfg.root, pattern.replace("{table}", table).replace("{tableName}", table)))
    return _table_base(pattern.replace("{table}", table).replace("{tableName}", table))


def _rewrite(
    con: duckdb.DuckDBPyConnection,
    cfg: StorageConfig,
    table: str,
    source: str,
    target_exists: bool,
    hive_columns: list[str],
    appender: bool = False,
    chunk_size: int = 0,
) -> tuple[str, int]:
    remote = source.startswith(_REMOTE_PREFIX)

    if appender and (hive_columns or remote):
        which = "hive-partitioned store" if hive_columns else "remote (object-store) target"
        raise ValueError(f"appender mode requires a flat local store; got a {which}")

    if hive_columns:
        base = _table_base(source) if (target_exists or remote) else _new_partition_base(cfg, table)
        if not remote:
            os.makedirs(base, exist_ok=True)
            for stale in globmod.glob(os.path.join(base, "**", "*.parquet"), recursive=True):
                os.remove(stale)
        cols = ", ".join(_quote_ident(c) for c in hive_columns)
        con.execute(f"COPY merged TO {_quote_literal(base.rstrip('/') + '/')} (FORMAT PARQUET, PARTITION_BY ({cols}))")
        return base, len(globmod.glob(os.path.join(base, "**", "*.parquet"), recursive=True)) if not remote else 0

    if target_exists:
        written = _flat_written(source, cfg, table)
    elif cfg.root:
        written = os.path.join(cfg.root, f"{table}.parquet")
    else:
        default_dir = os.path.dirname(os.getenv("FINA_OLAP_FIXTURE", "data/sample.parquet"))
        written = os.path.join(default_dir or os.getcwd(), f"{table}.parquet")

    if appender:
        return _rewrite_appender(con, written, source, target_exists, chunk_size)

    tmp = f"{written}.{os.getpid()}.tmp.parquet"
    try:
        con.execute(f"COPY merged TO {_quote_literal(tmp)} (FORMAT PARQUET)")
        if not remote:
            for stale in globmod.glob(source) if (target_exists and globmod.has_magic(source)) else []:
                if os.path.abspath(stale) != os.path.abspath(written):
                    os.remove(stale)
            os.replace(tmp, written)
        else:
            os.remove(tmp)
    finally:
        if not remote and os.path.exists(tmp):
            os.remove(tmp)
    return written, 0


def _rewrite_appender(
    con: duckdb.DuckDBPyConnection,
    written: str,
    source: str,
    target_exists: bool,
    chunk_size: int,
) -> tuple[str, int]:
    """Write the flat store via a pyarrow ParquetWriter, chunk by chunk.

    Each ``write_table`` call appends one row group; ``chunk_size`` controls the
    per-chunk row count. The file is written to a sibling temp path and swapped
    in atomically, mirroring the DuckDB COPY path.
    """
    table = con.execute("SELECT * FROM merged").to_arrow_table()
    tmp = f"{written}.{os.getpid()}.tmp.parquet"
    try:
        row_groups = 0
        with pq.ParquetWriter(tmp, table.schema) as writer:
            if chunk_size > 0 and table.num_rows > 0:
                for offset in range(0, table.num_rows, chunk_size):
                    writer.write_table(table.slice(offset, chunk_size))
                    row_groups += 1
            else:
                writer.write_table(table)
                row_groups = 1
        for stale in globmod.glob(source) if (target_exists and globmod.has_magic(source)) else []:
            if os.path.abspath(stale) != os.path.abspath(written):
                os.remove(stale)
        os.replace(tmp, written)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return written, row_groups


def _flat_written(source: str, cfg: StorageConfig, table: str) -> str:
    if not globmod.has_magic(source):
        return source
    if source.endswith("*.parquet"):
        return source[: -len("*.parquet")] + f"{table}.parquet"
    if cfg.root:
        return os.path.join(cfg.root, f"{table}.parquet")
    return os.path.join(os.path.dirname(source) or ".", f"{table}.parquet")
