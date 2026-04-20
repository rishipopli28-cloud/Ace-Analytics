require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const NodeCache = require("node-cache");
const path = require("path");

const app = express();
const cache = new NodeCache({ stdTTL: 300 });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || "demo";
const NEWS_API_KEY = process.env.NEWS_API_KEY || "";

// ─── YAHOO FINANCE SESSION (Crumb-Based Auth) ────────────────────────────────
let _yfCrumb = null;
let _yfCookies = "";
let _yfCrumbExpiry = 0;

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Origin": "https://finance.yahoo.com",
  "Referer": "https://finance.yahoo.com/",
};

async function getYahooCrumb() {
  if (_yfCrumb && Date.now() < _yfCrumbExpiry) {
    return { crumb: _yfCrumb, cookies: _yfCookies };
  }

  // Step 1 — Consent/session cookies
  try {
    const consentRes = await axios.get("https://fc.yahoo.com", {
      headers: YF_HEADERS,
      timeout: 8000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    const raw = consentRes.headers["set-cookie"] || [];
    _yfCookies = raw.map((c) => c.split(";")[0]).join("; ");
  } catch (_) { /* non-fatal */ }

  // Step 2 — Get crumb
  const crumbRes = await axios.get(
    "https://query2.finance.yahoo.com/v1/test/getcrumb",
    {
      headers: { ...YF_HEADERS, Cookie: _yfCookies },
      timeout: 10000,
    }
  );
  _yfCrumb = crumbRes.data;
  _yfCrumbExpiry = Date.now() + 3600 * 1000;
  return { crumb: _yfCrumb, cookies: _yfCookies };
}

async function yfGet(url) {
  let session = { crumb: "", cookies: _yfCookies };
  try { session = await getYahooCrumb(); } catch (_) { /* proceed crumbless */ }
  const sep = url.includes("?") ? "&" : "?";
  const finalUrl = session.crumb ? `${url}${sep}crumb=${encodeURIComponent(session.crumb)}` : url;
  return axios.get(finalUrl, {
    headers: { ...YF_HEADERS, Cookie: session.cookies },
    timeout: 12000,
  });
}

// ─── TICKER RESOLVER ─────────────────────────────────────────────────────────
const TICKER_MAP = {
  // Indian stocks
  reliance: "RELIANCE.NS", tcs: "TCS.NS", infosys: "INFY.NS", infy: "INFY.NS",
  hdfc: "HDFCBANK.NS", hdfcbank: "HDFCBANK.NS", icicibank: "ICICIBANK.NS", icici: "ICICIBANK.NS",
  wipro: "WIPRO.NS", bajajfinance: "BAJFINANCE.NS", bajajfinserv: "BAJAJFINSV.NS", bajaj: "BAJFINANCE.NS",
  bhartiairtel: "BHARTIARTL.NS", airtel: "BHARTIARTL.NS", itc: "ITC.NS",
  kotakbank: "KOTAKBANK.NS", kotak: "KOTAKBANK.NS", sbi: "SBIN.NS",
  axisbank: "AXISBANK.NS", axis: "AXISBANK.NS", hul: "HINDUNILVR.NS", hindunilvr: "HINDUNILVR.NS",
  maruti: "MARUTI.NS", tatamotors: "TATAMOTORS.NS", tatamotor: "TATAMOTORS.NS",
  sunpharma: "SUNPHARMA.NS", sun: "SUNPHARMA.NS", ultracemco: "ULTRACEMCO.NS", ultratech: "ULTRACEMCO.NS",
  nestleindia: "NESTLEIND.NS", nestle: "NESTLEIND.NS", titan: "TITAN.NS",
  adaniports: "ADANIPORTS.NS", adani: "ADANIPORTS.NS", ongc: "ONGC.NS", ntpc: "NTPC.NS",
  powergrid: "POWERGRID.NS", asianpaint: "ASIANPAINT.NS", drreddy: "DRREDDY.NS",
  cipla: "CIPLA.NS", tatasteel: "TATASTEEL.NS", jswsteel: "JSWSTEEL.NS", jsw: "JSWSTEEL.NS",
  hcltech: "HCLTECH.NS", hcl: "HCLTECH.NS", techm: "TECHM.NS",
  ltim: "LTIM.NS", ltimindtree: "LTIM.NS", divislab: "DIVISLAB.NS", divi: "DIVISLAB.NS",
  pidilite: "PIDILITIND.NS", mrf: "MRF.NS", bosch: "BOSCHLTD.NS", havells: "HAVELLS.NS",
  voltas: "VOLTAS.NS", pgel: "PGEL.NS", pgelectroplast: "PGEL.NS",
  dixon: "DIXON.NS", dixontechnologies: "DIXON.NS",
  // US stocks
  apple: "AAPL", aapl: "AAPL", microsoft: "MSFT", msft: "MSFT",
  google: "GOOGL", alphabet: "GOOGL", googl: "GOOGL", amazon: "AMZN", amzn: "AMZN",
  tesla: "TSLA", tsla: "TSLA", nvidia: "NVDA", nvda: "NVDA",
  meta: "META", facebook: "META", netflix: "NFLX", nflx: "NFLX",
  berkshire: "BRK-B", jpmorgan: "JPM", jpm: "JPM", visa: "V", mastercard: "MA",
  walmart: "WMT", johnson: "JNJ",
};

function resolveTicker(input) {
  const lower = input.trim().toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9.]/g, "");
  if (TICKER_MAP[lower]) return TICKER_MAP[lower];
  const upper = input.trim().toUpperCase();
  if (upper.includes(".NS") || upper.includes(".BO")) return upper;
  if (/^[A-Z0-9-]{1,6}$/.test(upper)) return upper;
  return upper + ".NS";
}

// ─── YAHOO FINANCE DATA ──────────────────────────────────────────────────────
async function fetchYahooData(ticker) {
  try {
    const modules = "price,defaultKeyStatistics,financialData,summaryDetail,assetProfile";
    const res = await yfGet(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}&formatted=false`
    );
    const result = res.data?.quoteSummary?.result?.[0];
    if (!result) throw new Error("Empty response");
    const { price = {}, financialData: fin = {}, defaultKeyStatistics: stats = {}, summaryDetail: detail = {}, assetProfile: profile = {} } = result;
    return {
      cmp: price.regularMarketPrice || null,
      previousClose: price.regularMarketPreviousClose || null,
      change: price.regularMarketChange || null,
      changePercent: price.regularMarketChangePercent || null,
      volume: price.regularMarketVolume || null,
      marketCap: price.marketCap || null,
      pe: detail.trailingPE || stats.trailingPE || null,
      forwardPE: detail.forwardPE || stats.forwardPE || null,
      eps: stats.trailingEps || null,
      roe: fin.returnOnEquity != null ? fin.returnOnEquity * 100 : null,
      debtToEquity: fin.debtToEquity || null,
      revenueGrowth: fin.revenueGrowth != null ? fin.revenueGrowth * 100 : null,
      grossMargins: fin.grossMargins != null ? fin.grossMargins * 100 : null,
      operatingMargins: fin.operatingMargins != null ? fin.operatingMargins * 100 : null,
      profitMargins: fin.profitMargins != null ? fin.profitMargins * 100 : null,
      currentRatio: fin.currentRatio || null,
      fiftyTwoWeekHigh: detail.fiftyTwoWeekHigh || null,
      fiftyTwoWeekLow: detail.fiftyTwoWeekLow || null,
      fiftyDayAverage: price.fiftyDayAverage || null,
      twoHundredDayAverage: price.twoHundredDayAverage || null,
      shortName: price.shortName || price.longName || ticker,
      currency: price.currency || "INR",
      exchange: price.exchangeName || "NSE",
      sector: profile.sector || "Unknown",
      industry: profile.industry || "Unknown",
    };
  } catch (err) {
    console.error(`[Yahoo] ${ticker}:`, err.message);
    return null;
  }
}

async function fetchHistoricalPrices(ticker, days = 40) {
  try {
    const end = Math.floor(Date.now() / 1000);
    const start = end - days * 86400;
    const res = await yfGet(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${start}&period2=${end}&interval=1d`
    );
    const closes = res.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    return closes.filter((v) => v != null && !isNaN(v));
  } catch {
    return [];
  }
}

// ─── ALPHA VANTAGE ───────────────────────────────────────────────────────────
async function fetchAVRSI(ticker) {
  try {
    const sym = ticker.replace(/\.(NS|BO)$/, "");
    const res = await axios.get("https://www.alphavantage.co/query", {
      params: { function: "RSI", symbol: sym, interval: "daily", time_period: 14, series_type: "close", apikey: ALPHA_VANTAGE_KEY },
      timeout: 10000,
    });
    const series = res.data["Technical Analysis: RSI"];
    if (!series || res.data.Note || res.data.Information) return null;
    const k = Object.keys(series)[0];
    return parseFloat(series[k]["RSI"]);
  } catch { return null; }
}

async function fetchAVMACD(ticker) {
  try {
    const sym = ticker.replace(/\.(NS|BO)$/, "");
    const res = await axios.get("https://www.alphavantage.co/query", {
      params: { function: "MACD", symbol: sym, interval: "daily", series_type: "close", apikey: ALPHA_VANTAGE_KEY },
      timeout: 10000,
    });
    const series = res.data["Technical Analysis: MACD"];
    if (!series || res.data.Note || res.data.Information) return null;
    const k = Object.keys(series)[0];
    return {
      macd: parseFloat(series[k]["MACD"]),
      signal: parseFloat(series[k]["MACD_Signal"]),
      histogram: parseFloat(series[k]["MACD_Hist"]),
    };
  } catch { return null; }
}

async function fetchAVSMA(ticker, period) {
  try {
    const sym = ticker.replace(/\.(NS|BO)$/, "");
    const res = await axios.get("https://www.alphavantage.co/query", {
      params: { function: "SMA", symbol: sym, interval: "daily", time_period: period, series_type: "close", apikey: ALPHA_VANTAGE_KEY },
      timeout: 10000,
    });
    const series = res.data["Technical Analysis: SMA"];
    if (!series || res.data.Note || res.data.Information) return null;
    const k = Object.keys(series)[0];
    return parseFloat(series[k]["SMA"]);
  } catch { return null; }
}

// ─── NEWS ────────────────────────────────────────────────────────────────────
async function fetchNews(stockName) {
  const empty = { articles: [], sentiment: "neutral", score: 5, positive: 0, negative: 0, neutral: 0 };
  if (!NEWS_API_KEY) return empty;
  try {
    const res = await axios.get("https://newsapi.org/v2/everything", {
      params: { q: `${stockName} stock`, language: "en", sortBy: "publishedAt", pageSize: 10, apiKey: NEWS_API_KEY },
      timeout: 8000,
    });
    const articles = res.data.articles || [];
    const POS = ["surge", "rally", "gain", "profit", "growth", "upgrade", "buy", "bullish", "beat", "record", "strong", "rise", "outperform", "breakthrough", "dividend"];
    const NEG = ["fall", "drop", "loss", "decline", "downgrade", "sell", "bearish", "miss", "weak", "plunge", "concern", "fraud", "penalty", "debt", "cut", "lawsuit"];
    let pos = 0, neg = 0, neu = 0;
    articles.forEach((a) => {
      const t = ((a.title || "") + " " + (a.description || "")).toLowerCase();
      const p = POS.filter((w) => t.includes(w)).length;
      const n = NEG.filter((w) => t.includes(w)).length;
      if (p > n) pos++; else if (n > p) neg++; else neu++;
    });
    const total = pos + neg + neu || 1;
    const ratio = (pos - neg) / total;
    const sentiment = ratio > 0.2 ? "positive" : ratio < -0.2 ? "negative" : "neutral";
    return {
      articles: articles.slice(0, 5).map(({ title, source, url, publishedAt }) => ({ title, source: source?.name, url, publishedAt })),
      sentiment,
      score: sentiment === "positive" ? 8 : sentiment === "negative" ? 3 : 5,
      positive: pos, negative: neg, neutral: neu,
    };
  } catch (err) {
    console.error("[News]", err.message);
    return empty;
  }
}

// ─── SCORING ENGINE ──────────────────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const sl = closes.slice(-period - 1);
  let g = 0, l = 0;
  for (let i = 1; i < sl.length; i++) {
    const d = sl[i] - sl[i - 1];
    if (d > 0) g += d; else l += Math.abs(d);
  }
  const rs = (g / period) / ((l / period) || 0.001);
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

const SC = {
  roe: (v) => v == null ? 5 : v > 20 ? 10 : v >= 15 ? 8 : v >= 10 ? 6 : 3,
  pe: (v, med = 22) => v == null ? 5 : (v / med) < 0.8 ? 8 : (v / med) <= 1.2 ? 5 : 3,
  rsi: (v) => v == null ? 5 : v >= 40 && v <= 60 ? 8 : v > 70 ? 4 : v < 30 ? 6 : v > 60 ? 6 : 5,
  de: (v) => v == null ? 6 : v < 0.5 ? 9 : v <= 1 ? 7 : 4,
  val: (c, i) => !c || !i ? 5 : (c / i) < 0.8 ? 9 : (c / i) <= 1.0 ? 7 : (c / i) <= 1.2 ? 5 : 3,
  mom: (c, d5, d2) => {
    let s = 5;
    if (c && d5) s += c > d5 ? 1.5 : -1;
    if (c && d2) s += c > d2 ? 1.5 : -0.5;
    return Math.min(10, Math.max(1, s));
  },
  risk: (de, cr, rg) => {
    let r = 5;
    if (de != null) r += de > 2 ? 3 : de > 1 ? 1.5 : 0;
    if (cr != null && cr < 1) r += 2;
    if (rg != null && rg < 0) r += 1;
    return Math.min(10, r);
  },
};

function composite({ roe, pe, rsi, debtEquity, sentiment, valuation, momentum, risk }) {
  const fund = (roe + pe) / 2;
  const tech = (rsi + momentum) / 2;
  return parseFloat(Math.min(10, Math.max(0,
    fund * 0.25 + valuation * 0.25 + tech * 0.20 + sentiment * 0.10 - (risk - 5) * 0.15
  )).toFixed(2));
}

function getDecision(s) {
  if (s > 8) return { decision: "STRONG BUY", decisionColor: "strong-buy" };
  if (s >= 6) return { decision: "BUY", decisionColor: "buy" };
  if (s >= 4) return { decision: "HOLD", decisionColor: "hold" };
  if (s >= 2) return { decision: "SELL", decisionColor: "sell" };
  return { decision: "AVOID", decisionColor: "avoid" };
}

function computeTargets(cmp, intrinsic, dec) {
  const tgtPcts = { "STRONG BUY": 0.22, "BUY": 0.15, "HOLD": 0.08, "SELL": 0.05, "AVOID": 0.03 };
  const pct = tgtPcts[dec] || 0.10;
  return {
    entry: `${(cmp * 0.98).toFixed(2)}–${(cmp * 1.01).toFixed(2)}`,
    stop_loss: parseFloat((cmp * 0.93).toFixed(2)),
    target: intrinsic
      ? parseFloat(Math.max(intrinsic, cmp * (1 + pct)).toFixed(2))
      : parseFloat((cmp * (1 + pct)).toFixed(2)),
  };
}

// ─── MAIN ENDPOINT ───────────────────────────────────────────────────────────
app.get("/analyze", async (req, res) => {
  const { stock } = req.query;
  if (!stock) return res.status(400).json({ error: "Provide ?stock=RELIANCE" });

  const ticker = resolveTicker(stock);
  const cacheKey = `v3_${ticker}`;
  const hit = cache.get(cacheKey);
  if (hit) return res.json({ ...hit, cached: true });

  try {
    // Fire all requests in parallel
    const [yahoo, news, avRSI, avMACD, avSMA20, avSMA50, avSMA200] = await Promise.all([
      fetchYahooData(ticker),
      fetchNews(stock),
      fetchAVRSI(ticker),
      fetchAVMACD(ticker),
      fetchAVSMA(ticker, 20),
      fetchAVSMA(ticker, 50),
      fetchAVSMA(ticker, 200),
    ]);

    if (!yahoo?.cmp) {
      return res.status(404).json({
        error: `No data found for "${stock}". Verify the ticker. Examples: RELIANCE, TCS.NS, AAPL`,
      });
    }

    // RSI with fallback
    let rsi = avRSI;
    if (!rsi) {
      const closes = await fetchHistoricalPrices(ticker);
      rsi = calcRSI(closes) ?? 50;
    }

    // DMA with Yahoo fallback
    const dma20 = avSMA20 || null;
    const dma50 = avSMA50 || yahoo.fiftyDayAverage;
    const dma200 = avSMA200 || yahoo.twoHundredDayAverage;
    const industryPE = 22;
    const intrinsic = yahoo.eps ? parseFloat((yahoo.eps * industryPE).toFixed(2)) : null;

    // Score each pillar
    const scores = {
      roe: SC.roe(yahoo.roe),
      pe: SC.pe(yahoo.pe, industryPE),
      rsi: SC.rsi(rsi),
      debtEquity: SC.de(yahoo.debtToEquity),
      sentiment: news.score,
      valuation: SC.val(yahoo.cmp, intrinsic),
      momentum: SC.mom(yahoo.cmp, dma50, dma200),
      risk: SC.risk(yahoo.debtToEquity, yahoo.currentRatio, yahoo.revenueGrowth),
    };

    const score = composite(scores);
    const { decision, decisionColor } = getDecision(score);
    const targets = computeTargets(yahoo.cmp, intrinsic, decision);

    const n = (v, d = 2) => v != null ? parseFloat(v.toFixed(d)) : null;

    const result = {
      stock: ticker.replace(/\.(NS|BO)$/, ""),
      fullName: yahoo.shortName,
      ticker,
      timestamp: new Date().toISOString(),
      cmp: yahoo.cmp,
      previousClose: yahoo.previousClose,
      change: n(yahoo.change),
      changePercent: n(yahoo.changePercent),
      volume: yahoo.volume,
      marketCap: yahoo.marketCap,
      currency: yahoo.currency,
      fiftyTwoWeekHigh: yahoo.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: yahoo.fiftyTwoWeekLow,
      pe: n(yahoo.pe), forwardPE: n(yahoo.forwardPE), eps: n(yahoo.eps),
      roe: n(yahoo.roe), debtToEquity: n(yahoo.debtToEquity),
      grossMargins: n(yahoo.grossMargins), operatingMargins: n(yahoo.operatingMargins),
      profitMargins: n(yahoo.profitMargins), revenueGrowth: n(yahoo.revenueGrowth),
      currentRatio: n(yahoo.currentRatio),
      rsi: n(rsi), macd: avMACD, dma20, dma50: n(dma50), dma200: n(dma200),
      intrinsic_value: intrinsic,
      sentiment: news.sentiment,
      sentimentBreakdown: { positive: news.positive, negative: news.negative, neutral: news.neutral },
      news: news.articles,
      scores, score, decision, decisionColor,
      ...targets,
      sector: yahoo.sector,
      industry: yahoo.industry,
    };

    cache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error("[/analyze]", err.message);
    res.status(500).json({ error: "Analysis failed: " + err.message });
  }
});

app.get("/compare", async (req, res) => {
  const stocks = (req.query.stocks || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 4);
  if (stocks.length < 2) return res.status(400).json({ error: "Need at least 2 stocks" });
  const results = await Promise.all(
    stocks.map((s) =>
      axios.get(`http://localhost:${PORT}/analyze?stock=${encodeURIComponent(s)}`)
        .then((r) => r.data).catch(() => ({ stock: s, error: "Fetch failed" }))
    )
  );
  res.json(results);
});

app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════════════╗`);
  console.log(`║  ACE Analytics — Stock Intelligence Platform   ║`);
  console.log(`║  Open → http://localhost:${PORT}                   ║`);
  console.log(`╚════════════════════════════════════════════════╝\n`);
});
