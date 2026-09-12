"""Deterministic OLAP fixture generation.

Mirrors the reference ``fina-olap/.tmp/gen.py`` fixture shape (though not
line-for-line): a portfolio → instrument → leg hierarchy with several numeric
measures, an underlying dimension, a date and a currency column. Deterministic
via ``numpy`` default_rng with a fixed seed so tests and reports are stable.
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pandas as pd

DEFAULT_ROW_COUNT = 1000


def generate_fixture(
    row_count: int = DEFAULT_ROW_COUNT,
    file_path: str = "data/sample.parquet",
    *,
    seed: int = 42,
    force: bool = False,
) -> Path:
    """Generate the standard OLAP fixture (portfolio/instrument/leg × measures)."""
    path = Path(file_path)
    if path.exists() and not force:
        return path

    rng = np.random.default_rng(seed)

    portfolios: list[str] = []
    for i in range(1, row_count + 1):
        if 1 <= i <= 100:
            portfolios.append("Portfolio 1")
        elif 101 <= i <= 300:
            portfolios.append("Portfolio 2")
        elif 301 <= i <= 600:
            portfolios.append("Portfolio 3")
        elif 601 <= i <= 900:
            portfolios.append("Portfolio 4")
        else:
            portfolios.append("Portfolio 5")

    instruments = [f"Instrument {i}" for i in range(1, row_count + 1)]

    df = pd.DataFrame(
        {
            "instrument": np.repeat(instruments, 3),
            "portfolio": np.repeat(portfolios, 3),
        }
    )
    df["leg"] = ["put", "note", "funding"] * row_count

    def underlyings(instrument_name: str) -> list[str]:
        num = int(instrument_name.split(" ")[1])
        return ["STOCK1 UW", "STOCK3 UW", "STOCK5 UW"] if num % 2 == 1 else ["STOCK2 UW", "STOCK4 UW"]

    df["underlying"] = df["instrument"].apply(underlyings)

    n = len(df)
    df["delta"] = rng.uniform(0.001, 0.05, n)
    df["gamma"] = rng.uniform(0.0001, 0.005, n)
    df["vega"] = rng.uniform(0.0001, 0.005, n)
    df["qty"] = rng.integers(1, 10_000, n)
    df["notional"] = rng.uniform(1_000_000, 50_000_000, n).round(2)
    df["strategy"] = rng.choice(["flow", "spread", "hybrid", "static"], n)

    currencies = ["USD", "HKD", "JPY", "AUD", "EUR"]
    df["paymentCcy"] = rng.choice(currencies, n)
    df["lastFixingDate"] = pd.to_datetime(
        pd.Timestamp("2024-09-01") + pd.to_timedelta(rng.integers(0, 90, n), unit="D")
    ).date

    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, index=False)
    return path


def summary(path: str | Path = "data/sample.parquet") -> dict[str, object]:
    """Human-readable shape summary for status/health endpoints."""
    p = Path(path)
    if not p.exists():
        return {"exists": False}
    df = pd.read_parquet(p)
    return {
        "exists": True,
        "rows": int(len(df)),
        "columns": list(df.columns),
        "portfolios": sorted(df["portfolio"].unique().tolist()) if "portfolio" in df else [],
    }


if __name__ == "__main__":
    target = os.getenv("FINA_OLAP_FIXTURE", "data/sample.parquet")
    print(generate_fixture(file_path=target))
    print(summary(target))
