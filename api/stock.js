// api/stock.js
// Vercel serverless API endpoint for Blake's stock dashboard.
// Keeps FINNHUB_API_KEY private on Vercel.
// Uses Finnhub first, then a Yahoo Finance quote fallback when Finnhub has no quote for a ticker.

export default async function handler(req, res) {
  const allowedOrigins = new Set([
    "https://blakeb22.github.io",
    "http://localhost:8000",
    "http://127.0.0.1:8000"
  ]);

  const origin = req.headers.origin || "";
  res.setHeader(
    "Access-Control-Allow-Origin",
    allowedOrigins.has(origin) ? origin : "https://blakeb22.github.io"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const symbol = String(req.query.symbol || "").trim().toUpperCase();

  if (!symbol || !/^[A-Z0-9.\-]{1,12}$/.test(symbol)) {
    return res.status(400).json({ error: "Enter a valid ticker symbol." });
  }

  const token = process.env.FINNHUB_API_KEY;

  if (!token) {
    return res.status(500).json({
      error: "FINNHUB_API_KEY is missing in Vercel environment variables."
    });
  }

  const jsonFetch = async (url) => {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 stock-dashboard-lookup"
      }
    });

    return response.json();
  };

  const finnhubBase = "https://finnhub.io/api/v1";

  const finnhubUrl = (path) => {
    return `${finnhubBase}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
  };

  async function getFinnhubData() {
    const [quote, profile, recommendations, priceTarget] = await Promise.all([
      jsonFetch(finnhubUrl(`/quote?symbol=${encodeURIComponent(symbol)}`)),
      jsonFetch(finnhubUrl(`/stock/profile2?symbol=${encodeURIComponent(symbol)}`)),
      jsonFetch(finnhubUrl(`/stock/recommendation?symbol=${encodeURIComponent(symbol)}`)),
      jsonFetch(finnhubUrl(`/stock/price-target?symbol=${encodeURIComponent(symbol)}`))
    ]);

    return {
      quote,
      profile,
      recommendations,
      priceTarget
    };
  }

  async function getYahooQuote() {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const data = await jsonFetch(url);
    const item = data?.quoteResponse?.result?.[0];

    if (
      !item ||
      item.regularMarketPrice === undefined ||
      item.regularMarketPrice === null
    ) {
      return null;
    }

    return {
      company: item.longName || item.shortName || symbol,
      exchange: item.fullExchangeName || item.exchange || "",
      industry: item.quoteType || "",
      quote: {
        current: item.regularMarketPrice ?? null,
        change: item.regularMarketChange ?? null,
        percentChange: item.regularMarketChangePercent ?? null,
        high: item.regularMarketDayHigh ?? null,
        low: item.regularMarketDayLow ?? null,
        open: item.regularMarketOpen ?? null,
        previousClose: item.regularMarketPreviousClose ?? null
      }
    };
  }

  async function getYahooAnalystFallback() {
    try {
      const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=recommendationTrend,financialData`;
      const data = await jsonFetch(url);
      const result = data?.quoteSummary?.result?.[0];

      const trend = result?.recommendationTrend?.trend?.[0] || null;
      const fd = result?.financialData || null;

      const rec = trend
        ? {
            period: trend.period || null,
            strongBuy: Number(trend.strongBuy || 0),
            buy: Number(trend.buy || 0),
            hold: Number(trend.hold || 0),
            sell: Number(trend.sell || 0),
            strongSell: Number(trend.strongSell || 0)
          }
        : null;

      const priceTarget = fd
        ? {
            targetHigh: fd.targetHighPrice?.raw ?? null,
            targetLow: fd.targetLowPrice?.raw ?? null,
            targetMean: fd.targetMeanPrice?.raw ?? null,
            targetMedian: fd.targetMedianPrice?.raw ?? null,
            lastUpdated: null
          }
        : null;

      return {
        rec,
        priceTarget
      };
    } catch {
      return {
        rec: null,
        priceTarget: null
      };
    }
  }

  function buildAnalyst(latestRec) {
    const total = latestRec
      ? ["strongBuy", "buy", "hold", "sell", "strongSell"].reduce((sum, key) => {
          return sum + Number(latestRec[key] || 0);
        }, 0)
      : 0;

    const bullish = latestRec
      ? Number(latestRec.strongBuy || 0) + Number(latestRec.buy || 0)
      : 0;

    const bearish = latestRec
      ? Number(latestRec.sell || 0) + Number(latestRec.strongSell || 0)
      : 0;

    let consensus = "No analyst consensus available";

    if (total > 0) {
      const bullishPct = Math.round((bullish / total) * 100);

      if (bullishPct >= 80) {
        consensus = "Strong Buy / Bullish";
      } else if (bullishPct >= 60) {
        consensus = "Buy / Positive";
      } else if (bearish / total >= 0.4) {
        consensus = "Sell / Bearish";
      } else {
        consensus = "Hold / Mixed";
      }
    }

    return latestRec
      ? {
          period: latestRec.period || null,
          strongBuy: Number(latestRec.strongBuy || 0),
          buy: Number(latestRec.buy || 0),
          hold: Number(latestRec.hold || 0),
          sell: Number(latestRec.sell || 0),
          strongSell: Number(latestRec.strongSell || 0),
          total,
          bullish,
          bullishPercent: total ? Math.round((bullish / total) * 100) : null,
          consensus
        }
      : {
          period: null,
          strongBuy: 0,
          buy: 0,
          hold: 0,
          sell: 0,
          strongSell: 0,
          total: 0,
          bullish: 0,
          bullishPercent: null,
          consensus
        };
  }

  try {
    const finnhub = await getFinnhubData();

    const finnhubQuoteOk =
      finnhub.quote &&
      finnhub.quote.c !== undefined &&
      finnhub.quote.c !== null &&
      Number(finnhub.quote.c) > 0;

    let quoteSource = "Finnhub";
    let company = finnhub.profile?.name || symbol;
    let exchange = finnhub.profile?.exchange || "";
    let industry = finnhub.profile?.finnhubIndustry || "";

    let quote = {
      current: finnhub.quote?.c ?? null,
      change: finnhub.quote?.d ?? null,
      percentChange: finnhub.quote?.dp ?? null,
      high: finnhub.quote?.h ?? null,
      low: finnhub.quote?.l ?? null,
      open: finnhub.quote?.o ?? null,
      previousClose: finnhub.quote?.pc ?? null
    };

    if (!finnhubQuoteOk) {
      const yahoo = await getYahooQuote();

      if (!yahoo) {
        return res.status(404).json({
          error: `No quote returned for ${symbol}. Check the ticker or provider coverage.`,
          providerTried: ["Finnhub", "Yahoo Finance fallback"]
        });
      }

      quoteSource = "Yahoo Finance fallback";
      company = yahoo.company || company;
      exchange = yahoo.exchange || exchange;
      industry = yahoo.industry || industry;
      quote = yahoo.quote;
    }

    let latestRec =
      Array.isArray(finnhub.recommendations) && finnhub.recommendations.length
        ? finnhub.recommendations[0]
        : null;

    let priceTarget =
      finnhub.priceTarget && Object.keys(finnhub.priceTarget).length
        ? {
            targetHigh: finnhub.priceTarget.targetHigh ?? null,
            targetLow: finnhub.priceTarget.targetLow ?? null,
            targetMean: finnhub.priceTarget.targetMean ?? null,
            targetMedian: finnhub.priceTarget.targetMedian ?? null,
            lastUpdated: finnhub.priceTarget.lastUpdated ?? null
          }
        : null;

    if (!latestRec || !priceTarget) {
      const yahooAnalyst = await getYahooAnalystFallback();

      if (!latestRec && yahooAnalyst.rec) {
        latestRec = yahooAnalyst.rec;
      }

      if (!priceTarget && yahooAnalyst.priceTarget) {
        priceTarget = yahooAnalyst.priceTarget;
      }
    }

    return res.status(200).json({
      symbol,
      company,
      exchange,
      industry,
      quoteSource,
      quote,
      analyst: buildAnalyst(latestRec),
      priceTarget,
      note:
        "Analyst consensus is separate from valuation. Fair value and buy-under need separate research."
    });
  } catch (error) {
    return res.status(500).json({
      error: "Lookup failed.",
      details: String(error)
    });
  }
}
