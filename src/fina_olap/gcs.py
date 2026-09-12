"""GCS / S3 interoperability helpers for DuckDB's S3-compatible reader.

Adapted from the fina-pricer ``riskcube_mcp.gcs`` module. Two credential
families are honoured so the same engine works against Google Cloud Storage
(interoperability credentials) and generic S3-compatible object stores:

- ``S3_API_KEY`` / ``S3_API_SECRET`` — Google interoperability HMAC keys used
  with ``storage.googleapis.com`` (``fina-pricer`` convention).
- ``AWS_ACCESS_KEY_ID`` / ``AWS_SECRET_ACCESS_KEY`` / ``AWS_ENDPOINT_URL`` —
  canonical S3 convention used by MinIO / AWS / other stores.

Neither set of secrets is ever logged; ``gcs_status`` only reports booleans.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def load_local_env(path: str | Path = ".env.local") -> None:
    """Load local key/value settings only when the variables are not already set."""
    env_path = Path(path)
    if not env_path.exists():
        return
    for raw_line in env_path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


class ObjectStoreConfigurationError(RuntimeError):
    """Raised when required S3/GCS settings are missing."""


def _aws_sdk_style_configured() -> bool:
    return bool(os.getenv("AWS_ACCESS_KEY_ID") and os.getenv("AWS_SECRET_ACCESS_KEY"))


def _gcs_style_configured() -> bool:
    return bool(os.getenv("S3_API_KEY") and os.getenv("S3_API_SECRET"))


def object_store_configured() -> bool:
    return _aws_sdk_style_configured() or _gcs_style_configured()


def configure_duckdb_object_store(
    connection: Any,
    *,
    secret_name: str = "fina_olap_store",
) -> None:
    """Configure a DuckDB S3 secret for GCS or a generic S3 store from env vars.

    Never logs credentials. ``REGION 'auto'`` is a requirement of GCS's S3
    interoperability endpoint (same as fina-pricer). For AWS-style endpoints
    the region is read from ``AWS_REGION`` (default ``auto`` may break some
    stores, but GCS requires it).
    """
    _ensure_httpfs(connection)
    region = os.getenv("AWS_REGION", "auto")
    if _gcs_style_configured():
        key_id, secret = os.getenv("S3_API_KEY"), os.getenv("S3_API_SECRET")
        endpoint = os.getenv("S3_ENDPOINT", "storage.googleapis.com").strip()
    elif _aws_sdk_style_configured():
        key_id, secret = os.getenv("AWS_ACCESS_KEY_ID"), os.getenv("AWS_SECRET_ACCESS_KEY")
        endpoint = os.getenv("AWS_ENDPOINT_URL", "s3.amazonaws.com").strip()
    else:
        raise ObjectStoreConfigurationError(
            "configure S3_API_KEY/S3_API_SECRET (GCS) or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY"
        )
    assert key_id and secret, "object-store credentials must be set"  # guarded by _*_configured()
    if not endpoint:
        raise ObjectStoreConfigurationError("object-store endpoint must not be empty")
    sql = (
        f"CREATE OR REPLACE SECRET {_identifier(secret_name)} ("
        f"TYPE S3, KEY_ID {_literal(key_id)}, SECRET {_literal(secret)}, "
        f"ENDPOINT {_literal(endpoint)}, URL_STYLE 'path', REGION {_literal(region)})"
    )
    connection.execute(sql)


def _ensure_httpfs(connection: Any) -> None:
    """Load DuckDB httpfs using a writable runtime home on serverless platforms."""
    home = os.getenv("DUCKDB_HOME_DIRECTORY", "/tmp/duckdb")
    Path(home).mkdir(parents=True, exist_ok=True)
    connection.execute(f"SET home_directory = {_literal(home)}")
    try:
        connection.execute("LOAD httpfs")
    except Exception:
        connection.execute("INSTALL httpfs")
        connection.execute("LOAD httpfs")


def configured_bucket() -> str:
    """Return the primary bucket name, preferring GCS then AWS conventions."""
    bucket = os.getenv("S3_BUCKET_NAME") or os.getenv("AWS_BUCKET") or os.getenv("AWS_S3_BUCKET")
    if not bucket:
        raise ObjectStoreConfigurationError("S3_BUCKET_NAME (or AWS_BUCKET) must be configured")
    return bucket.rstrip("/")


def object_uri(object_name: str) -> str:
    """Build an S3-compatible URI from the configured bucket."""
    return f"{configured_bucket()}/{object_name.lstrip('/')}"


def object_store_status() -> dict[str, Any]:
    """Return non-secret configuration diagnostics suitable for health/reporting."""
    return {
        "configured": object_store_configured(),
        "style": "gcs" if _gcs_style_configured() else ("aws" if _aws_sdk_style_configured() else "none"),
        "bucket": (os.getenv("S3_BUCKET_NAME") or os.getenv("AWS_BUCKET")),
        "endpoint": os.getenv("S3_ENDPOINT") or os.getenv("AWS_ENDPOINT_URL", "s3.amazonaws.com"),
        "url_style": "path",
        "region": os.getenv("AWS_REGION", "auto"),
        "credentials_present": object_store_configured(),
    }


def _identifier(value: str) -> str:
    if not value.replace("_", "").isalnum():
        raise ValueError("secret_name must be alphanumeric or underscore")
    return value


def _literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"
