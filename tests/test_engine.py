# ruff: noqa: E501
"""End-to-end engine tests mirroring the reference test scope in .tmp/ut.py."""

from __future__ import annotations

import os

import pandas as pd
import pytest

from fina_olap.engine import OlapEngine
from fina_olap.fixture import DEFAULT_ROW_COUNT
from fina_olap.schema import SSRMResponse

PAYLOAD_3LVL = {
    "rowGroupCols": [
        {"id": "portfolio", "field": "portfolio"},
        {"id": "instrument", "field": "instrument"},
        {"id": "leg", "field": "leg"},
    ],
    "valueCols": [
        {"id": "delta", "aggFunc": "sum", "field": "delta"},
        {"id": "gamma", "aggFunc": "sum", "field": "gamma"},
    ],
}


def run(engine, payload: dict) -> SSRMResponse:
    return engine.query(payload)


def test_fixture_generation_shape(engine):
    path = os.environ["FINA_OLAP_FIXTURE"]
    df = pd.read_parquet(path)
    assert len(df) == DEFAULT_ROW_COUNT * 3
    assert "portfolio" in df.columns
    assert "leg" in df.columns
    assert df["portfolio"].nunique() == 5


def test_grouping_by_portfolio(engine):
    resp = run(
        engine,
        {
            "rowGroupCols": [{"id": "portfolio", "field": "portfolio"}],
            "valueCols": [{"id": "delta", "aggFunc": "sum", "field": "delta"}],
            "groupKeys": [],
        },
    )
    assert resp.success
    portfolios = {r["portfolio"] for r in resp.rows}
    assert portfolios == {"Portfolio 1", "Portfolio 2", "Portfolio 3", "Portfolio 4", "Portfolio 5"}


def test_sub_grouping_by_instrument(engine):
    base = {
        "rowGroupCols": [{"id": "portfolio", "field": "portfolio"}, {"id": "instrument", "field": "instrument"}],
        "startRow": 0,
        "endRow": 300,
    }
    p1 = run(engine, {**base, "groupKeys": ["Portfolio 1"]})
    assert p1.success and len(p1.rows) == 100
    p2 = run(engine, {**base, "groupKeys": ["Portfolio 2"], "endRow": 300})
    assert p2.success and len(p2.rows) == 200


def test_grouped_pagination_is_deterministic(engine):
    """Without a sortModel, group rows must still order by the group columns so
    paged results are stable across rows, requests and processes (DuckDB hash
    aggregation order is otherwise process-random)."""
    base = {
        "rowGroupCols": [{"id": "portfolio", "field": "portfolio"}, {"id": "instrument", "field": "instrument"}],
        "groupKeys": ["Portfolio 1"],
        "sortModel": [],
        "page_size": 20,
    }
    first_page = run(engine, {**base, "startRow": 0, "endRow": 20})
    second_page = run(engine, {**base, "startRow": 20, "endRow": 40})
    third_page = run(engine, {**base, "startRow": 40, "endRow": 60})
    ordered = sorted(f"Instrument {i}" for i in range(1, 101))
    assert [r["instrument"] for r in first_page.rows] == ordered[0:20]
    assert [r["instrument"] for r in second_page.rows] == ordered[20:40]
    assert [r["instrument"] for r in third_page.rows] == ordered[40:60]


def test_sub_grouping_by_leg(engine):
    resp = run(
        engine,
        {
            "rowGroupCols": [
                {"id": "portfolio", "field": "portfolio"},
                {"id": "instrument", "field": "instrument"},
                {"id": "leg", "field": "leg"},
            ],
            "groupKeys": ["Portfolio 1", "Instrument 1"],
        },
    )
    assert resp.success
    assert {r["leg"] for r in resp.rows} == {"put", "note", "funding"}


def test_sorting_by_portfolio(engine):
    payload = {"rowGroupCols": [{"id": "portfolio", "field": "portfolio"}], "groupKeys": []}
    resp = run(engine, {**payload, "sortModel": [{"colId": "portfolio", "sort": "asc"}]})
    names = [r["portfolio"] for r in resp.rows]
    assert names == sorted(names)
    resp = run(engine, {**payload, "sortModel": [{"colId": "portfolio", "sort": "desc"}]})
    names = [r["portfolio"] for r in resp.rows]
    assert names == sorted(names, reverse=True)


def test_filtering_with_grouping(engine):
    payload = {
        "rowGroupCols": [{"id": "portfolio", "field": "portfolio"}],
        "valueCols": [
            {"id": "delta", "aggFunc": "sum", "field": "delta"},
            {"id": "vega", "aggFunc": "avg", "field": "vega"},
        ],
        "filterModel": {
            "portfolio": {"filterType": "set", "values": ["Portfolio 1", "Portfolio 2"]},
            "instrument": {
                "filterType": "set",
                "values": ["Instrument 1", "Instrument 3", "Instrument 5", "Instrument 101"],
            },
            "delta": {"filterType": "number", "type": "greaterThan", "filter": 0.03},
            "vega": {"filterType": "number", "type": "greaterThan", "filter": 0.001},
        },
        "groupKeys": [],
    }
    resp = run(engine, payload)
    assert resp.success
    assert {r["portfolio"] for r in resp.rows} <= {"Portfolio 1", "Portfolio 2"}


def test_pivot_by_leg(engine):
    resp = run(
        engine,
        {
            "rowGroupCols": [{"id": "portfolio", "field": "portfolio"}],
            "pivotCols": [{"id": "leg", "field": "leg"}],
            "valueCols": [{"id": "delta", "aggFunc": "sum", "field": "delta"}],
            "pivotMode": True,
        },
    )
    assert resp.success
    fields = set(resp.pivotResultFields)
    assert {"put_delta", "note_delta", "funding_delta"} <= fields
    assert any("put_delta" in r for r in resp.rows)


def test_custom_aggregation_by_level(engine):
    payload = {
        "rowGroupCols": [
            {"id": "portfolio", "field": "portfolio"},
            {"id": "instrument", "field": "instrument"},
            {"id": "leg", "field": "leg"},
        ],
        "valueCols": [{"id": "delta", "field": "delta", "aggFuncsByLevel": {"leg": "first"}}],
        "groupKeys": ["Portfolio 1", "Instrument 1"],
    }
    resp = run(engine, payload)
    assert resp.success
    assert len(resp.rows) == 3
    assert all(r["delta"] is not None for r in resp.rows)


def test_visible_levels_hide_at_instrument(engine):
    payload = {
        "rowGroupCols": [
            {"id": "portfolio", "field": "portfolio"},
            {"id": "instrument", "field": "instrument"},
        ],
        "valueCols": [{"id": "population", "field": "qty", "aggFunc": "sum", "visibleLevels": [0]}],
        "groupKeys": ["Portfolio 1"],
    }
    resp = run(engine, payload)
    assert resp.success
    # at instrument depth (level 1) the metric is suppressed -> NULL
    assert all(r["qty"] is None for r in resp.rows)


def test_none_agg_by_level_suppresses_metric(engine):
    """Per-level aggregation sentinel "none" = no aggregation at this layer."""
    payload = {
        "rowGroupCols": [
            {"id": "portfolio", "field": "portfolio"},
            {"id": "instrument", "field": "instrument"},
        ],
        "valueCols": [{"id": "delta", "field": "delta", "aggFunc": "sum", "aggFuncsByLevel": {"instrument": "none"}}],
        "groupKeys": ["Portfolio 1"],
    }
    resp = run(engine, payload)
    assert resp.success
    # instrument rows (level 1) carry no aggregate -> NULL
    assert all(r["delta"] is None for r in resp.rows)

    # deeper level unaffected: leaves re-aggregate with the default agg
    leaves = run(engine, {**payload, "groupKeys": ["Portfolio 1", "Instrument 1"]})
    assert leaves.success
    assert all(r["delta"] is not None for r in leaves.rows)


def test_list_tables_local(tmp_path):
    """Directory names become tables; flat files become single-file tables."""
    root = tmp_path / "warehouse"
    (root / "trades").mkdir(parents=True)
    (root / "orders").mkdir()
    pd.DataFrame({"a": [1]}).to_parquet(root / "trades" / "part1.parquet")
    pd.DataFrame({"a": [2]}).to_parquet(root / "trades" / "part2.parquet")
    pd.DataFrame({"a": [3]}).to_parquet(root / "orders" / "part1.parquet")
    pd.DataFrame({"a": [9]}).to_parquet(root / "single.parquet")

    tables = OlapEngine().list_tables({"dataSource": {"uri": f"{root}/**/*.parquet"}})
    names = {t["tableName"] for t in tables}
    assert names == {"trades", "orders", "single"}
    trades = next(t for t in tables if t["tableName"] == "trades")
    assert trades["uri"].endswith("trades/*.parquet")


def test_list_tables_hive_partitions_use_file_stem(tmp_path):
    """Hive partition dirs must not become table names; the file stem is used."""
    part = tmp_path / "warehouse" / "instance_id=c4e37029" / "date=2026-09-12"
    part.mkdir(parents=True)
    pd.DataFrame({"a": [1]}).to_parquet(part / "risk_wide.parquet")

    tables = OlapEngine().list_tables({"dataSource": {"uri": f"{tmp_path}/warehouse/**/*.parquet"}})
    assert [t["tableName"] for t in tables] == ["risk_wide"]
    # glob keeps the partition depth so every partition is read
    assert tables[0]["uri"].endswith("warehouse/*/*/risk_wide*.parquet")


def test_list_tables_table_dir_with_hive_below(tmp_path):
    """A named table directory under a hive partition keeps the directory name."""
    part = tmp_path / "wh" / "instance_id=abc" / "trades" / "region=APAC"
    part.mkdir(parents=True)
    pd.DataFrame({"a": [1]}).to_parquet(part / "part-000.parquet")

    tables = OlapEngine().list_tables({"dataSource": {"uri": f"{tmp_path}/wh/**/*.parquet"}})
    assert [t["tableName"] for t in tables] == ["trades"]
    assert tables[0]["uri"].endswith("wh/*/trades/*/*.parquet")


def test_default_agg_is_type_aware(engine):
    """Measures without an explicit aggFunc default by column type (no Binder errors)."""
    resp = run(
        engine,
        {
            "rowGroupCols": [{"id": "portfolio", "field": "portfolio"}],
            "valueCols": [
                {"id": "v_delta", "field": "delta"},  # numeric -> sum
                {"id": "v_ccy", "field": "paymentCcy"},  # text -> none (NULL)
                {"id": "v_fix", "field": "lastFixingDate"},  # date -> max
            ],
            "groupKeys": [],
        },
    )
    assert resp.success, resp.error
    row = resp.rows[0]
    assert row["delta"] is not None
    assert row["paymentCcy"] is None
    assert row["lastFixingDate"] is not None


def test_leaf_rows_omit_hidden_measure(engine):
    base = {
        "rowGroupCols": [
            {"id": "portfolio", "field": "portfolio"},
            {"id": "instrument", "field": "instrument"},
        ],
        "valueCols": [{"id": "delta", "field": "delta", "aggFunc": "sum", "visibleLevels": [0, 1]}],
    }
    # aggregated group rows still carry the measure
    grouped = run(engine, {**base, "groupKeys": ["Portfolio 1"]})
    assert grouped.success
    assert grouped.rows and all(r["delta"] is not None for r in grouped.rows)

    # fully-drilled raw leaf rows omit the measure entirely (SELECT * EXCLUDE)
    leaves = run(engine, {**base, "groupKeys": ["Portfolio 1", "Instrument 1"]})
    assert leaves.success
    assert leaves.rows and all("delta" not in r for r in leaves.rows)

    # without visibleLevels the leaf rows keep it
    visible = run(
        engine,
        {
            **base,
            "valueCols": [{"id": "delta", "field": "delta"}],
            "groupKeys": ["Portfolio 1", "Instrument 1"],
        },
    )
    assert visible.success
    assert visible.rows and all("delta" in r for r in visible.rows)


def test_grand_total(engine):
    resp = run(
        engine,
        {
            "rowGroupCols": [
                {"id": "portfolio", "field": "portfolio"},
                {"id": "instrument", "field": "instrument"},
            ],
            "valueCols": [{"id": "delta", "aggFunc": "sum", "field": "delta"}],
            "groupKeys": [],
            "includeGrandTotal": True,
        },
    )
    assert resp.success
    assert len(resp.rows) == 6
    assert resp.rows[0]["portfolio"] is None
    assert resp.rows[0]["delta"] is not None


def test_grand_total_independent_of_level_agg(engine):
    """The grand total uses its own agg over all records, not a level rollup."""
    resp = run(
        engine,
        {
            "rowGroupCols": [
                {"id": "portfolio", "field": "portfolio"},
                {"id": "instrument", "field": "instrument"},
            ],
            "valueCols": [
                {"id": "delta", "field": "delta", "aggFuncsByLevel": {"portfolio": "none"}},
            ],
            "groupKeys": [],
            "includeGrandTotal": True,
            "grandTotalAggFunc": "sum",
        },
    )
    assert resp.success
    gt_delta = resp.rows[0]["delta"]
    # "none" at the portfolio level must NOT blank the grand total
    assert gt_delta is not None
    expected = run(
        engine,
        {"valueCols": [{"id": "delta", "field": "delta", "aggFunc": "sum"}], "groupKeys": []},
    )
    assert expected.success
    assert abs(gt_delta - expected.rows[0]["delta"]) < 1e-9


def test_grand_total_with_pivot_no_broken_union(engine):
    """Pivot changes the row shape; grand total silently disabled there."""
    resp = run(
        engine,
        {
            "rowGroupCols": [{"id": "portfolio", "field": "portfolio"}],
            "pivotCols": [{"id": "leg", "field": "leg"}],
            "valueCols": [{"id": "delta", "aggFunc": "sum", "field": "delta"}],
            "pivotMode": True,
            "groupKeys": [],
            "includeGrandTotal": True,
        },
    )
    assert resp.success
    assert any(r["portfolio"] is not None for r in resp.rows)


def test_multi_level_expansion_and_sort(engine):
    s1 = run(engine, {**PAYLOAD_3LVL, "groupKeys": [], "sortModel": [{"colId": "portfolio", "sort": "asc"}]})
    assert [r["portfolio"] for r in s1.rows] == [f"Portfolio {i}" for i in range(1, 6)]

    s2 = run(
        engine,
        {
            **PAYLOAD_3LVL,
            "groupKeys": ["Portfolio 1"],
            "sortModel": [{"colId": "instrument", "sort": "asc"}],
            "endRow": 100,
        },
    )
    assert s2.rows[0]["instrument"] == "Instrument 1"
    assert s2.rows[1]["instrument"] == "Instrument 10"

    s3 = run(
        engine,
        {**PAYLOAD_3LVL, "groupKeys": ["Portfolio 1", "Instrument 2"], "sortModel": [{"colId": "leg", "sort": "asc"}]},
    )
    assert [r["leg"] for r in s3.rows] == ["funding", "note", "put"]


def test_advanced_filtering_and_expansion(engine):
    base = dict(PAYLOAD_3LVL)
    base["filterModel"] = {
        "portfolio": {"filterType": "set", "values": ["Portfolio 1", "Portfolio 2", "Portfolio 3"]},
        "instrument": {"filterType": "set", "values": ["Instrument 2", "Instrument 4"]},
    }
    s1 = run(engine, {**base, "groupKeys": []})
    assert s1.success and len(s1.rows) == 1 and s1.rows[0]["portfolio"] == "Portfolio 1"
    s2 = run(engine, {**base, "groupKeys": ["Portfolio 1"]})
    assert {r["instrument"] for r in s2.rows} == {"Instrument 2", "Instrument 4"}
    s3 = run(engine, {**base, "groupKeys": ["Portfolio 1", "Instrument 2"]})
    assert len(s3.rows) == 3


def test_totals_metadata(engine):
    resp = run(
        engine,
        {
            "rowGroupCols": [{"id": "portfolio", "field": "portfolio"}],
            "valueCols": [{"id": "delta", "aggFunc": "sum", "field": "delta"}],
            "groupKeys": [],
            "includeTotals": True,
        },
    )
    assert resp.success
    assert "delta" in resp.totals


def test_lod_fixed_computed_values(engine):
    resp = run(
        engine,
        {
            "rowGroupCols": [{"id": "portfolio", "field": "portfolio"}, {"id": "instrument", "field": "instrument"}],
            "groupKeys": ["Portfolio 1"],
            "valueCols": [{"id": "d", "aggFunc": "sum", "field": "delta"}],
            "lodConfig": {"type": "fixed", "groupKeys": ["portfolio"], "metrics": {"delta": "sum"}, "prefix": "_lod_"},
        },
    )
    assert resp.success
    assert "_lod_delta" in resp.lodFields
    per_portfolio = {r["portfolio"]: r["_lod_delta"] for r in resp.rows}
    assert len(set(per_portfolio.values())) == 1
    # The fixed value equals the portfolio-level sum of delta (whole-table agg)
    total = run(
        engine,
        {
            "valueCols": [{"id": "delta", "aggFunc": "sum", "field": "delta"}],
            "groupKeys": [],
            "filterModel": {"portfolio": {"filterType": "text", "type": "equals", "filter": "Portfolio 1"}},
        },
    )
    assert total.success and len(total.rows) == 1
    expected = total.rows[0]["delta"]
    assert abs(next(iter(per_portfolio.values())) - expected) < 1e-9


def test_pagination_last_row_sentinel(engine):
    # limit smaller than page -> lastRow == start+len(rows)
    resp = run(
        engine,
        {"rowGroupCols": [{"id": "portfolio", "field": "portfolio"}], "groupKeys": [], "startRow": 0, "endRow": 100},
    )
    assert resp.lastRow == 5
    # want 4 of 5 portfolios -> more rows exist -> -1
    resp = run(engine, {"rowGroupCols": [], "groupKeys": [], "startRow": 0, "endRow": 4})
    assert resp.lastRow == -1


def test_advanced_filter_single_column(engine):
    resp = run(
        engine,
        {
            "rowGroupCols": [{"id": "portfolio", "field": "portfolio"}],
            "groupKeys": [],
            "advancedFilterModel": {
                "colId": "portfolio",
                "filterType": "text",
                "type": "equals",
                "filter": "Portfolio 1",
            },
        },
    )
    assert resp.success and len(resp.rows) == 1


def test_bad_payload_rejected(engine):
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        engine.query({"rowGroupCols": [{"id": "x", "field": "not a valid identifier"}]})


def test_unknown_table_uses_fixture(engine):
    resp = engine.query(
        {"tableName": "trades", "rowGroupCols": [{"id": "portfolio", "field": "portfolio"}], "groupKeys": []}
    )
    assert resp.success


def test_response_serializer_coerces_datetimes(engine: OlapEngine) -> None:
    """Timestamp/date values in rows must survive model_dump as ISO strings."""
    resp = run(engine, {"rowGroupCols": [], "groupKeys": [], "startRow": 0, "endRow": 5})
    assert len(resp.rows) == 5
    dumped = resp.model_dump()
    date_vals = {k: v for row in dumped["rows"] for k, v in row.items() if k == "lastFixingDate"}
    assert date_vals, "fixture should carry a date column"
    for value in date_vals.values():
        assert value is None or (isinstance(value, str) and len(value) >= 10)
    import json

    json.dumps(dumped)  # must not raise


def test_grand_total_with_no_measures_is_harmless(engine: OlapEngine) -> None:
    """includeGrandTotal with no groups/values must not emit an empty SELECT."""
    resp = run(
        engine,
        {
            "rowGroupCols": [],
            "valueCols": [],
            "groupKeys": [],
            "startRow": 0,
            "endRow": 3,
            "includeGrandTotal": True,
        },
    )
    assert resp.success
    assert len(resp.rows) == 3
