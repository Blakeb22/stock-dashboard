// api/stock.js
// Vercel serverless API endpoint for Blake's stock dashboard.
// Keeps FINNHUB_API_KEY private on Vercel and lets GitHub Pages search any ticker.

export default async function handler(req, res) {
  const allowedOrigins = new Set([
    "https://blakeb22.github.io",
    "http://localhost:8000",
    "http://127.0.0.1:8000"
  ]);

  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigins.has(origin) ? origin : "https://blakeb22.github.io");
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
    return res.status(500).json({ error: "FINNHUB_API_KEY is missing in Vercel environment variables." });
  }

  const base = "https://finnhub.io/api/v1";
  const makeUrl = (path) => `${base}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;

  try {
    const [quoteRes, profileRes, recRes, targetRes] = await Promise.all([
      fetch(makeUrl(`/quote?symbol=${encodeURIComponent(symbol)}`)),
      fetch(makeUrl(`/stock/profile2?symbol=${encodeURIComponent(symbol)}`)),
      fetch(makeUrl(`/stock/recommendation?symbol=${encodeURIComponent(symbol)}`)),
      fetch(makeUrl(`/stock/price-target?symbol=${encodeURIComponent(symbol)}`))
    ]);

    const [quote, profile, recommendations, priceTarget] = await Promise.all([
      quoteRes.json(),
      profileRes.json(),
      recRes.json(),
      targetRes.json()
    ]);

    if (!quote || quote.c === 0 || quote.c === null || quote.c === undefined) {
      return res.status(404).json({
        error: `No quote returned for ${symbol}. Check the ticker or Finnhub coverage.`
      });
    }

    const latestRec = Array.isArray(recommendations) && recommendations.length ? recommendations[0] : null;
    const total = latestRec
      ? ["strongBuy", "buy", "hold", "sell", "strongSell"].reduce((sum, key) => sum + Number(latestRec[key] || 0), 0)
      : 0;

    const bullish = latestRec ? Number(latestRec.strongBuy || 0) + Number(latestRec.buy || 0) : 0;
    const bearish = latestRec ? Number(latestRec.sell || 0) + Number(latestRec.strongSell || 0) : 0;

    let consensus = "No analyst consensus available";
    if (total > 0) {
      const bullishPct = Math.round((bullish / total) * 100);
      if (bullishPct >= 80) consensus = "Strong Buy / Bullish";
      else if (bullishPct >= 60) consensus = "Buy / Positive";
      else if (bearish / total >= 0.40) consensus = "Sell / Bearish";
      else consensus = "Hold / Mixed";
    }

    return res.status(200).json({
      symbol,
      company: profile?.name || symbol,
      exchange: profile?.exchange || "",
      industry: profile?.finnhubIndustry || "",
      quote: {
        current: quote.c ?? null,
        change: quote.d ?? null,
        percentChange: quote.dp ?? null,
        high: quote.h ?? null,
        low: quote.l ?? null,
        open: quote.o ?? null,
        previousClose: quote.pc ?? null
      },
      analyst: latestRec
        ? {
            period: latestRec.period,
            strongBuy: latestRec.strongBuy || 0,
            buy: latestRec.buy || 0,
            hold: latestRec.hold || 0,
            sell: latestRec.sell || 0,
            strongSell: latestRec.strongSell || 0,
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
          },
      priceTarget: priceTarget && Object.keys(priceTarget).length
        ? {
            targetHigh: priceTarget.targetHigh ?? null,
            targetLow: priceTarget.targetLow ?? null,
            targetMean: priceTarget.targetMean ?? null,
            targetMedian: priceTarget.targetMedian ?? null,
            lastUpdated: priceTarget.lastUpdated ?? null
          }
        : null,
      note: "Analyst consensus is separate from valuation. Fair value and buy-under need separate research."
    });
  } catch (error) {
    return res.status(500).json({
      error: "Lookup failed.",
      details: String(error)
    });
  }
}
