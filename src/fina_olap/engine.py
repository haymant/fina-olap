"""OLAP query engine: resolve Parquet backing (S3/GCS/local), run SSRM queries.

The backing store is selected by the ``FINA_OLAP_STORE`` env switch (``local`` /
``s3`` / ``gcs`` / ``auto``) and the Parquet partition layout by
``FINA_OLAP_PARTITION_GLOB`` + ``FINA_OLAP_HIVE_PARTITIONING`` (see
``fina_olap.storage``). Connection handling is per-request (mostly zero-copy
in-memory DuckDB); remote parquet reads use DuckDB httpfs with an S3-compatible
secret for GCS or any S3 endpoint (see ``fina_olap.gcs``). Local development
falls back to the generated fixture so the HTTP/MCP surfaces work with zero
configuration.
"""

from __future__ import annotations

import glob
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pandas as pd

from .builder import DuckDBSqlBuilder
from .fixture import DEFAULT_ROW_COUNT, generate_fixture
from .gcs import configure_duckdb_object_store, object_store_configured
from .schema import SSRMRequest, SSRMResponse
from .storage import StorageConfig, get_storage_config

logger = logging.getLogger(__name__)

DEFAULT_TABLE = "trades"
LOCAL_FIXTURE_ENV = "FINA_OLAP_FIXTURE"


class SourceResolutionError(RuntimeError):
    """Raised when no Parquet backing can be resolved for a request."""


def _clean_rows(df: pd.DataFrame) -> list[dict[str, Any]]:
    """Coerce NaN/NaT to None and arrays to JSON-safe lists."""
    df = df.astype(object).where(pd.notnull(df), None)
    rows: list[dict[str, Any]] = []
    for record in df.to_dict("records"):
        cleaned: dict[str, Any] = {}
        for k, v in record.items():
            if isinstance(v, np.ndarray):
                v = v.tolist()
            if isinstance(v, list):
                cleaned[k] = v  # already JSON-safe; skip scalar isna
            else:
                cleaned[k] = None if v is None or pd.isna(v) else v
        rows.append(cleaned)
    return rows


def resolve_source(payload: SSRMRequest) -> str:
    """Return the Parquet URI/path backing the payload.

    Resolution order (driven by the ``FINA_OLAP_STORE`` switch):

    1. ``payload.dataSource.uri``              — explicit ``s3://``/``gs://``/local path
    2. ``payload.dataSource.bucket/path/glob`` — bucket-based (S3/GCS) construction
    3. ``FINA_OLAP_STORE=s3|gcs`` (forced)      — ``S3_PATH_TEMPLATE`` or
       ``FINA_OLAP_BUCKET`` + ``FINA_OLAP_PATH`` + partition glob. Fails loudly
       when the store is not configured (no silent fixture fallback).
    4. ``FINA_OLAP_STORE=local`` (forced)       — ``FINA_OLAP_PARQUET_ROOT`` +
       partition glob, then the generated fixture.
    5. ``auto`` (default)                       — legacy cascade: template →
       local root (``OLAP_PARQUET_ROOT``/``DATA_DIR``) → fixture.

    ``FINA_OLAP_PARTITION_GLOB`` is honoured everywhere a table glob is built,
    so partitioned layouts (e.g. ``{tableName}/region=*/date=*/*.parquet``) work
    identically on local disks and object stores.
    """
    ds = payload.dataSource
    table = payload.tableName or DEFAULT_TABLE
    cfg = get_storage_config()

    if ds and ds.uri:
        uri = ds.uri.removeprefix("file://")
        if uri.startswith(("s3://", "gs://", "http://", "https://")):
            return uri
        # local path / file:// URI: expand a directory to a parquet glob
        return _expand_local(uri, cfg)

    if ds and ds.bucket:
        glob_pat = ds.glob or cfg.glob_for(table)
        bucket = ds.bucket.rstrip("/")
        if bucket.startswith(("gs://", "s3://")):
            scheme = "gs://" if bucket.startswith("gs://") else "s3://"
            bucket = bucket.removeprefix("s3://").removeprefix("gs://")
        else:
            scheme = "gs://" if cfg.store == "gcs" else "s3://"
        prefix = (ds.path or "").strip("/")
        suffix = f"{prefix}/{glob_pat}" if prefix else glob_pat
        return f"{scheme}{bucket}/{suffix}"

    if cfg.is_object_store():
        return _resolve_object_store(payload, table, cfg)

    if cfg.store == "local":
        return _resolve_local(payload, table, cfg)

    # --- auto: legacy cascade -------------------------------------------------
    if cfg.path_template:
        return _resolve_template(payload, table, cfg)

    root = cfg.root
    if root:
        matches = _glob_source(root, cfg.glob_for(table), keep_glob=cfg.partition_glob is not None)
        if matches:
            return matches[0]

    fixture = os.getenv(LOCAL_FIXTURE_ENV, "data/sample.parquet")
    return fixture


def _glob_source(root: str, pattern: str, *, keep_glob: bool = False) -> list[str]:
    """Resolve a table glob under a local root.

    Flat layouts (default ``{tableName}*.parquet``) return the first concrete
    match; an explicit ``FINA_OLAP_PARTITION_GLOB`` returns the scanning glob so
    DuckDB reads every hive partition directory.
    """
    if keep_glob:
        # don't enumerate an (possibly recursive) partition glob just to check it
        return [os.path.join(root, pattern)]
    matches = sorted(glob.glob(os.path.join(root, pattern)))
    return matches


def _expand_local(source: str, cfg: StorageConfig) -> str:
    """Normalize a local source into a DuckDB-readable path/glob.

    - strips a ``file://`` prefix,
    - expands a **directory** to its direct ``*.parquet`` files (a configured
      ``FINA_OLAP_PARTITION_GLOB`` is used when set). Recursion is opt-in: pass
      an explicit glob such as ``file:///data/lake/**/*.parquet``,
    - leaves a bare file path or glob untouched.
    """
    path = source.removeprefix("file://")
    if glob.has_magic(path):
        return path
    if os.path.isdir(path):
        pattern = cfg.partition_glob or "*.parquet"
        return os.path.join(path.rstrip("/"), pattern)
    return path


def _local_exists(source: str) -> bool:
    """Cheap existence check that never enumerates a glob (which can hang)."""
    if not glob.has_magic(source):
        return Path(source).exists()
    keep: list[str] = []
    for segment in source.split("/"):
        if glob.has_magic(segment):
            break
        keep.append(segment)
    prefix = "/".join(keep)
    return Path(prefix).exists() if prefix else True


def _resolve_local(payload: SSRMRequest, table: str, cfg: StorageConfig) -> str:
    root = cfg.root
    if root:
        matches = _glob_source(root, cfg.glob_for(table), keep_glob=cfg.partition_glob is not None)
        if matches:
            return matches[0]
    fixture = os.getenv(LOCAL_FIXTURE_ENV, "data/sample.parquet")
    return fixture


def _resolve_object_store(payload: SSRMRequest, table: str, cfg: StorageConfig) -> str:
    version = (payload.dataSource.path if payload.dataSource else None) or payload.version or cfg.default_path
    if cfg.path_template:
        return _resolve_template(payload, table, cfg, version=version)
    bucket = cfg.effective_bucket
    if not bucket:
        raise SourceResolutionError(f"FINA_OLAP_STORE={cfg.store} requires FINA_OLAP_BUCKET (or S3_PATH_TEMPLATE)")
    prefix = cfg.default_path
    glob_pat = cfg.glob_for(table)
    suffix = f"{prefix}/{glob_pat}" if prefix else glob_pat
    return f"{cfg.scheme}{bucket}/{suffix}"


def _resolve_template(payload: SSRMRequest, table: str, cfg: StorageConfig, *, version: str | None = None) -> str:
    if version is None:
        version = (payload.dataSource.path if payload.dataSource else None) or payload.version or cfg.default_path
    template = cfg.path_template
    assert template is not None  # callers guard on it
    try:
        return template.format(
            bucket=cfg.effective_bucket or "",
            s3Path=cfg.default_path,
            version=version or "",
            slice=payload.sliceName or "",
            tableName=table,
        )
    except (KeyError, IndexError) as exc:  # pragma: no cover - defensive
        raise SourceResolutionError(f"malformed S3_PATH_TEMPLATE: {exc}") from exc


def hive_for(request: SSRMRequest, source: str) -> bool:
    """Effective hive-partitioning flag: env override > payload > store default."""
    cfg = get_storage_config()
    if cfg.hive_partitioning is not None:
        return cfg.hive_partitioning
    ds = request.dataSource
    if ds is not None:
        return ds.hivePartitioning
    return source.startswith(("s3://", "gs://"))


def ensure_fixture(path: str = "data/sample.parquet", row_count: int = DEFAULT_ROW_COUNT) -> Path:
    """Generate the fixture if it does not already exist (returns path)."""
    return generate_fixture(row_count=row_count, file_path=path)


def _table_identifier(name: str) -> str:
    """Sanitize a discovered table/file name into a valid DuckDB identifier."""
    clean = re.sub(r"[^A-Za-z0-9_]", "_", name)
    if not clean:
        return "parquet"
    if clean[0].isdigit():
        return f"t_{clean}"
    return clean


class OlapEngine:
    """Executes an SSRM request against Parquet backing through DuckDB."""

    def __init__(self, *, fixture_fallback: bool = True) -> None:
        self.fixture_fallback = fixture_fallback

    # ------------------------------------------------------------------ query
    def query(self, payload: SSRMRequest | dict[str, Any]) -> SSRMResponse:
        started = time.perf_counter()
        request = payload if isinstance(payload, SSRMRequest) else SSRMRequest.model_validate(payload)
        source = self._resolve(request)
        table = request.tableName or DEFAULT_TABLE

        con = duckdb.connect(":memory:")
        if source.startswith(("s3://", "gs://", "http://", "https://")):
            if object_store_configured():
                configure_duckdb_object_store(con)
        self._register(con, table, source, hive_for(request, source))

        builder = DuckDBSqlBuilder(request, table, con)
        built = builder.build()
        logger.debug("[fina-olap] SQL:\n%s", built.sql)

        try:
            df = con.execute(built.sql, built.params).fetchdf()
        except Exception as exc:  # pragma: no cover - surfaced to caller
            return SSRMResponse(
                success=False,
                lastRow=0,
                error=f"query failed: {exc}",
                sql=built.sql,
            )

        page_size = request.endRow - request.startRow
        if len(df) > page_size:
            df = df.iloc[:page_size]
            last_row = -1
        else:
            last_row = request.startRow + len(df)

        rows = _clean_rows(df)
        metrics = {"query_ms": round((time.perf_counter() - started) * 1000, 2), "table": table, "source": source}

        response = SSRMResponse(
            success=True,
            rows=rows,
            lastRow=last_row,
            pivotResultFields=built.pivot_result_fields,
            pivotResultColumnsFields=built.pivot_result_fields,
            lodFields=built.lod_fields,
            metrics=metrics,
        )

        if built.totals_sql:
            try:
                totals_df = con.execute(built.totals_sql, built.totals_params).fetchdf()
                response.totals = _clean_rows(totals_df)[0] if not totals_df.empty else {}
            except Exception:  # pragma: no cover - totals are best-effort
                response.totals = {}
        return response

    def _resolve(self, request: SSRMRequest) -> str:
        source = resolve_source(request)
        if source.startswith(("s3://", "gs://", "http://", "https://")):
            return source
        # local filesystem: expand directories / file:// URIs into a parquet glob
        source = _expand_local(source, get_storage_config())
        if not _local_exists(source):
            if self.fixture_fallback:
                logger.warning("resolved local parquet %s missing; generating fixture", source)
                source = str(ensure_fixture(source))
            else:
                raise SourceResolutionError(f"parquet not found: {source}")
        return source

    @staticmethod
    def _register(con: duckdb.DuckDBPyConnection, table: str, source: str, hive: bool) -> None:
        # CREATE VIEW cannot be prepared (DuckDB limitation), so the already-
        # validated source string is inlined with quote-escaping; all *values*
        # still flow through prepared parameters downstream.
        literal = source.replace("'", "''")
        hive_sql = str(hive).upper()
        sql = (
            f'CREATE OR REPLACE VIEW "{table}" AS '
            f"SELECT * FROM read_parquet('{literal}', hive_partitioning = {hive_sql})"
        )
        con.execute(sql)

    # ------------------------------------------------------------------ schema
    def schema_for(self, payload: SSRMRequest | dict[str, Any]) -> list[dict[str, Any]]:
        request = payload if isinstance(payload, SSRMRequest) else SSRMRequest.model_validate(payload)
        con = duckdb.connect(":memory:")
        source = self._resolve(request)
        if source.startswith(("s3://", "gs://", "http://", "https://")):
            if object_store_configured():
                configure_duckdb_object_store(con)
        table = request.tableName or DEFAULT_TABLE
        self._register(con, table, source, hive_for(request, source))
        rows = con.execute(f"DESCRIBE {table}").fetchall()
        numeric = {"BIGINT", "HUGEINT", "UBIGINT", "UINTEGER", "INTEGER", "SMALLINT", "DOUBLE", "DECIMAL", "FLOAT"}
        return [{"name": r[0], "type": str(r[1]), "numeric": str(r[1]).upper() in numeric} for r in rows]

    # ------------------------------------------------------------------ listing
    def list_tables(self, payload: SSRMRequest | dict[str, Any]) -> list[dict[str, str]]:
        """List candidate parquet tables under a dataSource (S3/GCS or local).

        A table is either a single ``*.parquet`` file or a directory of files
        (optionally hive-partitioned); directory names become table names.
        """
        request = payload if isinstance(payload, SSRMRequest) else SSRMRequest.model_validate(payload)
        ds = request.dataSource
        if ds is None or not (ds.uri or ds.bucket):
            return []

        schemes = ("s3://", "gs://")
        remote = bool((ds.uri and ds.uri.startswith(schemes)) or (ds.bucket and ds.bucket.startswith(schemes)))
        single_file = False
        if ds.uri:
            # strip file:// and normalise a local directory (direct *.parquet unless a glob is given)
            pattern = ds.uri.removeprefix("file://")
            if not glob.has_magic(pattern):
                if os.path.isdir(pattern):
                    pattern = os.path.join(pattern.rstrip("/"), ds.glob or "*.parquet")
                elif os.path.isfile(pattern):
                    single_file = True
        else:
            assert ds.bucket is not None
            bucket = ds.bucket.rstrip("/")
            scheme = ""
            if bucket.startswith(("s3://", "gs://")):
                scheme = "gs://" if bucket.startswith("gs://") else "s3://"
                bucket = bucket.removeprefix("s3://").removeprefix("gs://")
            prefix = (ds.path or "").strip("/")
            glob_pat = ds.glob or "**/*.parquet"
            pattern = f"{scheme}{bucket}/" + (f"{prefix}/{glob_pat}" if prefix else glob_pat)

        # root prefix used to derive the table name from each file path
        if glob.has_magic(pattern):
            keep: list[str] = []
            for segment in pattern.split("/"):
                if glob.has_magic(segment):
                    break
                keep.append(segment)
            root = "/".join(keep)
            if not root.endswith("/"):
                root += "/"
        else:
            root = pattern[: pattern.rfind("/") + 1]

        con = duckdb.connect(":memory:")
        if remote and object_store_configured():
            configure_duckdb_object_store(con)
        try:
            files = [r[0] for r in con.execute("SELECT DISTINCT file FROM glob(?) ORDER BY file", [pattern]).fetchall()]
        except Exception as exc:  # pragma: no cover - remote listing errors
            raise SourceResolutionError(f"list tables failed: {exc}") from exc

        tables: dict[str, dict[str, str]] = {}
        for file in files:
            rel = file[len(root):] if file.startswith(root) else file.rsplit("/", 1)[-1]
            parts = [p for p in rel.split("/") if p]
            if not parts:
                continue
            dir_parts, filename = parts[:-1], parts[-1]
            stem = filename.rsplit(".", 1)[0]
            if single_file:
                name, uri = stem, file
            else:
                non_hive_dirs = [p for p in dir_parts if "=" not in p]
                if non_hive_dirs:
                    # a real directory holds the table (hive partitions may sit above it)
                    name = non_hive_dirs[-1]
                    dir_glob = "/".join("*" if "=" in p else p for p in dir_parts)
                    uri = f"{root}{dir_glob}/*.parquet"
                else:
                    # file directly under the prefix or under hive dirs only: use the stem,
                    # and glob across partitions for the same table file name
                    name = stem
                    dir_glob = "/".join("*" for _ in dir_parts)
                    prefix = f"{dir_glob}/" if dir_glob else ""
                    uri = f"{root}{prefix}{stem}*.parquet"
            name = _table_identifier(name)
            tables.setdefault(name, {"label": name, "tableName": name, "uri": uri})
        return sorted(tables.values(), key=lambda t: t["tableName"])

    # ------------------------------------------------------------------ fixture
    def ensure_default_fixture(self, row_count: int = DEFAULT_ROW_COUNT) -> Path:
        return ensure_fixture(os.getenv(LOCAL_FIXTURE_ENV, "data/sample.parquet"), row_count)
