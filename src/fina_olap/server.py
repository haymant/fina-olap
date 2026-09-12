"""Combined SSRM HTTP + MCP Streamable HTTP ASGI application.

Routes:
- ``POST /api/getRows``  — ag-grid SSRM query (fina-olap response schema)
- ``POST /api/getSchema``— column schema for a table
- ``GET  /api/health``   — status     ``GET /api/tables`` — datasets
- ``GET  /api/totals``   — per-measure totals of the filtered dataset
- ``/mcp``               — MCP v2 Streamable HTTP tool server
- ``/healthz``           — MCP-mounted health route

Deployable to Vercel via ``api/index.py`` (see ``fina_olap.vercel``) or run
locally with ``fina-olap --http``.
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .engine import OlapEngine
from .fixture import summary
from .gcs import load_local_env, object_store_status
from .mcp_server import app as mcp_app
from .schema import SSRMRequest, SSRMResponse
from .storage import storage_status

load_local_env(".env")
load_local_env()

app = FastAPI(title="fina-olap", version="0.1.1")

_engine = OlapEngine()

_cors_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "fina-olap",
        "store": storage_status(),
        "object_store": object_store_status(),
        "fixture": summary(os.getenv("FINA_OLAP_FIXTURE", "data/sample.parquet")),
    }


@app.get("/api/tables")
async def tables() -> list[dict[str, Any]]:
    from .mcp_server import list_datasets as _list

    return _list()


@app.post("/api/getRows")
async def get_rows(request: Request) -> JSONResponse:
    payload = await request.json()
    try:
        response: SSRMResponse = _engine.query(payload)
    except Exception as exc:  # validation / resolution failures surface as 400
        return JSONResponse({"success": False, "lastRow": 0, "error": str(exc)}, status_code=400)
    return JSONResponse(_dump(response))


@app.post("/api/getSchema")
async def get_schema(request: Request) -> JSONResponse:
    payload = await request.json()
    try:
        columns = _engine.schema_for(payload)
    except Exception as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
    return JSONResponse({"ok": True, "table": (payload.get("tableName") or "trades"), "columns": columns})


@app.post("/api/listTables")
async def list_tables(request: Request) -> JSONResponse:
    """List candidate parquet tables under a dataSource (S3/GCS bucket or path)."""
    payload = await request.json()
    try:
        tables = _engine.list_tables(payload)
    except Exception as exc:
        return JSONResponse({"ok": False, "error": str(exc), "tables": []}, status_code=400)
    return JSONResponse({"ok": True, "tables": tables})


def _dump(response: SSRMResponse) -> dict[str, Any]:
    data = response.model_dump()
    data["success"] = response.success
    return data


app.mount("/mcp", mcp_app)


__all__ = ["app", "_engine", "SSRMRequest", "SSRMResponse"]
