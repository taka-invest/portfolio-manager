"""Fetch the daily FRED series used by the market-timing research - IN MEMORY ONLY.

FRED's terms (fred.stlouisfed.org/legal, item (p)) prohibit storing, caching or archiving
FRED content without written consent. So nothing is written to disk: each research run
downloads the few series it needs for personal, non-commercial use, computes, and keeps
only aggregated statistics that do not contain FRED values. See
docs/research/DATA_SOURCE_MIGRATION.md.

Usage:  python research-engine/fetch_fred.py   (prints a check of each series; saves nothing)
"""
from __future__ import annotations

import datetime as dt
import hashlib
import sys
import time
import urllib.request

URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={id}"
USER_AGENT = "portfolio-research/0.2 (personal, non-commercial)"

# id -> (description, first date expected from FRED as checked on 2026-11-27)
SERIES = {
    "VIXCLS": ("CBOE Volatility Index: VIX (close)", "1990-01-02"),
    "NASDAQ100": ("NASDAQ-100 Index (close)", "1986-01-02"),
    "NASDAQCOM": ("NASDAQ Composite Index (close)", "1971-02-05"),
    "DEXJPUS": ("Japanese Yen to U.S. Dollar Spot Exchange Rate (noon buying rate, NY)", "1971-01-04"),
}


class SeriesError(ValueError):
    """The downloaded file is not the series we asked for, or is malformed."""


def parse_series(text: str, series_id: str) -> list[tuple[str, float | None]]:
    """Parse a fredgraph CSV. Missing observations ('' or '.') stay None, never 0."""
    lines = [l for l in text.strip().splitlines() if l.strip()]
    if not lines:
        raise SeriesError(f"{series_id}: empty file")
    header = [h.strip() for h in lines[0].split(",")]
    if len(header) != 2 or header[1] != series_id or header[0] not in ("observation_date", "DATE"):
        raise SeriesError(f"{series_id}: unexpected header {header}")
    rows: list[tuple[str, float | None]] = []
    prev = ""
    for n, line in enumerate(lines[1:], start=2):
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 2:
            raise SeriesError(f"{series_id}: line {n} has {len(parts)} fields")
        date, raw = parts
        try:
            dt.date.fromisoformat(date)
        except ValueError as e:
            raise SeriesError(f"{series_id}: line {n} bad date {date!r}") from e
        if date <= prev:
            raise SeriesError(f"{series_id}: dates not strictly increasing at line {n} ({prev} -> {date})")
        prev = date
        if raw in ("", "."):
            value = None
        else:
            try:
                value = float(raw)
            except ValueError as e:
                raise SeriesError(f"{series_id}: line {n} bad value {raw!r}") from e
            if not (value > 0):
                raise SeriesError(f"{series_id}: line {n} non-positive value {raw!r}")
        rows.append((date, value))
    if not rows:
        raise SeriesError(f"{series_id}: no observations")
    return rows


def summarize(rows: list[tuple[str, float | None]]) -> dict:
    present = [r for r in rows if r[1] is not None]
    return {
        "rows": len(rows),
        "observations": len(present),
        "missing": len(rows) - len(present),
        "first": present[0][0] if present else None,
        "last": present[-1][0] if present else None,
    }


def fetch(series_id: str, *, opener=urllib.request.urlopen, now=None) -> tuple[list[tuple[str, float | None]], dict]:
    """Download and validate one series in memory; returns (rows, metadata). Writes nothing."""
    if series_id not in SERIES:
        raise SeriesError(f"unknown series {series_id}")
    url = URL.format(id=series_id)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with opener(req, timeout=60) as res:
        body = res.read()
    rows = parse_series(body.decode("utf-8"), series_id)
    meta = {
        "id": series_id,
        "source": "FRED, Federal Reserve Bank of St. Louis",
        "fetchedAt": (now or dt.datetime.now(dt.timezone.utc)).isoformat(timespec="seconds"),
        "sha256": hashlib.sha256(body).hexdigest(),
        **summarize(rows),
        "expectedFirst": SERIES[series_id][1],
    }
    meta["startsAsExpected"] = meta["first"] == meta["expectedFirst"]
    return rows, meta


def main(argv: list[str]) -> int:
    failed = 0
    for i, sid in enumerate(argv or list(SERIES)):
        if i:
            time.sleep(1.0)
        try:
            _, m = fetch(sid)
            flag = "" if m["startsAsExpected"] else f"  ! first date differs from expected {m['expectedFirst']}"
            print(f"{sid:10} {m['first']} .. {m['last']}  obs={m['observations']} missing={m['missing']}{flag}  (not saved)")
        except Exception as e:
            failed += 1
            print(f"{sid:10} FAILED: {e}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
