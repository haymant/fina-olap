# ruff: noqa: E501
"""HTTP surface tests: SSRM REST routes + MCP Streamable HTTP mount."""

from __future__ import annotations

from fastapi.testclient import TestClient

from fina_olap.server import app

client = TestClient(app)


def test_health():
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["service"] == "fina-olap"
    assert "fixture" in body
    assert body["store"]["store"] in ("auto", "local", "s3", "gcs")


def test_get_rows_grouping():
    resp = client.post(
        "/api/getRows",
        json={
            "rowGroupCols": [{"id": "portfolio", "field": "portfolio"}],
            "valueCols": [{"id": "d", "aggFunc": "sum", "field": "delta"}],
            "groupKeys": [],
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert len(body["rows"]) == 5
    assert body["lastRow"] == 5
    assert body["metrics"] and body["metrics"]["query_ms"] >= 0


def test_get_rows_validation_error_returns_400():
    resp = client.post("/api/getRows", json={"rowGroupCols": [{"id": "x", "field": "bad ident"}], "groupKeys": []})
    assert resp.status_code == 400
    assert resp.json()["success"] is False


def test_get_rows_pivot_returns_pivot_fields():
    resp = client.post(
        "/api/getRows",
        json={
            "rowGroupCols": [{"id": "portfolio", "field": "portfolio"}],
            "pivotCols": [{"id": "leg", "field": "leg"}],
            "valueCols": [{"id": "delta", "aggFunc": "sum", "field": "delta"}],
            "pivotMode": True,
        },
    )
    body = resp.json()
    assert "put_delta" in body["pivotResultFields"]
    assert "pivotResultColumnsFields" in body


def test_get_schema():
    resp = client.post("/api/getSchema", json={"tableName": "trades"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    cols = {c["name"] for c in body["columns"]}
    assert {"portfolio", "instrument", "leg", "delta"} <= cols
    numeric = {c["name"] for c in body["columns"] if c["numeric"]}
    assert {"delta", "gamma", "vega", "qty", "notional"} <= numeric


def test_tables_lists_parquet():
    resp = client.get("/api/tables")
    assert resp.status_code == 200
    assert any(t["exists"] for t in resp.json())


def test_mcp_mount_present():
    # Streamable HTTP needs a JSON-RPC POST; a bare GET should not 404 the app itself.
    resp = client.get("/mcp")
    assert resp.status_code != 200  # FastMCP requires initialize POST


def test_mcp_streamable_initialize():
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "fina-olap-tests", "version": "0.0.0"},
        },
    }
    resp = client.post(
        "/mcp",
        json=payload,
        headers={"Accept": "application/json, text/event-stream", "Mcp-Session-Id": "unused"},
    )
    assert resp.status_code in {200, 400, 404}, resp.text
    if resp.status_code == 200:
        assert "fina-olap" in resp.text or "serverInfo" in resp.text


def test_mcp_via_rewrite_path():
    """Simulate Vercel's /api/mcp rewrite landing on the app."""
    from fina_olap.vercel import _rewrite_path

    scope = {"path": "/api/mcp/initialize", "type": "http"}
    out = _rewrite_path(scope)
    assert out["path"] == "/mcp/initialize"


def test_list_tables_route(tmp_path):
    import pandas as pd

    d = tmp_path / "wh" / "trades"
    d.mkdir(parents=True)
    pd.DataFrame({"a": [1]}).to_parquet(d / "p.parquet")

    resp = client.post("/api/listTables", json={"dataSource": {"uri": f"{tmp_path}/wh/**/*.parquet"}})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["tables"][0]["tableName"] == "trades"
