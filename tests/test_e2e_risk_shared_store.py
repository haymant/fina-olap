"""Cross-package E2E: fina-olap reads the Parquet layout fina-risk writes.

Both packages resolve the same ``FINA_OLAP_*`` env vars, so a risk-generation
run (fina-risk ``write_risk_store``) and an OLAP query (fina-olap ``OlapEngine``)
can share one local directory or GCS/S3 bucket + partition glob. This test
reproduces fina-risk's on-disk layout and reads it through the olap engine.
"""

from __future__ import annotations

import pandas as pd
import pytest

from fina_olap.engine import OlapEngine
from fina_olap.storage import reload_storage_config


def _risk_wide() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "portfolio_id": ["P1", "P1", "P2"],
            "risk_factor_id": ["SPOT:ADBE", "SPOT:AMZN", "SPOT:ADBE"],
            "delta": [2.0, -1.0, 0.5],
            "base_pv": [10.0, 20.0, 5.0],
        }
    )


def test_flat_risk_store_is_queryable_via_shared_env(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    _risk_wide().to_parquet(tmp_path / "risk_wide.parquet")
    monkeypatch.setenv("FINA_OLAP_STORE", "local")
    monkeypatch.setenv("FINA_OLAP_PARQUET_ROOT", str(tmp_path))
    reload_storage_config()
    try:
        resp = OlapEngine().query(
            {
                "tableName": "risk_wide",
                "rowGroupCols": [{"id": "p", "field": "portfolio_id"}],
                "valueCols": [{"id": "d", "field": "delta", "aggFunc": "sum"}],
                "groupKeys": [],
            }
        )
    finally:
        reload_storage_config()
    assert resp.success, resp.error
    assert {r["portfolio_id"]: r["delta"] for r in resp.rows} == {"P1": 1.0, "P2": 0.5}


def test_hive_partitioned_risk_store_exposes_partition_columns(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    # fina-risk's directory/hive layout: {tableName}/region=*/date=*/*.parquet
    part = tmp_path / "risk_wide" / "region=APAC" / "date=2026-09-12"
    part.mkdir(parents=True)
    _risk_wide().to_parquet(part / "part-000.parquet")
    monkeypatch.setenv("FINA_OLAP_STORE", "local")
    monkeypatch.setenv("FINA_OLAP_PARQUET_ROOT", str(tmp_path))
    monkeypatch.setenv("FINA_OLAP_PARTITION_GLOB", "{tableName}/region=*/date=*/*.parquet")
    monkeypatch.setenv("FINA_OLAP_HIVE_PARTITIONING", "1")
    reload_storage_config()
    try:
        resp = OlapEngine().query(
            {
                "tableName": "risk_wide",
                "rowGroupCols": [{"id": "r", "field": "region"}],
                "valueCols": [{"id": "pv", "field": "base_pv", "aggFunc": "sum"}],
                "groupKeys": [],
            }
        )
    finally:
        reload_storage_config()
    assert resp.success, resp.error
    assert resp.rows[0]["region"] == "APAC"
    assert resp.rows[0]["base_pv"] == pytest.approx(35.0)
