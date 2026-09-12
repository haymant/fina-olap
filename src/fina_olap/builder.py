"""Translate an ag-grid SSRM payload into a single vectorized DuckDB query.

Port of the reference ``fina-olap/.tmp/1.py`` builder, reworked to be
dependency-light, prepared-statement based (no literal interpolation) and
extended with the OLAP features discussed in ``.tmp/gs.py``:

- per-depth aggregation functions via ``valueCols[].aggFuncsByLevel``,
- metric suppression per depth via ``valueCols[].visibleLevels``,
- Tableau-style Level-of-Detail joins via ``lodConfig``.

All user-provided values travel through ``?`` placeholders; identifiers are
validated upstream by the pydantic models (``fina_olap.schema``).
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from typing import Any

from .schema import SSRMRequest, infer_filter_type

NUMERIC_TYPES = {"BIGINT", "HUGEINT", "UBIGINT", "UINTEGER", "INTEGER", "SMALLINT", "DOUBLE", "DECIMAL", "FLOAT"}
DATE_TYPES = {
    "DATE",
    "DATETIME",
    "TIMESTAMP",
    "TIMESTAMP WITH TIME ZONE",
    "TIMESTAMP_S",
    "TIMESTAMP_MS",
    "TIMESTAMP_NS",
}
BOOLEAN_TYPES = {"BOOLEAN"}
PIVOT_VALUE_CAP = 200
PIVOT_COMBO_CAP = 5000


@dataclass
class BuiltQuery:
    """A fully-built query plus its positional parameters."""

    sql: str
    params: list[Any] = field(default_factory=list)
    pivot_result_fields: list[str] = field(default_factory=list)
    lod_fields: list[str] = field(default_factory=list)
    totals_sql: str | None = None
    totals_params: list[Any] = field(default_factory=list)


class DuckDBSqlBuilder:
    """Builds one parameterized DuckDB query for one SSRM request."""

    def __init__(self, payload: SSRMRequest | dict[str, Any], table_name: str, con: Any) -> None:
        self.payload = payload if isinstance(payload, SSRMRequest) else SSRMRequest.model_validate(payload)
        self.table_name = table_name
        self.con = con
        self._schema: dict[str, str] | None = None

    # ------------------------------------------------------------------ schema
    @property
    def schema(self) -> dict[str, str]:
        if self._schema is None:
            rows = self.con.execute(f"DESCRIBE {self.table_name}").fetchall()
            # duckdb DESCRIBE: (column_name, column_type, null, key, default, extra)
            self._schema = {row[0]: str(row[1]).upper() for row in rows}
        return self._schema

    def is_numeric(self, field: str) -> bool:
        return self.schema.get(field) in NUMERIC_TYPES

    # ------------------------------------------------------------------ build
    def build(self) -> BuiltQuery:
        p = self.payload
        depth = len(p.groupKeys)
        is_grouping = len(p.rowGroupCols) > depth

        select_parts: list[str] = []
        sel_params: list[Any] = []  # params bound inside the SELECT (pivot conditions)
        group_parts: list[str] = []

        if is_grouping:
            for i in range(depth + 1):
                col = p.rowGroupCols[i]
                select_parts.append(f'"{col.field}"')
                group_parts.append(f'"{col.field}"')
        elif not p.pivotMode:
            # Not drilling (leaf level or no row groups): raw rows are selected
            # either when there are no measures, or when the user drilled all the
            # way down and the measures are already raw columns. Whole-table
            # aggregation (no row groups at all) falls through to the measures.
            if not p.valueCols or (len(p.rowGroupCols) > 0 and len(p.rowGroupCols) == depth):
                # Leaf-level measures can be hidden ("show on leaf" off): omit
                # them from the raw projection (DuckDB * EXCLUDE).
                hidden = [
                    v.field
                    for v in p.valueCols
                    if v.visibleLevels is not None and depth not in v.visibleLevels
                ]
                if hidden:
                    cols = ", ".join(f'"{f}"' for f in hidden)
                    select_parts.append(f"* EXCLUDE ({cols})")
                else:
                    select_parts.append("*")

        where_sql, where_params = self._build_where()

        pivot_fields: list[str] = []
        if p.valueCols:
            if p.pivotMode and p.pivotCols:
                pivot_fields, parts, pivot_params = self._build_pivot(depth)
                select_parts.extend(parts)
                sel_params.extend(pivot_params)
            elif is_grouping or len(p.rowGroupCols) == 0:
                select_parts.extend(self._build_measures(depth, p.valueCols))
            # else: leaf drill (fully expanded) -> raw rows, measures are already
            # present as columns; nothing extra to select.
        # ORDER BY cannot be parameterized and never precedes the WHERE in the
        # assembled query, so it contributes no params regardless of position.
        order_sql, _ = self._build_order(select_parts, group_parts)

        group_sql = f" GROUP BY {', '.join(group_parts)}" if group_parts else ""
        page_size = p.endRow - p.startRow
        limit_sql = f" LIMIT {page_size + 1} OFFSET {p.startRow}"

        # Param order mirrors textual appearance in the final SQL string:
        # pivot conditions (SELECT) -> WHERE params -> (grand-total UNION WHERE first).
        main_sql = (
            f"SELECT {', '.join(select_parts)} FROM {self.table_name}{where_sql}{group_sql}{order_sql}{limit_sql}"
        )
        main_params = [*sel_params, *where_params]

        totals_sql = None
        totals_params: list[Any] = []
        if p.includeTotals and (p.valueCols or p.lodConfig):
            totals_sql = self._totals_query(where_sql, where_params)
            totals_params = list(where_params)

        # --- grand total (only meaningful on the top level; pivot changes the
        # column shape so the UNION would mismatch — falls back to plain rows)
        if p.includeGrandTotal and len(p.groupKeys) == 0 and not p.pivotMode:
            gt_parts = self._grand_total_select(depth)
            if gt_parts:
                total_query = f"SELECT {', '.join(gt_parts)} FROM {self.table_name}{where_sql}"
                sql = f"({total_query}) UNION ALL ({main_sql})"
                params = [*where_params, *main_params]
            else:
                # nothing to aggregate (no groups, no measures) -> plain rows
                sql = main_sql
                params = main_params
        else:
            sql = main_sql
            params = main_params

        # --- Level-of-Detail join ----------------------------------------------
        lod_fields: list[str] = []
        if p.lodConfig and p.lodConfig.metrics:
            sql, lod_params, lod_fields = self._apply_lod(sql, where_sql, where_params)
            params = [*params, *lod_params]

        return BuiltQuery(
            sql=sql,
            params=params,
            pivot_result_fields=pivot_fields,
            lod_fields=lod_fields,
            totals_sql=totals_sql,
            totals_params=totals_params,
        )

    # ------------------------------------------------------------------ measures
    def _build_measures(self, depth: int, value_cols: list[Any]) -> list[str]:
        parts: list[str] = []
        for val_col in value_cols:
            agg, visible = self._agg_for(val_col, depth)
            if not visible:
                parts.append(f'NULL AS "{val_col.field}"')
                continue
            parts.append(f'{agg}("{val_col.field}") AS "{val_col.field}"')
        return parts

    def _grand_total_select(self, depth: int) -> list[str]:
        p = self.payload
        # Grand total is an independent whole-table aggregate: it uses its own
        # aggregation function (default sum) for every value column and ignores
        # aggFuncsByLevel / visibleLevels, so "none" at a level never blanks it.
        agg = (p.grandTotalAggFunc or "sum").lower()
        parts: list[str] = []
        # Mirror the main query's column shape: grouping selects only the group
        # columns down to the current depth (rowGroupCols[: depth + 1]).
        for group_col in p.rowGroupCols[: depth + 1]:
            parts.append(f'NULL AS "{group_col.field}"')
        for val_col in p.valueCols:
            parts.append(f'{agg}("{val_col.field}") AS "{val_col.field}"')
        return parts

    def _agg_for(self, val_col: Any, depth: int) -> tuple[str, bool]:
        """Return (aggregation function, visible?) for a value column at a depth.

        Custom grouping level: ``aggFuncsByLevel`` can key on the current group
        field name (e.g. ``{"leg": "first"}``) or the 0-based level index. The
        sentinel ``"none"`` means "no aggregation at this layer" — the metric
        is suppressed (NULL), like ``visibleLevels`` excluding that depth.
        ``visibleLevels`` suppresses the metric (NULL) outside listed depths.
        """
        agg = (val_col.aggFunc or default_agg(self, val_col.field)).lower()
        visible = True

        if val_col.visibleLevels is not None and depth not in val_col.visibleLevels:
            visible = False

        by_level = val_col.aggFuncsByLevel
        if by_level:
            if isinstance(by_level, list):
                if depth < len(by_level) and by_level[depth]:
                    agg = str(by_level[depth]).lower()
            else:
                current_field = None
                if depth < len(self.payload.rowGroupCols):
                    current_field = self.payload.rowGroupCols[depth].field
                if str(depth) in by_level:
                    agg = str(by_level[str(depth)]).lower()
                elif current_field and str(current_field) in by_level:
                    agg = str(by_level[str(current_field)]).lower()

        if agg == "none":
            visible = False
        return agg, visible

    # ------------------------------------------------------------------ pivot
    def _build_pivot(self, depth: int) -> tuple[list[str], list[str], list[Any]]:
        p = self.payload
        fields = [c.field for c in p.pivotCols]
        value_lists: list[list[Any]] = []
        for f in fields:
            rows = self.con.execute(
                f'SELECT DISTINCT "{f}" FROM {self.table_name} WHERE "{f}" IS NOT NULL '
                f'ORDER BY "{f}" LIMIT {PIVOT_VALUE_CAP}'
            ).fetchall()
            value_lists.append([r[0] for r in rows])

        aliases: list[str] = []
        parts: list[str] = []
        params: list[Any] = []
        for combo in itertools.product(*value_lists):
            conds = [f'"{cf}" = ?' for cf in fields]
            condition = " AND ".join(conds)
            combo_str = "_".join(str(v) for v in combo)
            for val_col in p.valueCols:
                agg, visible = self._agg_for(val_col, depth)
                if not visible:
                    continue
                alias = f"{combo_str}_{val_col.field}"
                aliases.append(alias)
                parts.append(f'{agg}(CASE WHEN {condition} THEN "{val_col.field}" END) AS "{alias}"')
                # bind one value per pivot-dimension condition, in field order
                params.extend(combo)
            if len(aliases) >= PIVOT_COMBO_CAP:
                break
        return aliases, parts, params

    # ------------------------------------------------------------------ filters
    def _build_where(self) -> tuple[str, list[Any]]:
        p = self.payload
        parts: list[str] = []
        params: list[Any] = []

        for index, key in enumerate(p.groupKeys):
            col = p.rowGroupCols[index]
            parts.append(f'"{col.field}" = ?')
            params.append(str(key))

        for field_name, item in p.filterModel.items():
            if field_name not in self.schema:
                continue
            sql, ps = self._filter_sql(field_name, item)
            parts.append(sql)
            params.extend(ps)

        if p.advancedFilterModel:
            adv = p.advancedFilterModel
            if adv.get("colId") and adv["colId"] in self.schema:
                sql, ps = self._filter_sql(adv["colId"], adv)
                parts.append(sql)
                params.extend(ps)

        if not parts:
            return "", []
        return f" WHERE {' AND '.join(parts)}", params

    def _filter_sql(self, field: str, item: dict[str, Any]) -> tuple[str, list[Any]]:
        if item.get("operator") in {"AND", "OR"} and "condition1" in item:
            sql1, ps1 = self._filter_sql(field, item["condition1"])
            sql2, ps2 = self._filter_sql(field, item["condition2"])
            return f"({sql1} {item['operator']} {sql2})", [*ps1, *ps2]

        ftype = infer_filter_type(item)
        quoted = f'"{field}"'
        if ftype == "text":
            return self._text_filter(quoted, item)
        if ftype in {"number", "date"}:
            return self._number_filter(quoted, item)
        if ftype == "set":
            return self._set_filter(quoted, item)
        if ftype == "boolean":
            return self._boolean_filter(quoted, item)
        return "1=1", []

    def _text_filter(self, field: str, item: dict[str, Any]) -> tuple[str, list[Any]]:
        val = item.get("filter")
        t = item.get("type") or item.get("operator")
        if t in {"equals", "notEqual", "notEquals"}:
            op = "=" if t == "equals" else "!="
            return f"{field} {op} ?", [str(val)]
        if val is None and t in {"blank", "notBlank"}:
            if t == "blank":
                return f"({field} IS NULL OR CAST({field} AS VARCHAR) = '')", []
            return f"({field} IS NOT NULL AND CAST({field} AS VARCHAR) != '')", []
        if t == "contains":
            return f"{field} ILIKE '%' || ? || '%'", [str(val)]
        if t == "notContains":
            return f"{field} NOT ILIKE '%' || ? || '%'", [str(val)]
        if t == "startsWith":
            return f"{field} ILIKE ? || '%'", [str(val)]
        if t == "endsWith":
            return f"{field} ILIKE '%' || ?", [str(val)]
        return "1=1", []

    def _number_filter(self, field: str, item: dict[str, Any]) -> tuple[str, list[Any]]:
        fmt = "CAST(? AS DATE)" if item.get("filterType") == "date" else "?"
        val = item.get("filter")
        val_to = item.get("filterTo")
        t = item.get("type") or item.get("operator")
        ops = {
            "equals": "=",
            "notEqual": "!=",
            "notEquals": "!=",
            "greaterThan": ">",
            "greaterThanOrEqual": ">=",
            "lessThan": "<",
            "lessThanOrEqual": "<=",
        }
        if t in ops:
            return f"{field} {ops[t]} {fmt}", [val]
        if t in {"inRange", "between"}:
            return f"({field} >= {fmt} AND {field} <= {fmt})", [val, val_to]
        if t == "after":
            return f"{field} > {fmt}", [val]
        if t == "before":
            return f"{field} < {fmt}", [val]
        if t == "blank":
            return f"{field} IS NULL", []
        return "1=1", []

    def _set_filter(self, field: str, item: dict[str, Any]) -> tuple[str, list[Any]]:
        values = item.get("values") or []
        if not values:
            return "1=1", []
        placeholders = ", ".join(["?"] * len(values))
        return f"{field} IN ({placeholders})", list(values)

    def _boolean_filter(self, field: str, item: dict[str, Any]) -> tuple[str, list[Any]]:
        t = item.get("type") or item.get("operator")
        val = item.get("filter")
        if t in {"equals", "notEqual", "notEquals"}:
            neg = t != "equals"
            if isinstance(val, bool):
                lit = "TRUE" if val else "FALSE"
                return (f"{field} IS NOT {lit}" if neg else f"{field} IS {lit}"), []
            if isinstance(val, str) and val.lower() in {"true", "1"}:
                return (f"{field} IS NOT TRUE" if neg else f"{field} IS TRUE"), []
            if isinstance(val, str) and val.lower() in {"false", "0"}:
                return (f"{field} IS NOT FALSE" if neg else f"{field} IS FALSE"), []
        return "1=1", []

    # ------------------------------------------------------------------ order
    def _build_order(self, select_parts: list[str], group_parts: list[str]) -> tuple[str, list[Any]]:
        """Sort only over columns present in the SELECT output (avoids BinderErrors).

        When the client sends no sortModel but the query is grouped, default to
        ordering by the group columns ascending. Hash aggregation returns rows in
        process-random order; a deterministic ORDER BY keeps paged group rows
        stable across requests/processes (ag-grid convention: parents expand
        alphabetically).
        """
        seen = _select_aliases(select_parts)
        group_ids = {g.strip('"') for g in group_parts}
        parts: list[str] = []
        for s in self.payload.sortModel:
            if s.colId in seen or s.colId in group_ids:
                parts.append(f'"{s.colId}" {s.sort}')
        if not parts and group_parts:
            parts = [f'"{g}" ASC' for g in [x.strip('"') for x in group_parts]]
        if not parts:
            return "", []
        return f" ORDER BY {', '.join(parts)}", []

    # ------------------------------------------------------------------ totals
    def _totals_query(self, where_sql: str, where_params: list[Any]) -> str:
        parts: list[str] = []
        for val_col in self.payload.valueCols:
            agg = (val_col.aggFunc or default_agg(self, val_col.field)).lower()
            parts.append(f'{agg}("{val_col.field}") AS "{val_col.field}"')
        if self.payload.lodConfig:
            lod = self.payload.lodConfig
            for m, fn in lod.metrics.items():
                parts.append(f'{fn}("{m}") AS "{lod.prefix}{m}"')
        if not parts:
            return ""
        return f"SELECT {', '.join(parts)} FROM {self.table_name}{where_sql}"

    # ------------------------------------------------------------------ LOD
    def _lod_dimensions(self, view_groups: list[str]) -> list[str]:
        lod = self.payload.lodConfig
        if not lod:
            return []
        if lod.type == "include":
            return _dedupe([*view_groups, *lod.groupKeys])
        if lod.type == "exclude":
            return [g for g in view_groups if g not in lod.groupKeys]
        return list(lod.groupKeys)  # fixed

    def _apply_lod(
        self,
        sql: str,
        where_sql: str,
        where_params: list[Any],
    ) -> tuple[str, list[Any], list[str]]:
        p = self.payload
        lod = p.lodConfig
        assert lod is not None and lod.metrics

        all_group_cols = [c.field for c in p.rowGroupCols]
        view_groups = all_group_cols[: len(p.groupKeys) + 1] if all_group_cols else []
        dims = self._lod_dimensions(view_groups)

        if not dims:
            return sql, [], []

        dims_sql = ", ".join(f'"{d}"' for d in dims)
        agg_sql = ", ".join(f'{fn}("{m}") AS "{lod.prefix}{m}"' for m, fn in lod.metrics.items())
        join_on = " AND ".join(f'main."{d}" = lod."{d}"' for d in dims)
        lod_fields = [f"{lod.prefix}{m}" for m in lod.metrics]

        lod_subquery = f"SELECT {dims_sql}, {agg_sql} FROM {self.table_name}{where_sql} GROUP BY {dims_sql}"
        lod_select = ", ".join(f'lod."{f}"' for f in lod_fields)

        # Wrap the already-paginated main query as a sub-select and LEFT JOIN the
        # LOD aggregates on the fixed dimensions; the metric repeats per row.
        outer = f"SELECT main.*, {lod_select} FROM ({sql}) AS main LEFT JOIN ({lod_subquery}) AS lod ON {join_on}"
        return outer, list(where_params), lod_fields


def default_agg(builder: DuckDBSqlBuilder, field: str) -> str:
    """Type-aware default aggregation, so aggregating any column never errors.

    numeric -> ``sum``; date/timestamp -> ``max`` (latest); boolean -> ``max``
    (any-true); everything else (text, etc.) -> ``none`` (no aggregation — the
    measure is suppressed at aggregated levels instead of raising a Binder error).
    """
    kind = builder.schema.get(field)
    if kind in NUMERIC_TYPES:
        return "sum"
    if kind in DATE_TYPES or kind in BOOLEAN_TYPES:
        return "max"
    return "none"


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for v in values:
        if v not in seen:
            seen.add(v)
            out.append(v)
    return out


def _select_aliases(select_parts: list[str]) -> set[str]:
    aliases: set[str] = set()
    for part in select_parts:
        if " AS " in part.upper():
            alias = part.rsplit(" AS ", 1)[1].strip().strip('"')
            aliases.add(alias)
        elif part not in {"*"}:
            aliases.add(part.strip().strip('"'))
    return aliases
