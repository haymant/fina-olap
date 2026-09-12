"""Upsert tests: CSV/JSON/Parquet files + inline rows into flat and hive-partitioned stores."""

from __future__ import annotations

import glob as globmod
import json
import os

import pandas as pd
import pyarrow.parquet as pq
import pytest

from fina_olap.engine import OlapEngine
from fina_olap.storage import clear_storage_override, set_storage_override
from fina_olap.upsert import partition_columns, upsert_store

ENGINE = OlapEngine(fixture_fallback=False)


@pytest.fixture()
def store_root(tmp_path):
    """Each test gets its own configured local root; overrides are reset after."""
    root = tmp_path / "store"
    root.mkdir()
    set_storage_override(store="local", root=str(root))
    yield root
    clear_storage_override()


def _rows(table: str = "trades", key: str = "id") -> list[dict]:
    resp = ENGINE.query(
        {"tableName": table, "startRow": 0, "endRow": 500, "sortModel": [{"colId": key, "sort": "asc"}]}
    )
    assert resp.success
    return resp.rows


def test_upsert_rows_create_update_and_insert(store_root) -> None:
    first = upsert_store(ENGINE, table_name="trades", key="id", rows=[{"id": 1, "name": "a", "delta": 1.5}])
    assert first["target_rows_before"] == 0 and first["inserted"] == 1 and first["target_rows_after"] == 1
    assert first["written_to"] == str(store_root / "trades.parquet")

    second = upsert_store(
        ENGINE,
        table_name="trades",
        key="id",
        rows=[{"id": 1, "name": "a2", "delta": 9.9}, {"id": 2, "name": "b", "delta": 2.5}],
    )
    assert second["matched"] == 1 and second["inserted"] == 1 and second["target_rows_after"] == 2

    rows = _rows()
    assert len(rows) == 2
    by_id = {r["id"]: r for r in rows}
    assert by_id[1]["name"] == "a2" and by_id[1]["delta"] == 9.9  # updated
    assert by_id[2]["name"] == "b"  # inserted


def test_upsert_csv_file_coerces_types(store_root, tmp_path) -> None:
    csv_path = tmp_path / "in.csv"
    csv_path.write_text("id,name,delta\n1,alpha,1.5\n2,beta,9.9\n")
    first = upsert_store(ENGINE, table_name="trades", key="id", file_path=str(csv_path), data_format="csv")
    assert first["target_rows_before"] == 0 and first["inserted"] == 2

    # A rows-backed update with identical values types must survive the rewrite
    # (COALESCE needs the incoming column cast to the store's type).
    second = upsert_store(ENGINE, table_name="trades", key="id", rows=[{"id": 2, "name": "beta2", "delta": 44.0}])
    assert second["matched"] == 1 and second["target_rows_after"] == 2

    by_id = {r["id"]: r for r in _rows()}
    assert by_id[2] == {"id": 2, "name": "beta2", "delta": 44.0}


def test_upsert_json_file_and_rows(store_root, tmp_path) -> None:
    json_path = tmp_path / "in.json"
    json_path.write_text(
        json.dumps([{"id": 10, "name": "ten", "delta": 1.25}, {"id": 11, "name": "eleven", "delta": 2.5}])
    )
    result = upsert_store(ENGINE, table_name="trades", key="id", file_path=str(json_path))
    assert result["target_rows_after"] == 2 and result["inserted"] == 2

    json_path.write_text(json.dumps([{"id": 10, "name": "ten-updated", "delta": 8.8}]))
    result = upsert_store(ENGINE, table_name="trades", key="id", file_path=str(json_path), data_format="json")
    assert result["matched"] == 1 and result["target_rows_after"] == 2

    by_id = {r["id"]: r for r in _rows()}
    assert by_id[10]["name"] == "ten-updated" and by_id[10]["delta"] == 8.8


def test_upsert_parquet_file_input(store_root, tmp_path) -> None:
    parquet_path = tmp_path / "in.parquet"
    pd.DataFrame([{"id": 1, "name": "one", "delta": 3.5}]).to_parquet(parquet_path, index=False)
    result = upsert_store(ENGINE, table_name="trades", key="id", file_path=str(parquet_path))
    assert result["inserted"] == 1 and _rows() == [{"id": 1, "name": "one", "delta": 3.5}]


def test_upsert_new_table_targets_configured_root_not_fixture(store_root) -> None:
    """A table absent from the configured root must be created there, never in
    the sample fixture the engine would otherwise fall back to."""
    fixture = os.getenv("FINA_OLAP_FIXTURE")
    fixture_before = pd.read_parquet(fixture) if fixture and os.path.exists(fixture) else None

    result = upsert_store(
        ENGINE,
        table_name="custom",
        key="ticker",
        rows=[{"ticker": "AAA", "close": 12.5}, {"ticker": "BBB", "close": 8.25}],
    )
    assert result["target_rows_before"] == 0
    assert result["written_to"] == str(store_root / "custom.parquet")
    assert os.path.exists(store_root / "custom.parquet")

    # schema comes from the incoming rows, not from the fixture's columns
    resp = ENGINE.query({"tableName": "custom", "startRow": 0, "endRow": 10})
    assert {c for r in resp.rows for c in r} == {"ticker", "close"}

    if fixture_before is not None:
        assert pd.read_parquet(fixture).shape == fixture_before.shape  # fixture untouched


def test_upsert_multi_column_key(store_root) -> None:
    upsert_store(
        ENGINE,
        table_name="trades",
        key="region, id",
        rows=[
            {"id": 1, "region": "EU", "name": "x", "delta": 1.0},
            {"id": 1, "region": "US", "name": "y", "delta": 2.0},
        ],
    )
    upsert_store(
        ENGINE,
        table_name="trades",
        key="region,id",
        rows=[{"id": 1, "region": "EU", "name": "x2", "delta": 10.0}],
    )
    rows = {(r["region"], r["id"]): r for r in _rows()}
    assert len(rows) == 2
    assert rows[("EU", 1)]["delta"] == 10.0  # updated
    assert rows[("US", 1)]["delta"] == 2.0  # untouched


def test_upsert_hive_partitioned_store(store_root) -> None:
    set_storage_override(
        store="local",
        root=str(store_root),
        partition_glob="{tableName}/region=*/date=*/*.parquet",
        hive_partitioning="1",
    )

    first = upsert_store(
        ENGINE,
        table_name="trades",
        key="id",
        rows=[
            {"id": 1, "region": "EU", "date": "2024-01-05", "delta": 1.5},
            {"id": 2, "region": "US", "date": "2024-01-06", "delta": 2.5},
        ],
    )
    assert first["hive_columns"] == ["region", "date"]
    assert first["written_to"] == str(store_root / "trades")
    assert len(globmod.glob(str(store_root / "trades" / "region=*" / "date=*" / "*.parquet"))) == 2

    second = upsert_store(
        ENGINE,
        table_name="trades",
        key="id",
        rows=[
            {"id": 1, "region": "EU", "date": "2024-01-05", "delta": 9.9},  # update inside one partition
            {"id": 3, "region": "EU", "date": "2024-01-06", "delta": 3.3},  # new row, new partition
        ],
    )
    assert second["matched"] == 1 and second["inserted"] == 1 and second["target_rows_after"] == 3

    rows = _rows(key="region")
    by_id = {r["id"]: r for r in rows}
    assert set(r["id"] for r in rows) == {1, 2, 3}
    assert by_id[1]["delta"] == 9.9  # updated value survived the rewrite
    assert by_id[3]["region"] == "EU" and str(by_id[3]["date"]).startswith("2024-01-06")


def test_upsert_missing_key_or_inputs_raise(store_root) -> None:
    with pytest.raises(ValueError, match="key"):
        upsert_store(ENGINE, table_name="trades", key="", rows=[{"id": 1}])
    with pytest.raises(ValueError, match="key column"):
        upsert_store(ENGINE, table_name="trades", key="nope", rows=[{"id": 1}])
    with pytest.raises(ValueError, match="file_path|rows"):
        upsert_store(ENGINE, table_name="trades", key="id")
    with pytest.raises(ValueError, match="data_format"):
        bad = store_root.parent / "x.xyz"
        bad.write_text("id\n1\n")
        upsert_store(ENGINE, table_name="trades", key="id", file_path=str(bad))


def test_upsert_appender_fresh_table(store_root) -> None:
    result = upsert_store(
        ENGINE,
        table_name="trades",
        key="id",
        appender=True,
        rows=[
            {"id": 1, "name": "a", "delta": 1.5},
            {"id": 2, "name": "b", "delta": 2.5},
        ],
    )
    assert result["writer"] == "appender"
    assert result["row_groups"] == 1
    assert result["target_rows_after"] == 2
    assert os.path.exists(store_root / "trades.parquet")
    by_id = {r["id"]: r for r in _rows()}
    assert by_id[1]["name"] == "a" and by_id[2]["delta"] == 2.5


def test_upsert_appender_merges_existing_and_row_groups(store_root) -> None:
    upsert_store(
        ENGINE,
        table_name="trades",
        key="id",
        rows=[
            {"id": 1, "name": "a", "delta": 1.5},
            {"id": 2, "name": "b", "delta": 2.5},
            {"id": 3, "name": "c", "delta": 3.5},
        ],
    )
    result = upsert_store(
        ENGINE,
        table_name="trades",
        key="id",
        appender=True,
        chunk_size=1,
        rows=[
            {"id": 1, "name": "a2", "delta": 9.9},  # update
            {"id": 4, "name": "d", "delta": 4.5},  # insert
        ],
    )
    assert result["writer"] == "appender"
    assert result["matched"] == 1 and result["inserted"] == 1 and result["target_rows_after"] == 4
    # 4 merged rows written one chunk/row-group at a time
    assert result["row_groups"] == 4
    assert pq.ParquetFile(store_root / "trades.parquet").num_row_groups == 4

    by_id = {r["id"]: r for r in _rows()}
    assert by_id[1]["name"] == "a2" and by_id[1]["delta"] == 9.9  # updated
    assert by_id[4]["name"] == "d"  # inserted
    assert by_id[2]["delta"] == 2.5  # untouched


def test_upsert_appender_copy_and_arrow_writers_agree(store_root) -> None:
    rows = [{"id": i, "name": f"r{i}", "delta": float(i)} for i in range(1, 11)]
    copy = upsert_store(ENGINE, table_name="trades", key="id", rows=rows)
    assert copy["writer"] == "duckdb-copy" and copy["row_groups"] == 0
    app = upsert_store(
        ENGINE,
        table_name="trades2",
        key="id",
        appender=True,
        chunk_size=3,
        rows=rows,
    )
    assert app["row_groups"] == 4  # ceil(10 / 3)
    assert pq.ParquetFile(store_root / "trades2.parquet").num_row_groups == 4
    assert {r["id"] for r in _rows("trades2")} == set(range(1, 11))


def test_upsert_appender_hive_store_raises(store_root) -> None:
    set_storage_override(
        store="local",
        root=str(store_root),
        partition_glob="{tableName}/region=*/date=*/*.parquet",
        hive_partitioning="1",
    )
    with pytest.raises(ValueError, match="hive-partitioned"):
        upsert_store(ENGINE, table_name="trades", key="id", appender=True, rows=[{"id": 1, "region": "EU"}])


def test_partition_columns_helper() -> None:
    assert partition_columns(None) == []
    assert partition_columns("{tableName}/region=*/date=*/*.parquet") == ["region", "date"]
    assert partition_columns("{tableName}/site=*-*/*.parquet") == ["site"]
