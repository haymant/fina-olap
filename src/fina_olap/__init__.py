"""fina-olap: ag-grid SSRM OLAP engine over Parquet (S3/GCS/local), DuckDB-powered."""

__version__ = "0.3.0"

from .builder import BuiltQuery, DuckDBSqlBuilder, default_agg
from .engine import OlapEngine, resolve_source
from .export import export_store
from .schema import LodConfig, SSRMRequest, SSRMResponse, ValueCol
from .storage import (
    StorageConfig,
    clear_storage_override,
    get_storage_config,
    reload_storage_config,
    set_storage_override,
    storage_overrides,
    storage_status,
)
from .upsert import upsert_store

__all__ = [
    "__version__",
    "BuiltQuery",
    "DuckDBSqlBuilder",
    "LodConfig",
    "OlapEngine",
    "SSRMRequest",
    "SSRMResponse",
    "StorageConfig",
    "ValueCol",
    "clear_storage_override",
    "default_agg",
    "export_store",
    "get_storage_config",
    "reload_storage_config",
    "resolve_source",
    "set_storage_override",
    "storage_overrides",
    "storage_status",
    "upsert_store",
]
