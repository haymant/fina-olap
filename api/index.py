"""Vercel entry point: re-export the ASGI app from `fina_olap.vercel`."""

from fina_olap.vercel import app

__all__ = ["app"]
