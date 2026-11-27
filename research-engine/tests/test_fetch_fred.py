"""No network: parsing, validation and storage of FRED series (P0-A)."""
import io
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import fetch_fred as F  # noqa: E402
import data as D  # noqa: E402

GOOD = "observation_date,VIXCLS\n1990-01-02,17.24\n1990-01-03,18.19\n1990-01-04,\n1990-01-05,.\n1990-01-08,19.22\n"


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class ParseTests(unittest.TestCase):
    def test_parses_and_keeps_missing_as_none(self):
        rows = F.parse_series(GOOD, "VIXCLS")
        self.assertEqual(rows[0], ("1990-01-02", 17.24))
        self.assertEqual(rows[2], ("1990-01-04", None))   # empty -> None, not 0
        self.assertEqual(rows[3], ("1990-01-05", None))   # '.' -> None
        s = F.summarize(rows)
        self.assertEqual((s["rows"], s["observations"], s["missing"]), (5, 3, 2))
        self.assertEqual((s["first"], s["last"]), ("1990-01-02", "1990-01-08"))

    def test_rejects_wrong_series_and_malformed_files(self):
        with self.assertRaises(F.SeriesError):
            F.parse_series(GOOD, "NASDAQ100")                                    # header is another series
        with self.assertRaises(F.SeriesError):
            F.parse_series("observation_date,VIXCLS\n1990-01-03,1\n1990-01-02,2\n", "VIXCLS")  # not increasing
        with self.assertRaises(F.SeriesError):
            F.parse_series("observation_date,VIXCLS\n1990-01-02,abc\n", "VIXCLS")
        with self.assertRaises(F.SeriesError):
            F.parse_series("observation_date,VIXCLS\n1990-01-02,0\n", "VIXCLS")  # a price of 0 is an error, not data
        with self.assertRaises(F.SeriesError):
            F.parse_series("<html>error</html>", "VIXCLS")


class FetchTests(unittest.TestCase):
    def test_fetch_writes_csv_and_meta_and_flags_unexpected_start(self):
        seen = []

        def opener(req, timeout):
            seen.append((req.full_url, req.get_header("User-agent")))
            return FakeResponse(GOOD.encode())

        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp)
            m = F.fetch("VIXCLS", opener=opener, out_dir=out)
            self.assertEqual(seen[0][0], "https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS")
            self.assertNotIn("@", seen[0][1])                       # no personal contact sent
            self.assertTrue((out / "VIXCLS.csv").exists())
            saved = json.loads((out / "VIXCLS.meta.json").read_text(encoding="utf-8"))
            self.assertEqual(saved["observations"], 3)
            self.assertTrue(saved["startsAsExpected"])
            self.assertIn("non-commercial", saved["license"])
            s = D.load("VIXCLS", raw_dir=out)
            self.assertEqual(len(s), 3)                              # missing rows dropped, not zero-filled
            self.assertAlmostEqual(float(s.iloc[-1]), 19.22)

    def test_unknown_series_is_refused(self):
        with self.assertRaises(F.SeriesError):
            F.fetch("SP500", opener=lambda *a, **k: None)


if __name__ == "__main__":
    unittest.main()
