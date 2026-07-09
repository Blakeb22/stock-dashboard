import json
import math
import os
import re
import time
from datetime import datetime, timezone
from urllib.parse import quote
from urllib.request import urlopen, Request

INDEX_FILE = "index.html"
FINNHUB_API_KEY = os.environ.get("FINNHUB_API_KEY", "").strip()

# Some tickers can require mapping depending on the data provider.
# Keep this dictionary small and edit it if Finnhub does not return a quote for a symbol.
FINNHUB_SYMBOL_OVERRIDES = {
    "BRK.B": "BRK.B",
}

# Optional custom valuation model.
# Add tickers here when Blake/ChatGPT produces a researched fair value range.
# The automation will preserve these researched estimates and only update current price/upside.
CUSTOM_VALUATIONS = {
    # Example:
    # "TSM": {"fairValue": "$450-$520", "buyUnder": "Under $415"},
}

def fetch_quote(symbol: str) -> dict:
    if not FINNHUB_API_KEY:
        raise RuntimeError("FINNHUB_API_KEY is missing. Add it as a GitHub Actions repository secret.")

    finnhub_symbol = FINNHUB_SYMBOL_OVERRIDES.get(symbol, symbol)
    url = f"https://finnhub.io/api/v1/quote?symbol={quote(finnhub_symbol)}&token={FINNHUB_API_KEY}"
    req = Request(url, headers={"User-Agent": "stock-dashboard-updater/1.0"})
    with urlopen(req, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))

def money(value: float) -> str:
    if value is None or not math.isfinite(value):
        return "N/A"
    if value >= 1000:
        return f"${value:,.0f}"
    if value >= 100:
        return f"${value:,.0f}"
    return f"${value:,.2f}"

def percent(value: float) -> str:
    if value is None or not math.isfinite(value):
        return "N/A"
    sign = "+" if value > 0 else ""
    return f"{sign}{value:.0f}%"

def parse_fair_value_range(text: str):
    if not isinstance(text, str):
        return None
    nums = [float(x.replace(",", "")) for x in re.findall(r"\$?\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)", text)]
    if len(nums) >= 2:
        low, high = min(nums[0], nums[1]), max(nums[0], nums[1])
        return low, high
    if len(nums) == 1:
        return nums[0], nums[0]
    return None

def rule_based_valuation(stock: dict, current_price: float):
    """Fallback estimate when no researched valuation is stored yet.

    This is not a DCF model. It removes placeholders and creates a conservative,
    rules-based estimate until the Monday/Thursday research report supplies better numbers.
    """
    valuation = stock.get("valuation", "fair")
    sector = stock.get("sector", "")
    industry = stock.get("industry", "")
    score = float(stock.get("score", 75) or 75)

    speculative = (
        "Quantum" in sector
        or "Speculative" in industry
        or stock.get("ticker") in {"IREN", "IONQ", "RGTI", "QBTS", "QUBT", "ASTS", "LUNR", "RDW"}
    )

    if speculative:
        if valuation == "undervalued":
            low_mult, high_mult, buy_mult = 0.90, 1.20, 0.75
        elif valuation == "overvalued":
            low_mult, high_mult, buy_mult = 0.45, 0.75, 0.45
        else:
            low_mult, high_mult, buy_mult = 0.70, 1.05, 0.60
    elif sector == "Core ETFs":
        low_mult, high_mult, buy_mult = 0.97, 1.08, 0.95
    elif valuation == "undervalued":
        # Higher score gets slightly wider upside range.
        high_bonus = min(max((score - 75) / 100, 0), 0.12)
        low_mult, high_mult, buy_mult = 1.08, 1.22 + high_bonus, 0.98
    elif valuation == "overvalued":
        low_mult, high_mult, buy_mult = 0.70, 0.90, 0.72
    else:
        low_mult, high_mult, buy_mult = 0.92, 1.10, 0.88

    low = current_price * low_mult
    high = current_price * high_mult
    buy = current_price * buy_mult
    return low, high, buy

def update_stock(stock: dict) -> bool:
    ticker = stock.get("ticker")
    if not ticker or ticker in {"SPCX"}:
        # SPCX may represent private-market SpaceX exposure/ETF-like product depending on setup.
        # Keep a conservative display if Finnhub cannot provide clean public quote data.
        stock["currentPrice"] = stock.get("currentPrice", "N/A")
        stock["fairValue"] = stock.get("fairValue", "Model-dependent")
        stock["buyUnder"] = stock.get("buyUnder", "Research-only")
        stock["upsideToFairValue"] = stock.get("upsideToFairValue", "N/A")
        return True

    try:
        quote_data = fetch_quote(ticker)
        time.sleep(0.15)  # gentle rate-limit protection
    except Exception as exc:
        stock["currentPrice"] = stock.get("currentPrice", "Quote unavailable")
        if "Live update" in str(stock.get("fairValue", "")):
            stock["fairValue"] = "Research estimate pending"
        if "Live update" in str(stock.get("buyUnder", "")):
            stock["buyUnder"] = "Research estimate pending"
        stock["upsideToFairValue"] = stock.get("upsideToFairValue", "N/A")
        stock["keyReason"] = stock.get("keyReason", "") + f" Quote refresh failed for this run."
        return True

    current_price = quote_data.get("c")
    if not isinstance(current_price, (int, float)) or current_price <= 0:
        stock["currentPrice"] = stock.get("currentPrice", "Quote unavailable")
        if "Live update" in str(stock.get("fairValue", "")):
            stock["fairValue"] = "Research estimate pending"
        if "Live update" in str(stock.get("buyUnder", "")):
            stock["buyUnder"] = "Research estimate pending"
        stock["upsideToFairValue"] = stock.get("upsideToFairValue", "N/A")
        return True

    stock["currentPrice"] = money(current_price)

    custom = CUSTOM_VALUATIONS.get(ticker)
    if custom:
        stock["fairValue"] = custom["fairValue"]
        stock["buyUnder"] = custom["buyUnder"]
        fair_range = parse_fair_value_range(custom["fairValue"])
    else:
        existing_fair = str(stock.get("fairValue", ""))
        existing_buy = str(stock.get("buyUnder", ""))

        fair_range = parse_fair_value_range(existing_fair)
        has_placeholder = "Live update" in existing_fair or "needed" in existing_fair or not fair_range

        if has_placeholder:
            low, high, buy = rule_based_valuation(stock, current_price)
            stock["fairValue"] = f"{money(low)}-{money(high)}"
            stock["buyUnder"] = f"Under {money(buy)}"
            fair_range = (low, high)
        else:
            # Preserve researched fair value; only fill buy-under if missing.
            if "Live update" in existing_buy or "needed" in existing_buy:
                low, high = fair_range
                stock["buyUnder"] = f"Under {money(low * 0.92)}"

    if fair_range:
        low, high = fair_range
        low_up = ((low / current_price) - 1) * 100
        high_up = ((high / current_price) - 1) * 100
        if abs(low_up - high_up) < 1:
            stock["upsideToFairValue"] = percent(high_up)
        else:
            stock["upsideToFairValue"] = f"{percent(low_up)} to {percent(high_up)}"
    else:
        stock["upsideToFairValue"] = "N/A"

    return True

def main():
    with open(INDEX_FILE, "r", encoding="utf-8") as f:
        html = f.read()

    match = re.search(r"const report\s*=\s*(\{.*?\n\});", html, flags=re.DOTALL)
    if not match:
        raise RuntimeError("Could not find `const report = {...};` block in index.html")

    report = json.loads(match.group(1))

    changed = False
    for stock in report.get("stocks", []):
        changed = update_stock(stock) or changed

    report["date"] = datetime.now(timezone.utc).strftime("Market data refreshed %Y-%m-%d %H:%M UTC")
    report["confidence"] = "Prices refreshed; fair values are model estimates"
    report["uncertaintyNotes"] = (
        "Current prices are refreshed from Finnhub during scheduled workflow runs. "
        "Fair value and buy-under levels are analyst/model estimates and should be reviewed in the Monday/Thursday research report."
    )

    new_report = "const report = " + json.dumps(report, indent=6) + ";"
    new_html = html[:match.start()] + new_report + html[match.end():]

    # Safety check: no visible placeholder remains.
    new_html = new_html.replace("Live update needed", "Research estimate pending")
    new_html = new_html.replace("Live update", "Research estimate pending")

    with open(INDEX_FILE, "w", encoding="utf-8") as f:
        f.write(new_html)

if __name__ == "__main__":
    main()

