"""Shared fixtures: generate the deterministic OLAP parquet in a tmp dir per session."""

from __future__ import annotations

import os

import pytest

from fina_olap.fixture import DEFAULT_ROW_COUNT, generate_fixture


@pytest.fixture(scope="session", autouse=True)
def olap_env(tmp_path_factory: pytest.TempPathFactory) -> None:
    """Point the engine at a freshly-generated fixture inside a session tmp dir."""
    data_dir = tmp_path_factory.mktemp("olap")
    fixture_path = data_dir / "sample.parquet"
    generate_fixture(row_count=DEFAULT_ROW_COUNT, file_path=str(fixture_path), force=True)
    os.environ["FINA_OLAP_FIXTURE"] = str(fixture_path)
    os.environ["OLAP_PARQUET_ROOT"] = str(data_dir)
    os.environ["DATA_DIR"] = str(data_dir)
    yield


@pytest.fixture(scope="session")
def engine() -> object:
    from fina_olap.engine import OlapEngine

    return OlapEngine()
