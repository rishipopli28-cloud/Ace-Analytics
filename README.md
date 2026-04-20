# ACE Analytics — Stock Intelligence Platform
## Production-Grade Stock Analysis Dashboard

---

## QUICK START

### 1. Prerequisites
- Node.js v18+ installed
- npm v8+

### 2. Install Dependencies
```bash
cd stock-dashboard
npm install
```

### 3. Configure API Keys
```bash
cp .env.example .env
```

Edit `.env` and fill in your API keys:
```
ALPHA_VANTAGE_KEY=your_key_here     # Free at alphavantage.co
NEWS_API_KEY=your_key_here           # Free at newsapi.org
PORT=3000
```

> **Note:** The dashboard works without API keys. Yahoo Finance (via yfinance2) works without a key.
> Alpha Vantage & NewsAPI enhance RSI/MACD and sentiment analysis respectively.
> Without keys, RSI is calculated manually from historical data, and news sentiment shows "No data."

### 4. Start Server
```bash
npm start
```

### 5. Open Dashboard
```
http://localhost:3000
```

---

## API KEYS (FREE TIERS)

| Service | URL | Free Tier |
|---------|-----|-----------|
| Alpha Vantage | https://alphavantage.co/support/#api-key | 25 req/day |
| NewsAPI | https://newsapi.org/register | 100 req/day |
| Yahoo Finance | Built-in via yahoo-finance2 | No key needed |

---

## ENDPOINTS

| Endpoint | Description |
|----------|-------------|
| `GET /analyze?stock=RELIANCE` | Full stock analysis |
| `GET /compare?stocks=TCS,INFY,WIPRO` | Multi-stock comparison (max 4) |

### Example API Response
```json
{
  "stock": "RELIANCE",
  "cmp": 2450,
  "rsi": 62,
  "pe": 22,
  "roe": 18,
  "intrinsic_value": 2900,
  "score": 7.6,
  "decision": "BUY",
  "entry": "2401–2474",
  "stop_loss": 2278,
  "target": 2900
}
```

---

## SUPPORTED STOCKS

**Indian (NSE):** Reliance, TCS, Infosys, HDFC Bank, ICICI Bank, Wipro, Bajaj Finance, SBI, Axis Bank, Kotak Bank, HUL, Maruti, Tata Motors, Sun Pharma, Titan, ONGC, NTPC, Asian Paints, Dr. Reddy's, Cipla, Tata Steel, JSW Steel, HCL Tech, Tech Mahindra, Bharti Airtel, ITC, Nestle, Ultra Cement, Adani Ports, Power Grid

**US:** Apple (AAPL), Microsoft (MSFT), Google (GOOGL), Amazon (AMZN), Tesla (TSLA), Nvidia (NVDA), Meta, Netflix

**Any ticker:** You can also directly enter NSE tickers (e.g., RELIANCE.NS) or US tickers (AAPL)

---

## SCORING MODEL

| Factor | Weight | Metric |
|--------|--------|--------|
| Fundamental | 25% | ROE + P/E |
| Valuation | 25% | CMP vs Intrinsic Value |
| Technical | 20% | RSI + Momentum (DMA) |
| Sentiment | 10% | News Analysis |
| Risk (deducted) | 15% | D/E + Liquidity |

### Decision Matrix
| Score | Decision |
|-------|----------|
| > 8.0 | STRONG BUY |
| 6–8 | BUY |
| 4–6 | HOLD |
| 2–4 | SELL |
| < 2 | AVOID |

---

## FEATURES

- Real-time price data via Yahoo Finance
- RSI (14) from Alpha Vantage or manual calculation fallback
- MACD from Alpha Vantage
- 20/50/200 DMA signals
- News sentiment analysis (positive/negative/neutral)
- Intrinsic value calculation (EPS × Industry PE)
- Trade setup: Entry zone, Stop Loss, Target
- 5-minute server-side caching (prevents API rate limit hits)
- Multi-stock comparison table (up to 4 stocks)
- Radar chart for score breakdown
- Mobile-responsive dark UI

---

## PROJECT STRUCTURE

```
stock-dashboard/
├── server.js          # Express backend + scoring engine
├── package.json
├── .env.example       # API key template
├── .env               # Your actual keys (DO NOT COMMIT)
├── README.md
└── public/
    └── index.html     # Full frontend (single file)
```

---

## DEVELOPMENT

```bash
npm run dev    # Uses nodemon for auto-reload
```

---

## DISCLAIMER

This tool is for educational and research purposes only. Nothing here constitutes financial advice. Always perform your own due diligence before making investment decisions.
