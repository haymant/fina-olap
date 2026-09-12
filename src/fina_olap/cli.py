"""fina-olap command line interface.

- ``fina-olap --http``      serve the combined SSRM HTTP + MCP app (uvicorn)
- ``fina-olap --mcp``       run the MCP tool server over stdio (alias: fina-olap-mcp)
- ``fina-olap gen-fixture`` write the deterministic sample parquet
- ``fina-olap query ...``   run one SSRM payload against a parquet source
"""

from __future__ import annotations

import argparse
import json
import os

from .engine import OlapEngine
from .schema import SSRMRequest


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fina-olap", description="ag-grid SSRM OLAP engine over Parquet/DuckDB")
    parser.add_argument("--http", action="store_true", help="alias for the `http` subcommand")
    parser.add_argument("--host", default="0.0.0.0", help="http bind host")
    parser.add_argument("--port", type=int, default=8000, help="http bind port")
    sub = parser.add_subparsers(dest="command")

    http = sub.add_parser("http", help="serve the combined SSRM + MCP HTTP app")
    http.add_argument("--host", default="0.0.0.0")
    http.add_argument("--port", type=int, default=8000)

    sub.add_parser("mcp", help="run the MCP tool server over stdio")

    gen = sub.add_parser("gen-fixture", help="generate the deterministic sample parquet")
    gen.add_argument("--rows", type=int, default=1000)
    gen.add_argument("--path", default=os.getenv("FINA_OLAP_FIXTURE", "data/sample.parquet"))

    q = sub.add_parser("query", help="run one SSRM payload and print the JSON response")
    q.add_argument("payload", help="path to a JSON file with the SSRM request")
    q.add_argument("--table", default="trades")
    return parser


def main(argv: list[str] | None = None) -> None:
    args = _build_parser().parse_args(argv)
    if args.http or args.command == "http":
        from uvicorn import run

        run("fina_olap.server:app", host=args.host, port=args.port, reload=False)
        return
    if args.command == "mcp":
        from .mcp_server import main as mcp_main

        mcp_main()
        return
    if args.command == "gen-fixture":
        from .fixture import generate_fixture, summary

        path = generate_fixture(row_count=args.rows, file_path=args.path)
        print(json.dumps({"path": str(path), **summary(path)}, default=str))
        return
    if args.command == "query":
        with open(args.payload) as fh:
            payload = json.load(fh)
        payload.setdefault("tableName", args.table)
        engine = OlapEngine()
        response = engine.query(SSRMRequest.model_validate(payload))
        print(json.dumps(response.model_dump(), default=str))
        return
    _build_parser().print_help()


if __name__ == "__main__":
    main()
