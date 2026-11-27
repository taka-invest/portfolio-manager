"""No network: parsing, validation, and the no-storage rule for FRED series."""
import io
import pathlib
import sys
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
        self.assertEqual(rows[2], ("1990-01-04", None))
        self.assertEqual(rows[3], ("1990-01-05", None))
        s = F.summarize(rows)
        self.assertEqual((s["rows"], s["observations"], s["missing"]), (5, 3, 2))

    def test_rejects_wrong_series_and_malformed_files(self):
        for text, sid in [(GOOD, "NASDAQ100"), ("observation_date,VIXCLS\n1990-01-03,1\n1990-01-02,2\n", "VIXCLS"),
                          ("observation_date,VIXCLS\n1990-01-02,abc\n", "VIXCLS"), ("observation_date,VIXCLS\n1990-01-02,0\n", "VIXCLS"),
                          ("<html>error</html>", "VIXCLS")]:
            with self.assertRaises(F.SeriesError):
                F.parse_series(text, sid)


class NoStorageTests(unittest.TestCase):
    def test_fetch_and_load_keep_data_in_memory_only(self):
        seen = []

        def opener(req, timeout):
            seen.append((req.full_url, req.get_header("User-agent")))
            return FakeResponse(GOOD.encode())

        before = {p for p in D.ROOT.rglob("*") if "data" in p.parts}
        rows, meta = F.fetch("VIXCLS", opener=opener)
        self.assertEqual(seen[0][0], "https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS")
        self.assertNotIn("@", seen[0][1])
        self.assertEqual(meta["observations"], 3)
        D.clear()
        s = D.load("VIXCLS", fetcher=lambda sid: (rows, meta))
        self.assertEqual(len(s), 3)                                   # missing rows dropped, not zero-filled
        self.assertAlmostEqual(float(s.iloc[-1]), 19.22)
        after = {p for p in D.ROOT.rglob("*") if "data" in p.parts}
        self.assertEqual(after, before)                               # nothing written under data/
        self.assertFalse(hasattr(F, "OUT"))                           # no output directory any more
        D.clear()

    def test_unknown_series_is_refused(self):
        with self.assertRaises(F.SeriesError):
            F.fetch("SP500", opener=lambda *a, **k: None)


if __name__ == "__main__":
    unittest.main()
