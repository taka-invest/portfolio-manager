// Ported verbatim from the Netlify production source (masya_app, 2026-09-17) except
// that every upstream request goes through ../sec-gateway.js (SEC UA, pacing, cache,
// retry). Do not fix financial logic here: corrected logic lives in ../sec/.
// Netlify Function: SEC 8-K Guidance Detection
// Analyzes recent 8-K filings for earnings guidance and outlook changes

import { getJson, getText } from '../sec-gateway.js';

// Simple cache (12 hours TTL)
const cache = new Map();
const CACHE_TTL = 12 * 60 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) {
    return entry.data;
  }
  cache.delete(key);
  return null;
}

function setCached(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

const fetchJson = url => getJson(url);

// Fetch SEC EDGAR submissions (JSON format)
async function getSEC8KData(ticker, cik) {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const data = await fetchJson(url);
  return data;
}

// Parse 8-K for guidance keywords and direction
function analyze8KText(text) {
  const result = {
    guidance_detected: false,
    guidance_keywords: [],
    revenue_guidance: null,
    margin_guidance: null,
    eps_guidance: null,
    direction: "neutral", // up / down / flat
    snippet: "",
  };

  if (!text || text.length < 100) {
    return result;
  }

  // Normalize text
  const normalized = text.toLowerCase();

  // Key guidance keywords
  const upKeywords = ["raised", "raised our", "increased our", "raising", "upside", "raise", "beat"];
  const downKeywords = ["reduced", "lowered", "reduced our", "lower", "downside", "downgrade"];
  const guidanceKeywords = ["guidance", "outlook", "guidance for", "forecast", "expect", "guidance update", "guidance raise"];

  // Check for guidance presence
  const hasGuidance = guidanceKeywords.some(kw => normalized.includes(kw));
  const hasUp = upKeywords.some(kw => normalized.includes(kw));
  const hasDown = downKeywords.some(kw => normalized.includes(kw));

  if (hasGuidance) {
    result.guidance_detected = true;
    result.guidance_keywords = [
      ...upKeywords.filter(kw => normalized.includes(kw)),
      ...guidanceKeywords.filter(kw => normalized.includes(kw))
    ].slice(0, 3);

    // Determine direction
    if (hasUp && !hasDown) result.direction = "up";
    else if (hasDown && !hasUp) result.direction = "down";
    else if (hasUp && hasDown) result.direction = "mixed"; // unclear
    else result.direction = "neutral";

    // Try to extract revenue guidance (pattern: X.XB or XXM)
    const revenueMatch = text.match(/(?:revenue|sales).*?(?:guidance|outlook|expect).*?([\d.]+)\s*(?:billion|million|B|M)/i) ||
                         text.match(/expect.*?revenue.*?([\d.]+)\s*(?:billion|million|B|M)/i) ||
                         text.match(/(\d+(?:\.\d+)?)\s*(?:billion|B)\s*(?:revenue|sales)/i);

    if (revenueMatch) {
      const value = parseFloat(revenueMatch[1]);
      const isBillion = revenueMatch[0].toLowerCase().includes('b') || revenueMatch[0].toLowerCase().includes('billion');
      result.revenue_guidance = {
        value,
        currency: isBillion ? "B" : "M",
        period: "Next Quarter" // Typical 8-K guidance is for next quarter
      };
    }

    // Try to extract margin guidance (pattern: XX.X% or XX%)
    const marginMatch = text.match(/(?:gross margin|gross profit margin|margin).*?([\d.]+)\s*%/i) ||
                       text.match(/([\d.]+)\s*%\s*(?:gross margin|margin)/i);

    if (marginMatch) {
      const value = parseFloat(marginMatch[1]);
      result.margin_guidance = {
        value,
        type: "gross margin",
        direction: hasUp && !hasDown ? "up" : hasDown && !hasUp ? "down" : "flat"
      };
    }

    // Try to extract EPS guidance
    const epsMatch = text.match(/(?:eps|earnings per share).*?(?:expect|guidance).*?([\d.]+)/i) ||
                     text.match(/expect.*?eps.*?([\d.]+)/i);

    if (epsMatch) {
      result.eps_guidance = {
        value: parseFloat(epsMatch[1])
      };
    }

    // Extract snippet (first 150 chars of guidance-related text)
    const snippetMatch = text.match(/(?:guidance|expect|raise|outlook).*?[.!]/i);
    if (snippetMatch) {
      result.snippet = snippetMatch[0].slice(0, 150);
    }
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
  const cik = (event.queryStringParameters?.cik || "").padStart(10, "0");

  if (!ticker || !/^[A-Z]{1,5}$/.test(ticker)) {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ error: "Invalid ticker" }),
    };
  }

  if (!cik || cik === "0000000000") {
    return {
      statusCode: 400,
      headers: cors,
      body: JSON.stringify({ error: "CIK required for 8-K lookup" }),
    };
  }

  try {
    const cacheKey = `${ticker}-8k`;
    const cached = getCached(cacheKey);
    if (cached) {
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({ ...cached, fromCache: true }),
      };
    }

    const submissions = await getSEC8KData(ticker, cik);

    // Find the most recent 8-K filing
    const filings = submissions?.filings?.recent || [];
    const recent8K = filings.find(f => f.form === "8-K");

    if (!recent8K) {
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({
          ticker,
          latest_8k_date: null,
          guidance_detected: false,
          guidance_keywords: [],
          signalScore_bonus: 0,
          days_since_8k: null,
          description: "No recent 8-K filings found",
          error: "No 8-K found",
        }),
      };
    }

    const accessionNumber = recent8K.accession_number?.replace(/-/g, "");
    const filingDate = recent8K.filing_date;

    // Calculate days since filing
    const filingDateObj = new Date(filingDate);
    const today = new Date();
    const daysSince = Math.floor((today - filingDateObj) / (1000 * 60 * 60 * 24));

    // Fetch the actual 8-K document text
    let documentText = "";
    try {
      const docUrl = `https://www.sec.gov/cgi-bin/viewer?action=view&cik=${cik}&accession_number=${accessionNumber}&xbrl_type=v`;
      {
        const html = await getText(docUrl);
        // Simple extraction: look for text between <div> tags
        const textMatch = html.match(/<div[^>]*>([\s\S]{100,1000}?)<\/div>/);
        documentText = textMatch ? textMatch[1] : "";
      }
    } catch (e) {
      // Document fetch failed, use filing_date as indicator only
      documentText = "";
    }

    const analysis = analyze8KText(documentText || filingDate);

    // Calculate signal score bonus
    let signalScore_bonus = 0;
    if (analysis.guidance_detected) {
      signalScore_bonus = 20; // Base bonus for guidance detection

      // Additional bonus for direction
      if (analysis.direction === "up" &&
          analysis.revenue_guidance &&
          analysis.margin_guidance) {
        signalScore_bonus += 5; // Multiple metrics guidance
      }
    }

    const result = {
      ticker,
      latest_8k_date: filingDate,
      guidance_detected: analysis.guidance_detected,
      guidance_keywords: analysis.guidance_keywords,
      revenue_guidance: analysis.revenue_guidance,
      margin_guidance: analysis.margin_guidance,
      eps_guidance: analysis.eps_guidance,
      full_text_snippet: analysis.snippet,
      guidance_direction: analysis.direction,
      signalScore_bonus,
      days_since_8k: daysSince,
      description: analysis.guidance_detected
        ? `ガイダンス${analysis.direction === "up" ? "上方" : analysis.direction === "down" ? "下方" : ""}修正（${filingDate}）`
        : `最新8-K: ${filingDate}（${daysSince}日前）`,
    };

    setCached(cacheKey, result);

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
        guidance_detected: false,
        signalScore_bonus: 0,
      }),
    };
  }
};
