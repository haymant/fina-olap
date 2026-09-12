# ruff: noqa: E501
"""Builder-level unit tests: SQL shape, parameterization, no unvalidated identifiers."""

from __future__ import annotations

import duckdb
import pytest

from fina_olap.builder import DuckDBSqlBuilder
from fina_olap.fixture import DEFAULT_ROW_COUNT, generate_fixture
from fina_olap.schema import SSRMRequest


@pytest.fixture(scope="module")
def con(tmp_path_factory: pytest.TempPathFactory) -> duckdb.DuckDBPyConnection:
    path = tmp_path_factory.mktemp("builder") / "f.parquet"
    generate_fixture(DEFAULT_ROW_COUNT, str(path), force=True)
    con = duckdb.connect(":memory:")
    con.execute(f"CREATE OR REPLACE VIEW trades AS SELECT * FROM read_parquet('{path}')")
    return con


def build(con: duckdb.DuckDBPyConnection, payload: dict) -> tuple[str, list, list[str]]:
    request = SSRMRequest.model_validate(payload)
    built = DuckDBSqlBuilder(request, "trades", con).build()
    return built.sql, built.params, built.pivot_result_fields


def test_grouping_select_uses_validated_fields(con):
    sql, params, _ = build(
        con,
        {
            "rowGroupCols": [{"id": "p", "field": "portfolio"}],
            "valueCols": [{"id": "d", "field": "delta", "aggFunc": "sum"}],
            "groupKeys": [],
        },
    )
    assert '"portfolio"' in sql
    assert 'sum("delta")' in sql
    assert "GROUP BY" in sql
    assert params == []


def test_group_keys_become_placeholders_not_literals(con):
    sql, params, _ = build(
        con,
        {
            "rowGroupCols": [{"id": "p", "field": "portfolio"}, {"id": "i", "field": "instrument"}],
            "groupKeys": ["Portfolio 1"],
        },
    )
    assert '"portfolio" = ?' in sql
    assert params == ["Portfolio 1"]
    # no literal interpolation sneak-through
    assert "Portfolio 1" not in sql


def test_filter_values_parameterized(con):
    sql, params, _ = build(
        con,
        {
            "rowGroupCols": [],
            "valueCols": [],
            "filterModel": {
                "portfolio": {"filterType": "set", "values": ["Portfolio 1", "Portfolio 2"]},
                "delta": {"filterType": "number", "type": "greaterThan", "filter": 0.03},
            },
        },
    )
    assert params == ["Portfolio 1", "Portfolio 2", 0.03]
    assert "Portfolio 1" not in sql
    assert "%" not in sql.replace("%%", "")


def test_filter_accepts_client_operator_shape(con):
    """The fina-table client sends `operator` (ag-grid sends `type`); both work."""
    sql, params, _ = build(
        con,
        {
            "rowGroupCols": [],
            "valueCols": [],
            "filterModel": {
                "portfolio": {"filterType": "text", "operator": "contains", "filter": "olio 1"},
                "delta": {"filterType": "number", "operator": "notEquals", "filter": 0.0},
            },
        },
    )
    assert 'ILIKE' in sql
    assert '"delta" != ?' in sql
    assert params == ["olio 1", 0.0]


def test_boolean_filter_sql(con):
    builder = DuckDBSqlBuilder(SSRMRequest.model_validate({}), "trades", con)
    sql, params = builder._filter_sql("flag", {"filterType": "boolean", "type": "equals", "filter": True})
    assert sql == '"flag" IS TRUE'
    assert params == []
    sql, params = builder._filter_sql("flag", {"filterType": "boolean", "operator": "notEquals", "filter": True})
    assert sql == '"flag" IS NOT TRUE'
    assert params == []


def test_combined_filter_operator(con):
    sql, params, _ = build(
        con,
        {
            "rowGroupCols": [],
            "filterModel": {
                "portfolio": {
                    "filterType": "number",
                    "operator": "OR",
                    "condition1": {"filterType": "text", "type": "equals", "filter": "A"},
                    "condition2": {"filterType": "text", "type": "equals", "filter": "B"},
                }
            },
        },
    )
    assert "OR" in sql
    assert params == ["A", "B"]


def test_sort_only_on_output_columns(con):
    sql, params, _ = build(
        con,
        {
            "rowGroupCols": [{"id": "p", "field": "portfolio"}],
            "groupKeys": [],
            "sortModel": [{"colId": "portfolio", "sort": "asc"}, {"colId": "missing_col", "sort": "desc"}],
        },
    )
    assert '"portfolio" asc' in sql
    assert "missing_col" not in sql


def test_pagination_limit_plus_one(con):
    sql, _, _ = build(con, {"startRow": 10, "endRow": 110})
    assert "LIMIT 101" in sql
    assert "OFFSET 10" in sql


def test_grand_total_union(con):
    sql, _, _ = build(
        con,
        {
            "rowGroupCols": [{"id": "p", "field": "portfolio"}],
            "valueCols": [{"id": "d", "field": "delta"}],
            "includeGrandTotal": True,
            "groupKeys": [],
        },
    )
    assert "UNION ALL" in sql
    assert 'NULL AS "portfolio"' in sql


def test_pivot_builds_condition_placeholders(con):
    sql, params, fields = build(
        con,
        {
            "rowGroupCols": [{"id": "p", "field": "portfolio"}],
            "pivotCols": [{"id": "l", "field": "leg"}],
            "valueCols": [{"id": "d", "field": "delta", "aggFunc": "sum"}],
            "pivotMode": True,
        },
    )
    assert any(f == "put_delta" for f in fields)
    assert any(f == "note_delta" for f in fields)
    assert any(f == "funding_delta" for f in fields)
    # executing the built query with params must succeed
    con.execute(sql, params)
    assert params  # pivot combos are parameterized


def test_pivot_non_numeric_uses_min(con):
    _, _, fields = build(
        con,
        {
            "rowGroupCols": [{"id": "p", "field": "portfolio"}],
            "pivotCols": [{"id": "l", "field": "leg"}],
            "valueCols": [{"id": "s", "field": "strategy", "aggFunc": "min"}],
            "pivotMode": True,
        },
    )
    assert len(fields) >= 3


def test_agg_funcs_by_level_field_key(con):
    sql, params, _ = build(
        con,
        {
            "rowGroupCols": [
                {"id": "p", "field": "portfolio"},
                {"id": "i", "field": "instrument"},
                {"id": "l", "field": "leg"},
            ],
            "groupKeys": ["Portfolio 1", "Instrument 1"],
            "valueCols": [{"id": "d", "field": "delta", "aggFuncsByLevel": {"leg": "first"}}],
        },
    )
    assert 'first("delta")' in sql


def test_agg_funcs_by_level_index_key(con):
    sql, _, _ = build(
        con,
        {
            "rowGroupCols": [{"id": "p", "field": "portfolio"}, {"id": "i", "field": "instrument"}],
            "groupKeys": ["Portfolio 1"],
            "valueCols": [{"id": "d", "field": "delta", "aggFuncsByLevel": {"1": "avg"}}],
        },
    )
    assert 'avg("delta")' in sql


def test_visible_levels_suppress_metric(con):
    sql, _, _ = build(
        con,
        {
            "rowGroupCols": [{"id": "p", "field": "portfolio"}, {"id": "i", "field": "instrument"}],
            "groupKeys": ["Portfolio 1"],
            "valueCols": [{"id": "d", "field": "delta", "aggFunc": "sum", "visibleLevels": [0]}],
        },
    )
    assert 'NULL AS "delta"' in sql
    assert 'sum("delta")' not in sql


def test_lod_fixed_joins_dimension_measures(con):
    sql, params, _ = build(
        con,
        {
            "rowGroupCols": [{"id": "p", "field": "portfolio"}, {"id": "i", "field": "instrument"}],
            "groupKeys": ["Portfolio 1"],
            "valueCols": [{"id": "d", "field": "delta", "aggFunc": "sum"}],
            "lodConfig": {"type": "fixed", "groupKeys": ["portfolio"], "metrics": {"delta": "sum"}, "prefix": "_lod_"},
        },
    )
    assert "LEFT JOIN" in sql
    assert '"portfolio"' in sql
    con.execute(sql, params)
    df = con.execute(sql, params).fetchdf()
    assert "_lod_delta" in df.columns
    # fixed LOD: every portfolio repeats the same portfolio-level delta
    assert len(df["_lod_delta"].unique()) == 1


def test_lod_exclude_dims(con):
    sql, _, _ = build(
        con,
        {
            "rowGroupCols": [{"id": "p", "field": "portfolio"}, {"id": "i", "field": "instrument"}],
            "groupKeys": [],
            "valueCols": [{"id": "d", "field": "delta", "aggFunc": "sum"}],
            "lodConfig": {"type": "exclude", "groupKeys": ["instrument"], "metrics": {"qty": "sum"}, "prefix": "lod_"},
        },
    )
    assert "LEFT JOIN" in sql


def test_lod_include_dims(con):
    sql, _, _ = build(
        con,
        {
            "rowGroupCols": [{"id": "p", "field": "portfolio"}],
            "groupKeys": [],
            "valueCols": [],
            "lodConfig": {"type": "include", "groupKeys": ["leg"], "metrics": {"qty": "count"}, "prefix": "_lod_"},
        },
    )
    assert "GROUP BY" in sql


def test_totals_query_built(con):
    built = DuckDBSqlBuilder(
        SSRMRequest.model_validate(
            {
                "rowGroupCols": [{"id": "p", "field": "portfolio"}],
                "valueCols": [{"id": "d", "field": "delta", "aggFunc": "sum"}],
                "includeTotals": True,
            }
        ),
        "trades",
        con,
    ).build()
    assert built.totals_sql and 'sum("delta")' in built.totals_sql
    cols = con.execute(built.totals_sql, built.totals_params).fetchdf()
    assert not cols.empty


def test_measure_default_agg_is_type_aware(con):
    sql, _, _ = build(
        con,
        {
            "rowGroupCols": [{"id": "p", "field": "portfolio"}],
            "valueCols": [
                {"id": "s", "field": "strategy"},
                {"id": "f", "field": "lastFixingDate"},
                {"id": "d", "field": "delta"},
            ],
            "groupKeys": [],
        },
    )
    assert 'NULL AS "strategy"' in sql  # text -> none (no aggregation)
    assert 'max("lastFixingDate")' in sql  # date/timestamp -> max
    assert 'sum("delta")' in sql  # numeric -> sum
