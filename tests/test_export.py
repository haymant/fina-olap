"""Export tests: CSV / JSON / JSONL / Parquet with filters, columns and limit."""

from __future__ import annotations

import json

import pandas as pd
import pytest

from fina_olap.engine import OlapEngine
from fina_olap.export import export_store
from fina_olap.fixture import DEFAULT_ROW_COUNT

ENGINE = OlapEngine(fixture_fallback=False)

# The fixture repeats instrument/portfolio rows 3x, so the parquet file holds
# 3 * DEFAULT_ROW_COUNT rows; "Portfolio 1" covers ids 1..100 (= 300 rows).
FIXTURE_ROWS = DEFAULT_ROW_COUNT * 3
PORTFOLIO1_ROWS = 100 * 3

TEXT_EQUALS_PORTFOLIO1 = {"portfolio": {"filterType": "text", "type": "equals", "filter": "Portfolio 1"}}


def test_export_csv_all_rows(tmp_path) -> None:
    out = tmp_path / "out.csv"
    result = export_store(ENGINE, table_name="trades", out_path=str(out))
    assert result["data_format"] == "csv"
    assert result["rows_exported"] == FIXTURE_ROWS
    frame = pd.read_csv(out)
    assert len(frame) == FIXTURE_ROWS
    assert {"portfolio", "instrument", "delta"}.issubset(frame.columns)


def test_export_json_array_and_jsonl(tmp_path) -> None:
    out_json = tmp_path / "out.json"
    result = export_store(ENGINE, table_name="trades", out_path=str(out_json))
    assert result["data_format"] == "json"
    parsed = json.loads(out_json.read_text())
    assert isinstance(parsed, list) and len(parsed) == FIXTURE_ROWS

    out_jsonl = tmp_path / "out.ndjson"
    result = export_store(ENGINE, table_name="trades", out_path=str(out_jsonl))
    assert result["data_format"] == "ndjson"
    lines = [ln for ln in out_jsonl.read_text().splitlines() if ln.strip()]
    assert len(lines) == FIXTURE_ROWS
    assert json.loads(lines[0])["portfolio"] == "Portfolio 1"


def test_export_parquet_roundtrip(tmp_path) -> None:
    out = tmp_path / "out.parquet"
    result = export_store(ENGINE, table_name="trades", out_path=str(out))
    assert result["data_format"] == "parquet"
    assert len(pd.read_parquet(out)) == FIXTURE_ROWS


def test_export_filtered_text_equals(tmp_path) -> None:
    out = tmp_path / "p1.csv"
    result = export_store(ENGINE, table_name="trades", out_path=str(out), filters=TEXT_EQUALS_PORTFOLIO1)
    assert result["rows_exported"] == len(pd.read_csv(out))
    assert result["rows_exported"] == PORTFOLIO1_ROWS
    assert set(pd.read_csv(out)["portfolio"]) == {"Portfolio 1"}
    assert result["columns"] == sorted(set(pd.read_csv(out).columns))


def test_export_limit_and_columns_subset(tmp_path) -> None:
    out = tmp_path / "few.parquet"
    result = export_store(ENGINE, table_name="trades", out_path=str(out), columns="portfolio,delta", limit=10)
    assert result["rows_exported"] == 10
    assert result["columns"] == ["portfolio", "delta"]  # caller order preserved
    frame = pd.read_parquet(out)
    assert len(frame) == 10 and set(frame.columns) == {"portfolio", "delta"}


def test_export_combined_filter_condition(tmp_path) -> None:
    out = tmp_path / "combo.csv"
    filters = {
        "delta": {
            "filterType": "number",
            "type": "inRange",
            "filter": 0.0,
            "filterTo": 0.5,
        }
    }
    result = export_store(ENGINE, table_name="trades", out_path=str(out), filters=filters)
    frame = pd.read_csv(out)
    assert result["rows_exported"] == len(frame) and result["rows_exported"] > 0
    assert frame["delta"].min() >= 0.0 and frame["delta"].max() <= 0.5


def test_export_format_override_and_errors(tmp_path) -> None:
    out = tmp_path / "weird.xyz"
    with pytest.raises(ValueError, match="unsupported export format"):
        export_store(ENGINE, table_name="trades", out_path=str(out), data_format="xml")
    with pytest.raises(ValueError, match="not present"):
        export_store(ENGINE, table_name="trades", out_path=str(tmp_path / "x.parquet"), columns="nope")
    with pytest.raises(ValueError, match="identifier"):
        export_store(ENGINE, table_name="trades", out_path=str(tmp_path / "x.parquet"), columns="bad ident")
