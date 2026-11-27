"""P0-B: VIX>=30 event study (docs/research/MARKET_TIMING_MODEL_DESIGN.md section 2).

Question: after VIX closes >= 30, is it better to buy at once, in 50/30/20 stages, after
VIX normalises, or after a rebound is confirmed?  Measured on NASDAQ-100 (FRED close
only), in USD and JPY, net of the buy commission, with uninvested cash counted at 0%
so waiting costs show up as opportunity cost.

Rules fixed BEFORE looking at results (see PARAMS); changing them = a new version.
No look-ahead: every decision on day d uses closes up to d; the fill is the close of
the NEXT trading day (FRED has no open prices).
"""
from __future__ import annotations

import datetime as dt
import json
import math
import pathlib
import random
import subprocess
import sys

import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import data as D  # noqa: E402

VERSION = "p0b-1"
PARAMS = {
    "threshold": 30.0,          # VIX close >= threshold starts an event
    "quiet": 20,                # ... and the previous `quiet` trading days were all below it
    "dedupe": 60,               # a new event needs `dedupe` trading days since the previous one
    "stages": [[1, 0.5], [11, 0.3], [21, 0.2]],   # S2: [trading-day offset after t0, weight]
    "normal_level": 20.0,       # S3: VIX close below this = normalised
    "rebound": 0.05,            # S4: index >= post-t0 low * (1 + rebound) ...
    "vix_off_peak": 0.75,       # ... and VIX <= post-t0 VIX peak * this
    "deadline": 120,            # S3/S4: buy anyway at t0 + deadline if no signal
    "fee": 0.00495,             # buy commission (0.495%; the $22 cap is ignored = conservative)
    "horizons": [60, 120, 250], # evaluation dates: t0 + h trading days
    "bootstrap": 10000,
    "seed": 20261127,
}
STRATEGIES = {
    "S1": "VIX30超えの翌日に全額",
    "S2": "50/30/20で段階購入（翌日・+11日・+21日）",
    "S3": "VIXが20未満に戻った翌日に全額（最長120営業日）",
    "S4": "指数が安値から+5%反発し、VIXが局面の最高値の75%以下に下がった翌日に全額（最長120営業日）",
}


def find_events(vix: pd.Series, threshold=30.0, quiet=20, dedupe=60) -> list[int]:
    """Positions (in vix) of event days t0."""
    above = (vix >= threshold).to_numpy()
    events, last = [], None
    for i in range(len(above)):
        if not above[i]:
            continue
        if i >= quiet and above[i - quiet:i].any():
            continue
        if i < quiet and above[:i].any():
            continue
        if last is not None and i - last < dedupe:
            continue
        events.append(i)
        last = i
    return events


def signal_day(t0: int, vix, px, kind: str, p=PARAMS) -> tuple[int, bool]:
    """Day (position) on which S3/S4 fire, decided with data up to that day. (day, fired?)"""
    end = min(t0 + p["deadline"], len(px) - 1)
    low, peak = px[t0], vix[t0]
    for d in range(t0, end + 1):
        low, peak = min(low, px[d]), max(peak, vix[d])
        if kind == "S3" and vix[d] < p["normal_level"]:
            return d, True
        if kind == "S4" and px[d] >= low * (1 + p["rebound"]) and vix[d] <= peak * p["vix_off_peak"]:
            return d, True
    return end, False


def tranches(t0: int, kind: str, vix, px, p=PARAMS) -> list[tuple[int, float]] | None:
    """[(fill day position, weight)]; fills are the close of the day after the decision."""
    if kind == "S1":
        return [(t0 + 1, 1.0)]
    if kind == "S2":
        return [(t0 + off, w) for off, w in p["stages"]]
    d, _ = signal_day(t0, vix, px, kind, p)
    return [(d + 1, 1.0)]


def evaluate(t0: int, kind: str, h: int, vix, px, fx, p=PARAMS) -> dict | None:
    """Wealth at t0+h per 1 unit of capital (cash at 0%), USD and JPY, plus MAE."""
    H = t0 + h
    if H >= len(px):
        return None                                   # horizon not reached yet
    fills = tranches(t0, kind, vix, px, p)
    w_usd = w_jpy = 0.0
    invested = 0.0
    entry = None
    for day, w in fills:
        if day > H:                                   # still in cash at the horizon (opportunity cost)
            w_usd += w
            w_jpy += w
            continue
        invested += w
        units = w * (1 - p["fee"]) / px[day]
        w_usd += units * px[H]
        w_jpy += units * px[H] * fx[H] / fx[day]     # JPY wealth relative to JPY committed at fill
        entry = day if entry is None else entry
    first_fill = fills[0][0]
    # Maximum adverse excursion of the invested position until the horizon (USD).
    mae = None
    if invested > 0:
        worst = 0.0
        for d in range(entry, H + 1):
            val = sum(w * (1 - p["fee"]) / px[day] * px[d] for day, w in fills if day <= d)
            cost = sum(w for day, w in fills if day <= d)
            if cost:
                worst = min(worst, val / cost - 1)
        mae = worst
    return {"usd": w_usd - 1, "jpy": w_jpy - 1, "invested": invested, "mae": mae,
            "lag": first_fill - t0}


def bootstrap_ci(values: list[float], stat, n: int, seed: int) -> tuple[float, float]:
    rng = random.Random(seed)
    k = len(values)
    sims = sorted(stat([values[rng.randrange(k)] for _ in range(k)]) for _ in range(n))
    return sims[int(0.025 * n)], sims[int(0.975 * n) - 1]


def median(xs):
    s = sorted(xs)
    n = len(s)
    return (s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2) if n else None


def quantile(xs, q):
    s = sorted(xs)
    if not s:
        return None
    pos = (len(s) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def run(vix_s: pd.Series, px_s: pd.Series, fx_s: pd.Series, p=PARAMS) -> dict:
    # Common trading calendar: days where both VIX and the index have a close.
    df = pd.concat({"vix": vix_s, "px": px_s}, axis=1, join="inner").dropna()
    # USD/JPY on that calendar: last known rate on or before the day (never a future rate).
    df["fx"] = fx_s.reindex(df.index.union(fx_s.index)).ffill().reindex(df.index)
    df = df.dropna()
    dates = [d.date().isoformat() for d in df.index]
    vix, px, fx = df["vix"].tolist(), df["px"].tolist(), df["fx"].tolist()
    events = find_events(df["vix"], p["threshold"], p["quiet"], p["dedupe"])

    per_event = []
    for t0 in events:
        row = {"t0": dates[t0], "vix": vix[t0], "strategies": {}}
        for k in STRATEGIES:
            fills = tranches(t0, k, vix, px, p)
            fired = signal_day(t0, vix, px, k, p)[1] if k in ("S3", "S4") else True
            row["strategies"][k] = {
                "firstFill": dates[fills[0][0]] if fills[0][0] < len(dates) else None,
                "signalFired": fired,
                **{str(h): evaluate(t0, k, h, vix, px, fx, p) for h in p["horizons"]},
            }
        per_event.append(row)

    summary = {}
    for h in p["horizons"]:
        hs = str(h)
        done = [e for e in per_event if e["strategies"]["S1"][hs] is not None]
        summary[hs] = {"events": len(done)}
        for k in STRATEGIES:
            for ccy in ("usd", "jpy"):
                vals = [e["strategies"][k][hs][ccy] for e in done]
                diffs = [e["strategies"][k][hs][ccy] - e["strategies"]["S1"][hs][ccy] for e in done]
                maes = [e["strategies"][k][hs]["mae"] for e in done if e["strategies"][k][hs]["mae"] is not None]
                cell = {
                    "median": median(vals), "mean": sum(vals) / len(vals) if vals else None,
                    "positive": sum(v > 0 for v in vals), "q05": quantile(vals, 0.05), "min": min(vals) if vals else None,
                    "medianMae": median(maes),
                    "lagMedian": median([e["strategies"][k][hs]["lag"] for e in done]),
                }
                if k != "S1" and len(diffs) >= 5:
                    cell["diffVsS1"] = {
                        "median": median(diffs), "mean": sum(diffs) / len(diffs),
                        "better": sum(d > 0 for d in diffs), "worse": sum(d < 0 for d in diffs),
                        "meanCI95": bootstrap_ci(diffs, lambda xs: sum(xs) / len(xs), p["bootstrap"], p["seed"]),
                        "medianCI95": bootstrap_ci(diffs, median, p["bootstrap"], p["seed"] + 1),
                    }
                summary[hs].setdefault(k, {})[ccy] = cell
    return {"dates": [dates[0], dates[-1]], "eventCount": len(events), "perEvent": per_event, "summary": summary}


def git_commit() -> str | None:
    try:
        return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], text=True).strip()
    except Exception:
        return None


def main() -> int:
    out = run(D.load("VIXCLS"), D.load("NASDAQ100"), D.load("DEXJPUS"))
    out = {"version": VERSION, "params": PARAMS, "strategies": STRATEGIES, "index": "NASDAQ100",
           "computedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "commit": git_commit(),
           "data": {s: {k: D.meta(s)[k] for k in ("first", "last", "fetchedAt", "sha256")} for s in ("VIXCLS", "NASDAQ100", "DEXJPUS")},
           "assumptions": ["約定はシグナル翌営業日の終値（FREDは終値のみ）", "買付手数料0.495%を控除（上限22ドルは無視＝保守的）",
                           "待機中の現金の利息は0%", "円建ては取得日・評価日のUSD/JPY（NY正午）で換算、為替手数料は未控除",
                           "指数（NASDAQ-100、配当なしの価格指数）での結果。個別株には直接当てはまらない"],
           **out}
    res_dir = D.ROOT / "data" / "results"
    res_dir.mkdir(parents=True, exist_ok=True)
    path = res_dir / f"vix_event_study_{VERSION}.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"events={out['eventCount']} period={out['dates'][0]}..{out['dates'][1]} -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
