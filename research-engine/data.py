"""Series for the research scripts, fetched from FRED into memory for this run only.

Nothing is written to disk (FRED terms item (p)); the in-process cache lives only until the
script exits, so one run downloads each series at most once.
"""
from __future__ import annotations

import pathlib
import time

import pandas as pd

import fetch_fred as F

ROOT = pathlib.Path(__file__).resolve().parents[1]
_cache: dict[str, tuple[pd.Series, dict]] = {}


def _get(series_id: str, fetcher=None) -> tuple[pd.Series, dict]:
    if series_id not in _cache:
        if _cache:
            time.sleep(1.0)  # be polite between downloads
        rows, meta = (fetcher or F.fetch)(series_id)
        s = pd.Series({pd.Timestamp(d): v for d, v in rows if v is not None}, dtype=float).sort_index()
        if not s.index.is_monotonic_increasing:
            raise ValueError(f"{series_id}: dates not increasing")
        _cache[series_id] = (s, meta)
    return _cache[series_id]


def load(series_id: str, fetcher=None) -> pd.Series:
    """Daily close series indexed by date. Missing observations are dropped (never filled with 0)."""
    return _get(series_id, fetcher)[0]


def meta(series_id: str, fetcher=None) -> dict:
    return _get(series_id, fetcher)[1]


def clear() -> None:
    _cache.clear()
