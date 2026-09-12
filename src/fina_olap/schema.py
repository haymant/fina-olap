"""Typed models for the ag-grid Server-Side Row Model payload and extensions.

The base payload follows ag-grid's SSRM request schema (``rowGroupCols``,
``groupKeys``, ``pivotCols``/``pivotMode``, ``valueCols``, ``sortModel``,
``filterModel``). Three extensions power OLAP features on top of the base
schema (see ``docs/lod-grouping.md`` and the ``fina-table`` client):

- ``valueCols[].aggFuncsByLevel`` — distinct aggregation functions per
  grouping depth (the *custom grouping level* feature from gs.md).
- ``valueCols[].visibleLevels``  — suppress a metric on chosen depths
  (emit ``NULL`` so the client renders an empty cell).
- ``lodConfig`` — Tableau-style Level of Detail expressions computed at a
  grain independent of the current view and joined back onto every row.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_serializer, model_validator

AGG_FUNCS = ("sum", "avg", "count", "min", "max", "first", "last", "stddev", "var")
_SORT_DIRS = ("asc", "desc")


class FilterModel(BaseModel):
    """One ag-grid filter item; ``filterType`` is usually inferred from the value."""

    model_config = ConfigDict(extra="allow")

    filterType: str | None = None
    operator: str | None = None
    condition1: FilterModel | None = None
    condition2: FilterModel | None = None
    type: str | None = None
    filter: Any = None
    filterTo: Any = None
    values: list[Any] | None = None
    dateFrom: str | None = None
    dateTo: str | None = None


class GroupCol(BaseModel):
    id: str
    field: str
    displayName: str | None = None

    @field_validator("field")
    @classmethod
    def _identifier(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", value):
            raise ValueError(f"invalid column identifier: {value!r}")
        return value


class PivotCol(BaseModel):
    id: str
    field: str


class ValueCol(BaseModel):
    """A measure column with optional per-depth aggregation control.

    ``aggFuncsByLevel`` values may be a known ``AGG_FUNCS`` name or the sentinel
    ``"none"`` (no aggregation at that layer — the metric is suppressed to
    NULL, mirroring a ``visibleLevels`` exclusion).
    """

    id: str
    field: str
    aggFunc: str | None = None
    aggFuncsByLevel: dict[str, str] | list[Any] | None = None
    visibleLevels: list[int] | None = None
    displayName: str | None = None

    @field_validator("aggFuncsByLevel")
    @classmethod
    def _merge_by_level(cls, value: dict[str, str] | list[Any] | None) -> dict[str, str] | list[Any] | None:
        if isinstance(value, list):
            return value
        if isinstance(value, dict):
            for _key, fn in value.items():
                if isinstance(fn, str) and not fn.isidentifier() and fn not in AGG_FUNCS:
                    raise ValueError(f"unrecognised aggregation function {fn!r}")
        return value


class SortItem(BaseModel):
    colId: str
    sort: Literal["asc", "desc"]


class LodConfig(BaseModel):
    """Level-of-Detail expression (Tableau-style) evaluated over the same source.

    - ``fixed``   — aggregate only at ``groupKeys`` grain, independent of the view.
    - ``include`` — aggregate at the current view grain *plus* ``groupKeys``.
    - ``exclude`` — aggregate at the current view grain *minus* ``groupKeys``.
    Computed columns are joined back to every row and prefixed with ``prefix``.
    """

    model_config = ConfigDict(extra="allow")

    type: Literal["fixed", "include", "exclude"] = "fixed"
    groupKeys: list[str] = Field(default_factory=list)
    metrics: dict[str, str] = Field(default_factory=dict)
    prefix: str = "_lod_"

    @field_validator("groupKeys")
    @classmethod
    def _identifier_list(cls, values: list[str]) -> list[str]:
        for value in values:
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", value):
                raise ValueError(f"invalid lod dimension: {value!r}")
        return values

    @field_validator("metrics")
    @classmethod
    def _metric_fns(cls, value: dict[str, str]) -> dict[str, str]:
        for field_name, fn in value.items():
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", field_name):
                raise ValueError(f"invalid lod metric column: {field_name!r}")
            if not fn.isidentifier():
                raise ValueError(f"invalid lod aggregation function: {fn!r}")
        return value


class DataSource(BaseModel):
    """Overrides how the engine locates Parquet backing the payload's table."""

    model_config = ConfigDict(extra="allow")

    uri: str | None = None
    bucket: str | None = None
    path: str | None = None
    glob: str | None = None
    tableName: str | None = None
    hivePartitioning: bool = True
    forceS3: bool = False


class SSRMRequest(BaseModel):
    """Full ag-grid SSRM payload plus the fina-olap extensions."""

    model_config = ConfigDict(extra="ignore")

    startRow: int = Field(default=0, ge=0)
    endRow: int = Field(default=100, gt=0)
    rowGroupCols: list[GroupCol] = Field(default_factory=list)
    groupKeys: list[Any] = Field(default_factory=list)
    pivotMode: bool = False
    pivotCols: list[PivotCol] = Field(default_factory=list)
    valueCols: list[ValueCol] = Field(default_factory=list)
    sortModel: list[SortItem] = Field(default_factory=list)
    filterModel: dict[str, Any] = Field(default_factory=dict)
    advancedFilterModel: dict[str, Any] | None = None
    includeGrandTotal: bool = False
    # Aggregation applied to every value column in the grand-total row,
    # computed over all (filtered) records — independent of aggFuncsByLevel /
    # visibleLevels. Defaults to "sum".
    grandTotalAggFunc: str | None = None

    # --- fina-olap extensions ---
    tableName: str | None = None
    version: str | None = None
    sliceName: str | None = None
    includeTotals: bool = False
    dataSource: DataSource | None = None
    lodConfig: LodConfig | None = None

    @field_validator("tableName")
    @classmethod
    def _table_identifier(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
            raise ValueError(f"invalid table name: {value!r}")
        return value

    @field_validator("grandTotalAggFunc")
    @classmethod
    def _grand_total_agg(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.lower()
        if not value.isidentifier() and value not in AGG_FUNCS:
            raise ValueError(f"unrecognised grand-total aggregation {value!r}")
        return value

    @model_validator(mode="after")
    def _page_sane(self) -> SSRMRequest:
        if self.endRow <= self.startRow:
            raise ValueError("endRow must be greater than startRow")
        return self


class SSRMResponse(BaseModel):
    """ag-grid compatible response with fina-olap metadata extensions."""

    success: bool = True
    rows: list[dict[str, Any]] = Field(default_factory=list)
    lastRow: int
    pivotResultFields: list[str] = Field(default_factory=list)
    pivotResultColumnsFields: list[str] = Field(default_factory=list)
    sql: str | None = None
    totals: dict[str, Any] = Field(default_factory=dict)
    lodFields: list[str] = Field(default_factory=list)
    metrics: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None

    @model_serializer(mode="wrap")
    def _json_safe_dump(self, handler: Any) -> dict[str, Any]:
        """Coerce DuckDB/pandas scalars (Timestamp, NaT, numpy, Decimal) to JSON."""
        data = handler(self)
        data["rows"] = [_json_safe(row) for row in data.get("rows", [])]
        data["totals"] = _json_safe(data.get("totals", {}))
        data["metrics"] = _json_safe(data.get("metrics", {}))
        return data


def _json_safe(value: Any) -> Any:
    """Recursively convert non-JSON scalar types (datetimes, numpy, Decimal)."""
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, (datetime, date)):
        try:
            return value.isoformat()
        except ValueError:
            return None
    if isinstance(value, np.datetime64):
        return None if np.isnat(value) else value.astype("datetime64[s]").item().isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


def infer_filter_type(item: dict[str, Any] | None) -> str | None:
    """Best-effort filterType inference when ag-grid omits it (1.py behaviour)."""
    if not item:
        return None
    ftype = item.get("filterType")
    if ftype:
        return ftype
    value = item.get("filter")
    op = item.get("type") or item.get("operator")
    text_ops = {"contains", "notContains", "startsWith", "endsWith", "equals", "notEqual", "notEquals"}
    if isinstance(value, str) or op in text_ops:
        return "text"
    if isinstance(value, (int, float)):
        return "number"
    return None
