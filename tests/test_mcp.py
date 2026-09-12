# ruff: noqa: E501
"""MCP v2 stdio integration test: spawn the server, list tools, call them."""

from __future__ import annotations

import asyncio
import os
import sys

from fina_olap.fixture import DEFAULT_ROW_COUNT

ASYNC_TIMEOUT = 60


async def _list_tools():
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "fina_olap.cli", "mcp"],
        env={**os.environ, "PYTHONPATH": repo_root},
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            return {t.name for t in tools.tools}


async def _do(tmp_path: str, row_count: int):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "fina_olap.cli", "mcp"],
        env={**os.environ, "PYTHONPATH": repo_root},
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            await session.call_tool("generate_fixture", {"row_count": row_count, "path": tmp_path})
            payload = {
                "tableName": "trades",
                "dataSource": {"uri": f"file://{tmp_path}"},
                "rowGroupCols": [{"id": "portfolio", "field": "portfolio"}],
                "valueCols": [{"id": "d", "aggFunc": "sum", "field": "delta"}],
                "groupKeys": [],
            }
            res = await session.call_tool("get_rows", {"payload": payload})
            schema = await session.call_tool("dataset_schema", {"payload": payload})
            status = await session.call_tool("status", {})
            return res, schema, status


def test_mcp_stdio_tools_listed():
    names = asyncio.run(asyncio.wait_for(_list_tools(), ASYNC_TIMEOUT))
    assert {"generate_fixture", "get_rows", "dataset_schema", "list_datasets", "status"} <= names
    assert {"store_config", "store_configure", "store_resolve", "upsert_store", "store_export"} <= names


def test_mcp_stdio_query_roundtrip(tmp_path):
    target = str(tmp_path / "mcp_fixture.parquet")
    res, schema, status = asyncio.run(asyncio.wait_for(_do(target, DEFAULT_ROW_COUNT), ASYNC_TIMEOUT))

    text = "".join(c.text for c in res.content if c.type == "text")
    assert res.isError is False
    assert "Portfolio 1" in text

    schema_text = "".join(c.text for c in schema.content if c.type == "text")
    assert "delta" in schema_text

    status_text = "".join(c.text for c in status.content if c.type == "text")
    assert "fixture" in status_text


def test_mcp_stdio_invalid_payload_returns_error(tmp_path):
    async def _bad():
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "fina_olap.cli", "mcp"],
            env={**os.environ, "PYTHONPATH": repo_root},
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                res = await session.call_tool(
                    "get_rows", {"payload": {"rowGroupCols": [{"id": "x", "field": "bad ident"}]}}
                )
                return res

    res = asyncio.run(asyncio.wait_for(_bad(), ASYNC_TIMEOUT))
    text = "".join(c.text for c in res.content if c.type == "text")
    # either FastMCP reports a tool error or the engine returns a structured failure dict
    assert res.isError is True or "error" in text


def test_mcp_stdio_upsert_roundtrip():
    import tempfile
    import time

    table = "ut" + str(int(time.time() * 1000))[-8:]
    out_csv = os.path.join(tempfile.mkdtemp(), f"{table}.csv")

    async def _run():
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        params = StdioServerParameters(
            command=sys.executable,
            args=["-m", "fina_olap.cli", "mcp"],
            env={**os.environ, "PYTHONPATH": repo_root},
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                first = await session.call_tool(
                    "upsert_store", {"table_name": table, "key": "id", "rows": [{"id": 1, "name": "a", "delta": 1.5}]}
                )
                second = await session.call_tool(
                    "upsert_store",
                    {
                        "table_name": table,
                        "key": "id",
                        "rows": [{"id": 1, "name": "a2", "delta": 9.9}, {"id": 2, "name": "b", "delta": 2.5}],
                    },
                )
                appender = await session.call_tool(
                    "upsert_store",
                    {
                        "table_name": table,
                        "key": "id",
                        "appender": True,
                        "chunk_size": 1,
                        "rows": [{"id": 3, "name": "c", "delta": 3.5}],
                    },
                )
                exported = await session.call_tool("store_export", {"table_name": table, "out_path": out_csv})
                query = await session.call_tool(
                    "get_rows",
                    {
                        "payload": {
                            "tableName": table,
                            "startRow": 0,
                            "endRow": 10,
                            "sortModel": [{"colId": "id", "sort": "asc"}],
                        }
                    },
                )
                cfg = await session.call_tool("store_config", {})
                set_cfg = await session.call_tool("store_configure", {"store": "local"})
                resolve = await session.call_tool("store_resolve", {"table_name": table})
                reset = await session.call_tool("store_configure", {"clear": True})
                return first, second, appender, exported, query, cfg, set_cfg, resolve, reset

    first, second, appender, exported, query, cfg, set_cfg, resolve, reset = asyncio.run(
        asyncio.wait_for(_run(), ASYNC_TIMEOUT)
    )
    first_text = "".join(c.text for c in first.content if c.type == "text")
    assert first.isError is False and '"inserted": 1' in first_text

    second_text = "".join(c.text for c in second.content if c.type == "text")
    assert '"matched": 1' in second_text and '"inserted": 1' in second_text and '"target_rows_after": 2' in second_text

    appender_text = "".join(c.text for c in appender.content if c.type == "text")
    assert '"writer": "appender"' in appender_text and '"row_groups": 3' in appender_text

    exported_text = "".join(c.text for c in exported.content if c.type == "text")
    assert (
        exported.isError is False and '"data_format": "csv"' in exported_text and '"rows_exported": 3' in exported_text
    )
    assert os.path.exists(out_csv)

    cfg_text = "".join(c.text for c in cfg.content if c.type == "text")
    assert '"store": "auto"' in cfg_text or '"store": "local"' in cfg_text

    set_text = "".join(c.text for c in set_cfg.content if c.type == "text")
    assert '"store": "local"' in set_text and '"overrides"' in set_text

    resolve_text = "".join(c.text for c in resolve.content if c.type == "text")
    assert table in resolve_text

    reset_text = "".join(c.text for c in reset.content if c.type == "text")
    assert '"overrides": {}' in reset_text
