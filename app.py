import os, json, math
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
import yfinance as yf
import pandas as pd

app = Flask(__name__, static_folder='public', static_url_path='')
CORS(app)

NEWS_API_KEY = os.environ.get('NEWS_API_KEY', '')

KNOWN = {
    'reliance':'RELIANCE.NS','tcs':'TCS.NS','infosys':'INFY.NS','infy':'INFY.NS',
    'hdfc':'HDFCBANK.NS','hdfcbank':'HDFCBANK.NS','icicibank':'ICICIBANK.NS','icici':'ICICIBANK.NS',
    'wipro':'WIPRO.NS','bajajfinance':'BAJFINANCE.NS','bajaj':'BAJFINANCE.NS',
    'airtel':'BHARTIARTL.NS','bhartiairtel':'BHARTIARTL.NS','itc':'ITC.NS',
    'kotakbank':'KOTAKBANK.NS','kotak':'KOTAKBANK.NS','sbi':'SBIN.NS',
    'axisbank':'AXISBANK.NS','axis':'AXISBANK.NS','hul':'HINDUNILVR.NS',
    'maruti':'MARUTI.NS','tatamotors':'TATAMOTORS.NS','sunpharma':'SUNPHARMA.NS',
    'ultracemco':'ULTRACEMCO.NS','ultratech':'ULTRACEMCO.NS','nestle':'NESTLEIND.NS',
    'titan':'TITAN.NS','adaniports':'ADANIPORTS.NS','adani':'ADANIPORTS.NS',
    'ongc':'ONGC.NS','ntpc':'NTPC.NS','powergrid':'POWERGRID.NS','asianpaint':'ASIANPAINT.NS',
    'drreddy':'DRREDDY.NS','cipla':'CIPLA.NS','tatasteel':'TATASTEEL.NS',
    'jswsteel':'JSWSTEEL.NS','jsw':'JSWSTEEL.NS','hcltech':'HCLTECH.NS','hcl':'HCLTECH.NS',
    'techm':'TECHM.NS','ltim':'LTIM.NS','divislab':'DIVISLAB.NS','pidilite':'PIDILITIND.NS',
    'mrf':'MRF.NS','havells':'HAVELLS.NS','voltas':'VOLTAS.NS',
    'irctc':'IRCTC.NS','zomato':'ZOMATO.NS','paytm':'PAYTM.NS','nykaa':'NYKAA.NS',
    'pgel':'PGEL.NS','dixon':'DIXON.NS','tatapower':'TATAPOWER.NS',
    'adanigreen':'ADANIGREEN.NS','adanient':'ADANIENT.NS','coalindia':'COALINDIA.NS',
    'hindalco':'HINDALCO.NS','vedanta':'VEDL.NS','indusindbk':'INDUSINDBK.NS',
    'indusind':'INDUSINDBK.NS','federalbank':'FEDERALBNK.NS','idfcfirst':'IDFCFIRSTB.NS',
    'pnb':'PNB.NS','bankofbaroda':'BANKBARODA.NS','canarabank':'CANBK.NS',
    'apollohosp':'APOLLOHOSP.NS','naukri':'NAUKRI.NS','indigo':'INDIGO.NS',
    'motherson':'MOTHERSON.NS','shreecem':'SHREECEM.NS','ambuja':'AMBUJACEM.NS','acc':'ACC.NS',
    'cholafin':'CHOLAFIN.NS','muthootfin':'MUTHOOTFIN.NS',
    'apple':'AAPL','aapl':'AAPL','microsoft':'MSFT','msft':'MSFT',
    'google':'GOOGL','alphabet':'GOOGL','googl':'GOOGL','amazon':'AMZN','amzn':'AMZN',
    'tesla':'TSLA','tsla':'TSLA','nvidia':'NVDA','nvda':'NVDA',
    'meta':'META','netflix':'NFLX','nflx':'NFLX',
    'jpmorgan':'JPM','jpm':'JPM','visa':'V','mastercard':'MA',
}

def resolve_ticker(inp):
    lower = inp.strip().lower().replace(' ','').replace('-','')
    if lower in KNOWN: return KNOWN[lower]
    upper = inp.strip().upper().replace(' ','')
    if '.NS' in upper or '.BO' in upper: return upper
    if upper.isalpha() and len(upper) <= 10: return upper + '.NS'
    return upper + '.NS'

def safe(v, decimals=2):
    if v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))): return None
    if isinstance(v, float): return round(v, decimals)
    return v

def calc_rsi(closes, period=14):
    if len(closes) < period+1: return None
    sl = closes[-(period+1):]
    gains = [max(sl[i]-sl[i-1],0) for i in range(1,len(sl))]
    losses = [max(sl[i-1]-sl[i],0) for i in range(1,len(sl))]
    avg_g = sum(gains)/period
    avg_l = sum(losses)/period or 0.001
    rs = avg_g/avg_l
    return round(100-100/(1+rs), 2)

def calc_ema(data, period):
    if not data: return []
    k = 2/(period+1)
    ema = data[0]
    result = []
    for v in data:
        ema = v*k + ema*(1-k)
        result.append(ema)
    return result

def calc_macd(closes):
    if len(closes) < 35: return None
    ema12 = calc_ema(closes, 12)
    ema26 = calc_ema(closes, 26)
    macd_line = [ema12[i]-ema26[i] for i in range(len(closes))]
    signal = calc_ema(macd_line[-9:], 9)
    last_macd = macd_line[-1]
    last_sig = signal[-1]
    hist = last_macd - last_sig
    prev_hist = macd_line[-2] - (signal[-2] if len(signal)>1 else last_sig)
    trend = 'Bullish Crossover' if hist>0 and hist>prev_hist else ('Bullish' if hist>0 else 'Bearish')
    return {'macd':round(last_macd,4),'signal':round(last_sig,4),'histogram':round(hist,4),'trend':trend}

def calc_bollinger(closes, period=20):
    if len(closes) < period: return None
    sl = closes[-period:]
    mean = sum(sl)/period
    std = (sum((v-mean)**2 for v in sl)/period)**0.5
    return {'upper':round(mean+2*std,2),'middle':round(mean,2),'lower':round(mean-2*std,2)}

def calc_sr(highs, lows):
    if len(highs) < 20: return {'support':[],'resistance':[]}
    sup, res = [], []
    for i in range(5, len(highs)-5):
        if lows[i] == min(lows[i-5:i+6]): sup.append(round(lows[i],2))
        if highs[i] == max(highs[i-5:i+6]): res.append(round(highs[i],2))
    def dedupe(arr):
        seen = sorted(set(arr))
        cl = []
        for v in seen:
            if cl and abs(v-cl[-1])/cl[-1] < 0.02: cl[-1] = round((cl[-1]+v)/2,2)
            else: cl.append(v)
        return cl
    return {'support':dedupe(sup)[-3:],'resistance':dedupe(res)[-3:]}

def calc_volume_analysis(volumes):
    vols = [v for v in volumes if v and v > 0]
    if len(vols) < 20: return None
    avg20 = sum(vols[-20:])/20
    last = vols[-1]
    spike = ((last-avg20)/avg20*100)
    interp = 'Very High — Strong Interest' if spike>100 else ('High — Above Average' if spike>50 else ('Normal' if spike>-20 else 'Low — Weak Interest'))
    return {'avg20d':int(avg20),'lastVolume':int(last),'spikePercent':round(spike,1),'interpretation':interp}

def calc_stoch(highs, lows, closes, period=14):
    if len(closes) < period: return None
    h = max(highs[-period:])
    l = min(lows[-period:])
    if h == l: return None
    k = round((closes[-1]-l)/(h-l)*100, 2)
    return {'k':k,'signal':'Overbought' if k>80 else ('Oversold' if k<20 else 'Neutral')}

def calc_atr(highs, lows, closes, period=14):
    if len(closes) < period+1: return None
    trs = []
    for i in range(1, len(closes)):
        h,l,pc = highs[i],lows[i],closes[i-1]
        trs.append(max(h-l, abs(h-pc), abs(l-pc)))
    return round(sum(trs[-period:])/period, 2)

def fetch_news(name):
    empty = {'articles':[],'sentiment':'neutral','score':5,'positive':0,'negative':0,'neutral':0}
    if not NEWS_API_KEY: return empty
    try:
        import requests
        r = requests.get('https://newsapi.org/v2/everything', params={
            'q':f'{name} stock','language':'en','sortBy':'publishedAt','pageSize':10,'apiKey':NEWS_API_KEY
        }, timeout=8)
        articles = r.json().get('articles',[])
        POS = ['surge','rally','gain','profit','growth','upgrade','buy','bullish','beat','record','strong','rise','outperform','dividend']
        NEG = ['fall','drop','loss','decline','downgrade','sell','bearish','miss','weak','plunge','concern','fraud','penalty','debt','cut']
        pos=neg=neu=0
        for a in articles:
            t = ((a.get('title','') or '') + ' ' + (a.get('description','') or '')).lower()
            p = sum(1 for w in POS if w in t)
            n = sum(1 for w in NEG if w in t)
            if p>n: pos+=1
            elif n>p: neg+=1
            else: neu+=1
        total = pos+neg+neu or 1
        ratio = (pos-neg)/total
        sentiment = 'positive' if ratio>0.2 else ('negative' if ratio<-0.2 else 'neutral')
        return {
            'articles':[{'title':a.get('title'),'source':a.get('source',{}).get('name'),'url':a.get('url'),'publishedAt':a.get('publishedAt')} for a in articles[:5]],
            'sentiment':sentiment,'score':8 if sentiment=='positive' else (3 if sentiment=='negative' else 5),
            'positive':pos,'negative':neg,'neutral':neu
        }
    except Exception as e:
        print(f'[News] {e}')
        return empty

_cache = {}

@app.route('/api/indices')
def api_indices():
    def get_idx(ticker):
        try:
            t = yf.Ticker(ticker)
            info = t.fast_info
            price = info.last_price
            prev = info.previous_close
            ch = price - prev
            return {'price':round(price,2),'change':round(ch,2),'changePct':round(ch/prev*100,2)}
        except: return None
    return jsonify({
        'nifty':get_idx('^NSEI'),
        'sensex':get_idx('^BSESN'),
        'banknifty':get_idx('^NSEBANK'),
        'timestamp':pd.Timestamp.now().isoformat()
    })

@app.route('/api/analyze')
def api_analyze():
    stock = request.args.get('stock','')
    if not stock: return jsonify({'error':'Provide ?stock=RELIANCE'}), 400
    ticker = resolve_ticker(stock)
    cache_key = f'v6_{ticker}'
    if cache_key in _cache:
        r = _cache[cache_key].copy()
        r['cached'] = True
        return jsonify(r)
    try:
        t = yf.Ticker(ticker)
        info = t.info
        if not info or not info.get('regularMarketPrice'):
            return jsonify({'error':f'No data found for "{stock}". Please check the ticker symbol.'}), 404

        hist = t.history(period='1y')
        hist5m = t.history(period='1d', interval='5m')

        closes = hist['Close'].tolist()
        highs = hist['High'].tolist()
        lows = hist['Low'].tolist()
        volumes = hist['Volume'].tolist()
        dates = [str(d.date()) for d in hist.index]

        rsi = calc_rsi(closes)
        macd = calc_macd(closes)
        bollinger = calc_bollinger(closes)
        sr = calc_sr(highs, lows)
        vol_analysis = calc_volume_analysis(volumes)
        stoch = calc_stoch(highs, lows, closes)
        atr = calc_atr(highs, lows, closes)

        dma20 = round(sum(closes[-20:])/20, 2) if len(closes)>=20 else None
        dma50 = round(sum(closes[-50:])/50, 2) if len(closes)>=50 else None
        dma200 = round(sum(closes[-200:])/200, 2) if len(closes)>=200 else None

        cmp = safe(info.get('regularMarketPrice'))
        prev_close = safe(info.get('regularMarketPreviousClose'))
        change = safe(cmp - prev_close) if cmp and prev_close else None
        change_pct = safe(change/prev_close*100) if change and prev_close else None

        eps = safe(info.get('trailingEps'))
        book_val = safe(info.get('bookValue'))
        intrinsic_pe = round(eps*22, 2) if eps else None
        graham = round((22.5*max(eps,0)*book_val)**0.5, 2) if eps and book_val and eps>0 and book_val>0 else None

        high52 = safe(info.get('fiftyTwoWeekHigh'))
        low52 = safe(info.get('fiftyTwoWeekLow'))
        week_pos = round((cmp-low52)/(high52-low52)*100, 1) if cmp and high52 and low52 and high52!=low52 else None

        rev_growth = safe(info.get('revenueGrowth',0.10))
        if rev_growth: rev_growth *= 100
        rev_growth_rate = (rev_growth or 10)/100
        total_rev = info.get('totalRevenue')
        proj = {
            'year1':{
                'revenue':int(total_rev*(1+rev_growth_rate)) if total_rev else None,
                'eps':safe(info.get('earningsEstimate',{}).get('avg',0)) or (round(eps*(1+rev_growth_rate),2) if eps else None),
                'targetPrice':None
            },
            'year2':{
                'revenue':int(total_rev*(1+rev_growth_rate)**2) if total_rev else None,
                'eps':round(eps*(1+rev_growth_rate)**2,2) if eps else None,
                'targetPrice':None
            }
        }
        if proj['year1']['eps']: proj['year1']['targetPrice'] = round(proj['year1']['eps']*22,2)
        if proj['year2']['eps']: proj['year2']['targetPrice'] = round(proj['year2']['eps']*22,2)

        roe = safe(info.get('returnOnEquity',None))
        if roe: roe = round(roe*100,2)
        roa = safe(info.get('returnOnAssets',None))
        if roa: roa = round(roa*100,2)
        gross_m = info.get('grossMargins')
        if gross_m: gross_m = round(gross_m*100,2)
        op_m = info.get('operatingMargins')
        if op_m: op_m = round(op_m*100,2)
        net_m = info.get('profitMargins')
        if net_m: net_m = round(net_m*100,2)
        ebitda_m = info.get('ebitdaMargins')
        if ebitda_m: ebitda_m = round(ebitda_m*100,2)
        rev_g = info.get('revenueGrowth')
        if rev_g: rev_g = round(rev_g*100,2)
        earn_g = info.get('earningsGrowth')
        if earn_g: earn_g = round(earn_g*100,2)

        # Score
        roe_s = 5 if roe is None else (10 if roe>20 else (8 if roe>=15 else (6 if roe>=10 else 3)))
        pe = safe(info.get('trailingPE'))
        pe_s = 5 if pe is None else (8 if pe/22<0.8 else (5 if pe/22<=1.2 else 3))
        de = safe(info.get('debtToEquity'))
        de_s = 6 if de is None else (9 if de<0.5 else (7 if de<=1 else 4))
        margin_s = 5 if net_m is None else (9 if net_m>20 else (7 if net_m>10 else (5 if net_m>5 else 3)))
        fundamental = (roe_s+pe_s+de_s+margin_s)/4

        intr = eps*22 if eps else None
        val_s = 5 if not intr or not cmp else (9 if cmp/intr<0.8 else (7 if cmp/intr<=1.0 else (5 if cmp/intr<=1.2 else 3)))

        rsi_s = 5 if rsi is None else (8 if 40<=rsi<=60 else (4 if rsi>70 else (6 if rsi<30 else (6 if rsi>60 else 5))))
        macd_s = 5 if not macd else (8 if macd['histogram']>0 else (5 if macd['histogram']>-0.5 else 3))
        mom_s = 5 if not cmp or not dma50 else (9 if cmp>dma50 and (not dma200 or cmp>dma200) else (7 if cmp>dma50 else (5 if dma200 and cmp>dma200 else 3)))
        vol_s = 5 if not vol_analysis else (8 if vol_analysis['spikePercent']>50 else (6 if vol_analysis['spikePercent']>0 else 4))
        technical = (rsi_s+macd_s+mom_s+vol_s)/4

        news = fetch_news(stock)
        sent_s = news['score']
        risk_pen = 0 if not de else (2 if de>2 else (1 if de>1 else 0))
        raw = fundamental*0.30 + val_s*0.20 + technical*0.30 + sent_s*0.10 + (5-risk_pen)*0.10
        score = round(min(10, max(0, raw)), 2)

        if score>8: decision,color='STRONG BUY','strong-buy'
        elif score>=6.5: decision,color='BUY','buy'
        elif score>=5: decision,color='HOLD','hold'
        elif score>=3: decision,color='SELL','sell'
        else: decision,color='AVOID','avoid'

        entry = sr['support'][-1] if sr['support'] else (round(cmp*0.98,2) if cmp else None)
        sl = sr['support'][-2] if len(sr['support'])>1 else (round(cmp*0.93,2) if cmp else None)
        tgt = sr['resistance'][0] if sr['resistance'] else (round(cmp*1.12,2) if cmp else None)

        intraday = []
        if not hist5m.empty:
            for ts, row in hist5m.iterrows():
                try:
                    import pytz
                    ist = pytz.timezone('Asia/Kolkata')
                    t_ist = ts.astimezone(ist)
                    intraday.append({'time':t_ist.strftime('%I:%M %p'),'close':round(row['Close'],2),'volume':int(row['Volume'])})
                except: pass

        result = {
            'stock':ticker.replace('.NS','').replace('.BO',''),
            'fullName':info.get('longName') or info.get('shortName') or ticker,
            'ticker':ticker,'timestamp':pd.Timestamp.now().isoformat(),
            'cmp':cmp,'previousClose':prev_close,'change':change,'changePercent':change_pct,
            'open':safe(info.get('regularMarketOpen')),
            'dayHigh':safe(info.get('regularMarketDayHigh')),
            'dayLow':safe(info.get('regularMarketDayLow')),
            'volume':info.get('regularMarketVolume'),
            'avgVolume':info.get('averageDailyVolume3Month'),
            'marketCap':info.get('marketCap'),'currency':info.get('currency','INR'),
            'fiftyTwoWeekHigh':high52,'fiftyTwoWeekLow':low52,'weekPositionPercent':week_pos,
            'beta':safe(info.get('beta')),'dividendYield':safe(info.get('dividendYield')),
            'pe':pe,'forwardPE':safe(info.get('forwardPE')),
            'pb':safe(info.get('priceToBook')),'eps':eps,'forwardEps':safe(info.get('forwardEps')),
            'roe':roe,'roa':roa,'debtToEquity':de,
            'grossMargins':gross_m,'operatingMargins':op_m,'profitMargins':net_m,'ebitdaMargins':ebitda_m,
            'currentRatio':safe(info.get('currentRatio')),'quickRatio':safe(info.get('quickRatio')),
            'revenueGrowth':rev_g,'earningsGrowth':earn_g,
            'totalRevenue':info.get('totalRevenue'),'totalDebt':info.get('totalDebt'),
            'totalCash':info.get('totalCash'),'freeCashflow':info.get('freeCashflow'),
            'ebitda':info.get('ebitda'),'enterpriseValue':info.get('enterpriseValue'),
            'enterpriseToRevenue':safe(info.get('enterpriseToRevenue')),
            'enterpriseToEbitda':safe(info.get('enterpriseToEbitda')),
            'pegRatio':safe(info.get('pegRatio')),'bookValue':book_val,
            'intrinsicPE':intrinsic_pe,'grahamNumber':graham,
            'rsi':rsi,'macd':macd,'bollinger':bollinger,'sr':sr,
            'volumeAnalysis':vol_analysis,'stochastic':stoch,'atr':atr,
            'dma20':dma20,'dma50':dma50,'dma200':dma200,
            'projections':proj,
            'scores':{'fundamental':round(fundamental,2),'valuation':round(val_s,2),'technical':round(technical,2),'sentiment':sent_s},
            'score':score,'decision':decision,'decisionColor':color,
            'entry':entry,'stop_loss':sl,'target':tgt,
            'sentiment':news['sentiment'],
            'sentimentBreakdown':{'positive':news['positive'],'negative':news['negative'],'neutral':news['neutral']},
            'news':news['articles'],
            'sector':info.get('sector','—'),'industry':info.get('industry','—'),
            'description':info.get('longBusinessSummary'),
            'website':info.get('website'),'employees':info.get('fullTimeEmployees'),
            'intradayData':intraday,
            'historyData':[{'date':dates[i],'close':round(closes[i],2),'volume':int(volumes[i])} for i in range(max(0,len(dates)-60),len(dates))]
        }
        _cache[cache_key] = result
        return jsonify(result)
    except Exception as e:
        print(f'[analyze] {e}')
        return jsonify({'error':f'Analysis failed: {str(e)}'}), 500

@app.route('/api/compare')
def api_compare():
    stocks = [s.strip() for s in request.args.get('stocks','').split(',') if s.strip()][:4]
    if len(stocks) < 2: return jsonify({'error':'Need at least 2 stocks'}), 400
    import requests as req_lib
    results = []
    for s in stocks:
        try:
            r = req_lib.get(f'http://localhost:{os.environ.get("PORT",3000)}/api/analyze?stock={s}', timeout=30)
            results.append(r.json())
        except: results.append({'stock':s,'error':'Failed'})
    return jsonify(results)

@app.route('/api/broker/save', methods=['POST'])
def broker_save():
    data = request.json
    sid = data.get('sid')
    if not sid: return jsonify({'error':'sid required'}), 400
    _sessions[sid] = data.get('accounts', [])
    return jsonify({'success':True})

_sessions = {}

@app.route('/api/broker/holdings/<sid>')
def broker_holdings(sid):
    import requests as req_lib
    accounts = _sessions.get(sid, [])
    all_holdings, errors = [], []
    for a in accounts:
        try:
            broker = a.get('broker')
            h = []
            if broker == 'zerodha' and a.get('apiKey') and a.get('accessToken'):
                r = req_lib.get('https://api.kite.trade/portfolio/holdings', headers={'X-Kite-Version':'3','Authorization':f"token {a['apiKey']}:{a['accessToken']}"}, timeout=10)
                h = [{'stock':x['tradingsymbol'],'qty':x['quantity'],'avgPrice':x['average_price'],'lastPrice':x['last_price'],'pnl':x['pnl'],'account':a.get('accountName'),'broker':'zerodha'} for x in r.json().get('data',[])]
            elif broker == 'upstox' and a.get('accessToken'):
                r = req_lib.get('https://api.upstox.com/v2/portfolio/long-term-holdings', headers={'Authorization':f"Bearer {a['accessToken']}",'Accept':'application/json'}, timeout=10)
                h = [{'stock':x['tradingsymbol'],'qty':x['quantity'],'avgPrice':x['average_price'],'lastPrice':x['last_price'],'pnl':(x['last_price']-x['average_price'])*x['quantity'],'account':a.get('accountName'),'broker':'upstox'} for x in r.json().get('data',[])]
            elif broker == 'angelone' and a.get('apiKey') and a.get('accessToken'):
                r = req_lib.get('https://apiconnect.angelbroking.com/rest/secure/angelbroking/portfolio/v1/getAllHolding', headers={'Authorization':f"Bearer {a['accessToken']}",'X-ClientCode':a.get('userId',''),'X-APIKey':a['apiKey'],'Accept':'application/json'}, timeout=10)
                h = [{'stock':x['tradingsymbol'],'qty':int(x['quantity']),'avgPrice':float(x['averageprice']),'lastPrice':float(x['ltp']),'pnl':(float(x['ltp'])-float(x['averageprice']))*int(x['quantity']),'account':a.get('accountName'),'broker':'angelone'} for x in r.json().get('data',{}).get('holdings',[])]
            all_holdings.extend(h)
        except Exception as e:
            errors.append({'account':a.get('accountName'),'error':str(e)})
    merged = {}
    for h in all_holdings:
        k = h['stock']
        if k in merged:
            merged[k]['qty'] += h['qty']
            merged[k]['invested'] = merged[k].get('invested',0) + h['avgPrice']*h['qty']
            merged[k]['current'] = merged[k].get('current',0) + h['lastPrice']*h['qty']
            merged[k]['pnl'] += h['pnl']
            merged[k].setdefault('accounts',[]).append(h['account'])
        else:
            merged[k] = {**h,'invested':h['avgPrice']*h['qty'],'current':h['lastPrice']*h['qty'],'accounts':[h['account']]}
    holdings = [{**h,'returnPct':round((h['current']-h['invested'])/h['invested']*100,2) if h['invested'] else 0} for h in merged.values()]
    ti = sum(h['invested'] for h in holdings)
    tc = sum(h['current'] for h in holdings)
    return jsonify({'holdings':holdings,'errors':errors,'summary':{'totalInvested':ti,'totalCurrent':tc,'totalPnl':tc-ti,'totalReturn':round((tc-ti)/ti*100,2) if ti else 0}})

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def catch_all(path):
    return send_from_directory('public', 'index.html')

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 3000))
    print(f'\n╔══════════════════════════════════════════════════╗')
    print(f'║   ACE Analytics — Python/yfinance Edition        ║')
    print(f'║   http://localhost:{port}                           ║')
    print(f'╚══════════════════════════════════════════════════╝\n')
    app.run(host='0.0.0.0', port=port)