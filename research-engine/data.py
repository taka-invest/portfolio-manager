"""Load the locally stored FRED series as pandas objects for the research scripts."""
from __future__ import annotations

import json
import pathlib

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "fred"


def load(series_id: str, raw_dir: pathlib.Path = RAW) -> pd.Series:
    """Daily close series indexed by date. Missing observations are dropped (never filled with 0)."""
    path = raw_dir / f"{series_id}.csv"
    if not path.exists():
        raise FileNotFoundError(f"{path} not found - run: python research-engine/fetch_fred.py {series_id}")
    df = pd.read_csv(path, na_values=["", "."])
    df.columns = ["date", series_id]
    df["date"] = pd.to_datetime(df["date"])
    s = df.set_index("date")[series_id].dropna().astype(float)
    if not s.index.is_monotonic_increasing:
        raise ValueError(f"{series_id}: dates not increasing")
    return s


def meta(series_id: str, raw_dir: pathlib.Path = RAW) -> dict:
    return json.loads((raw_dir / f"{series_id}.meta.json").read_text(encoding="utf-8"))
