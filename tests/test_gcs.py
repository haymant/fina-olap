"""GCS (S3-interoperable) round-trip test.

Runs only when GCS credentials are configured — either exported in the
environment or present in the repo ``.env`` — and ``S3_ENDPOINT`` points at
``storage.googleapis.com``. It writes a tiny parquet under ``_pytest/`` and
reads it back through the full ``OlapEngine`` (DuckDB httpfs + GCS S3 secret),
so it exercises the remote parquet path end to end. Skipped (not failed) when
the endpoint is unreachable, so offline CI stays green.

Credentials from ``.env`` are injected per-test with ``monkeypatch`` so the
global environment is never mutated for other tests.
"""

from __future__ import annotations

import os
from pathlib import Path

import duckdb
import pytest

from fina_olap.engine import OlapEngine
from fina_olap.gcs import configure_duckdb_object_store, object_store_configured

_CRED_VARS = ("S3_API_KEY", "S3_API_SECRET", "S3_BUCKET_NAME", "S3_ENDPOINT")


def _read_dotenv() -> dict[str, str]:
    path = Path(__file__).resolve().parents[1] / ".env"
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            out[key.strip()] = value.strip()
    return out


_DOTENV = _read_dotenv()


def _setting(name: str) -> str | None:
    return os.environ.get(name) or _DOTENV.get(name)


def _gcs_bucket() -> str | None:
    bucket = _setting("S3_BUCKET_NAME") or _setting("FINA_OLAP_BUCKET")
    endpoint = _setting("S3_ENDPOINT") or ""
    has_gcs = bool(_setting("S3_API_KEY") and _setting("S3_API_SECRET"))
    has_aws = bool(os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY"))
    if not bucket or "googleapis.com" not in endpoint or not (has_gcs or has_aws):
        return None
    return bucket.removeprefix("s3://").removeprefix("gs://").rstrip("/")


pytestmark = pytest.mark.skipif(_gcs_bucket() is None, reason="GCS S3 credentials not configured")


def test_parquet_round_trip_via_gcs(monkeypatch: pytest.MonkeyPatch):
    for var in _CRED_VARS:
        if var in _DOTENV:
            monkeypatch.setenv(var, _DOTENV[var])
    assert object_store_configured()

    bucket = _gcs_bucket()
    assert bucket  # guarded by the skipif marker
    key = f"s3://{bucket}/_pytest/fina_olap_probe.parquet"

    con = duckdb.connect(":memory:")
    configure_duckdb_object_store(con)
    try:
        con.execute(
            "CREATE TABLE t AS SELECT * FROM (VALUES "
            "('Portfolio 1', 'Instrument 1', 'put', 1.5), "
            "('Portfolio 1', 'Instrument 1', 'note', 2.5)) "
            "AS v(portfolio, instrument, leg, delta)"
        )
        con.execute(f"COPY t TO '{key}' (FORMAT PARQUET)")
    except Exception as exc:  # pragma: no cover - network dependent
        pytest.skip(f"GCS endpoint unreachable: {exc}")

    resp = OlapEngine().query(
        {
            "dataSource": {"uri": key},
            "rowGroupCols": [{"id": "p", "field": "portfolio"}],
            "valueCols": [{"id": "d", "field": "delta", "aggFunc": "sum"}],
            "groupKeys": [],
            "includeGrandTotal": True,
        }
    )
    assert resp.success, resp.error
    # leading grand-total row + the portfolio rollup, both summing to 4.0
    assert float(resp.rows[0]["delta"]) == pytest.approx(4.0)
    assert resp.rows[0]["portfolio"] is None
    assert resp.rows[1]["portfolio"] == "Portfolio 1"
    assert float(resp.rows[1]["delta"]) == pytest.approx(4.0)
