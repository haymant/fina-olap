"""Local filesystem Parquet sources: plain paths, ``file://`` URIs and directories.

Directory expansion is intentionally **non-recursive** (``*.parquet``) to avoid
walking huge trees; recursion is opt-in via an explicit glob.
"""

from __future__ import annotations

import pandas as pd
import pytest

from fina_olap.engine import OlapEngine, resolve_source
from fina_olap.schema import SSRMRequest


def _write(path, **cols) -> None:
    pd.DataFrame(cols).to_parquet(path)


def test_query_local_single_file(tmp_path):
    f = tmp_path / "risk_wide.parquet"
    _write(f, portfolio_id=["P1", "P1"], delta=[1.0, 2.0])
    resp = OlapEngine().query(
        {
            "dataSource": {"uri": f"file://{f}"},
            "rowGroupCols": [{"id": "p", "field": "portfolio_id"}],
            "valueCols": [{"id": "d", "field": "delta", "aggFunc": "sum"}],
            "groupKeys": [],
        }
    )
    assert resp.success, resp.error
    assert resp.rows[0]["delta"] == pytest.approx(3.0)


def test_query_local_directory_reads_direct_parquet(tmp_path):
    lake = tmp_path / "lake"
    lake.mkdir()
    _write(lake / "p.parquet", portfolio_id=["P1"], delta=[5.0])

    resp = OlapEngine().query(
        {
            "dataSource": {"uri": f"file://{lake}/"},
            "rowGroupCols": [{"id": "p", "field": "portfolio_id"}],
            "valueCols": [{"id": "d", "field": "delta", "aggFunc": "sum"}],
            "groupKeys": [],
        }
    )
    assert resp.success, resp.error
    assert resp.rows[0]["delta"] == pytest.approx(5.0)


def test_query_local_explicit_recursive_glob_with_hive(tmp_path):
    part = tmp_path / "lake" / "region=APAC"
    part.mkdir(parents=True)
    _write(part / "p.parquet", portfolio_id=["P1"], delta=[5.0])

    resp = OlapEngine().query(
        {
            "dataSource": {"uri": f"file://{tmp_path / 'lake'}/**/*.parquet"},
            "rowGroupCols": [{"id": "r", "field": "region"}],
            "valueCols": [{"id": "d", "field": "delta", "aggFunc": "sum"}],
            "groupKeys": [],
        }
    )
    assert resp.success, resp.error
    assert resp.rows[0]["region"] == "APAC"  # hive partition dir exposed
    assert resp.rows[0]["delta"] == pytest.approx(5.0)


def test_query_plain_local_path_without_scheme(tmp_path):
    f = tmp_path / "risk_wide.parquet"
    _write(f, portfolio_id=["P1"], delta=[7.0])
    resp = OlapEngine().query(
        {
            "dataSource": {"uri": str(f)},
            "valueCols": [{"id": "d", "field": "delta", "aggFunc": "sum"}],
            "groupKeys": [],
        }
    )
    assert resp.success, resp.error
    assert resp.rows[0]["delta"] == pytest.approx(7.0)


def test_resolve_source_expands_dir_non_recursively(tmp_path):
    lake = tmp_path / "lake"
    lake.mkdir()
    _write(lake / "a.parquet", x=[1])
    source = resolve_source(SSRMRequest.model_validate({"dataSource": {"uri": f"file://{lake}"}}))
    assert source.endswith("*.parquet")
    assert "**" not in source  # directory expansion must not force a full-tree walk


def test_list_tables_local_file_uri(tmp_path):
    lake = tmp_path / "lake"
    (lake / "trades").mkdir(parents=True)
    _write(lake / "trades" / "part.parquet", x=[1])
    _write(lake / "single.parquet", x=[2])

    # recursive listing is opt-in via the glob
    names = {
        t["tableName"]
        for t in OlapEngine().list_tables({"dataSource": {"uri": f"file://{lake}", "glob": "**/*.parquet"}})
    }
    assert names == {"trades", "single"}
