# ruff: noqa: E501
"""Schema-level tests: payload validation, extensions, identifier safety."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from fina_olap.schema import LodConfig, SSRMRequest, ValueCol, infer_filter_type


def test_minimal_payload_defaults():
    req = SSRMRequest.model_validate({"startRow": 0, "endRow": 100})
    assert req.rowGroupCols == []
    assert req.valueCols == []
    assert req.includeGrandTotal is False
    assert req.lodConfig is None


def test_end_row_must_exceed_start():
    with pytest.raises(ValidationError):
        SSRMRequest.model_validate({"startRow": 50, "endRow": 50})


def test_negative_start_rejected():
    with pytest.raises(ValidationError):
        SSRMRequest.model_validate({"startRow": -1, "endRow": 10})


def test_identifier_safety_blocks_injection():
    with pytest.raises(ValidationError):
        SSRMRequest.model_validate({"rowGroupCols": [{"id": "x", "field": "portfolio; DROP TABLE trades"}]})
    with pytest.raises(ValidationError):
        SSRMRequest.model_validate({"tableName": "trades; DROP TABLE x"})


def test_value_col_custom_levels():
    vc = ValueCol.model_validate({"id": "d", "field": "delta", "aggFuncsByLevel": {"leg": "first", "0": "avg"}})
    assert vc.aggFuncsByLevel["leg"] == "first"
    vc2 = ValueCol.model_validate({"id": "d", "field": "delta", "aggFuncsByLevel": ["sum", None, "avg"]})
    assert vc2.aggFuncsByLevel[2] == "avg"


def test_visible_levels_roundtrip():
    vc = ValueCol.model_validate({"id": "d", "field": "delta", "visibleLevels": [0, 2]})
    assert vc.visibleLevels == [0, 2]


def test_lod_config_validation():
    lod = LodConfig.model_validate(
        {"type": "fixed", "groupKeys": ["portfolio"], "metrics": {"delta": "sum"}, "prefix": "_lod_"}
    )
    assert lod.type == "fixed"
    with pytest.raises(ValidationError):
        LodConfig.model_validate({"type": "fixed", "groupKeys": ["portfolio; drop"]})
    with pytest.raises(ValidationError):
        LodConfig.model_validate({"type": "weird"})
    with pytest.raises(ValidationError):
        SSRMRequest.model_validate({"lodConfig": {"type": "include", "metrics": {"delta": "evil()"}}})


def test_unknown_extra_fields_ignored():
    req = SSRMRequest.model_validate({"startRow": 0, "endRow": 10, "someFutureAgGridField": {"a": 1}})
    assert req.endRow == 10


def test_infer_filter_type():
    assert infer_filter_type({"type": "contains", "filter": "abc"}) == "text"
    assert infer_filter_type({"type": "greaterThan", "filter": 3}) == "number"
    assert infer_filter_type(None) is None
