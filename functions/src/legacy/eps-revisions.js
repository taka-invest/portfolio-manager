// NOT DEPLOYED: scrapes finviz.com HTML. Kept only for reference until a data
// source with clear terms of use is chosen (see docs/MIGRATION_AUDIT.md).
// Netlify Function: EPS Revision Detection (Finviz)
// Returns: Current EPS estimate vs previous, revision trend, signal score bonus

const SEC_HEADERS = {
  "User-Agent": "MasyaScreener contact@example.com",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// Simple cache (12 hours TTL)
const cache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000;

function getCached(ticker) {
  const entry = cache.get(ticker);
  if (entry && Date.now() - entry.ts < CACHE_TTL) {
    return entry.data;
  }
  cache.delete(ticker);
  return null;
}

function setCached(ticker, data) {
  cache.set(ticker, { data, ts: Date.now() });
}

async function fetchFinviz(ticker) {
  const url = `https://finviz.com/quote.ashx?t=${ticker}`;
  try {
    const res = await fetch(url, { headers: SEC_HEADERS, timeout: 5000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    throw new Error(`Finviz fetch failed: ${e.message}`);
  }
}

// Parse Finviz HTML to extract EPS revision data
function parseFinvizEPS(html, ticker) {
  const result = {
    ticker,
    current_eps_estimate: null,
    previous_eps_estimate: null,
    revision_percent: null,
    revisions_up_30d: null,
    revisions_down_30d: null,
    revision_trend: "neutral",
    days_since_latest: null,
    signalScore_bonus: 0,
    description: "",
    guidance_keywords: [],
    full_text_snippet: "",
    error: null,
  };

  try {
    // Extract "Est. EPS Next Year" pattern
    // Finviz format: <td>EPS next Y.</td><td align="right"><b>2.05</b></td>
    const epsNextMatch = html.match(/Est\.\s+EPS\s+Next\s+Y\.\<\/td\>\s*\<td[^>]*\>\s*\<b\>([0-9.]+)\<\/b\>/i) ||
                         html.match(/EPS\s+next\s+Y\.\<\/td\>\s*\<td[^>]*\>\s*\<b\>([0-9.]+)\<\/b\>/i);

    if (epsNextMatch) {
      result.current_eps_estimate = parseFloat(epsNextMatch[1]);
    }

    // Look for "EPS Past 30A" or revision pattern
    // Format: EPS past 30A: +0.25 (shows revision from 30 days ago)
    const epsPast30Match = html.match(/EPS\s+past\s+30A\.?\<\/td\>\s*\<td[^>]*\>\s*\<b\>([+-]?[0-9.]+)\<\/b\>/i);

    if (epsPast30Match && result.current_eps_estimate) {
      const revisionDelta = parseFloat(epsPast30Match[1]);
      result.previous_eps_estimate = result.current_eps_estimate - revisionDelta;

      if (result.previous_eps_estimate && result.previous_eps_estimate > 0) {
        result.revision_percent = (revisionDelta / result.previous_eps_estimate) * 100;
      }
    }

    // Parse revision counts (analyst estimate revisions)
    // Typically shown as separate rows
    const revisionsMatch = html.match(/Analysts?\s+(?:Revisions?|Estimate?\s+Revisions?)/i);

    // Simple heuristic: look for revision sentiment in the page
    // Count occurrences of "up" and "down" in revision context
    const revisionContext = html.slice(
      Math.max(0, html.indexOf("Estimates") - 2000),
      Math.min(html.length, html.indexOf("Estimates") + 3000)
    );

    const upCount = (revisionContext.match(/up/gi) || []).length;
    const downCount = (revisionContext.match(/down/gi) || []).length;

    result.revisions_up_30d = Math.max(upCount - 2, 0); // Rough estimate, subtract noise
    result.revisions_down_30d = Math.max(downCount - 2, 0);

    // Determine trend
    if (result.revision_percent !== null) {
      if (result.revision_percent >= 10) result.revision_trend = "strong_up";
      else if (result.revision_percent >= 5) result.revision_trend = "up";
      else if (result.revision_percent <= -10) result.revision_trend = "strong_down";
      else if (result.revision_percent <= -5) result.revision_trend = "down";
      else result.revision_trend = "neutral";
    }

    // Calculate days since latest revision (approximation)
    result.days_since_latest = 3; // Default assumption

    // Calculate signal score bonus
    if (result.revision_percent !== null && result.revision_percent >= 5) {
      // Base bonus for positive revision >= 5%
      if (result.revision_percent >= 10) {
        result.signalScore_bonus = 15;
      } else {
        result.signalScore_bonus = 10;
      }

      // Additional bonus for revision ratio (up > down)
      if (result.revisions_up_30d > 0 && result.revisions_down_30d === 0) {
        result.signalScore_bonus += 3;
      }
    }

    // Build description
    if (result.current_eps_estimate && result.previous_eps_estimate) {
      result.description = `EPS予想 ${result.revision_percent >= 0 ? '+' : ''}${result.revision_percent.toFixed(1)}% ` +
        `上方修正（上方修正${result.revisions_up_30d}件 vs 下方修正${result.revisions_down_30d}件）`;
    } else {
      result.description = "EPS修正データ取得中...";
    }

  } catch (e) {
    result.error = e.message;
  }

  return result;
}

export const handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors, body: "" };
  }

  const ticker = (event.queryStringParameters?.ticker || "").toUpperCase().trim();
  if (!ticker || !/^[A-Z]{1,5}$/.test(ticker)) {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ error: "Invalid ticker" }),
    };
  }

  try {
    // Check cache first
    const cached = getCached(ticker);
    if (cached) {
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({ ...cached, fromCache: true }),
      };
    }

    // Fetch from Finviz
    const html = await fetchFinviz(ticker);
    const result = parseFinvizEPS(html, ticker);

    // Cache the result
    setCached(ticker, result);

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify(result),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({
        error: e.message,
        ticker,
        signalScore_bonus: 0,
      }),
    };
  }
};
