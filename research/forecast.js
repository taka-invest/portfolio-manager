'use strict';
// Forecast quarter for the analysis screen (stage 1: consensus + own assumption).
// enrich() is a line-for-line port of the legacy signal rules in
// functions/src/legacy/analyze.js (getFinancials, both passes) so a forecast row is
// scored exactly like the actual quarters; tests/forecast.test.js checks parity
// against the server's real output. Forecasts are never mixed into actual data.
((root) => {
  const nn = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  /** Legacy derived fields + signalScore for rows ordered newest first. */
  function enrich(base) {
    const trend = base.map((q, i) => {
      const prev = base[i + 1];
      let opLeverage = null;
      if (prev && q.opM != null && prev.opM != null && prev.revM > 0 && q.revM > 0) {
        const revChange = (q.revM - prev.revM) / prev.revM;
        if (Math.abs(revChange) > 0.005 && prev.opM !== 0) {
          const opChange = (q.opM - prev.opM) / Math.abs(prev.opM);
          opLeverage = +(Math.min(Math.max(opChange / revChange, -9.9), 19.9)).toFixed(2);
        }
      }
      const rof40 = (q.revYoY != null && q.opMargin != null) ? +(q.revYoY + q.opMargin).toFixed(1) : null;
      const yoyAccel = (q.revYoY != null && prev != null && prev.revYoY != null) ? +(q.revYoY - prev.revYoY).toFixed(1) : null;
      const opMDelta = (q.opMargin != null && prev != null && prev.opMargin != null) ? +(q.opMargin - prev.opMargin).toFixed(1) : null;
      const prevRof40 = (prev != null && prev.revYoY != null && prev.opMargin != null) ? prev.revYoY + prev.opMargin : null;
      const prevOpMargin = prev != null ? (prev.opMargin ?? null) : null;
      const signals = {
        redToBlack: q.opMargin != null && q.opMargin > 0 && (prevOpMargin === null || prevOpMargin <= 0),
        opMInflection: opMDelta !== null && opMDelta >= 5,
        rof40Cross40: rof40 !== null && rof40 >= 40 && (prevRof40 === null || prevRof40 < 40),
        rof40Cross60: rof40 !== null && rof40 >= 60 && (prevRof40 === null || prevRof40 < 60),
        rof40Cross80: rof40 !== null && rof40 >= 80 && (prevRof40 === null || prevRof40 < 80),
        opLevHigh: opLeverage !== null && opLeverage >= 2.5,
        yoyAccelStrong: yoyAccel !== null && yoyAccel >= 10
      };
      const inflectionLevel = (signals.redToBlack || signals.opMInflection || signals.rof40Cross40) ? 'inflection'
        : (signals.rof40Cross60 || signals.yoyAccelStrong) ? 'acceleration' : signals.rof40Cross80 ? 'hyper' : null;
      return { ...q, opLeverage, rof40, yoyAccel, opMDelta, signals, inflectionLevel };
    });
    for (let i = 0; i < trend.length; i++) {
      const q = trend[i], prevQ = trend[i + 1] ?? null, s = q.signals;
      let pts = 0;
      if (s.redToBlack) pts += 40;
      if (s.rof40Cross40) pts += 30;
      if (s.rof40Cross60) pts += 25;
      if (s.rof40Cross80) pts += 30;
      if (s.opMInflection) pts += 20;
      if (s.yoyAccelStrong) pts += 15;
      if (s.opLevHigh) pts += 20;
      if (q.opMDelta !== null && q.opMDelta >= 15) pts += 10;
      if (q.opMDelta !== null && q.opMDelta >= 20) pts += 10;
      let mult = 1.0;
      const prevRof40Max = trend.slice(i + 1).map(p => p.rof40).filter(r => r !== null).reduce((m, r) => Math.max(m, r), 0);
      if (q.rof40 !== null && q.rof40 > prevRof40Max && prevRof40Max > 20) mult *= 1.5;
      if (prevQ) {
        const ps = prevQ.signals;
        if (['redToBlack', 'rof40Cross40', 'rof40Cross60', 'rof40Cross80'].some(k => s[k] && ps[k])) mult *= 0.25;
        if (['opMInflection', 'yoyAccelStrong', 'opLevHigh'].filter(k => s[k] && ps[k]).length >= 2) mult *= 1.3;
      }
      q.signalScore = Math.min(100, Math.round(pts * mult));
    }
    return trend;
  }

  const DAY = 86400000;
  const iso = t => new Date(t).toISOString().slice(0, 10);
  /** Calendar quarter end that follows `end` (YYYY-MM-DD, a quarter end). */
  function nextQuarterEnd(end) {
    const d = new Date(end + 'T00:00:00Z');
    return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 4, 0));
  }
  const quarterLabel = end => {
    const d = new Date(end + 'T00:00:00Z'), m = d.getUTCMonth() + 1;
    return `${d.getUTCFullYear()} ${m <= 3 ? 'Q1' : m <= 6 ? 'Q2' : m <= 9 ? 'Q3' : 'Q4'}`;
  };
  /** Actual row ~1 year before `end` (±20 days), or null — never a guess. */
  function yearAgo(trend, end) {
    const target = Date.parse(end) - 365 * DAY;
    return trend.find(q => Math.abs(Date.parse(q.end) - target) <= 20 * DAY) ?? null;
  }

  /**
   * The quarter the next earnings report covers is the one after the latest actual
   * quarter when the report date is 20–150 days after that quarter's end; otherwise
   * the consensus cannot be matched to a quarter (returns null).
   */
  function consensusQuarter(trend, next) {
    if (!trend?.length || !next?.date) return null;
    const end = nextQuarterEnd(trend[0].end);
    const lag = (Date.parse(next.date) - Date.parse(end)) / DAY;
    return lag >= 20 && lag <= 150 ? end : null;
  }

  /**
   * One forecast row, scored with the legacy rules on top of the actual trend.
   * input: { revM (required), opMargin?, epsQ?, source, kind: 'consensus'|'own' }
   */
  function forecastRow(trend, input) {
    const revM = nn(input.revM);
    if (!trend?.length || revM === null || revM <= 0) return null;
    const end = input.end || nextQuarterEnd(trend[0].end);
    const ago = yearAgo(trend, end);
    const opMargin = nn(input.opMargin);
    const q = {
      end, label: quarterLabel(end), revM,
      revYoY: ago && ago.revM > 0 ? (revM / ago.revM - 1) * 100 : null,
      revQoQ: trend[0].revM > 0 ? (revM / trend[0].revM - 1) * 100 : null,
      opMargin, opM: opMargin === null ? null : revM * opMargin / 100,
      costRatio: null, grossMargin: null, opExRatio: null,
      epsQ: nn(input.epsQ), epsYoY: ago && nn(input.epsQ) !== null && nn(ago.epsQ) !== null ? input.epsQ - ago.epsQ : null,
      forecast: true, kind: input.kind, source: input.source || ''
    };
    return enrich([q, ...trend])[0];
  }

  /** Own assumption (per device): { revM?, revYoY?, opMargin? } stored per ticker. */
  const KEY = t => 'pm_forecast_' + t;
  function readOwn(storage, ticker) {
    try {
      const v = JSON.parse(storage.getItem(KEY(ticker)));
      return v && typeof v === 'object' ? v : null;
    } catch { return null; }
  }
  function saveOwn(storage, ticker, v) {
    if (!v) storage.removeItem(KEY(ticker));
    else storage.setItem(KEY(ticker), JSON.stringify({ ...v, savedAt: new Date().toISOString() }));
  }
  /** Revenue from an own assumption given as $M or as YoY % (YoY needs the year-ago actual). */
  function ownRevenue(trend, own) {
    if (nn(own?.revM) !== null) return own.revM;
    if (nn(own?.revYoY) === null || !trend?.length) return null;
    const ago = yearAgo(trend, nextQuarterEnd(trend[0].end));
    return ago && ago.revM > 0 ? ago.revM * (1 + own.revYoY / 100) : null;
  }

  const api = { enrich, forecastRow, consensusQuarter, nextQuarterEnd, quarterLabel, yearAgo, readOwn, saveOwn, ownRevenue };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PMForecast = api;
})(globalThis);
