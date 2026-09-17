"""Env-driven storage backend + Parquet partition configuration for the engine.

A single top-level switch selects the backing store (local filesystem, an
S3 bucket or GCS), and a partition configuration controls how Parquet files
are discovered and whether DuckDB exposes hive-style partition columns.

The resolution honours, in decreasing priority:

- ``FINA_OLAP_STORE``          — ``local`` | ``s3`` | ``gcs`` | ``auto`` (default).
                                ``auto`` keeps the legacy cascade (uri → bucket →
                                ``S3_PATH_TEMPLATE`` → local root → fixture). An
                                explicit ``s3``/``gcs`` forces the object-store
                                branch and fails loudly when it is unconfigured
                                (no silent fixture fallback).
- ``FINA_OLAP_PARQUET_ROOT``   — local Parquet root (aliases: ``OLAP_PARQUET_ROOT``,
                                ``DATA_DIR``). When unset, ``TAC_LAKE_DIR`` resolves
                                to its ``reports`` subdirectory.
- ``FINA_OLAP_BUCKET``         — object-store bucket (aliases: ``S3_BUCKET_NAME``
                                / ``AWS_BUCKET``; gcs honours ``GCS_BUCKET_NAME``).
- ``FINA_OLAP_PATH``           — default prefix under the bucket (alias ``S3_PATH_ENV``);
                                used as the ``s3Path`` template field.
- ``S3_PATH_TEMPLATE``         — explicit ``{bucket}/{s3Path}/{version}/{slice}/{tableName}*``
                                style layout.
- ``FINA_OLAP_PARTITION_GLOB`` — glob describing the on-store layout, e.g.
                                ``{tableName}/region=*/date=*/*.parquet``. The
                                placeholders ``{table}``/``{tableName}`` expand to
                                the payload's ``tableName``. Default: ``{tableName}*.parquet``.
- ``FINA_OLAP_HIVE_PARTITIONING`` — ``1/0/true/false``; defaults to hive partition
                                discovery on for ``s3``/``gcs`` and off for local.
"""

from __future__ import annotations

import dataclasses
import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

ALLOWED_STORES = ("local", "s3", "gcs", "auto")

_OVERRIDE_FIELDS = ("store", "root", "bucket", "default_path", "path_template", "partition_glob", "hive_partitioning")

#: Runtime (process-local) config overrides applied on top of the env base.
_OVERIDES: dict[str, Any] = {}

_ALIASES: dict[str, tuple[str, ...]] = {
    "root": ("FINA_OLAP_PARQUET_ROOT", "OLAP_PARQUET_ROOT", "DATA_DIR"),
    "bucket": ("FINA_OLAP_BUCKET", "S3_BUCKET_NAME", "AWS_BUCKET"),
    "path": ("FINA_OLAP_PATH", "S3_PATH_ENV"),
}


def _first(*names: str) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value:
            return value.strip()
    return None


def _parse_bool(value: str | None) -> bool | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"invalid boolean value {value!r} for FINA_OLAP_HIVE_PARTITIONING")


def _normalize_store(value: str | None) -> str:
    store = (value or "auto").strip().lower()
    if store not in ALLOWED_STORES:
        raise ValueError(f"invalid FINA_OLAP_STORE {value!r} (expected one of {', '.join(ALLOWED_STORES)})")
    return store


@dataclass(frozen=True)
class StorageConfig:
    """Resolved, env-driven storage + partition settings (no secrets)."""

    store: str = "auto"
    root: str | None = None
    bucket: str | None = None
    default_path: str = ""
    path_template: str | None = None
    partition_glob: str | None = None
    hive_partitioning: bool | None = None

    @property
    def effective_bucket(self) -> str | None:
        if self.bucket:
            return self.bucket.rstrip("/")
        if self.store == "gcs":
            bucket = _first("GCS_BUCKET_NAME")
            return bucket.rstrip("/") if bucket else None
        return None

    @property
    def scheme(self) -> str:
        return "gs://" if self.store == "gcs" else "s3://"

    def is_object_store(self) -> bool:
        return self.store in ("s3", "gcs")

    @property
    def auto_hive(self) -> bool:
        return self.is_object_store()

    def glob_for(self, table: str) -> str:
        pattern = self.partition_glob or "{tableName}*.parquet"
        return pattern.replace("{table}", table).replace("{tableName}", table)


def get_storage_config() -> StorageConfig:
    """Return the effective storage config.

    Env vars (memoized) supply the base; any runtime overrides set through
    :func:`set_storage_override` are applied on top so the UI can point the
    engine at a different store without a restart. Use
    :func:`reload_storage_config` after editing env vars.
    """
    config = _build_storage_config()
    changes = {key: value for key, value in _OVERIDES.items() if hasattr(config, key)}
    if not changes:
        return config
    return dataclasses.replace(config, **changes)


@lru_cache(maxsize=1)
def _build_storage_config() -> StorageConfig:
    root = _first(*_ALIASES["root"])
    tac_lake_dir = _first("TAC_LAKE_DIR")
    if not root and tac_lake_dir:
        root = os.path.join(tac_lake_dir, "reports")
    bucket = _first(*_ALIASES["bucket"]) or _first("GCS_BUCKET_NAME")
    return StorageConfig(
        store=_normalize_store(os.getenv("FINA_OLAP_STORE")),
        root=root,
        bucket=bucket,
        default_path=(_first(*_ALIASES["path"]) or "").strip("/"),
        path_template=os.getenv("S3_PATH_TEMPLATE"),
        partition_glob=os.getenv("FINA_OLAP_PARTITION_GLOB")
        or ("slice=*/version=*/*.parquet" if tac_lake_dir else None),
        hive_partitioning=_parse_bool(os.getenv("FINA_OLAP_HIVE_PARTITIONING"))
        if os.getenv("FINA_OLAP_HIVE_PARTITIONING") is not None
        else (True if tac_lake_dir else None),
    )


def reload_storage_config() -> StorageConfig:
    """Drop the memoized config and rebuild from the current environment."""
    _build_storage_config.cache_clear()
    return get_storage_config()


def set_storage_override(**kwargs: Any) -> StorageConfig:
    """Apply runtime overrides on top of the env-backed config.

    Keys are ``StorageConfig`` field names (``store``, ``root``, ``bucket``,
    ``default_path``, ``path_template``, ``partition_glob``,
    ``hive_partitioning``). Values are validated; ``hive_partitioning`` accepts
    a bool or the ``1/0/true/false`` spellings. Returns the new effective
    config. Overrides are process-local (cleared by :func:`clear_storage_override`).
    """
    normalized: dict[str, Any] = {}
    for key, value in kwargs.items():
        if key not in _OVERRIDE_FIELDS:
            raise ValueError(f"unknown storage config field {key!r} (expected one of {', '.join(_OVERRIDE_FIELDS)})")
        if key == "store":
            normalized[key] = _normalize_store(str(value))
        elif key == "hive_partitioning":
            text = value if isinstance(value, str) else ("true" if value else "false")
            parsed = _parse_bool(text)
            assert parsed is not None
            normalized[key] = parsed
        else:
            normalized[key] = value if value is None or isinstance(value, str) else str(value)
    _OVERIDES.update(normalized)
    return get_storage_config()


def clear_storage_override() -> StorageConfig:
    """Reset all runtime overrides, returning to the pure env-backed config."""
    _OVERIDES.clear()
    return get_storage_config()


def storage_overrides() -> dict[str, Any]:
    """Currently applied runtime overrides (field name → value)."""
    return dict(_OVERIDES)


def storage_status() -> dict[str, Any]:
    """Non-secret diagnostics for health endpoints / MCP status."""
    cfg = get_storage_config()
    return {
        "store": cfg.store,
        "root": cfg.root,
        "bucket": cfg.effective_bucket,
        "path": cfg.default_path,
        "path_template_set": bool(cfg.path_template),
        "partition_glob": cfg.partition_glob,
        "hive_partitioning": cfg.hive_partitioning if cfg.hive_partitioning is not None else cfg.auto_hive,
        "hive_partitioning_explicit": cfg.hive_partitioning is not None,
        "overrides": storage_overrides(),
    }


__all__ = [
    "StorageConfig",
    "clear_storage_override",
    "get_storage_config",
    "reload_storage_config",
    "set_storage_override",
    "storage_overrides",
    "storage_status",
]
