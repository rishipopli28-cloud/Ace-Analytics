require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const NodeCache = require("node-cache");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const path = require("path");

const app = express();
const cache = new NodeCache({ stdTTL: 300 });
const indexCache = new NodeCache({ stdTTL: 60 });
const otpStore = new Map(); // { mobile: { otp, expiresAt } }

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "ace_analytics_jwt_secret_dev";
const JWT_EXPIRES = process.env.JWT_EXPIRES || "7d";
const ENC_KEY = (process.env.ENC_KEY || "aceanalytics32bytesecretkey12345").slice(0,32).padEnd(32,"0");
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/aceanalytics";
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || "demo";
const NEWS_API_KEY = process.env.NEWS_API_KEY || "";

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: "Too many requests. Try again in 15 minutes." } });
const otpLimiter = rateLimit({ windowMs: 60*1000, max: 3, message: { error: "OTP limit reached. Wait 1 minute." } });
const apiLimiter = rateLimit({ windowMs: 60*1000, max: 60 });
app.use("/api/", apiLimiter);

// ─── MONGODB ──────────────────────────────────────────────────────────────────
mongoose.connect(MONGODB_URI).then(() => console.log("MongoDB connected")).catch(e => console.warn("MongoDB:", e.message, "(running without DB — auth disabled)"));

const AccountSchema = new mongoose.Schema({
  account_name: { type: String, required: true },
  broker: { type: String, required: true, enum: ["zerodha","upstox","angelone"] },
  api_key_enc: String,
  api_secret_enc: String,
  access_token_enc: String,
  user_id: String,
  addedAt: { type: Date, default: Date.now }
});

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  mobile: { type: String, required: true, unique: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  mobile_verified: { type: Boolean, default: false },
  accounts: [AccountSchema],
  createdAt: { type: Date, default: Date.now },
  lastLogin: Date
});

const User = mongoose.model("User", UserSchema);

// ─── ENCRYPTION ───────────────────────────────────────────────────────────────
const ALGO = "aes-256-cbc";
function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(16);
  const key = Buffer.from(ENC_KEY);
  const c = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([c.update(String(text)), c.final()]);
  return iv.toString("hex") + ":" + enc.toString("hex");
}
function decrypt(enc) {
  if (!enc) return null;
  try {
    const [ivHex, dataHex] = enc.split(":");
    const key = Buffer.from(ENC_KEY);
    const d = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
    return Buffer.concat([d.update(Buffer.from(dataHex, "hex")), d.final()]).toString();
  } catch { return null; }
}

// ─── JWT MIDDLEWARE ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized. Please log in." });
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }
}

// ─── OTP HELPERS ─────────────────────────────────────────────────────────────
function generateOTP() { return Math.floor(100000 + Math.random() * 900000).toString(); }

async function sendOTP(mobile, otp) {
  // Twilio integration (optional)
  if (process.env.TWILIO_SID && process.env.TWILIO_TOKEN) {
    try {
      await axios.post(
        `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`,
        new URLSearchParams({ To: mobile, From: process.env.TWILIO_FROM, Body: `Your ACE Analytics OTP is: ${otp}. Valid for 5 minutes.` }),
        { auth: { username: process.env.TWILIO_SID, password: process.env.TWILIO_TOKEN }, timeout: 8000 }
      );
      return true;
    } catch (e) { console.error("[Twilio]", e.message); }
  }
  // Fallback: log to console
  console.log(`\n╔══════════════════════════════╗`);
  console.log(`║  OTP for ${mobile}: ${otp}  ║`);
  console.log(`╚══════════════════════════════╝\n`);
  return true;
}

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────
app.post("/api/auth/send-otp", otpLimiter, async (req, res) => {
  const { mobile } = req.body;
  if (!mobile || !/^\+?[0-9]{10,15}$/.test(mobile.replace(/\s/g,""))) {
    return res.status(400).json({ error: "Invalid mobile number." });
  }
  const otp = generateOTP();
  otpStore.set(mobile, { otp, expiresAt: Date.now() + 5 * 60 * 1000 });
  await sendOTP(mobile, otp);
  res.json({ success: true, message: "OTP sent successfully.", debug: process.env.NODE_ENV !== "production" ? otp : undefined });
});

app.post("/api/auth/verify-otp", authLimiter, async (req, res) => {
  const { mobile, otp } = req.body;
  if (!mobile || !otp) return res.status(400).json({ error: "Mobile and OTP required." });
  const stored = otpStore.get(mobile);
  if (!stored) return res.status(400).json({ error: "OTP expired or not found. Please request a new one." });
  if (Date.now() > stored.expiresAt) { otpStore.delete(mobile); return res.status(400).json({ error: "OTP expired." }); }
  if (stored.otp !== String(otp)) return res.status(400).json({ error: "Incorrect OTP." });
  otpStore.delete(mobile);
  res.json({ success: true, message: "Mobile verified successfully." });
});

app.post("/api/auth/signup", authLimiter, async (req, res) => {
  const { name, mobile, email, username, password, otp_verified } = req.body;
  if (!name || !mobile || !email || !username || !password) return res.status(400).json({ error: "All fields are required." });
  if (!otp_verified) return res.status(400).json({ error: "Please verify your mobile number first." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  if (!/[A-Z]/.test(password)) return res.status(400).json({ error: "Password must contain at least one uppercase letter." });
  if (!/[0-9]/.test(password)) return res.status(400).json({ error: "Password must contain at least one number." });

  try {
    const existing = await User.findOne({ $or: [{ mobile }, { email: email.toLowerCase() }, { username: username.toLowerCase() }] });
    if (existing) {
      if (existing.mobile === mobile) return res.status(400).json({ error: "Mobile number already registered." });
      if (existing.email === email.toLowerCase()) return res.status(400).json({ error: "Email already registered." });
      return res.status(400).json({ error: "Username already taken." });
    }
    const hashed = await bcrypt.hash(password, 12);
    const user = await User.create({ name, mobile, email, username, password: hashed, mobile_verified: true });
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.status(201).json({ success: true, token, user: { name: user.name, username: user.username, email: user.email } });
  } catch (e) {
    console.error("[Signup]", e.message);
    res.status(500).json({ error: "Signup failed. " + e.message });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) return res.status(400).json({ error: "Username/email and password required." });
  try {
    const user = await User.findOne({ $or: [{ email: identifier.toLowerCase() }, { username: identifier.toLowerCase() }] });
    if (!user) return res.status(401).json({ error: "Invalid credentials." });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Invalid credentials." });
    user.lastLogin = new Date();
    await user.save();
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.json({ success: true, token, user: { name: user.name, username: user.username, email: user.email, accountCount: user.accounts.length } });
  } catch (e) {
    console.error("[Login]", e.message);
    res.status(500).json({ error: "Login failed." });
  }
});

app.get("/api/auth/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("-password");
    if (!user) return res.status(404).json({ error: "User not found." });
    res.json({ name: user.name, username: user.username, email: user.email, mobile: user.mobile, accountCount: user.accounts.length, createdAt: user.createdAt, lastLogin: user.lastLogin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BROKER ACCOUNT ROUTES ────────────────────────────────────────────────────
app.get("/api/accounts", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found." });
    const accounts = user.accounts.map(a => ({
      id: a._id, account_name: a.account_name, broker: a.broker,
      user_id: a.user_id, addedAt: a.addedAt,
      has_key: !!a.api_key_enc, has_token: !!a.access_token_enc
    }));
    res.json(accounts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/accounts", authMiddleware, async (req, res) => {
  const { account_name, broker, api_key, api_secret, access_token, user_id } = req.body;
  if (!account_name || !broker || !api_key) return res.status(400).json({ error: "account_name, broker, and api_key are required." });
  const supported = ["zerodha","upstox","angelone"];
  if (!supported.includes(broker)) return res.status(400).json({ error: "Unsupported broker." });
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found." });
    user.accounts.push({
      account_name,
      broker,
      api_key_enc: encrypt(api_key),
      api_secret_enc: api_secret ? encrypt(api_secret) : null,
      access_token_enc: access_token ? encrypt(access_token) : null,
      user_id
    });
    await user.save();
    res.status(201).json({ success: true, message: `${account_name} connected successfully.`, accountCount: user.accounts.length });
  } catch (e) {
    console.error("[AddAccount]", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/accounts/:accountId", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found." });
    const before = user.accounts.length;
    user.accounts = user.accounts.filter(a => a._id.toString() !== req.params.accountId);
    if (user.accounts.length === before) return res.status(404).json({ error: "Account not found." });
    await user.save();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BROKER API FETCHERS ──────────────────────────────────────────────────────
async function fetchZerodhaHoldings(acct) {
  const key = decrypt(acct.api_key_enc);
  const token = decrypt(acct.access_token_enc);
  if (!key || !token) throw new Error("Missing Zerodha credentials");
  const r = await axios.get("https://api.kite.trade/portfolio/holdings", {
    headers: { "X-Kite-Version": "3", "Authorization": `token ${key}:${token}` },
    timeout: 10000
  });
  return (r.data?.data || []).map(h => ({
    stock: h.tradingsymbol, qty: h.quantity, avgPrice: h.average_price,
    lastPrice: h.last_price, pnl: h.pnl, dayChange: h.day_change,
    dayChangePct: h.day_change_percentage, account: acct.account_name, broker: "zerodha"
  }));
}

async function fetchUpstoxHoldings(acct) {
  const token = decrypt(acct.access_token_enc);
  if (!token) throw new Error("Missing Upstox access token");
  const r = await axios.get("https://api.upstox.com/v2/portfolio/long-term-holdings", {
    headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
    timeout: 10000
  });
  return (r.data?.data || []).map(h => ({
    stock: h.tradingsymbol, qty: h.quantity, avgPrice: h.average_price,
    lastPrice: h.last_price, pnl: (h.last_price - h.average_price) * h.quantity,
    dayChange: 0, dayChangePct: 0, account: acct.account_name, broker: "upstox"
  }));
}

async function fetchAngelHoldings(acct) {
  const token = decrypt(acct.access_token_enc);
  const key = decrypt(acct.api_key_enc);
  if (!token || !key) throw new Error("Missing Angel One credentials");
  const r = await axios.get("https://apiconnect.angelbroking.com/rest/secure/angelbroking/portfolio/v1/getAllHolding", {
    headers: {
      "Authorization": `Bearer ${token}`, "X-ClientCode": acct.user_id || "",
      "X-APIKey": key, "Accept": "application/json", "Content-Type": "application/json"
    },
    timeout: 10000
  });
  return (r.data?.data?.holdings || []).map(h => ({
    stock: h.tradingsymbol, qty: parseInt(h.quantity) || 0, avgPrice: parseFloat(h.averageprice) || 0,
    lastPrice: parseFloat(h.ltp) || 0,
    pnl: (parseFloat(h.ltp) - parseFloat(h.averageprice)) * (parseInt(h.quantity) || 0),
    dayChange: 0, dayChangePct: parseFloat(h.profitandloss) || 0,
    account: acct.account_name, broker: "angelone"
  }));
}

const brokerFetchers = { zerodha: fetchZerodhaHoldings, upstox: fetchUpstoxHoldings, angelone: fetchAngelHoldings };

// ─── PORTFOLIO ROUTE (AUTH REQUIRED) ─────────────────────────────────────────
app.get("/api/portfolio", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found." });
    if (!user.accounts.length) return res.json({ holdings: [], summary: { totalInvested:0,totalCurrent:0,totalPnl:0,totalReturn:0 }, errors: [], accounts: [] });

    const allHoldings = [];
    const errors = [];
    const accountSummaries = [];

    for (const acct of user.accounts) {
      if (brokerFetchers[acct.broker]) {
        try {
          const holdings = await brokerFetchers[acct.broker](acct);
          allHoldings.push(...holdings);
          const inv = holdings.reduce((s,h) => s + h.avgPrice*h.qty, 0);
          const cur = holdings.reduce((s,h) => s + h.lastPrice*h.qty, 0);
          accountSummaries.push({ id: acct._id, name: acct.account_name, broker: acct.broker, invested: inv, current: cur, pnl: cur-inv, holdings: holdings.length });
        } catch (e) {
          errors.push({ account: acct.account_name, broker: acct.broker, error: e.message });
        }
      }
    }

    // Enrich with Yahoo Finance if lastPrice is 0
    const enriched = await Promise.all(allHoldings.map(async h => {
      if (!h.lastPrice || h.lastPrice === 0) {
        try {
          const ticker = resolveTicker(h.stock);
          const y = await fetchYahoo(ticker);
          if (y?.cmp) { h.lastPrice = y.cmp; h.pnl = (y.cmp - h.avgPrice) * h.qty; }
        } catch(_) {}
      }
      return { ...h, invested: h.avgPrice * h.qty, current: h.lastPrice * h.qty, returnPct: h.avgPrice ? ((h.lastPrice - h.avgPrice) / h.avgPrice * 100) : 0 };
    }));

    const totalInvested = enriched.reduce((s,h) => s + h.invested, 0);
    const totalCurrent = enriched.reduce((s,h) => s + h.current, 0);

    res.json({
      holdings: enriched,
      accounts: accountSummaries,
      errors,
      summary: { totalInvested, totalCurrent, totalPnl: totalCurrent-totalInvested, totalReturn: totalInvested ? ((totalCurrent-totalInvested)/totalInvested*100) : 0 },
      syncedAt: new Date().toISOString()
    });
  } catch (e) {
    console.error("[Portfolio]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── YAHOO FINANCE SESSION ────────────────────────────────────────────────────
let _crumb = null, _cookies = "", _crumbExp = 0;
const YFH = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://finance.yahoo.com",
  "Referer": "https://finance.yahoo.com/",
};
async function getCrumb() {
  if (_crumb && Date.now() < _crumbExp) return { crumb: _crumb, cookies: _cookies };
  try {
    const r = await axios.get("https://fc.yahoo.com", { headers: YFH, timeout: 8000, validateStatus: () => true });
    _cookies = (r.headers["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");
  } catch(_) {}
  const r = await axios.get("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { ...YFH, Cookie: _cookies }, timeout: 10000 });
  _crumb = r.data; _crumbExp = Date.now() + 3600000;
  return { crumb: _crumb, cookies: _cookies };
}
async function yfGet(url) {
  let s = { crumb: "", cookies: _cookies };
  try { s = await getCrumb(); } catch(_) {}
  const sep = url.includes("?") ? "&" : "?";
  const fu = s.crumb ? `${url}${sep}crumb=${encodeURIComponent(s.crumb)}` : url;
  return axios.get(fu, { headers: { ...YFH, Cookie: s.cookies }, timeout: 12000 });
}

// ─── TICKER RESOLVER ─────────────────────────────────────────────────────────
const KNOWN = {
  reliance:"RELIANCE.NS",tcs:"TCS.NS",infosys:"INFY.NS",infy:"INFY.NS",
  hdfc:"HDFCBANK.NS",hdfcbank:"HDFCBANK.NS",icicibank:"ICICIBANK.NS",icici:"ICICIBANK.NS",
  wipro:"WIPRO.NS",bajajfinance:"BAJFINANCE.NS",bajajfinserv:"BAJAJFINSV.NS",bajaj:"BAJFINANCE.NS",
  airtel:"BHARTIARTL.NS",bhartiairtel:"BHARTIARTL.NS",itc:"ITC.NS",
  kotakbank:"KOTAKBANK.NS",kotak:"KOTAKBANK.NS",sbi:"SBIN.NS",axisbank:"AXISBANK.NS",axis:"AXISBANK.NS",
  hul:"HINDUNILVR.NS",hindunilvr:"HINDUNILVR.NS",maruti:"MARUTI.NS",tatamotors:"TATAMOTORS.NS",
  sunpharma:"SUNPHARMA.NS",ultracemco:"ULTRACEMCO.NS",ultratech:"ULTRACEMCO.NS",nestle:"NESTLEIND.NS",
  titan:"TITAN.NS",adaniports:"ADANIPORTS.NS",adani:"ADANIPORTS.NS",ongc:"ONGC.NS",ntpc:"NTPC.NS",
  powergrid:"POWERGRID.NS",asianpaint:"ASIANPAINT.NS",drreddy:"DRREDDY.NS",cipla:"CIPLA.NS",
  tatasteel:"TATASTEEL.NS",jswsteel:"JSWSTEEL.NS",jsw:"JSWSTEEL.NS",hcltech:"HCLTECH.NS",hcl:"HCLTECH.NS",
  techm:"TECHM.NS",ltim:"LTIM.NS",divislab:"DIVISLAB.NS",pidilite:"PIDILITIND.NS",mrf:"MRF.NS",
  bosch:"BOSCHLTD.NS",havells:"HAVELLS.NS",voltas:"VOLTAS.NS",irctc:"IRCTC.NS",zomato:"ZOMATO.NS",
  paytm:"PAYTM.NS",nykaa:"NYKAA.NS",pgel:"PGEL.NS",pgelectroplast:"PGEL.NS",dixon:"DIXON.NS",
  tatapower:"TATAPOWER.NS",adanigreen:"ADANIGREEN.NS",adanient:"ADANIENT.NS",
  coalindia:"COALINDIA.NS",hindalco:"HINDALCO.NS",vedanta:"VEDL.NS",
  indusindbk:"INDUSINDBK.NS",indusind:"INDUSINDBK.NS",federalbank:"FEDERALBNK.NS",
  idfcfirst:"IDFCFIRSTB.NS",bandhanbank:"BANDHANBNK.NS",rblbank:"RBLBANK.NS",
  pnb:"PNB.NS",bankofbaroda:"BANKBARODA.NS",canarabank:"CANBK.NS",
  apollohosp:"APOLLOHOSP.NS",fortis:"FORTIS.NS",naukri:"NAUKRI.NS",
  indiamart:"INDIAMART.NS",indigo:"INDIGO.NS",spicejet:"SPICEJET.NS",
  apple:"AAPL",aapl:"AAPL",microsoft:"MSFT",msft:"MSFT",
  google:"GOOGL",alphabet:"GOOGL",googl:"GOOGL",amazon:"AMZN",amzn:"AMZN",
  tesla:"TSLA",tsla:"TSLA",nvidia:"NVDA",nvda:"NVDA",
  meta:"META",netflix:"NFLX",nflx:"NFLX",berkshire:"BRK-B",
  jpmorgan:"JPM",jpm:"JPM",visa:"V",mastercard:"MA",walmart:"WMT",
};
function resolveTicker(input) {
  const lower = input.trim().toLowerCase().replace(/\s+/g,"").replace(/[^a-z0-9.&]/g,"");
  if (KNOWN[lower]) return KNOWN[lower];
  const upper = input.trim().toUpperCase().replace(/\s+/g,"");
  if (upper.includes(".NS") || upper.includes(".BO")) return upper;
  if (/^[A-Z0-9&-]{1,10}$/.test(upper)) return upper + ".NS";
  return upper + ".NS";
}

// ─── YAHOO DATA ───────────────────────────────────────────────────────────────
async function fetchYahoo(ticker) {
  try {
    const res = await yfGet(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=price,defaultKeyStatistics,financialData,summaryDetail,assetProfile&formatted=false`);
    const d = res.data?.quoteSummary?.result?.[0];
    if (!d) throw new Error("No data");
    const { price:p={}, financialData:f={}, defaultKeyStatistics:s={}, summaryDetail:sd={}, assetProfile:ap={} } = d;
    return {
      cmp:p.regularMarketPrice||null, previousClose:p.regularMarketPreviousClose||null,
      change:p.regularMarketChange||null, changePercent:p.regularMarketChangePercent||null,
      open:p.regularMarketOpen||null, dayHigh:p.regularMarketDayHigh||null, dayLow:p.regularMarketDayLow||null,
      volume:p.regularMarketVolume||null, avgVolume:p.averageDailyVolume3Month||null, marketCap:p.marketCap||null,
      pe:sd.trailingPE||s.trailingPE||null, forwardPE:sd.forwardPE||s.forwardPE||null, eps:s.trailingEps||null,
      roe:f.returnOnEquity!=null?f.returnOnEquity*100:null, debtToEquity:f.debtToEquity||null,
      revenueGrowth:f.revenueGrowth!=null?f.revenueGrowth*100:null,
      grossMargins:f.grossMargins!=null?f.grossMargins*100:null,
      operatingMargins:f.operatingMargins!=null?f.operatingMargins*100:null,
      profitMargins:f.profitMargins!=null?f.profitMargins*100:null,
      currentRatio:f.currentRatio||null, fiftyTwoWeekHigh:sd.fiftyTwoWeekHigh||null, fiftyTwoWeekLow:sd.fiftyTwoWeekLow||null,
      fiftyDayAvg:p.fiftyDayAverage||null, twoHundredDayAvg:p.twoHundredDayAverage||null,
      shortName:p.shortName||p.longName||ticker, currency:p.currency||"INR",
      sector:ap.sector||"—", industry:ap.industry||"—",
    };
  } catch(e) { console.error(`[Yahoo] ${ticker}:`, e.message); return null; }
}

async function fetchHistory(ticker, days=40) {
  try {
    const end=Math.floor(Date.now()/1000), start=end-days*86400;
    const r = await yfGet(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${start}&period2=${end}&interval=1d`);
    const result = r.data?.chart?.result?.[0];
    if (!result) return [];
    const times=result.timestamp||[], closes=result.indicators?.quote?.[0]?.close||[];
    return times.map((t,i) => ({ date:new Date(t*1000).toISOString().slice(0,10), close:closes[i] })).filter(d=>d.close!=null);
  } catch { return []; }
}

async function fetchIntraday(ticker) {
  try {
    const end=Math.floor(Date.now()/1000), start=end-86400;
    const r = await yfGet(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${start}&period2=${end}&interval=5m`);
    const result = r.data?.chart?.result?.[0];
    if (!result) return [];
    const times=result.timestamp||[], closes=result.indicators?.quote?.[0]?.close||[], vols=result.indicators?.quote?.[0]?.volume||[];
    return times.map((t,i) => ({
      time: new Date(t*1000).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Kolkata"}),
      close: closes[i], volume: vols[i]
    })).filter(d=>d.close!=null);
  } catch { return []; }
}

// ─── INDICES ──────────────────────────────────────────────────────────────────
async function fetchIndex(ticker) {
  try {
    const r = await yfGet(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`);
    const meta = r.data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    return { price:meta.regularMarketPrice, change:meta.regularMarketPrice-meta.chartPreviousClose, changePct:((meta.regularMarketPrice-meta.chartPreviousClose)/meta.chartPreviousClose*100) };
  } catch { return null; }
}
app.get("/api/indices", async (req,res) => {
  const hit = indexCache.get("indices");
  if (hit) return res.json(hit);
  const [nifty, sensex, banknifty] = await Promise.all([fetchIndex("^NSEI"), fetchIndex("^BSESN"), fetchIndex("^NSEBANK")]);
  const data = { nifty, sensex, banknifty, timestamp: new Date().toISOString() };
  indexCache.set("indices", data);
  res.json(data);
});

// ─── ALPHA VANTAGE ────────────────────────────────────────────────────────────
async function avGet(params) {
  const r = await axios.get("https://www.alphavantage.co/query", { params:{...params,apikey:ALPHA_VANTAGE_KEY}, timeout:10000 });
  return r.data;
}
async function avRSI(ticker) {
  try {
    const sym=ticker.replace(/\.(NS|BO)$/,"");
    const d=await avGet({function:"RSI",symbol:sym,interval:"daily",time_period:14,series_type:"close"});
    const s=d["Technical Analysis: RSI"];
    if (!s||d.Note||d.Information) return null;
    return parseFloat(s[Object.keys(s)[0]]["RSI"]);
  } catch { return null; }
}
async function avMACD(ticker) {
  try {
    const sym=ticker.replace(/\.(NS|BO)$/,"");
    const d=await avGet({function:"MACD",symbol:sym,interval:"daily",series_type:"close"});
    const s=d["Technical Analysis: MACD"];
    if (!s||d.Note||d.Information) return null;
    const k=Object.keys(s)[0];
    return { macd:parseFloat(s[k]["MACD"]), signal:parseFloat(s[k]["MACD_Signal"]), histogram:parseFloat(s[k]["MACD_Hist"]) };
  } catch { return null; }
}
async function avSMA(ticker, period) {
  try {
    const sym=ticker.replace(/\.(NS|BO)$/,"");
    const d=await avGet({function:"SMA",symbol:sym,interval:"daily",time_period:period,series_type:"close"});
    const s=d["Technical Analysis: SMA"];
    if (!s||d.Note||d.Information) return null;
    return parseFloat(s[Object.keys(s)[0]]["SMA"]);
  } catch { return null; }
}

// ─── NEWS ─────────────────────────────────────────────────────────────────────
async function fetchNews(name) {
  const empty = { articles:[],sentiment:"neutral",score:5,positive:0,negative:0,neutral:0 };
  if (!NEWS_API_KEY) return empty;
  try {
    const r = await axios.get("https://newsapi.org/v2/everything", { params:{q:`${name} stock`,language:"en",sortBy:"publishedAt",pageSize:10,apiKey:NEWS_API_KEY}, timeout:8000 });
    const articles = r.data.articles||[];
    const POS=["surge","rally","gain","profit","growth","upgrade","buy","bullish","beat","record","strong","rise","outperform","dividend"];
    const NEG=["fall","drop","loss","decline","downgrade","sell","bearish","miss","weak","plunge","concern","fraud","penalty","debt","cut"];
    let pos=0,neg=0,neu=0;
    articles.forEach(a => {
      const t = ((a.title||"")+" "+(a.description||"")).toLowerCase();
      const p=POS.filter(w=>t.includes(w)).length, n=NEG.filter(w=>t.includes(w)).length;
      if(p>n) pos++; else if(n>p) neg++; else neu++;
    });
    const total=pos+neg+neu||1, ratio=(pos-neg)/total;
    const sentiment=ratio>0.2?"positive":ratio<-0.2?"negative":"neutral";
    return { articles:articles.slice(0,5).map(({title,source,url,publishedAt})=>({title,source:source?.name,url,publishedAt})), sentiment, score:sentiment==="positive"?8:sentiment==="negative"?3:5, positive:pos, negative:neg, neutral:neu };
  } catch(e) { console.error("[News]",e.message); return empty; }
}

// ─── SCORING ─────────────────────────────────────────────────────────────────
function calcRSI(closes, period=14) {
  if (closes.length < period+1) return null;
  const sl = closes.slice(-period-1);
  let g=0, l=0;
  for (let i=1; i<sl.length; i++) { const d=sl[i]-sl[i-1]; if(d>0) g+=d; else l+=Math.abs(d); }
  const rs = (g/period)/((l/period)||0.001);
  return parseFloat((100-100/(1+rs)).toFixed(2));
}
const SC = {
  roe: v=>v==null?5:v>20?10:v>=15?8:v>=10?6:3,
  pe: (v,m=22)=>v==null?5:(v/m)<0.8?8:(v/m)<=1.2?5:3,
  rsi: v=>v==null?5:v>=40&&v<=60?8:v>70?4:v<30?6:v>60?6:5,
  de: v=>v==null?6:v<0.5?9:v<=1?7:4,
  val: (c,i)=>!c||!i?5:(c/i)<0.8?9:(c/i)<=1.0?7:(c/i)<=1.2?5:3,
  mom: (c,d5,d2)=>{let s=5;if(c&&d5)s+=c>d5?1.5:-1;if(c&&d2)s+=c>d2?1.5:-0.5;return Math.min(10,Math.max(1,s));},
  risk: (de,cr,rg)=>{let r=5;if(de!=null)r+=de>2?3:de>1?1.5:0;if(cr!=null&&cr<1)r+=2;if(rg!=null&&rg<0)r+=1;return Math.min(10,r);}
};
function composite(sc) {
  const fund=(sc.roe+sc.pe)/2, tech=(sc.rsi+sc.momentum)/2;
  return parseFloat(Math.min(10,Math.max(0,fund*0.25+sc.valuation*0.25+tech*0.20+sc.sentiment*0.10-(sc.risk-5)*0.15)).toFixed(2));
}
function getDecision(s) {
  if(s>8) return {decision:"STRONG BUY",decisionColor:"strong-buy"};
  if(s>=6) return {decision:"BUY",decisionColor:"buy"};
  if(s>=4) return {decision:"HOLD",decisionColor:"hold"};
  if(s>=2) return {decision:"SELL",decisionColor:"sell"};
  return {decision:"AVOID",decisionColor:"avoid"};
}
function getTargets(cmp, intrinsic, dec) {
  const p={"STRONG BUY":0.22,"BUY":0.15,"HOLD":0.08,"SELL":0.05,"AVOID":0.03};
  const pct=p[dec]||0.10;
  return {
    entry: `${(cmp*0.98).toFixed(2)}–${(cmp*1.01).toFixed(2)}`,
    stop_loss: parseFloat((cmp*0.93).toFixed(2)),
    target: intrinsic ? parseFloat(Math.max(intrinsic,cmp*(1+pct)).toFixed(2)) : parseFloat((cmp*(1+pct)).toFixed(2))
  };
}

// ─── ANALYZE ENDPOINT ─────────────────────────────────────────────────────────
app.get("/api/analyze", async (req,res) => {
  const { stock } = req.query;
  if (!stock) return res.status(400).json({ error: "Provide ?stock=RELIANCE" });
  const ticker = resolveTicker(stock);
  const ckey = `v5_${ticker}`;
  const hit = cache.get(ckey);
  if (hit) return res.json({ ...hit, cached: true });
  try {
    const [yahoo,news,rsiAV,macdAV,sma20,sma50,sma200] = await Promise.all([
      fetchYahoo(ticker), fetchNews(stock), avRSI(ticker), avMACD(ticker), avSMA(ticker,20), avSMA(ticker,50), avSMA(ticker,200)
    ]);
    if (!yahoo?.cmp) return res.status(404).json({ error: `No data for "${stock}". Try exact ticker: RELIANCE.NS` });
    let rsi = rsiAV;
    if (!rsi) { const h=await fetchHistory(ticker); rsi=calcRSI(h.map(d=>d.close))??50; }
    const dma50=sma50||yahoo.fiftyDayAvg, dma200=sma200||yahoo.twoHundredDayAvg;
    const industryPE=22, intrinsic=yahoo.eps?parseFloat((yahoo.eps*industryPE).toFixed(2)):null;
    const scores = {
      roe:SC.roe(yahoo.roe), pe:SC.pe(yahoo.pe,industryPE), rsi:SC.rsi(rsi),
      debtEquity:SC.de(yahoo.debtToEquity), sentiment:news.score,
      valuation:SC.val(yahoo.cmp,intrinsic), momentum:SC.mom(yahoo.cmp,dma50,dma200),
      risk:SC.risk(yahoo.debtToEquity,yahoo.currentRatio,yahoo.revenueGrowth)
    };
    const score = composite({...scores,rsi:scores.rsi});
    const { decision, decisionColor } = getDecision(score);
    const targets = getTargets(yahoo.cmp, intrinsic, decision);
    const intradayData = await fetchIntraday(ticker);
    const n = (v,d=2) => v!=null ? parseFloat(v.toFixed(d)) : null;
    const result = {
      stock:ticker.replace(/\.(NS|BO)$/,""), fullName:yahoo.shortName, ticker,
      timestamp:new Date().toISOString(),
      cmp:yahoo.cmp, previousClose:yahoo.previousClose, change:n(yahoo.change), changePercent:n(yahoo.changePercent),
      open:yahoo.open, dayHigh:yahoo.dayHigh, dayLow:yahoo.dayLow, volume:yahoo.volume, avgVolume:yahoo.avgVolume,
      marketCap:yahoo.marketCap, currency:yahoo.currency, fiftyTwoWeekHigh:yahoo.fiftyTwoWeekHigh, fiftyTwoWeekLow:yahoo.fiftyTwoWeekLow,
      pe:n(yahoo.pe), forwardPE:n(yahoo.forwardPE), eps:n(yahoo.eps), roe:n(yahoo.roe),
      debtToEquity:n(yahoo.debtToEquity), grossMargins:n(yahoo.grossMargins), operatingMargins:n(yahoo.operatingMargins),
      profitMargins:n(yahoo.profitMargins), revenueGrowth:n(yahoo.revenueGrowth), currentRatio:n(yahoo.currentRatio),
      rsi:n(rsi), macd:macdAV, dma20:sma20, dma50:n(dma50), dma200:n(dma200), intrinsic_value:intrinsic,
      sentiment:news.sentiment, sentimentBreakdown:{positive:news.positive,negative:news.negative,neutral:news.neutral},
      news:news.articles, scores, score, decision, decisionColor, ...targets,
      sector:yahoo.sector, industry:yahoo.industry, intradayData,
    };
    cache.set(ckey, result);
    res.json(result);
  } catch(e) {
    console.error("[/api/analyze]", e.message);
    res.status(500).json({ error: "Analysis failed: "+e.message });
  }
});

app.get("/api/compare", async (req,res) => {
  const stocks = (req.query.stocks||"").split(",").map(s=>s.trim()).filter(Boolean).slice(0,4);
  if (stocks.length < 2) return res.status(400).json({ error: "Need at least 2 stocks" });
  const results = await Promise.all(stocks.map(s =>
    axios.get(`http://localhost:${PORT}/api/analyze?stock=${encodeURIComponent(s)}`).then(r=>r.data).catch(()=>({stock:s,error:"Failed"}))
  ));
  res.json(results);
});

app.get("/api/price/:ticker", async (req,res) => {
  try {
    const ticker = resolveTicker(req.params.ticker);
    const yahoo = await fetchYahoo(ticker);
    if (!yahoo?.cmp) return res.status(404).json({ error: "Not found" });
    res.json({ ticker, cmp:yahoo.cmp, change:yahoo.change, changePercent:yahoo.changePercent, shortName:yahoo.shortName });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SPA FALLBACK ─────────────────────────────────────────────────────────────
app.get("*", (req,res) => res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║   ACE Analytics v4 — Auth + Multi-Broker         ║`);
  console.log(`║   http://localhost:${PORT}                           ║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);
});
