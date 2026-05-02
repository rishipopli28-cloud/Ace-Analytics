require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const NodeCache = require("node-cache");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();
const cache = new NodeCache({ stdTTL: 300 });
const indexCache = new NodeCache({ stdTTL: 60 });

const PORT = process.env.PORT || 3000;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || "demo";
const NEWS_API_KEY = process.env.NEWS_API_KEY || "";

app.use(cors());
app.use(express.json());
app.set("trust proxy", 1);
app.use(express.static(path.join(__dirname, "public")));

const apiLimiter = rateLimit({ windowMs:60*1000, max:100, standardHeaders:true, legacyHeaders:false });
app.use("/api/", apiLimiter);

// ─── YAHOO FINANCE SESSION ────────────────────────────────────────────────────
let _crumb = null, _cookies = "", _crumbExp = 0;
const YFH = {
  "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept":"application/json, text/plain, */*",
  "Accept-Language":"en-US,en;q=0.9",
  "Origin":"https://finance.yahoo.com",
  "Referer":"https://finance.yahoo.com/",
};
async function getCrumb() {
  if (_crumb && Date.now() < _crumbExp) return { crumb:_crumb, cookies:_cookies };
  try {
    const r = await axios.get("https://fc.yahoo.com", { headers:YFH, timeout:8000, validateStatus:()=>true });
    _cookies = (r.headers["set-cookie"]||[]).map(c=>c.split(";")[0]).join("; ");
  } catch(_) {}
  const r = await axios.get("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers:{...YFH,Cookie:_cookies}, timeout:10000 });
  _crumb = r.data; _crumbExp = Date.now()+3600000;
  return { crumb:_crumb, cookies:_cookies };
}
async function yfGet(url) {
  let s = { crumb:"", cookies:_cookies };
  try { s = await getCrumb(); } catch(_) {}
  const sep = url.includes("?")?"&":"?";
  const fu = s.crumb ? `${url}${sep}crumb=${encodeURIComponent(s.crumb)}` : url;
  return axios.get(fu, { headers:{...YFH,Cookie:s.cookies}, timeout:12000 });
}

// ─── TICKER RESOLVER ─────────────────────────────────────────────────────────
const KNOWN = {
  reliance:"RELIANCE.NS",tcs:"TCS.NS",infosys:"INFY.NS",infy:"INFY.NS",
  hdfc:"HDFCBANK.NS",hdfcbank:"HDFCBANK.NS",icicibank:"ICICIBANK.NS",icici:"ICICIBANK.NS",
  wipro:"WIPRO.NS",bajajfinance:"BAJFINANCE.NS",bajajfinserv:"BAJAJFINSV.NS",bajaj:"BAJFINANCE.NS",
  airtel:"BHARTIARTL.NS",bhartiairtel:"BHARTIARTL.NS",itc:"ITC.NS",
  kotakbank:"KOTAKBANK.NS",kotak:"KOTAKBANK.NS",sbi:"SBIN.NS",
  axisbank:"AXISBANK.NS",axis:"AXISBANK.NS",hul:"HINDUNILVR.NS",
  maruti:"MARUTI.NS",tatamotors:"TATAMOTORS.NS",sunpharma:"SUNPHARMA.NS",
  ultracemco:"ULTRACEMCO.NS",ultratech:"ULTRACEMCO.NS",nestle:"NESTLEIND.NS",
  titan:"TITAN.NS",adaniports:"ADANIPORTS.NS",adani:"ADANIPORTS.NS",
  ongc:"ONGC.NS",ntpc:"NTPC.NS",powergrid:"POWERGRID.NS",asianpaint:"ASIANPAINT.NS",
  drreddy:"DRREDDY.NS",cipla:"CIPLA.NS",tatasteel:"TATASTEEL.NS",
  jswsteel:"JSWSTEEL.NS",jsw:"JSWSTEEL.NS",hcltech:"HCLTECH.NS",hcl:"HCLTECH.NS",
  techm:"TECHM.NS",ltim:"LTIM.NS",divislab:"DIVISLAB.NS",pidilite:"PIDILITIND.NS",
  mrf:"MRF.NS",bosch:"BOSCHLTD.NS",havells:"HAVELLS.NS",voltas:"VOLTAS.NS",
  irctc:"IRCTC.NS",zomato:"ZOMATO.NS",paytm:"PAYTM.NS",nykaa:"NYKAA.NS",
  pgel:"PGEL.NS",dixon:"DIXON.NS",tatapower:"TATAPOWER.NS",
  adanigreen:"ADANIGREEN.NS",adanient:"ADANIENT.NS",coalindia:"COALINDIA.NS",
  hindalco:"HINDALCO.NS",vedanta:"VEDL.NS",indusindbk:"INDUSINDBK.NS",
  indusind:"INDUSINDBK.NS",federalbank:"FEDERALBNK.NS",idfcfirst:"IDFCFIRSTB.NS",
  bandhanbank:"BANDHANBNK.NS",pnb:"PNB.NS",bankofbaroda:"BANKBARODA.NS",
  canarabank:"CANBK.NS",apollohosp:"APOLLOHOSP.NS",fortis:"FORTIS.NS",
  naukri:"NAUKRI.NS",indiamart:"INDIAMART.NS",indigo:"INDIGO.NS",spicejet:"SPICEJET.NS",
  motherson:"MOTHERSON.NS",shreecem:"SHREECEM.NS",ambuja:"AMBUJACEM.NS",acc:"ACC.NS",
  suntv:"SUNTV.NS",zeel:"ZEEL.NS",pvrinox:"PVRINOX.NS",cholafin:"CHOLAFIN.NS",
  muthootfin:"MUTHOOTFIN.NS",bajajhldng:"BAJAJHLDNG.NS",
  apple:"AAPL",aapl:"AAPL",microsoft:"MSFT",msft:"MSFT",
  google:"GOOGL",alphabet:"GOOGL",googl:"GOOGL",amazon:"AMZN",amzn:"AMZN",
  tesla:"TSLA",tsla:"TSLA",nvidia:"NVDA",nvda:"NVDA",
  meta:"META",netflix:"NFLX",nflx:"NFLX",
  berkshire:"BRK-B",jpmorgan:"JPM",jpm:"JPM",visa:"V",mastercard:"MA",walmart:"WMT",
};
function resolveTicker(input) {
  const lower = input.trim().toLowerCase().replace(/\s+/g,"").replace(/[^a-z0-9.&]/g,"");
  if (KNOWN[lower]) return KNOWN[lower];
  const upper = input.trim().toUpperCase().replace(/\s+/g,"");
  if (upper.includes(".NS")||upper.includes(".BO")) return upper;
  if (/^[A-Z0-9&-]{1,10}$/.test(upper)) return upper+".NS";
  return upper+".NS";
}

// ─── YAHOO FULL DATA ──────────────────────────────────────────────────────────
async function fetchYahoo(ticker) {
  try {
    const modules = "price,defaultKeyStatistics,financialData,summaryDetail,assetProfile,earnings,earningsTrend,indexTrend,sectorTrend";
    const res = await yfGet(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}&formatted=false`);
    const d = res.data?.quoteSummary?.result?.[0];
    if (!d) throw new Error("No data");
    const { price:p={}, financialData:f={}, defaultKeyStatistics:s={}, summaryDetail:sd={}, assetProfile:ap={}, earnings:e={}, earningsTrend:et={} } = d;

    // Earnings trend for projections
    const trend = et?.trend || [];
    const revenueEst = trend.find(t=>t.period==="+1y")?.revenue?.avg || null;
    const epsEst = trend.find(t=>t.period==="+1y")?.earningsPerShare?.avg || null;
    const revenueEst2 = trend.find(t=>t.period==="+2y")?.revenue?.avg || null;
    const epsEst2 = trend.find(t=>t.period==="+2y")?.earningsPerShare?.avg || null;

    return {
      cmp:p.regularMarketPrice||null, previousClose:p.regularMarketPreviousClose||null,
      change:p.regularMarketChange||null, changePercent:p.regularMarketChangePercent||null,
      open:p.regularMarketOpen||null, dayHigh:p.regularMarketDayHigh||null, dayLow:p.regularMarketDayLow||null,
      volume:p.regularMarketVolume||null, avgVolume:p.averageDailyVolume3Month||null,
      avgVolume10d:p.averageDailyVolume10Day||null, marketCap:p.marketCap||null,
      pe:sd.trailingPE||s.trailingPE||null, forwardPE:sd.forwardPE||s.forwardPE||null,
      pb:s.priceToBook||null, eps:s.trailingEps||null, forwardEps:s.forwardEps||null,
      roe:f.returnOnEquity!=null?f.returnOnEquity*100:null,
      roa:f.returnOnAssets!=null?f.returnOnAssets*100:null,
      roic:null,
      debtToEquity:f.debtToEquity||null,
      revenueGrowth:f.revenueGrowth!=null?f.revenueGrowth*100:null,
      earningsGrowth:f.earningsGrowth!=null?f.earningsGrowth*100:null,
      grossMargins:f.grossMargins!=null?f.grossMargins*100:null,
      operatingMargins:f.operatingMargins!=null?f.operatingMargins*100:null,
      profitMargins:f.profitMargins!=null?f.profitMargins*100:null,
      ebitdaMargins:f.ebitdaMargins!=null?f.ebitdaMargins*100:null,
      currentRatio:f.currentRatio||null, quickRatio:f.quickRatio||null,
      totalCash:f.totalCash||null, totalDebt:f.totalDebt||null,
      freeCashflow:f.freeCashflow||null, operatingCashflow:f.operatingCashflow||null,
      totalRevenue:f.totalRevenue||null, ebitda:f.ebitda||null,
      fiftyTwoWeekHigh:sd.fiftyTwoWeekHigh||null, fiftyTwoWeekLow:sd.fiftyTwoWeekLow||null,
      fiftyDayAvg:p.fiftyDayAverage||null, twoHundredDayAvg:p.twoHundredDayAverage||null,
      beta:sd.beta||s.beta||null, dividendYield:sd.dividendYield||null,
      payoutRatio:sd.payoutRatio||null,
      sharesOutstanding:s.sharesOutstanding||null,
      bookValue:s.bookValue||null,
      enterpriseValue:s.enterpriseValue||null,
      enterpriseToRevenue:s.enterpriseToRevenue||null,
      enterpriseToEbitda:s.enterpriseToEbitda||null,
      pegRatio:s.pegRatio||null,
      shortName:p.shortName||p.longName||ticker, currency:p.currency||"INR",
      exchange:p.exchangeName||"NSE", sector:ap.sector||"—", industry:ap.industry||"—",
      website:ap.website||null, employees:ap.fullTimeEmployees||null,
      description:ap.longBusinessSummary||null,
      // Projections from analyst estimates
      revenueEst1Y:revenueEst, epsEst1Y:epsEst,
      revenueEst2Y:revenueEst2, epsEst2Y:epsEst2,
    };
  } catch(e) { console.error(`[Yahoo] ${ticker}:`, e.message); return null; }
}

async function fetchHistory(ticker, days=250) {
  try {
    const end=Math.floor(Date.now()/1000), start=end-days*86400;
    const r = await yfGet(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${start}&period2=${end}&interval=1d`);
    const result = r.data?.chart?.result?.[0];
    if (!result) return [];
    const times=result.timestamp||[];
    const q=result.indicators?.quote?.[0]||{};
    return times.map((t,i)=>({
      date:new Date(t*1000).toISOString().slice(0,10),
      open:q.open?.[i]||null, high:q.high?.[i]||null,
      low:q.low?.[i]||null, close:q.close?.[i]||null,
      volume:q.volume?.[i]||null
    })).filter(d=>d.close!=null);
  } catch { return []; }
}

async function fetchIntraday(ticker) {
  try {
    const end=Math.floor(Date.now()/1000), start=end-86400;
    const r = await yfGet(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${start}&period2=${end}&interval=5m`);
    const result = r.data?.chart?.result?.[0];
    if (!result) return [];
    const times=result.timestamp||[], closes=result.indicators?.quote?.[0]?.close||[], vols=result.indicators?.quote?.[0]?.volume||[];
    return times.map((t,i)=>({
      time:new Date(t*1000).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Kolkata"}),
      close:closes[i], volume:vols[i]
    })).filter(d=>d.close!=null);
  } catch { return []; }
}

// ─── TECHNICAL CALCULATIONS ───────────────────────────────────────────────────
function calcEMA(data, period) {
  const k = 2/(period+1);
  let ema = data[0];
  return data.map(v=>{ ema=v*k+ema*(1-k); return ema; });
}

function calcMACD(closes) {
  if (closes.length < 35) return null;
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v,i)=>v-ema26[i]);
  const signal = calcEMA(macdLine.slice(macdLine.length-9), 9);
  const lastMACD = macdLine[macdLine.length-1];
  const lastSignal = signal[signal.length-1];
  const hist = lastMACD-lastSignal;
  return {
    macd:parseFloat(lastMACD.toFixed(4)),
    signal:parseFloat(lastSignal.toFixed(4)),
    histogram:parseFloat(hist.toFixed(4)),
    trend:hist>0?(hist>macdLine[macdLine.length-2]-signal[signal.length-2]?"Bullish Crossover":"Bullish"):"Bearish"
  };
}

function calcRSI(closes, period=14) {
  if (closes.length<period+1) return null;
  const sl=closes.slice(-period-1);
  let g=0,l=0;
  for(let i=1;i<sl.length;i++){const d=sl[i]-sl[i-1];if(d>0)g+=d;else l+=Math.abs(d);}
  const rs=(g/period)/((l/period)||0.001);
  return parseFloat((100-100/(1+rs)).toFixed(2));
}

function calcBollingerBands(closes, period=20) {
  if (closes.length<period) return null;
  const sl=closes.slice(-period);
  const mean=sl.reduce((a,b)=>a+b,0)/period;
  const std=Math.sqrt(sl.map(v=>Math.pow(v-mean,2)).reduce((a,b)=>a+b,0)/period);
  return { upper:parseFloat((mean+2*std).toFixed(2)), middle:parseFloat(mean.toFixed(2)), lower:parseFloat((mean-2*std).toFixed(2)) };
}

function calcSupportResistance(history) {
  if (history.length<20) return { support:[], resistance:[] };
  const highs=history.map(d=>d.high||d.close);
  const lows=history.map(d=>d.low||d.close);
  const support=[], resistance=[];
  for(let i=5;i<history.length-5;i++){
    const isSwingLow=lows[i]===Math.min(...lows.slice(i-5,i+6));
    const isSwingHigh=highs[i]===Math.max(...highs.slice(i-5,i+6));
    if(isSwingLow) support.push(parseFloat(lows[i].toFixed(2)));
    if(isSwingHigh) resistance.push(parseFloat(highs[i].toFixed(2)));
  }
  const dedupe=(arr)=>{
    const sorted=[...new Set(arr)].sort((a,b)=>a-b);
    const clusters=[];
    sorted.forEach(v=>{
      const last=clusters[clusters.length-1];
      if(last && Math.abs(v-last)/last<0.02) clusters[clusters.length-1]=(last+v)/2;
      else clusters.push(v);
    });
    return clusters;
  };
  return {
    support:dedupe(support).slice(-3).map(v=>parseFloat(v.toFixed(2))),
    resistance:dedupe(resistance).slice(-3).map(v=>parseFloat(v.toFixed(2)))
  };
}

function calcVolumeAnalysis(history) {
  if (history.length<20) return null;
  const vols=history.map(d=>d.volume||0).filter(v=>v>0);
  const avg20=vols.slice(-20).reduce((a,b)=>a+b,0)/20;
  const lastVol=vols[vols.length-1];
  const spike=((lastVol-avg20)/avg20*100);
  return {
    avg20d:Math.round(avg20),
    lastVolume:lastVol,
    spikePercent:parseFloat(spike.toFixed(1)),
    interpretation:spike>100?"Very High — Strong Interest":spike>50?"High — Above Average":spike>-20?"Normal":"Low — Weak Interest"
  };
}

function calcStochastic(history, period=14) {
  if (history.length<period) return null;
  const sl=history.slice(-period);
  const low=Math.min(...sl.map(d=>d.low||d.close));
  const high=Math.max(...sl.map(d=>d.high||d.close));
  const lastClose=sl[sl.length-1].close;
  const k=parseFloat(((lastClose-low)/(high-low)*100).toFixed(2));
  return { k, d:k, signal:k>80?"Overbought":k<20?"Oversold":"Neutral" };
}

function calcATR(history, period=14) {
  if (history.length<period+1) return null;
  const trs=[];
  for(let i=1;i<history.length;i++){
    const h=history[i].high||history[i].close, l=history[i].low||history[i].close, pc=history[i-1].close;
    trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
  }
  return parseFloat((trs.slice(-period).reduce((a,b)=>a+b,0)/period).toFixed(2));
}

function calc52WkPosition(cmp, high52, low52) {
  if (!cmp||!high52||!low52) return null;
  return parseFloat(((cmp-low52)/(high52-low52)*100).toFixed(1));
}

// ─── INDICES ─────────────────────────────────────────────────────────────────
async function fetchIndex(ticker) {
  try {
    const r = await yfGet(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`);
    const meta = r.data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    return { price:meta.regularMarketPrice, change:meta.regularMarketPrice-meta.chartPreviousClose, changePct:((meta.regularMarketPrice-meta.chartPreviousClose)/meta.chartPreviousClose*100) };
  } catch { return null; }
}
app.get("/api/indices", async (req,res) => {
  const hit=indexCache.get("indices");
  if(hit) return res.json(hit);
  const [nifty,sensex,banknifty]=await Promise.all([fetchIndex("^NSEI"),fetchIndex("^BSESN"),fetchIndex("^NSEBANK")]);
  const data={nifty,sensex,banknifty,timestamp:new Date().toISOString()};
  indexCache.set("indices",data);
  res.json(data);
});

// ─── NEWS ─────────────────────────────────────────────────────────────────────
async function fetchNews(name) {
  const empty={articles:[],sentiment:"neutral",score:5,positive:0,negative:0,neutral:0};
  if(!NEWS_API_KEY) return empty;
  try {
    const r=await axios.get("https://newsapi.org/v2/everything",{params:{q:`${name} stock`,language:"en",sortBy:"publishedAt",pageSize:10,apiKey:NEWS_API_KEY},timeout:8000});
    const articles=r.data.articles||[];
    const POS=["surge","rally","gain","profit","growth","upgrade","buy","bullish","beat","record","strong","rise","outperform","dividend","acquisition"];
    const NEG=["fall","drop","loss","decline","downgrade","sell","bearish","miss","weak","plunge","concern","fraud","penalty","debt","cut","lawsuit"];
    let pos=0,neg=0,neu=0;
    articles.forEach(a=>{
      const t=((a.title||"")+" "+(a.description||"")).toLowerCase();
      const p=POS.filter(w=>t.includes(w)).length,n=NEG.filter(w=>t.includes(w)).length;
      if(p>n)pos++;else if(n>p)neg++;else neu++;
    });
    const total=pos+neg+neu||1,ratio=(pos-neg)/total;
    const sentiment=ratio>0.2?"positive":ratio<-0.2?"negative":"neutral";
    return {articles:articles.slice(0,5).map(({title,source,url,publishedAt})=>({title,source:source?.name,url,publishedAt})),sentiment,score:sentiment==="positive"?8:sentiment==="negative"?3:5,positive:pos,negative:neg,neutral:neu};
  } catch(e){console.error("[News]",e.message);return empty;}
}

// ─── SCORING ─────────────────────────────────────────────────────────────────
function computeScore(data) {
  const { yahoo, history, macd, rsi, bollinger, volumeAnalysis, sr } = data;
  const scores = {};

  // Fundamental (25%)
  const roeS = yahoo.roe==null?5:yahoo.roe>20?10:yahoo.roe>=15?8:yahoo.roe>=10?6:3;
  const peS = yahoo.pe==null?5:(yahoo.pe/22)<0.8?8:(yahoo.pe/22)<=1.2?5:3;
  const deS = yahoo.debtToEquity==null?6:yahoo.debtToEquity<0.5?9:yahoo.debtToEquity<=1?7:4;
  const marginS = yahoo.profitMargins==null?5:yahoo.profitMargins>20?9:yahoo.profitMargins>10?7:yahoo.profitMargins>5?5:3;
  scores.fundamental = (roeS+peS+deS+marginS)/4;

  // Valuation (15%)
  const industryPE=22;
  const intrinsic=yahoo.eps?yahoo.eps*industryPE:null;
  const valS=!intrinsic||!yahoo.cmp?5:(yahoo.cmp/intrinsic)<0.8?9:(yahoo.cmp/intrinsic)<=1.0?7:(yahoo.cmp/intrinsic)<=1.2?5:3;
  scores.valuation=valS;

  // Technical (25%)
  const rsiS=rsi==null?5:rsi>=40&&rsi<=60?8:rsi>70?4:rsi<30?6:rsi>60?6:5;
  const macdS=!macd?5:macd.histogram>0?8:macd.histogram>-0.5?5:3;
  const cmp=yahoo.cmp;
  const momS=!cmp||!yahoo.fiftyDayAvg?5:cmp>yahoo.fiftyDayAvg?(cmp>yahoo.twoHundredDayAvg?9:7):(cmp>yahoo.twoHundredDayAvg?5:3);
  const volS=!volumeAnalysis?5:volumeAnalysis.spikePercent>50?8:volumeAnalysis.spikePercent>0?6:4;
  scores.technical=(rsiS+macdS+momS+volS)/4;

  // Sentiment (10%)
  scores.sentiment=data.news?.score||5;

  // Risk adjustment
  const riskPenalty=!yahoo.debtToEquity?0:yahoo.debtToEquity>2?2:yahoo.debtToEquity>1?1:0;
  const finalRaw=scores.fundamental*0.25+scores.valuation*0.15+scores.technical*0.25+scores.sentiment*0.10;
  const final=Math.min(10,Math.max(0,finalRaw+2.5-riskPenalty)); // normalize to 0-10
  return { scores, final:parseFloat(final.toFixed(2)) };
}

function getDecision(score, cmp, sr) {
  const nearSupport=sr.support.length>0&&cmp&&Math.abs(cmp-sr.support[sr.support.length-1])/cmp<0.05;
  const nearResistance=sr.resistance.length>0&&cmp&&Math.abs(cmp-sr.resistance[sr.resistance.length-1])/cmp<0.03;
  let decision, color;
  if(score>8){decision="STRONG BUY";color="strong-buy";}
  else if(score>=6.5){decision="BUY";color="buy";}
  else if(score>=5){decision="HOLD";color="hold";}
  else if(score>=3){decision="SELL";color="sell";}
  else{decision="AVOID";color="avoid";}

  const entry=sr.support.length?sr.support[sr.support.length-1]:cmp?(cmp*0.98).toFixed(2):null;
  const sl=sr.support.length>1?sr.support[sr.support.length-2]:cmp?(cmp*0.93).toFixed(2):null;
  const tgt=sr.resistance.length?sr.resistance[0]:cmp?(cmp*1.12).toFixed(2):null;
  return { decision, decisionColor:color, entry, stop_loss:sl, target:tgt };
}

// ─── MAIN ANALYZE ─────────────────────────────────────────────────────────────
app.get("/api/analyze", async (req,res) => {
  const { stock } = req.query;
  if (!stock) return res.status(400).json({ error: "Provide ?stock=RELIANCE" });
  const ticker = resolveTicker(stock);
  const ckey = `v6_${ticker}`;
  const hit = cache.get(ckey);
  if (hit) return res.json({ ...hit, cached:true });
  try {
    const [yahoo, news, history, intraday] = await Promise.all([
      fetchYahoo(ticker), fetchNews(stock), fetchHistory(ticker, 250), fetchIntraday(ticker)
    ]);
    if (!yahoo?.cmp) return res.status(404).json({ error:`No data for "${stock}". Try exact ticker.` });

    const closes = history.map(d=>d.close);
    const rsi = calcRSI(closes);
    const macd = calcMACD(closes);
    const bollinger = calcBollingerBands(closes);
    const sr = calcSupportResistance(history);
    const volumeAnalysis = calcVolumeAnalysis(history);
    const stochastic = calcStochastic(history);
    const atr = calcATR(history);
    const weekPos = calc52WkPosition(yahoo.cmp, yahoo.fiftyTwoWeekHigh, yahoo.fiftyTwoWeekLow);

    // Intrinsic value (DCF simplified + Graham formula)
    const industryPE = 22;
    const intrinsicPE = yahoo.eps ? parseFloat((yahoo.eps*industryPE).toFixed(2)) : null;
    const grahamNumber = yahoo.eps && yahoo.bookValue ? parseFloat(Math.sqrt(22.5*yahoo.eps*yahoo.bookValue).toFixed(2)) : null;

    // 2-Year Projections
    const revGrowth = yahoo.revenueGrowth || 10;
    const rev = yahoo.totalRevenue;
    const proj = {
      year1: {
        revenue: rev ? parseFloat((rev*(1+revGrowth/100)).toFixed(0)) : null,
        eps: yahoo.epsEst1Y || (yahoo.eps ? parseFloat((yahoo.eps*(1+revGrowth/100)).toFixed(2)) : null),
        targetPrice: yahoo.epsEst1Y ? parseFloat((yahoo.epsEst1Y*industryPE).toFixed(2)) : null
      },
      year2: {
        revenue: rev ? parseFloat((rev*Math.pow(1+revGrowth/100,2)).toFixed(0)) : null,
        eps: yahoo.epsEst2Y || (yahoo.eps ? parseFloat((yahoo.eps*Math.pow(1+revGrowth/100,2)).toFixed(2)) : null),
        targetPrice: yahoo.epsEst2Y ? parseFloat((yahoo.epsEst2Y*industryPE).toFixed(2)) : null
      }
    };

    const scoreData = { yahoo, history, macd, rsi, bollinger, volumeAnalysis, sr, news };
    const { scores, final:scoreVal } = computeScore(scoreData);
    const { decision, decisionColor, entry, stop_loss, target } = getDecision(scoreVal, yahoo.cmp, sr);

    const n = (v,d=2) => v!=null?parseFloat(v.toFixed(d)):null;

    const result = {
      stock:ticker.replace(/\.(NS|BO)$/,""), fullName:yahoo.shortName, ticker,
      timestamp:new Date().toISOString(),
      // Price
      cmp:yahoo.cmp, previousClose:yahoo.previousClose, change:n(yahoo.change), changePercent:n(yahoo.changePercent),
      open:yahoo.open, dayHigh:yahoo.dayHigh, dayLow:yahoo.dayLow, volume:yahoo.volume, avgVolume:yahoo.avgVolume,
      marketCap:yahoo.marketCap, currency:yahoo.currency,
      fiftyTwoWeekHigh:yahoo.fiftyTwoWeekHigh, fiftyTwoWeekLow:yahoo.fiftyTwoWeekLow,
      weekPositionPercent:weekPos,
      // Fundamentals
      pe:n(yahoo.pe), forwardPE:n(yahoo.forwardPE), pb:n(yahoo.pb), eps:n(yahoo.eps), forwardEps:n(yahoo.forwardEps),
      roe:n(yahoo.roe), roa:n(yahoo.roa), debtToEquity:n(yahoo.debtToEquity),
      grossMargins:n(yahoo.grossMargins), operatingMargins:n(yahoo.operatingMargins),
      profitMargins:n(yahoo.profitMargins), ebitdaMargins:n(yahoo.ebitdaMargins),
      currentRatio:n(yahoo.currentRatio), quickRatio:n(yahoo.quickRatio),
      revenueGrowth:n(yahoo.revenueGrowth), earningsGrowth:n(yahoo.earningsGrowth),
      totalRevenue:yahoo.totalRevenue, totalDebt:yahoo.totalDebt, totalCash:yahoo.totalCash,
      freeCashflow:yahoo.freeCashflow, ebitda:yahoo.ebitda,
      beta:n(yahoo.beta), dividendYield:n(yahoo.dividendYield),
      enterpriseValue:yahoo.enterpriseValue,
      enterpriseToRevenue:n(yahoo.enterpriseToRevenue),
      enterpriseToEbitda:n(yahoo.enterpriseToEbitda),
      pegRatio:n(yahoo.pegRatio), bookValue:n(yahoo.bookValue),
      sharesOutstanding:yahoo.sharesOutstanding,
      // Technicals
      rsi:n(rsi), macd, bollinger, sr, volumeAnalysis, stochastic, atr,
      dma20:history.length>=20?n(history.slice(-20).reduce((s,d)=>s+d.close,0)/20):null,
      dma50:n(yahoo.fiftyDayAvg), dma200:n(yahoo.twoHundredDayAvg),
      // Valuation
      intrinsicPE, grahamNumber,
      // Projections
      projections:proj,
      // Score
      scores, score:scoreVal, decision, decisionColor, entry, stop_loss, target,
      // News
      sentiment:news.sentiment,
      sentimentBreakdown:{positive:news.positive,negative:news.negative,neutral:news.neutral},
      news:news.articles,
      // Meta
      sector:yahoo.sector, industry:yahoo.industry, description:yahoo.description,
      website:yahoo.website, employees:yahoo.employees,
      // Chart data
      intradayData:intraday,
      historyData:history.slice(-60).map(d=>({date:d.date,close:d.close,volume:d.volume})),
    };
    cache.set(ckey, result);
    res.json(result);
  } catch(e) {
    console.error("[/api/analyze]", e.message);
    res.status(500).json({ error:"Analysis failed: "+e.message });
  }
});

app.get("/api/compare", async (req,res) => {
  const stocks=(req.query.stocks||"").split(",").map(s=>s.trim()).filter(Boolean).slice(0,4);
  if(stocks.length<2) return res.status(400).json({error:"Need at least 2 stocks"});
  const results=await Promise.all(stocks.map(s=>
    axios.get(`http://localhost:${PORT}/api/analyze?stock=${encodeURIComponent(s)}`).then(r=>r.data).catch(()=>({stock:s,error:"Failed"}))
  ));
  res.json(results);
});

app.get("/api/price/:ticker", async (req,res) => {
  try {
    const ticker=resolveTicker(req.params.ticker);
    const y=await fetchYahoo(ticker);
    if(!y?.cmp) return res.status(404).json({error:"Not found"});
    res.json({ticker,cmp:y.cmp,change:y.change,changePercent:y.changePercent,shortName:y.shortName});
  } catch(e){res.status(500).json({error:e.message});}
});

// Broker holdings proxy (so API keys stay server-side in session)
const brokerSessions = new Map();
app.post("/api/broker/save", (req,res) => {
  const { sid, accounts } = req.body;
  if (!sid) return res.status(400).json({ error:"sid required" });
  brokerSessions.set(sid, accounts||[]);
  res.json({ success:true });
});

app.get("/api/broker/holdings/:sid", async (req,res) => {
  const accounts = brokerSessions.get(req.params.sid) || [];
  const allHoldings=[], errors=[];
  for (const acct of accounts) {
    try {
      let holdings=[];
      if (acct.broker==="zerodha" && acct.apiKey && acct.accessToken) {
        const r=await axios.get("https://api.kite.trade/portfolio/holdings",{headers:{"X-Kite-Version":"3","Authorization":`token ${acct.apiKey}:${acct.accessToken}`},timeout:10000});
        holdings=(r.data?.data||[]).map(h=>({stock:h.tradingsymbol,qty:h.quantity,avgPrice:h.average_price,lastPrice:h.last_price,pnl:h.pnl,account:acct.accountName,broker:"zerodha"}));
      } else if (acct.broker==="upstox" && acct.accessToken) {
        const r=await axios.get("https://api.upstox.com/v2/portfolio/long-term-holdings",{headers:{"Authorization":`Bearer ${acct.accessToken}`,"Accept":"application/json"},timeout:10000});
        holdings=(r.data?.data||[]).map(h=>({stock:h.tradingsymbol,qty:h.quantity,avgPrice:h.average_price,lastPrice:h.last_price,pnl:(h.last_price-h.average_price)*h.quantity,account:acct.accountName,broker:"upstox"}));
      } else if (acct.broker==="angelone" && acct.apiKey && acct.accessToken) {
        const r=await axios.get("https://apiconnect.angelbroking.com/rest/secure/angelbroking/portfolio/v1/getAllHolding",{headers:{"Authorization":`Bearer ${acct.accessToken}`,"X-ClientCode":acct.userId||"","X-APIKey":acct.apiKey,"Accept":"application/json"},timeout:10000});
        holdings=(r.data?.data?.holdings||[]).map(h=>({stock:h.tradingsymbol,qty:parseInt(h.quantity)||0,avgPrice:parseFloat(h.averageprice)||0,lastPrice:parseFloat(h.ltp)||0,pnl:(parseFloat(h.ltp)-parseFloat(h.averageprice))*(parseInt(h.quantity)||0),account:acct.accountName,broker:"angelone"}));
      }
      allHoldings.push(...holdings);
    } catch(e){errors.push({account:acct.accountName,error:e.message});}
  }
  const merged={};
  allHoldings.forEach(h=>{
    const key=h.stock;
    if(merged[key]){merged[key].qty+=h.qty;merged[key].invested+=h.avgPrice*h.qty;merged[key].current+=h.lastPrice*h.qty;merged[key].pnl+=h.pnl;merged[key].accounts.push(h.account);}
    else{merged[key]={...h,invested:h.avgPrice*h.qty,current:h.lastPrice*h.qty,accounts:[h.account]};}
  });
  const holdings=Object.values(merged).map(h=>({...h,returnPct:h.invested?(h.current-h.invested)/h.invested*100:0}));
  const totalInvested=holdings.reduce((s,h)=>s+h.invested,0);
  const totalCurrent=holdings.reduce((s,h)=>s+h.current,0);
  res.json({holdings,errors,summary:{totalInvested,totalCurrent,totalPnl:totalCurrent-totalInvested,totalReturn:totalInvested?((totalCurrent-totalInvested)/totalInvested*100):0}});
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>{console.log(`\n╔══════════════════════════════════════════════════╗`);console.log(`║   ACE Analytics v5 — No Login · Full Analysis   ║`);console.log(`║   http://localhost:${PORT}                           ║`);console.log(`╚══════════════════════════════════════════════════╝\n`);});
