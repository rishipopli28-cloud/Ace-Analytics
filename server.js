require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const NodeCache = require("node-cache");
const path = require("path");

const app = express();
const cache = new NodeCache({ stdTTL: 300 });
const indexCache = new NodeCache({ stdTTL: 60 }); // 1min for indices
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || "demo";
const NEWS_API_KEY = process.env.NEWS_API_KEY || "";

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
  } catch (_) {}
  const r = await axios.get("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { ...YFH, Cookie: _cookies }, timeout: 10000 });
  _crumb = r.data; _crumbExp = Date.now() + 3600000;
  return { crumb: _crumb, cookies: _cookies };
}

async function yfGet(url) {
  let s = { crumb: "", cookies: _cookies };
  try { s = await getCrumb(); } catch (_) {}
  const sep = url.includes("?") ? "&" : "?";
  const fu = s.crumb ? `${url}${sep}crumb=${encodeURIComponent(s.crumb)}` : url;
  return axios.get(fu, { headers: { ...YFH, Cookie: s.cookies }, timeout: 12000 });
}

// ─── UNIVERSAL TICKER RESOLVER ────────────────────────────────────────────────
// Supports ANY NSE/BSE stock by auto-appending .NS
// Plus hardcoded common names for convenience
const KNOWN = {
  reliance:"RELIANCE.NS",tcs:"TCS.NS",infosys:"INFY.NS",infy:"INFY.NS",
  hdfc:"HDFCBANK.NS",hdfcbank:"HDFCBANK.NS",icicibank:"ICICIBANK.NS",icici:"ICICIBANK.NS",
  wipro:"WIPRO.NS",bajajfinance:"BAJFINANCE.NS",bajajfinserv:"BAJAJFINSV.NS",bajaj:"BAJFINANCE.NS",
  airtel:"BHARTIARTL.NS",bhartiairtel:"BHARTIARTL.NS",itc:"ITC.NS",
  kotakbank:"KOTAKBANK.NS",kotak:"KOTAKBANK.NS",sbi:"SBIN.NS",
  axisbank:"AXISBANK.NS",axis:"AXISBANK.NS",hul:"HINDUNILVR.NS",hindunilvr:"HINDUNILVR.NS",
  maruti:"MARUTI.NS",tatamotors:"TATAMOTORS.NS",sunpharma:"SUNPHARMA.NS",
  ultracemco:"ULTRACEMCO.NS",ultratech:"ULTRACEMCO.NS",nestle:"NESTLEIND.NS",
  titan:"TITAN.NS",adaniports:"ADANIPORTS.NS",adani:"ADANIPORTS.NS",
  ongc:"ONGC.NS",ntpc:"NTPC.NS",powergrid:"POWERGRID.NS",asianpaint:"ASIANPAINT.NS",
  drreddy:"DRREDDY.NS",cipla:"CIPLA.NS",tatasteel:"TATASTEEL.NS",
  jswsteel:"JSWSTEEL.NS",jsw:"JSWSTEEL.NS",hcltech:"HCLTECH.NS",hcl:"HCLTECH.NS",
  techm:"TECHM.NS",ltim:"LTIM.NS",divislab:"DIVISLAB.NS",divi:"DIVISLAB.NS",
  pidilite:"PIDILITIND.NS",mrf:"MRF.NS",bosch:"BOSCHLTD.NS",havells:"HAVELLS.NS",
  voltas:"VOLTAS.NS",irctc:"IRCTC.NS",zomato:"ZOMATO.NS",paytm:"PAYTM.NS",
  nykaa:"NYKAA.NS",policybazaar:"POLICYBZR.NS",freshworks:"FRSH",
  pgelectroplast:"PGEL.NS",pgel:"PGEL.NS",dixon:"DIXON.NS",
  tatapower:"TATAPOWER.NS",adanigreen:"ADANIGREEN.NS",adanient:"ADANIENT.NS",
  adanitrans:"ADANITRANS.NS",adanigas:"MGL.NS",coal:"COALINDIA.NS",coalindia:"COALINDIA.NS",
  hindalco:"HINDALCO.NS",vedanta:"VEDL.NS",
  bajajholdco:"BAJAJHLDNG.NS",motherson:"MOTHERSON.NS",
  indusindbk:"INDUSINDBK.NS",indusind:"INDUSINDBK.NS",
  federalbank:"FEDERALBNK.NS",idfcfirst:"IDFCFIRSTB.NS",
  bandhanbank:"BANDHANBNK.NS",rblbank:"RBLBANK.NS",
  pnb:"PNB.NS",bankofbaroda:"BANKBARODA.NS",canarabank:"CANBK.NS",
  unionbank:"UNIONBANK.NS",iob:"IOB.NS",boi:"BANKINDIA.NS",
  lichsgfin:"LICHSGFIN.NS",muthootfin:"MUTHOOTFIN.NS",cholamandalam:"CHOLAFIN.NS",
  shreecement:"SHREECEM.NS",ambuja:"AMBUJACEM.NS",acc:"ACC.NS",
  dalmia:"DALBHARAT.NS",ramco:"RAMCOCEM.NS",
  suntvnetwork:"SUNTV.NS",zeel:"ZEEL.NS",pvrinox:"PVRINOX.NS",
  inoxleisure:"PVRINOX.NS",balajitele:"BALAJITELE.NS",
  drlalupath:"LALPATHLAB.NS",thyrocare:"THYROCARE.NS",
  apollohosp:"APOLLOHOSP.NS",fortis:"FORTIS.NS",maxhealth:"MAXHEALTH.NS",
  naukri:"NAUKRI.NS",infoeigde:"NAUKRI.NS",justdial:"JUSTDIAL.NS",
  indiamart:"INDIAMART.NS",tradeindia:"INDIAMART.NS",
  happyeasygo:"EASEMYTRIP.NS",makemytrip:"MMYT",
  interglobe:"INDIGO.NS",indigo:"INDIGO.NS",spicejet:"SPICEJET.NS",
  // US
  apple:"AAPL",aapl:"AAPL",microsoft:"MSFT",msft:"MSFT",
  google:"GOOGL",alphabet:"GOOGL",googl:"GOOGL",amazon:"AMZN",amzn:"AMZN",
  tesla:"TSLA",tsla:"TSLA",nvidia:"NVDA",nvda:"NVDA",
  meta:"META",facebook:"META",netflix:"NFLX",nflx:"NFLX",
  berkshire:"BRK-B",jpmorgan:"JPM",jpm:"JPM",visa:"V",mastercard:"MA",
  walmart:"WMT",johnson:"JNJ",samsung:"005930.KS",
};

function resolveTicker(input) {
  const lower = input.trim().toLowerCase().replace(/\s+/g,"").replace(/[^a-z0-9.&]/g,"");
  if (KNOWN[lower]) return KNOWN[lower];
  const upper = input.trim().toUpperCase().replace(/\s+/g,"");
  if (upper.includes(".NS")||upper.includes(".BO")||upper.includes(".KS")) return upper;
  // If it looks like a pure ticker (1-6 uppercase chars), try as-is first then .NS
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
      cmp: p.regularMarketPrice||null,
      previousClose: p.regularMarketPreviousClose||null,
      change: p.regularMarketChange||null,
      changePercent: p.regularMarketChangePercent||null,
      open: p.regularMarketOpen||null,
      dayHigh: p.regularMarketDayHigh||null,
      dayLow: p.regularMarketDayLow||null,
      volume: p.regularMarketVolume||null,
      avgVolume: p.averageDailyVolume3Month||null,
      marketCap: p.marketCap||null,
      pe: sd.trailingPE||s.trailingPE||null,
      forwardPE: sd.forwardPE||s.forwardPE||null,
      eps: s.trailingEps||null,
      roe: f.returnOnEquity!=null?f.returnOnEquity*100:null,
      debtToEquity: f.debtToEquity||null,
      revenueGrowth: f.revenueGrowth!=null?f.revenueGrowth*100:null,
      grossMargins: f.grossMargins!=null?f.grossMargins*100:null,
      operatingMargins: f.operatingMargins!=null?f.operatingMargins*100:null,
      profitMargins: f.profitMargins!=null?f.profitMargins*100:null,
      currentRatio: f.currentRatio||null,
      fiftyTwoWeekHigh: sd.fiftyTwoWeekHigh||null,
      fiftyTwoWeekLow: sd.fiftyTwoWeekLow||null,
      fiftyDayAvg: p.fiftyDayAverage||null,
      twoHundredDayAvg: p.twoHundredDayAverage||null,
      shortName: p.shortName||p.longName||ticker,
      currency: p.currency||"INR",
      exchange: p.exchangeName||"NSE",
      sector: ap.sector||"—",
      industry: ap.industry||"—",
      website: ap.website||null,
      employees: ap.fullTimeEmployees||null,
    };
  } catch(e) { console.error(`[Yahoo] ${ticker}:`,e.message); return null; }
}

async function fetchHistory(ticker, days=60) {
  try {
    const end=Math.floor(Date.now()/1000), start=end-days*86400;
    const r = await yfGet(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${start}&period2=${end}&interval=1d`);
    const result = r.data?.chart?.result?.[0];
    if (!result) return [];
    const times = result.timestamp||[];
    const closes = result.indicators?.quote?.[0]?.close||[];
    const highs = result.indicators?.quote?.[0]?.high||[];
    const lows = result.indicators?.quote?.[0]?.low||[];
    const opens = result.indicators?.quote?.[0]?.open||[];
    const vols = result.indicators?.quote?.[0]?.volume||[];
    return times.map((t,i)=>({
      date: new Date(t*1000).toISOString().slice(0,10),
      open: opens[i], high: highs[i], low: lows[i], close: closes[i], volume: vols[i]
    })).filter(d=>d.close!=null);
  } catch { return []; }
}

async function fetchIntraday(ticker) {
  try {
    const end=Math.floor(Date.now()/1000), start=end-86400;
    const r = await yfGet(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${start}&period2=${end}&interval=5m`);
    const result = r.data?.chart?.result?.[0];
    if (!result) return [];
    const times = result.timestamp||[];
    const closes = result.indicators?.quote?.[0]?.close||[];
    const vols = result.indicators?.quote?.[0]?.volume||[];
    return times.map((t,i)=>({
      time: new Date(t*1000).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'}),
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
    return {
      price: meta.regularMarketPrice,
      change: meta.regularMarketPrice - meta.chartPreviousClose,
      changePct: ((meta.regularMarketPrice - meta.chartPreviousClose)/meta.chartPreviousClose*100),
    };
  } catch { return null; }
}

app.get("/indices", async (req,res) => {
  const hit = indexCache.get("indices");
  if (hit) return res.json(hit);
  const [nifty, sensex, banknifty] = await Promise.all([
    fetchIndex("^NSEI"), fetchIndex("^BSESN"), fetchIndex("^NSEBANK")
  ]);
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
async function avSMA(ticker,period) {
  try {
    const sym=ticker.replace(/\.(NS|BO)$/,"");
    const d=await avGet({function:"SMA",symbol:sym,interval:"daily",time_period:period,series_type:"close"});
    const s=d["Technical Analysis: SMA"];
    if (!s||d.Note||d.Information) return null;
    return parseFloat(s[Object.keys(s)[0]]["SMA"]);
  } catch { return null; }
}

// ─── NEWS ────────────────────────────────────────────────────────────────────
async function fetchNews(name) {
  const empty={articles:[],sentiment:"neutral",score:5,positive:0,negative:0,neutral:0};
  if (!NEWS_API_KEY) return empty;
  try {
    const r=await axios.get("https://newsapi.org/v2/everything",{params:{q:`${name} stock`,language:"en",sortBy:"publishedAt",pageSize:10,apiKey:NEWS_API_KEY},timeout:8000});
    const articles=r.data.articles||[];
    const POS=["surge","rally","gain","profit","growth","upgrade","buy","bullish","beat","record","strong","rise","outperform","breakthrough","dividend","acquisition"];
    const NEG=["fall","drop","loss","decline","downgrade","sell","bearish","miss","weak","plunge","concern","fraud","penalty","debt","cut","lawsuit","probe"];
    let pos=0,neg=0,neu=0;
    articles.forEach(a=>{
      const t=((a.title||"")+" "+(a.description||"")).toLowerCase();
      const p=POS.filter(w=>t.includes(w)).length, n=NEG.filter(w=>t.includes(w)).length;
      if(p>n) pos++; else if(n>p) neg++; else neu++;
    });
    const total=pos+neg+neu||1, ratio=(pos-neg)/total;
    const sentiment=ratio>0.2?"positive":ratio<-0.2?"negative":"neutral";
    return {
      articles:articles.slice(0,5).map(({title,source,url,publishedAt})=>({title,source:source?.name,url,publishedAt})),
      sentiment, score:sentiment==="positive"?8:sentiment==="negative"?3:5,
      positive:pos,negative:neg,neutral:neu
    };
  } catch(e) { console.error("[News]",e.message); return empty; }
}

// ─── SCORING ─────────────────────────────────────────────────────────────────
function calcRSI(closes,period=14) {
  if(closes.length<period+1) return null;
  const sl=closes.slice(-period-1);
  let g=0,l=0;
  for(let i=1;i<sl.length;i++){const d=sl[i]-sl[i-1];if(d>0)g+=d;else l+=Math.abs(d);}
  const rs=(g/period)/((l/period)||0.001);
  return parseFloat((100-100/(1+rs)).toFixed(2));
}

const SC={
  roe:v=>v==null?5:v>20?10:v>=15?8:v>=10?6:3,
  pe:(v,m=22)=>v==null?5:(v/m)<0.8?8:(v/m)<=1.2?5:3,
  rsi:v=>v==null?5:v>=40&&v<=60?8:v>70?4:v<30?6:v>60?6:5,
  de:v=>v==null?6:v<0.5?9:v<=1?7:4,
  val:(c,i)=>!c||!i?5:(c/i)<0.8?9:(c/i)<=1.0?7:(c/i)<=1.2?5:3,
  mom:(c,d5,d2)=>{let s=5;if(c&&d5)s+=c>d5?1.5:-1;if(c&&d2)s+=c>d2?1.5:-0.5;return Math.min(10,Math.max(1,s));},
  risk:(de,cr,rg)=>{let r=5;if(de!=null)r+=de>2?3:de>1?1.5:0;if(cr!=null&&cr<1)r+=2;if(rg!=null&&rg<0)r+=1;return Math.min(10,r);}
};

function composite(sc) {
  const fund=(sc.roe+sc.pe)/2, tech=(sc.rsi+sc.momentum)/2;
  return parseFloat(Math.min(10,Math.max(0,fund*0.25+sc.valuation*0.25+tech*0.20+sc.sentiment*0.10-(sc.risk-5)*0.15)).toFixed(2));
}

function decision(s) {
  if(s>8) return {decision:"STRONG BUY",decisionColor:"strong-buy"};
  if(s>=6) return {decision:"BUY",decisionColor:"buy"};
  if(s>=4) return {decision:"HOLD",decisionColor:"hold"};
  if(s>=2) return {decision:"SELL",decisionColor:"sell"};
  return {decision:"AVOID",decisionColor:"avoid"};
}

function targets(cmp,intrinsic,dec) {
  const p={STRONGBUY:0.22,BUY:0.15,HOLD:0.08,SELL:0.05,AVOID:0.03};
  const pct=p[dec.replace(" ","")||"HOLD"]||0.10;
  return {
    entry:`${(cmp*0.98).toFixed(2)}–${(cmp*1.01).toFixed(2)}`,
    stop_loss:parseFloat((cmp*0.93).toFixed(2)),
    target:intrinsic?parseFloat(Math.max(intrinsic,cmp*(1+pct)).toFixed(2)):parseFloat((cmp*(1+pct)).toFixed(2))
  };
}

// ─── MAIN ANALYZE ─────────────────────────────────────────────────────────────
app.get("/analyze", async(req,res)=>{
  const {stock}=req.query;
  if(!stock) return res.status(400).json({error:"Provide ?stock=RELIANCE"});
  const ticker=resolveTicker(stock);
  const ckey=`v4_${ticker}`;
  const hit=cache.get(ckey);
  if(hit) return res.json({...hit,cached:true});

  try {
    const [yahoo,news,rsiAV,macdAV,sma20,sma50,sma200] = await Promise.all([
      fetchYahoo(ticker),fetchNews(stock),avRSI(ticker),avMACD(ticker),avSMA(ticker,20),avSMA(ticker,50),avSMA(ticker,200)
    ]);

    if(!yahoo?.cmp) {
      // Try without .NS if it failed
      const altTicker = ticker.endsWith(".NS") ? ticker.replace(".NS","") : ticker+".NS";
      const alt = await fetchYahoo(altTicker);
      if(!alt?.cmp) return res.status(404).json({error:`No data found for "${stock}". Try the exact NSE ticker e.g. IRCTC.NS`});
    }

    const yf = yahoo || await fetchYahoo(ticker.endsWith(".NS")?ticker.replace(".NS",""):ticker+".NS");

    let rsi=rsiAV;
    if(!rsi){const closes=await fetchHistory(ticker,40).then(h=>h.map(d=>d.close));rsi=calcRSI(closes)??50;}

    const dma20=sma20||null, dma50=sma50||yf.fiftyDayAvg, dma200=sma200||yf.twoHundredDayAvg;
    const industryPE=22;
    const intrinsic=yf.eps?parseFloat((yf.eps*industryPE).toFixed(2)):null;

    const scores={
      roe:SC.roe(yf.roe),pe:SC.pe(yf.pe,industryPE),rsi:SC.rsi(rsi),
      debtEquity:SC.de(yf.debtToEquity),sentiment:news.score,
      valuation:SC.val(yf.cmp,intrinsic),momentum:SC.mom(yf.cmp,dma50,dma200),
      risk:SC.risk(yf.debtToEquity,yf.currentRatio,yf.revenueGrowth)
    };
    const score=composite({...scores,rsi:scores.rsi});
    const {decision:dec,decisionColor}=decision(score);
    const t=targets(yf.cmp,intrinsic,dec);
    const n=(v,d=2)=>v!=null?parseFloat(v.toFixed(d)):null;

    // Fetch intraday chart data
    const intradayData = await fetchIntraday(ticker);

    const result={
      stock:ticker.replace(/\.(NS|BO)$/,""),fullName:yf.shortName,ticker,
      timestamp:new Date().toISOString(),
      cmp:yf.cmp,previousClose:yf.previousClose,
      change:n(yf.change),changePercent:n(yf.changePercent),
      open:yf.open,dayHigh:yf.dayHigh,dayLow:yf.dayLow,
      volume:yf.volume,avgVolume:yf.avgVolume,marketCap:yf.marketCap,currency:yf.currency,
      fiftyTwoWeekHigh:yf.fiftyTwoWeekHigh,fiftyTwoWeekLow:yf.fiftyTwoWeekLow,
      pe:n(yf.pe),forwardPE:n(yf.forwardPE),eps:n(yf.eps),
      roe:n(yf.roe),debtToEquity:n(yf.debtToEquity),
      grossMargins:n(yf.grossMargins),operatingMargins:n(yf.operatingMargins),
      profitMargins:n(yf.profitMargins),revenueGrowth:n(yf.revenueGrowth),currentRatio:n(yf.currentRatio),
      rsi:n(rsi),macd:macdAV,dma20,dma50:n(dma50),dma200:n(dma200),
      intrinsic_value:intrinsic,
      sentiment:news.sentiment,
      sentimentBreakdown:{positive:news.positive,negative:news.negative,neutral:news.neutral},
      news:news.articles,scores,score,decision:dec,decisionColor,...t,
      sector:yf.sector,industry:yf.industry,website:yf.website,employees:yf.employees,
      intradayData,
    };
    cache.set(ckey,result);
    res.json(result);
  } catch(e) {
    console.error("[/analyze]",e.message);
    res.status(500).json({error:"Analysis failed: "+e.message});
  }
});

app.get("/compare", async(req,res)=>{
  const stocks=(req.query.stocks||"").split(",").map(s=>s.trim()).filter(Boolean).slice(0,4);
  if(stocks.length<2) return res.status(400).json({error:"Need ≥2 stocks"});
  const results=await Promise.all(stocks.map(s=>axios.get(`http://localhost:${PORT}/analyze?stock=${encodeURIComponent(s)}`).then(r=>r.data).catch(()=>({stock:s,error:"Failed"}))));
  res.json(results);
});

// Portfolio endpoints
const portfolios = new Map();
app.post("/portfolio", (req,res)=>{
  const {id,holdings}=req.body;
  if(!id||!holdings) return res.status(400).json({error:"Need id and holdings"});
  portfolios.set(id,holdings);
  res.json({success:true});
});
app.get("/portfolio/:id", (req,res)=>{
  const h=portfolios.get(req.params.id);
  if(!h) return res.status(404).json({error:"Not found"});
  res.json(h);
});

app.listen(PORT,()=>{
  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║   ACE Analytics v2 — Luxury Edition              ║`);
  console.log(`║   http://localhost:${PORT}                           ║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);
});
