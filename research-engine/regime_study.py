"""P0-C: market regime and what followed (docs/research/MARKET_TIMING_MODEL_DESIGN.md section 1).

Each trading day is classified with data up to that day only:
  trend : NASDAQ-100 close vs its 200-day simple moving average   -> 上昇 / 下落
  vol   : VIX close in fixed bands                                   -> 低 / 通常 / 高 / 極端
  depth : close vs the highest close of the last 252 trading days  -> 浅い / 調整 / 弱気相場
Then the forward return from the NEXT day's close over 20/60/250 trading days is
summarised per regime (USD and JPY). Days in the same regime overlap heavily, so the
number of separate episodes is reported and intervals resample whole episodes.

Rules are fixed in PARAMS (version p0c-1) before looking at results.
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib
import random
import sys

import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import data as D  # noqa: E402
from vix_event_study import git_commit, median, quantile  # noqa: E402

VERSION = "p0c-2"   # p0c-2: adds trend|depth and depth comparisons (usable without VIX); no FRED values in output
PARAMS = {
    "ma": 200,
    "highWindow": 252,
    "vixBands": [[15, "低"], [20, "通常"], [30, "高"], [None, "極端"]],   # upper bound (exclusive), label
    "depthBands": [[-0.10, "浅い"], [-0.20, "調整"], [None, "弱気相場"]],  # lower bound (exclusive), label
    "horizons": [20, 60, 250],
    "episodeGap": 20,           # runs closer than this many trading days belong to the same episode
    "minEpisodes": 5,           # fewer separate episodes than this = "少数" (falls back to a coarser group)
    "bootstrap": 2000,
    "seed": 20261127,
}
LEVELS = ["trend|vol|depth", "vol|depth", "vol", "trend|depth", "depth", "all"]


def vol_band(vix: float, p=PARAMS) -> str:
    for upper, label in p["vixBands"]:
        if upper is None or vix < upper:
            return label
    raise ValueError(vix)


def depth_band(dd: float, p=PARAMS) -> str:
    for lower, label in p["depthBands"]:
        if lower is None or dd > lower:
            return label
    raise ValueError(dd)


def classify(df: pd.DataFrame, p=PARAMS) -> pd.DataFrame:
    """df has columns vix, px (aligned trading days). Adds ma, high, dd, trend, vol, depth."""
    out = df.copy()
    out["ma"] = out["px"].rolling(p["ma"], min_periods=p["ma"]).mean()
    out["high"] = out["px"].rolling(p["highWindow"], min_periods=p["highWindow"]).max()
    out["dd"] = out["px"] / out["high"] - 1
    out = out.dropna(subset=["ma", "high"]).copy()
    out["trend"] = ["上昇" if c >= m else "下落" for c, m in zip(out["px"], out["ma"])]
    out["vol"] = [vol_band(v, p) for v in out["vix"]]
    out["depth"] = [depth_band(d, p) for d in out["dd"]]
    return out


def key(row, level: str) -> str:
    if level == "all":
        return "全期間"
    return "・".join(str(row[f]) for f in level.split("|"))


def episodes(positions: list[int], gap: int = 1) -> list[list[int]]:
    """Group sorted trading-day positions into episodes: a day joins the current episode
    when it is at most `gap` trading days after its previous member (gap=1: plain runs)."""
    runs: list[list[int]] = []
    for pos in positions:
        if runs and pos - runs[-1][-1] <= max(gap, 1):
            runs[-1].append(pos)
        else:
            runs.append([pos])
    return runs


def run(vix_s: pd.Series, px_s: pd.Series, fx_s: pd.Series, p=PARAMS) -> dict:
    df = pd.concat({"vix": vix_s, "px": px_s}, axis=1, join="inner").dropna()
    df["fx"] = fx_s.reindex(df.index.union(fx_s.index)).ffill().reindex(df.index)
    df = classify(df.dropna(), p)
    px, fx = df["px"].tolist(), df["fx"].tolist()
    n = len(df)
    rows = df.reset_index().rename(columns={"index": "date"})
    rng = random.Random(p["seed"])

    groups: dict = {}
    for level in LEVELS:
        members: dict[str, list[int]] = {}
        for i, r in rows.iterrows():
            members.setdefault(key(r, level), []).append(i)
        for name, pos in members.items():
            eps = episodes(pos, p["episodeGap"])
            g = {"level": level, "days": len(pos), "episodes": len(eps), "horizons": {}}
            for h in p["horizons"]:
                cell = {}
                for ccy in ("usd", "jpy"):
                    def ret(i):
                        a, b = i + 1, i + 1 + h                      # buy next day's close, hold h days
                        if b >= n:
                            return None
                        r = px[b] / px[a] - 1
                        return r if ccy == "usd" else (1 + r) * fx[b] / fx[a] - 1
                    by_ep = [[x for x in (ret(i) for i in ep) if x is not None] for ep in eps]
                    by_ep = [e for e in by_ep if e]
                    vals = [x for e in by_ep for x in e]
                    if not vals:
                        cell[ccy] = None
                        continue
                    # Cluster bootstrap: resample whole episodes, take the median of the pooled days.
                    sims = []
                    for _ in range(p["bootstrap"] if len(by_ep) >= 2 else 0):   # no interval from one episode
                        pick = [by_ep[rng.randrange(len(by_ep))] for _ in range(len(by_ep))]
                        sims.append(median([x for e in pick for x in e]))
                    sims.sort()
                    cell[ccy] = {"n": len(vals), "episodes": len(by_ep), "median": median(vals),
                                 "mean": sum(vals) / len(vals), "q05": quantile(vals, 0.05), "q95": quantile(vals, 0.95),
                                 "positive": sum(v > 0 for v in vals) / len(vals),
                                 "medianCI95": [sims[int(0.025 * len(sims))], sims[int(0.975 * len(sims)) - 1]] if sims else None}
                g["horizons"][str(h)] = cell
            groups[f"{level}:{name}"] = g

    last = rows.iloc[-1]
    # Ratios and bands only: no raw FRED values (index level, VIX level) leave this machine.
    current = {"date": last["date"].date().isoformat(), "pxVsMa": float(last["px"] / last["ma"] - 1), "dd": float(last["dd"]),
               "trend": last["trend"], "vol": last["vol"], "depth": last["depth"],
               "keys": {lv: f"{lv}:{key(last, lv)}" for lv in LEVELS}}
    return {"dates": [rows["date"].iloc[0].date().isoformat(), current["date"]], "groups": groups, "current": current}


def main() -> int:
    out = run(D.load("VIXCLS"), D.load("NASDAQ100"), D.load("DEXJPUS"))
    out = {"version": VERSION, "params": PARAMS, "levels": LEVELS, "index": "NASDAQ100",
           "computedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "commit": git_commit(),
           "data": {s: {k: D.meta(s)[k] for k in ("first", "last", "fetchedAt", "sha256")} for s in ("VIXCLS", "NASDAQ100", "DEXJPUS")},
           "assumptions": ["判定はその日の終値までのデータだけで行う。リターンは翌営業日の終値で買い、20・60・250営業日後の終値で評価",
                           "同じ状態の日は連続して重なるため、日数ではなく『局面の数』を目安にする。20営業日以内に同じ状態に戻った日は同じ局面として数える。区間は局面単位のブートストラップ（全期間は1局面のため区間なし）",
                           "NASDAQ-100（配当なしの価格指数）。円建ては取得日・評価日のUSD/JPY（NY正午）で換算、手数料は未控除",
                           "200日線・52週高値の計算に必要な期間のため、分類は1990年代前半から"],
           **out}
    res_dir = D.ROOT / "data" / "results"
    res_dir.mkdir(parents=True, exist_ok=True)
    path = res_dir / f"regime_study_{VERSION}.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    c = out["current"]
    print(f"period={out['dates'][0]}..{out['dates'][1]} groups={len(out['groups'])} -> {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
