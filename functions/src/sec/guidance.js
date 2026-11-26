// Company guidance from the latest earnings release (8-K Item 2.02, Exhibit 99.1).
// Extraction is deliberately conservative and returns CANDIDATES with the original
// sentence and the SEC link; the owner confirms before a figure is used. Margin /
// profit guidance is usually non-GAAP and is returned as reference text only.
import { getJson, getText } from '../sec-gateway.js';

const UNIT = { billion: 1000, b: 1000, million: 1, m: 1, thousand: 0.001, k: 0.001 };

/** HTML -> plain text (entities decoded, whitespace collapsed). */
export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&[lr]squo;/g, "'").replace(/&[lr]dquo;/g, '"').replace(/&[nm]dash;/g, '-')
    .replace(/[–—]/g, '-').replace(/ /g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const num = s => Number(String(s).replace(/,/g, ''));
const GUIDE_CONTEXT = /(outlook|guidance|expects?|expected|anticipates?|forecast)/i;

/** Which period a figure belongs to: the nearest period phrase before it (or inside it). */
function periodOf(text, at, own) {
  const from = Math.max(0, at - 400);
  const before = text.slice(from, at) + ' ' + own;
  let best = { kind: 'unknown', text: '', pos: -1 };
  const scan = (re, kind, skip) => {
    for (const m of before.matchAll(re)) {
      if (skip && skip(before, m.index)) continue;
      if (m.index >= best.pos) best = { kind, text: m[0], pos: m.index };
    }
  };
  scan(/\b(?:Q[1-4](?:\s*(?:FY)?\s*'?\d{2,4})?|[1-4]Q\s?'?\d{2}|(?:first|second|third|fourth)\s+(?:fiscal\s+)?quarter(?:\s+of)?(?:\s+(?:fiscal\s+)?(?:year\s+)?\d{4})?)/gi, 'quarter');
  scan(/\b(?:full[-\s]year(?:\s+(?:fiscal\s+)?\d{4})?|fiscal\s+(?:year\s+)?\d{4}|(?:for|in)\s+\d{4}(?!\s*(?:first|second|third|fourth|Q[1-4])))\b/gi, 'year',
    // "fourth quarter (of) fiscal year 2026" is a quarter, not a year
    (s, i) => /quarter\s+(?:of\s+)?$/i.test(s.slice(Math.max(0, i - 14), i)));
  return { kind: best.kind, text: best.text };
}

/**
 * Revenue guidance candidates (values in $ millions) and other guidance sentences.
 * @returns {{ revenue: Array<{low, high, mid, approx, period, periodText, snippet}>, other: string[] }}
 */
export function extractGuidance(text) {
  const revenue = [];
  const seen = new Set();
  const push = (m, low, high, approx) => {
    if (!(low > 0) || !(high >= low) || high > low * 1.5) return;      // implausible ranges are not guesses
    const before = text.slice(Math.max(0, m.index - 300), m.index);
    if (!GUIDE_CONTEXT.test(before + m[0])) return;                     // results tables, not guidance
    const p = periodOf(text, m.index, m[0]);
    const key = [low, high, p.kind].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    // "U.S. commercial revenue", "AI semiconductor revenue": a segment, not total revenue.
    const lead = (text.slice(Math.max(0, m.index - 40), m.index).match(/([A-Za-z.&-]+)\s*$/) || [])[1] || '';
    const segment = !!lead && !/^(?:total|our|the|of|quarter|year|for|expects?|guidance|consolidated|net|and|low|high)$/i.test(lead);
    revenue.push({ low, high, mid: (low + high) / 2, approx, segment, period: p.kind, periodText: p.text,
      snippet: text.slice(Math.max(0, m.index - 120), Math.min(text.length, m.index + m[0].length + 60)).trim() });
  };
  const unitOf = (u, at) => {
    if (u) return UNIT[u.toLowerCase()];
    const ctx = text.slice(Math.max(0, at - 300), at);
    return /\(in thousands/i.test(ctx) ? 0.001 : /\(in millions/i.test(ctx) ? 1 : null;
  };
  // Ranges: "Revenue is expected to be between $525 million and $535 million",
  // "Revenue of between $2.649 - $2.653 billion", "revenue guidance to between $8.5 - $8.6 billion".
  const RANGE = /\b(?:total\s+)?revenues?\b(?:\s+guidance)?[^.;:•$]{0,60}?(?:between|of|in the range of|range of|to be|at)\s*(?:between\s*)?\$\s?([\d,]+(?:\.\d+)?)\s*(billion|million|thousand|B|M|K)?\s*(?:-|to|and)\s*\$?\s?([\d,]+(?:\.\d+)?)\s*(billion|million|thousand|B|M|K)?\b/gi;
  for (const m of text.matchAll(RANGE)) {
    const u2 = unitOf(m[4] || m[2], m.index), u1 = m[2] ? UNIT[m[2].toLowerCase()] : u2;
    if (u1 == null || u2 == null) continue;
    push(m, num(m[1]) * u1, num(m[3]) * u2, false);
  }
  // Single point: "revenue guidance of approximately $34.8 billion".
  const POINT = /\b(?:total\s+)?revenues?\b(?:\s+guidance)?[^.;:•$]{0,40}?(?:of\s+)?(?:approximately|about|roughly)\s+\$\s?([\d,]+(?:\.\d+)?)\s*(billion|million|B|M)\b/gi;
  for (const m of text.matchAll(POINT)) {
    const v = num(m[1]) * UNIT[m[2].toLowerCase()];
    push(m, v, v, true);
  }
  // Point with tolerance: "Revenue is expected to be $130.0 billion, plus or minus 3%" (NVIDIA).
  const PM = /\b(?:total\s+)?revenues?\b[^.;:•$]{0,40}?(?:to be|of)\s+\$\s?([\d,]+(?:\.\d+)?)\s*(billion|million|B|M)\b,?\s*plus or minus\s+(\d+(?:\.\d+)?)\s*%/gi;
  for (const m of text.matchAll(PM)) {
    const v = num(m[1]) * UNIT[m[2].toLowerCase()], tol = num(m[3]) / 100;
    if (tol > 0.2) continue;
    push(m, +(v * (1 - tol)).toFixed(3), +(v * (1 + tol)).toFixed(3), false);
  }
  // Table: "Guidance Summary ... (In millions) Low High Revenue $2,365 $2,395".
  const TABLE = /\bRevenues?\s+\$\s?([\d,]+(?:\.\d+)?)\s+\$\s?([\d,]+(?:\.\d+)?)/g;
  for (const m of text.matchAll(TABLE)) {
    const ctx = text.slice(Math.max(0, m.index - 300), m.index);
    if (!/\bLow\s+High\b/i.test(ctx)) continue;
    const u = unitOf(null, m.index);
    if (u == null) continue;
    push(m, num(m[1]) * u, num(m[2]) * u, false);
  }
  // Other guidance (margins, operating income, EBITDA, EPS): reference sentences only.
  const other = [];
  let pos = 0;
  // Sentences split on periods that are not decimal points, bullets and semicolons.
  for (const raw of text.split(/(?<!\d)\.(?!\d)|•|;/)) {
    const at = pos;
    pos += raw.length + 1;
    const s = raw.trim();
    if (!/\b(?:operating income|operating margin|income from operations|EBITDA|gross margin|EPS|earnings per share|operating expenses)\b/i.test(s)) continue;
    if (!/(?:between|approximately|range|expected|guidance)/i.test(s) || !/\d/.test(s) || /\breconciliation\b/i.test(s)) continue;
    if (!GUIDE_CONTEXT.test(text.slice(Math.max(0, at - 300), at) + s)) continue;
    const t = s.length > 240 ? s.slice(0, 240) + '…' : s;
    if (!other.includes(t)) other.push(t);
    if (other.length >= 4) break;
  }
  return { revenue, other };
}

/** Latest earnings release (8-K with Item 2.02) and its guidance candidates. */
export async function latestGuidance(cik, { fetchJson = getJson, fetchText = getText } = {}) {
  const cik10 = String(cik).padStart(10, '0');
  const sub = await fetchJson(`https://data.sec.gov/submissions/CIK${cik10}.json`);
  const r = sub?.filings?.recent;
  if (!r) return { error: '提出書類の一覧を取得できませんでした' };
  const i = r.form.findIndex((f, k) => f === '8-K' && /\b2\.02\b/.test(r.items?.[k] || ''));
  if (i < 0) return { error: '決算発表の8-Kが見つかりません' };
  const accession = r.accessionNumber[i];
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/`;
  // The filing index states each document's type; file names vary by company
  // (exhibit991…, q3fy27pr.htm, a2026q3earningsrelease.htm). EX-99.1 is the press
  // release; EX-99.2 is often a CFO commentary that holds the outlook (e.g. NVIDIA).
  const index = await fetchText(base + accession + '-index.html');
  // One table row at a time (Seq | Description | Document | Type | Size), so a link is
  // never paired with the type of a neighbouring row.
  const docs = String(index).split(/<tr\b/i).slice(1).map(row => {
    const cells = [...row.split(/<\/tr>/i)[0].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    const link = cells[2]?.match(/<a href="[^"]*\/([^"/]+\.html?)"/i);
    const type = cells[3]?.replace(/<[^>]+>/g, '').trim().toUpperCase();
    return link && /^EX-99\.[12]$/.test(type) ? { name: link[1], type } : null;
  }).filter(Boolean).sort((a, b) => a.type.localeCompare(b.type));
  if (!docs.length) return { error: '決算発表資料（Exhibit 99.1）が見つかりません', filingDate: r.filingDate[i], accession, url: base };
  const texts = [];
  for (const d of docs) texts.push(htmlToText(await fetchText(base + d.name)));
  const { revenue, other } = extractGuidance(texts.join(' • '));
  return { filingDate: r.filingDate[i], accession, url: base + docs[0].name, docs: docs.map(d => d.type), revenue, other };
}
