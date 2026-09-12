#!/usr/bin/env python3
"""Generate TEST_REPORT.md: run the pytest suite with coverage and append live
sample outputs from each OLAP scenario through the real engine.

Modern replacement for the reference `.tmp/genmd.py`: instead of pasting the
SQL builder's raw output, every scenario below runs through ``OlapEngine.query``
(the same code path the HTTP and MCP surfaces use) against a freshly generated
fixture, so the report always reflects the current engine behaviour.

Usage:  ``uv run python scripts/make_report.py``
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from fina_olap.engine import OlapEngine
from fina_olap.fixture import DEFAULT_ROW_COUNT, generate_fixture
from fina_olap.schema import SSRMRequest, SSRMResponse

ROOT = Path(__file__).resolve().parent.parent
REPORT_PATH = ROOT / "TEST_REPORT.md"
NULL_MARK = "*(null)*"

SCENARIOS: list[tuple[str, str, dict]] = [
    (
        "Top-level grouping by Portfolio",
        "Displays the 5 distinct portfolios with sum(delta) via the REST/engine path.",
        {"rowGroupCols": [{"id": "portfolio", "field": "portfolio"}], "valueCols": [{"id": "d", "aggFunc": "sum", "field": "delta"}], "groupKeys": []},
    ),
    (
        "Sub-grouping: instruments under Portfolio 1",
        "Expands Portfolio 1 to its 100 instrument children (page of 5).",
        {"rowGroupCols": [{"id": "p", "field": "portfolio"}, {"id": "i", "field": "instrument"}], "groupKeys": ["Portfolio 1"], "startRow": 0, "endRow": 5, "sortModel": [{"colId": "instrument", "sort": "asc"}]},
    ),
    (
        "Sub-grouping: legs under Portfolio 1 / Instrument 1",
        "Drills one more level to the 3 legs.",
        {"rowGroupCols": [{"id": "p", "field": "portfolio"}, {"id": "i", "field": "instrument"}, {"id": "l", "field": "leg"}], "groupKeys": ["Portfolio 1", "Instrument 1"]},
    ),
    (
        "Sorting: portfolios descending",
        "Sets sortModel on the output column only.",
        {"rowGroupCols": [{"id": "portfolio", "field": "portfolio"}], "groupKeys": [], "sortModel": [{"colId": "portfolio", "sort": "desc"}]},
    ),
    (
        "Advanced filtering + multi-level expansion",
        "portfolio in {1,2,3} AND instrument in {2,4}; Portfolio 1 only matches.",
        {
            "rowGroupCols": [{"id": "p", "field": "portfolio"}, {"id": "i", "field": "instrument"}, {"id": "l", "field": "leg"}],
            "valueCols": [{"id": "d", "aggFunc": "sum", "field": "delta"}],
            "filterModel": {
                "portfolio": {"filterType": "set", "values": ["Portfolio 1", "Portfolio 2", "Portfolio 3"]},
                "instrument": {"filterType": "set", "values": ["Instrument 2", "Instrument 4"]},
            },
            "groupKeys": ["Portfolio 1"],
        },
    ),
    (
        "Pivot by leg across delta/gamma/vega",
        "Pivot mode over 3 value columns; pivoted column names follow `{leg}_{field}`.",
        {
            "rowGroupCols": [{"id": "portfolio", "field": "portfolio"}],
            "pivotCols": [{"id": "l", "field": "leg"}],
            "valueCols": [
                {"id": "delta", "aggFunc": "sum", "field": "delta"},
                {"id": "gamma", "aggFunc": "sum", "field": "gamma"},
                {"id": "vega", "aggFunc": "sum", "field": "vega"},
            ],
            "pivotMode": True,
        },
    ),
    (
        "Custom aggregation: first() at the leg level only",
        "aggFuncsByLevel = {'leg': 'first'} leaves other levels un-aggregated.",
        {
            "rowGroupCols": [{"id": "p", "field": "portfolio"}, {"id": "i", "field": "instrument"}, {"id": "l", "field": "leg"}],
            "valueCols": [{"id": "d", "field": "delta", "aggFuncsByLevel": {"leg": "first"}}],
            "groupKeys": ["Portfolio 1", "Instrument 1"],
        },
    ),
    (
        "Grand total row",
        "includeGrandTotal prepends a NULL-group row with whole-table aggregates.",
        {"rowGroupCols": [{"id": "portfolio", "field": "portfolio"}], "valueCols": [{"id": "d", "aggFunc": "sum", "field": "delta"}], "groupKeys": [], "includeGrandTotal": True},
    ),
    (
        "Level-of-Detail (fixed) join",
        "lodConfig fixed on portfolio; every row carries _lod_delta (portfolio sum).",
        {
            "rowGroupCols": [{"id": "p", "field": "portfolio"}, {"id": "i", "field": "instrument"}],
            "groupKeys": ["Portfolio 1"],
            "valueCols": [{"id": "d", "aggFunc": "sum", "field": "delta"}],
            "lodConfig": {"type": "fixed", "groupKeys": ["portfolio"], "metrics": {"delta": "sum"}, "prefix": "_lod_"},
            "startRow": 0,
            "endRow": 8,
        },
    ),
    (
        "Per-level visibility: qty only at the portfolio level",
        "visibleLevels=[0] suppresses qty (NULL) one level down.",
        {
            "rowGroupCols": [{"id": "p", "field": "portfolio"}, {"id": "i", "field": "instrument"}],
            "groupKeys": ["Portfolio 1"],
            "valueCols": [{"id": "qty", "field": "qty", "aggFunc": "sum", "visibleLevels": [0]}],
            "startRow": 0,
            "endRow": 7,
        },
    ),
]


def fmt_value(value: object, max_len: int = 24) -> str:
    if value is None:
        return NULL_MARK
    text = str(value)
    return text[:max_len] + ("…" if len(text) > max_len else "")


def md_table(rows: list[dict], cols: list[str], headers: list[str] | None = None, right: set[str] | None = None) -> str:
    headers = headers or cols
    right = right or set()
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---:" if c in right else "---" for c in cols) + " |"]
    for row in rows:
        lines.append("| " + " | ".join(fmt_value(row.get(c)) for c in cols) + " |")
    return "\n".join(lines)


def run_scenario(engine: OlapEngine, payload: dict) -> SSRMResponse:
    return engine.query(SSRMRequest.model_validate(payload))


def coverage_table() -> tuple[str, float]:
    """Run pytest --cov with JSON reporting and return (markdown, total)."""
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "--cov=fina_olap", "--cov-report=json:coverage.json", "-q"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    try:
        with open(ROOT / "coverage.json") as fh:
            data = json.load(fh)
        files = sorted(data["files"].items())
        total = data["totals"]["percent_covered"]
    except Exception:
        return f"```\n{result.stdout}\n{result.stderr}\n```", -1.0
    md = ["| Module | Coverage |", "| --- | --- |"]
    for name, stats in files:
        pct = stats.get("summary", {}).get("percent_covered", 0.0)
        md.append(f"| `{name}` | {pct:.1f}% |")
    md.append(f"| **Total** | **{total:.1f}%** |")
    return "\n".join(md), total


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        fixture = generate_fixture(DEFAULT_ROW_COUNT, str(Path(tmp) / "sample.parquet"), force=True)
        old = os.environ.get("FINA_OLAP_FIXTURE")
        os.environ["FINA_OLAP_FIXTURE"] = str(fixture)
        engine = OlapEngine()

        sections: list[str] = [f"# TEST_REPORT.md — fina-olap OLAP engine, seed fixture {fixture.name}", ""]
        sections.append("Live sample outputs generated end-to-end through `OlapEngine.query` — the same code path the "
                        "REST, MCP and Vercel surfaces use. Numeric measures are truncated for readability.")
        sections.append("")

        for i, (title, blurb, payload) in enumerate(SCENARIOS, 1):
            resp = run_scenario(engine, payload)
            sections.append(f"## Scenario {i}: {title}")
            sections.append(blurb)
            try:
                cols = list(resp.rows[0].keys()) if resp.rows else ["(empty)"]
            except Exception:
                cols = ["(empty)"]
            right = {c for c in cols if c in {"delta", "gamma", "vega", "qty", "notional"}}
            sections.append(f"* `lastRow={resp.lastRow}` · `rows={len(resp.rows)}` · `success={resp.success}`")
            sections.append("")
            sections.append(md_table(resp.rows, cols, right=right))
            sections.append("")

        cov_md, total = coverage_table()
        sections.append("## Python test + coverage")
        sections.append(f"`pytest {DEFAULT_ROW_COUNT * 3} fixture rows, {len(SCENARIOS)} scenarios` — coverage JSON from `coverage.json`.")
        sections.append("")
        sections.append(cov_md)
        sections.append("")

        if old:
            os.environ["FINA_OLAP_FIXTURE"] = old

        REPORT_PATH.write_text("\n".join(sections))
        print(f"Report written to {REPORT_PATH} (coverage total {total:.1f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())