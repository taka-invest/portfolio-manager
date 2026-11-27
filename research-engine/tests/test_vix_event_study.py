"""P0-B event study on synthetic data: events, fills, hand-computed returns, no look-ahead."""
import pathlib
import sys
import unittest

import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import vix_event_study as S  # noqa: E402

P = {**S.PARAMS, "deadline": 10, "horizons": [5, 15], "bootstrap": 200, "stages": [[1, 0.5], [3, 0.3], [5, 0.2]]}


def series(values, start="2020-01-01"):
    return pd.Series(values, index=pd.bdate_range(start, periods=len(values)), dtype=float)


class EventTests(unittest.TestCase):
    def test_first_close_above_threshold_after_quiet_period_and_dedupe(self):
        v = [15] * 25 + [31, 35, 29, 33] + [15] * 30 + [32] + [15] * 80 + [40]
        ev = S.find_events(series(v), threshold=30, quiet=20, dedupe=60)
        # 25: first event. 27/28 within the quiet window. 59 (=25+34) is < 60 days later -> same episode.
        self.assertEqual(ev, [25, 140])


class FillAndReturnTests(unittest.TestCase):
    def setUp(self):
        #           t0=2
        self.vix = [15, 15, 31, 30, 28, 25, 19, 18, 17, 16, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15]
        self.px = [100, 100, 90, 80, 84, 88, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110]
        self.fx = [150.0] * 22

    def test_fills_are_the_close_after_the_decision(self):
        self.assertEqual(S.tranches(2, "S1", self.vix, self.px, P), [(3, 1.0)])
        self.assertEqual(S.tranches(2, "S2", self.vix, self.px, P), [(3, 0.5), (5, 0.3), (7, 0.2)])
        # S3: VIX < 20 first on day 6 -> fill day 7.
        self.assertEqual(S.tranches(2, "S3", self.vix, self.px, P), [(7, 1.0)])
        # S4: low 80 (day 3); 84 >= 84 (=80*1.05) on day 4 and VIX 28 <= 31*0.75? no (23.25). Day 5: 88 and 25 > 23.25 no.
        # Day 6: 95 and 19 <= 23.25 -> fires on day 6, fill day 7.
        self.assertEqual(S.tranches(2, "S4", self.vix, self.px, P), [(7, 1.0)])

    def test_returns_match_hand_calculation_in_usd_and_jpy(self):
        fee = P["fee"]
        r = S.evaluate(2, "S1", 5, self.vix, self.px, self.fx, P)          # buy day 3 @80, value day 7 @96
        self.assertAlmostEqual(r["usd"], (1 - fee) * 96 / 80 - 1)
        self.assertAlmostEqual(r["jpy"], r["usd"])                          # flat FX
        fx = [150.0] * 3 + [150.0] * 4 + [165.0] * 15                       # yen weakens 10% by day 7
        r2 = S.evaluate(2, "S1", 5, self.vix, self.px, fx, P)
        self.assertAlmostEqual(r2["jpy"], (1 - fee) * 96 / 80 * 1.1 - 1)
        # MAE: bought at 80 (after fee), price never below 80 afterwards -> only the fee.
        self.assertAlmostEqual(r["mae"], -fee)

    def test_waiting_past_the_horizon_counts_as_cash_at_zero(self):
        r = S.evaluate(2, "S3", 3, self.vix, self.px, self.fx, P)          # horizon day 5, S3 fills day 7
        self.assertEqual(r["usd"], 0.0)
        self.assertEqual(r["invested"], 0.0)
        s2 = S.evaluate(2, "S2", 3, self.vix, self.px, self.fx, P)         # day-7 tranche (20%) still cash
        fee = P["fee"]
        expected = 0.5 * (1 - fee) * 88 / 80 + 0.3 * (1 - fee) * 88 / 88 + 0.2 - 1
        self.assertAlmostEqual(s2["usd"], expected)

    def test_no_look_ahead_future_prices_do_not_change_decisions(self):
        base = S.tranches(2, "S4", self.vix, self.px, P)
        changed = self.px[:7] + [1.0] * (len(self.px) - 7)                 # crash after the signal day 6
        self.assertEqual(S.tranches(2, "S4", self.vix, changed, P), base)

    def test_deadline_buys_anyway(self):
        vix = [15, 15, 31] + [35] * 30
        px = [100, 100, 90] + [70] * 30
        self.assertEqual(S.signal_day(2, vix, px, "S3", P), (12, False))  # t0 + deadline(10)
        self.assertEqual(S.tranches(2, "S3", vix, px, P), [(13, 1.0)])


class RunTests(unittest.TestCase):
    def test_run_aligns_calendars_and_reports_counts(self):
        vix = series(([15] * 25 + [35] + [15] * 40) * 2)               # spikes 66 days apart (> dedupe 60)
        px = series([100 + i * 0.1 for i in range(len(vix))])
        fx = series([150.0] * len(vix)).iloc[::2]                           # FX with gaps -> last known rate
        out = S.run(vix, px, fx, P)
        self.assertEqual(out["eventCount"], 2)
        self.assertEqual(out["summary"]["15"]["events"], 2)
        for k in S.STRATEGIES:
            self.assertIn("usd", out["summary"]["5"][k])
        self.assertEqual(S.quantile([1, 2, 3, 4, 5], 0.5), 3)
        self.assertEqual(S.median([4, 1, 3, 2]), 2.5)


if __name__ == "__main__":
    unittest.main()
