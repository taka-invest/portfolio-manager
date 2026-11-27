"""P0-C regime study on synthetic data: bands, classification without look-ahead, episodes, returns."""
import pathlib
import sys
import unittest

import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import regime_study as R  # noqa: E402

P = {**R.PARAMS, "ma": 3, "highWindow": 4, "horizons": [2], "bootstrap": 50}


def frame(vix, px):
    idx = pd.bdate_range("2020-01-01", periods=len(px))
    return pd.DataFrame({"vix": vix, "px": px}, index=idx, dtype=float)


class BandTests(unittest.TestCase):
    def test_vix_and_depth_bands_use_fixed_thresholds(self):
        self.assertEqual([R.vol_band(v) for v in (12, 15, 19.9, 20, 29.9, 30, 80)], ["低", "通常", "通常", "高", "高", "極端", "極端"])
        self.assertEqual([R.depth_band(d) for d in (0, -0.0999, -0.10, -0.15, -0.20, -0.5)], ["浅い", "浅い", "調整", "調整", "弱気相場", "弱気相場"])


class ClassifyTests(unittest.TestCase):
    def test_uses_only_past_data_and_marks_trend_and_drawdown(self):
        df = R.classify(frame([14, 16, 22, 31, 25, 18], [100, 110, 120, 90, 95, 130]), P)
        # first row needs 4 closes (high window): day 4 (index 3)
        self.assertEqual(len(df), 3)
        d3 = df.iloc[0]
        self.assertAlmostEqual(d3["ma"], (110 + 120 + 90) / 3)
        self.assertEqual(d3["trend"], "下落")            # 90 < 106.7
        self.assertAlmostEqual(d3["dd"], 90 / 120 - 1)   # -25%
        self.assertEqual((d3["vol"], d3["depth"]), ("極端", "弱気相場"))
        # changing a LATER price must not change an earlier classification
        later = R.classify(frame([14, 16, 22, 31, 25, 18], [100, 110, 120, 90, 95, 1]), P)
        self.assertEqual(later.iloc[0][["trend", "vol", "depth"]].tolist(), d3[["trend", "vol", "depth"]].tolist())

    def test_episodes_are_runs_of_consecutive_days(self):
        self.assertEqual(R.episodes([1, 2, 3, 7, 8, 12]), [[1, 2, 3], [7, 8], [12]])          # plain runs
        self.assertEqual(R.episodes([1, 2, 3, 7, 8, 40], gap=20), [[1, 2, 3, 7, 8], [40]])  # short gaps merge


class RunTests(unittest.TestCase):
    def test_forward_returns_start_the_next_day_and_current_regime_is_reported(self):
        px = [100, 100, 100, 100, 110, 121, 133.1, 140]
        vix = [14] * 8
        fx = pd.Series([150.0] * 8, index=pd.bdate_range("2020-01-01", periods=8))
        out = R.run(pd.Series(vix, index=fx.index, dtype=float), pd.Series(px, index=fx.index, dtype=float), fx, P)
        allg = out["groups"]["all:全期間"]["horizons"]["2"]["usd"]
        # classified days: original 3..7. Buy the NEXT close, hold 2 days: day3 -> 110..133.1, day4 -> 121..140
        self.assertEqual(allg["n"], 2)
        self.assertAlmostEqual(allg["median"], ((133.1 / 110 - 1) + (140 / 121 - 1)) / 2)
        self.assertEqual(out["current"]["date"], fx.index[-1].date().isoformat())
        self.assertEqual(out["current"]["keys"]["vol"], "vol:低")


if __name__ == "__main__":
    unittest.main()


class NoRawValuesTests(unittest.TestCase):
    def test_outputs_carry_ratios_and_bands_but_no_raw_fred_values(self):
        px = [100, 100, 100, 100, 110, 121, 133.1, 140]
        fx = pd.Series([150.0] * 8, index=pd.bdate_range("2020-01-01", periods=8))
        out = R.run(pd.Series([14.0] * 8, index=fx.index), pd.Series(px, index=fx.index, dtype=float), fx, P)
        c = out["current"]
        for k in ("vix", "px", "ma"):
            self.assertNotIn(k, c)
        self.assertAlmostEqual(c["pxVsMa"], 140 / ((121 + 133.1 + 140) / 3) - 1)
        self.assertIn("trend|depth:" + c["trend"] + "・" + c["depth"], out["groups"])
        import vix_event_study as S
        ev = S.run(pd.Series(([15] * 25 + [35] + [15] * 40) * 2, index=pd.bdate_range("2020-01-01", periods=132), dtype=float),
                   pd.Series([100 + i * 0.1 for i in range(132)], index=pd.bdate_range("2020-01-01", periods=132)),
                   pd.Series([150.0] * 132, index=pd.bdate_range("2020-01-01", periods=132)), {**S.PARAMS, "horizons": [5], "bootstrap": 50})
        self.assertTrue(all("vix" not in e for e in ev["perEvent"]))
