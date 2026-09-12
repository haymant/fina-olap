"""Vercel serverless entry adapter.

Vercel imports ``api/index.py`` directly from ``/var/task``; this project uses
a ``src`` layout, so we make the source tree importable first, then delegate
to the combined ASGI app created by ``fina_olap.server`` (FastAPI SSRM routes
+ MCP Streamable HTTP mount).

Path mapping on Vercel:
- ``/api/*``        → SSRM REST endpoints (native function path, unchanged)
- ``/mcp``, ``/mcp/*``  → rewritten to ``/api/mcp*`` by ``vercel.json``,
  then restored to ``/mcp*`` here so the FastAPI mount receives the MCP path.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

_SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from fina_olap.server import app as _server_app  # noqa: E402


def _rewrite_path(scope: dict[str, Any]) -> dict[str, Any]:
    path = scope.get("path", "")
    if path == "/api/mcp" or path.startswith("/api/mcp/"):
        mcp_path = "/mcp" + path.removeprefix("/api/mcp")
        return {**scope, "path": mcp_path, "raw_path": mcp_path.encode()}
    return scope


async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
    """Adapt Vercel's function path to the FastAPI + MCP routes."""
    if scope.get("type") == "http":
        scope = _rewrite_path(scope)
    await _server_app(scope, receive, send)


__all__ = ["app"]
