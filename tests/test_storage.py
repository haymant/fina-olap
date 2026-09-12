"""Storage-backend switch (FINA_OLAP_STORE) + Parquet partition configuration.

Covers resolution for local / s3 / gcs, the partition glob layout, the
hive-partitioning precedence (env > payload > store default), and the end-to-end
read of a hive-partitioned local directory.
"""

from __future__ import annotations

import os

import pandas as pd
import pytest

from fina_olap.engine import OlapEngine, hive_for, resolve_source
from fina_olap.gcs import ObjectStoreConfigurationError
from fina_olap.schema import SSRMRequest
from fina_olap.storage import (
    clear_storage_override,
    get_storage_config,
    reload_storage_config,
    set_storage_override,
    storage_overrides,
    storage_status,
)


@pytest.fixture(autouse=True)
def _clean_storage_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Reset the storage switch for every test (aliases keep their conftest values)."""
    monkeypatch.delenv("FINA_OLAP_STORE", raising=False)
    monkeypatch.delenv("FINA_OLAP_BUCKET", raising=False)
    monkeypatch.delenv("GCS_BUCKET_NAME", raising=False)
    monkeypatch.delenv("FINA_OLAP_PATH", raising=False)
    monkeypatch.delenv("FINA_OLAP_PARTITION_GLOB", raising=False)
    monkeypatch.delenv("FINA_OLAP_HIVE_PARTITIONING", raising=False)
    monkeypatch.delenv("S3_PATH_TEMPLATE", raising=False)
    # object-store credentials may be loaded from a repo .env at import time
    for var in (
        "S3_API_KEY",
        "S3_API_SECRET",
        "S3_BUCKET_NAME",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_BUCKET",
        "AWS_ENDPOINT_URL",
    ):
        monkeypatch.delenv(var, raising=False)
    reload_storage_config()
    yield
    try:
        reload_storage_config()  # teardown; env may be invalid (test_invalid_store_raises)
    except ValueError:
        pass


def _req(**extras: object) -> SSRMRequest:
    return SSRMRequest.model_validate({"startRow": 0, "endRow": 50, **extras})


def test_default_store_is_auto() -> None:
    cfg = get_storage_config()
    assert cfg.store == "auto"
    assert storage_status()["store"] == "auto"


def test_invalid_store_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FINA_OLAP_STORE", "ftp")
    with pytest.raises(ValueError, match="FINA_OLAP_STORE"):
        reload_storage_config()


def test_local_forced_resolves_root_then_fixture(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FINA_OLAP_STORE", "local")
    reload_storage_config()
    # no trades*.parquet under the conftest root -> fixture fallback
    source = resolve_source(_req(tableName="trades"))
    assert source == os.getenv("FINA_OLAP_FIXTURE")

    root = tmp_path
    monkeypatch.setenv("FINA_OLAP_PARQUET_ROOT", str(root))
    (root / "trades_daily.parquet").touch()
    reload_storage_config()
    assert resolve_source(_req(tableName="trades")) == os.path.join(str(root), "trades_daily.parquet")


def test_s3_forced_builds_bucket_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FINA_OLAP_STORE", "s3")
    monkeypatch.setenv("FINA_OLAP_BUCKET", "olap-bucket")
    monkeypatch.setenv("FINA_OLAP_PATH", "data/v1")
    cfg = reload_storage_config()
    assert cfg.store == "s3" and cfg.scheme == "s3://"
    source = resolve_source(_req(tableName="trades"))
    assert source == "s3://olap-bucket/data/v1/trades*.parquet"
    assert hive_for(_req(tableName="trades"), source) is True


def test_gcs_forced_uses_gs_scheme_and_gcs_bucket(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FINA_OLAP_STORE", "gcs")
    monkeypatch.setenv("GCS_BUCKET_NAME", "my-bucket")
    cfg = reload_storage_config()
    assert cfg.scheme == "gs://" and cfg.effective_bucket == "my-bucket"
    source = resolve_source(_req(tableName="trades"))
    assert source == "gs://my-bucket/trades*.parquet"
    assert hive_for(_req(tableName="trades"), source) is True


def test_forced_s3_without_config_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FINA_OLAP_STORE", "s3")
    reload_storage_config()
    with pytest.raises(Exception, match="FINA_OLAP_BUCKET"):
        resolve_source(_req(tableName="trades"))


def test_partition_glob_layout(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FINA_OLAP_STORE", "s3")
    monkeypatch.setenv("FINA_OLAP_BUCKET", "b")
    monkeypatch.setenv("FINA_OLAP_PARTITION_GLOB", "{tableName}/region=*/date=*/*.parquet")
    reload_storage_config()
    assert resolve_source(_req(tableName="trades")) == "s3://b/trades/region=*/date=*/*.parquet"
    assert resolve_source(_req(tableName="bookings")) == "s3://b/bookings/region=*/date=*/*.parquet"


def test_hive_env_overrides_data_source(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FINA_OLAP_STORE", "s3")
    monkeypatch.setenv("FINA_OLAP_HIVE_PARTITIONING", "0")
    reload_storage_config()

    req = _req(tableName="trades", dataSource={"bucket": "b", "hivePartitioning": True})
    assert hive_for(req, "s3://b/trades*.parquet") is False  # env wins


def test_hive_data_source_drives_when_env_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FINA_OLAP_STORE", "s3")
    reload_storage_config()

    req = _req(tableName="trades", dataSource={"bucket": "b"})
    assert hive_for(req, "s3://b/trades*.parquet") is True  # dataSource default True

    req2 = _req(tableName="trades", dataSource={"bucket": "b", "hivePartitioning": False})
    assert hive_for(req2, "s3://b/trades*.parquet") is False


def test_hive_partitioned_local_end_to_end(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Local hive layout: FINA_OLAP_STORE=local + partition glob + hive=1 reads
    partition columns through the real engine pipeline."""
    root = tmp_path / "root"
    table_dir = root / "trades"
    table_dir.mkdir(parents=True)
    eu = table_dir / "region=EU"
    us = table_dir / "region=US"
    eu.mkdir()
    us.mkdir()
    pd.DataFrame({"portfolio": ["P1"] * 3, "instrument": [0, 1, 2], "delta": [10.0, 20.0, 30.0]}).to_parquet(
        eu / "data.parquet", index=False
    )
    pd.DataFrame({"portfolio": ["P1"] * 3, "instrument": [3, 4, 5], "delta": [40.0, 50.0, 60.0]}).to_parquet(
        us / "data.parquet", index=False
    )

    monkeypatch.setenv("FINA_OLAP_STORE", "local")
    monkeypatch.setenv("FINA_OLAP_PARQUET_ROOT", str(root))
    monkeypatch.setenv("FINA_OLAP_PARTITION_GLOB", "{tableName}/region=*/*.parquet")
    monkeypatch.setenv("FINA_OLAP_HIVE_PARTITIONING", "1")
    reload_storage_config()

    source = resolve_source(_req(tableName="trades"))
    assert source == os.path.join(str(root), "trades", "region=*/*.parquet")

    engine = OlapEngine()
    columns = engine.schema_for(_req(tableName="trades"))
    assert {c["name"] for c in columns} >= {"portfolio", "instrument", "delta", "region"}

    grouped = engine.query(_req(tableName="trades", rowGroupCols=[{"id": "region", "field": "region"}]))
    assert grouped.success
    assert [r["region"] for r in grouped.rows] == ["EU", "US"]


def test_bucket_with_store_gcs_scheme(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FINA_OLAP_STORE", "gcs")
    reload_storage_config()
    req = _req(tableName="trades", dataSource={"bucket": "raw", "path": "olap", "glob": "*.parquet"})
    assert resolve_source(req) == "gs://raw/olap/*.parquet"


def test_uri_wins_over_forced_store(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv("FINA_OLAP_STORE", "s3")
    reload_storage_config()
    local = tmp_path / "f.parquet"
    local.touch()
    req = _req(tableName="trades", dataSource={"uri": f"file://{local}"})
    assert resolve_source(req) == str(local)


def test_object_store_configured_guard(monkeypatch: pytest.MonkeyPatch) -> None:
    from fina_olap.gcs import configure_duckdb_object_store

    monkeypatch.delenv("S3_API_KEY", raising=False)
    monkeypatch.delenv("S3_API_SECRET", raising=False)
    monkeypatch.delenv("AWS_ACCESS_KEY_ID", raising=False)
    monkeypatch.delenv("AWS_SECRET_ACCESS_KEY", raising=False)
    import duckdb

    with pytest.raises(ObjectStoreConfigurationError):
        configure_duckdb_object_store(duckdb.connect(":memory:"))


# --------------------------------------------------------------------------
# Runtime override layer (store_configure in the MCP surface)


def test_runtime_override_applied_on_top_and_cleared(tmp_path) -> None:
    root = tmp_path / "override-root"
    root.mkdir()
    (root / "trades.parquet").touch()
    set_storage_override(
        store="local",
        root=str(root),
        hive_partitioning="1",
    )
    try:
        cfg = get_storage_config()
        assert cfg.store == "local"
        assert cfg.root == str(root)
        assert cfg.hive_partitioning is True
        assert storage_status()["overrides"] == {
            "store": "local",
            "root": str(root),
            "hive_partitioning": True,
        }
        # the override root drives resolution (file present -> root path wins)
        assert resolve_source(_req(tableName="trades")) == str(root / "trades.parquet")
        assert hive_for(_req(tableName="trades"), "s3://x/trades*.parquet") is True  # override hive wins
    finally:
        clear_storage_override()
    assert storage_overrides() == {}
    assert storage_status()["overrides"] == {}
    assert get_storage_config().root == os.getenv("OLAP_PARQUET_ROOT")


def test_runtime_override_partition_glob_drives_resolution(tmp_path) -> None:
    root = tmp_path / "root"
    (root / "trades" / "region=EU").mkdir(parents=True)
    (root / "trades" / "region=EU" / "data.parquet").touch()
    set_storage_override(
        store="local",
        root=str(root),
        partition_glob="{tableName}/region=*/*.parquet",
        hive_partitioning="1",
    )
    try:
        assert resolve_source(_req(tableName="trades")) == str(root / "trades" / "region=*" / "*.parquet")
    finally:
        clear_storage_override()


def test_runtime_override_survives_env_reload(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FINA_OLAP_STORE", "auto")
    reload_storage_config()
    set_storage_override(root="/oride")
    try:
        assert get_storage_config().root == "/oride"
        reload_storage_config()
        assert get_storage_config().root == "/oride"  # env reload does not drop overrides
    finally:
        clear_storage_override()
    assert get_storage_config().root == os.getenv("OLAP_PARQUET_ROOT")


def test_runtime_override_validation() -> None:
    assert storage_overrides() == {}
    with pytest.raises(ValueError, match="unknown storage config field"):
        set_storage_override(not_a_field="x")
    with pytest.raises(ValueError, match="FINA_OLAP_STORE"):
        set_storage_override(store="ftp")
    with pytest.raises(ValueError, match="boolean"):
        set_storage_override(hive_partitioning="maybe")
    assert storage_overrides() == {}

    set_storage_override(store="gcs", hive_partitioning=True)
    try:
        cfg = get_storage_config()
        assert cfg.store == "gcs" and cfg.hive_partitioning is True
    finally:
        clear_storage_override()
