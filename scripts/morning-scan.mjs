#!/usr/bin/env node
/**
 * TV Morning Watchlist Scanner v2 — Multi-Timeframe + LuxAlgo SMC
 * Weekly (trend) + Daily (OB/FVG/BOS/CHoCH) + 4H (entry)
 * Sends: Best Swing Trades + Discount+OB list + Full watchlist
 */

import https from 'https';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const nodemailer = require('nodemailer');

const GMAIL_USER  = process.env.GMAIL_USER;
const GMAIL_PASS  = process.env.GMAIL_APP_PASSWORD;
const ALERT_EMAIL = process.env.ALERT_EMAIL || GMAIL_USER;

if (!GMAIL_USER || !GMAIL_PASS) { console.error('❌ Missing env vars'); process.exit(1); }

// ─── WATCHLISTS ───────────────────────────────────────────────────────────────
const WATCHLISTS = {
  krishiv: [
    'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','BRK-B','AVGO','JPM',
    'V','XOM','UNH','MA','HD','COST','BAC','NFLX','PG','WMT',
    'LIN','AMD','ORCL','CRM','CVX','MCD','KO','CSCO','WFC','ABT',
    'ACN','CAT','IBM','GS','INTU','NOW','T','UBER','RTX','BKNG',
    'MS','SPGI','LOW','TXN','ISRG','HON','NEE','GE','BLK','AXP'
  ],
  vaisham: [
    'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA','BRK-B','AVGO','JPM',
    'V','XOM','UNH','MA','HD','COST','BAC','NFLX','PG','WMT',
    'LIN','AMD','ORCL','CRM','CVX','MCD','KO','CSCO','WFC','ABT',
    'ACN','CAT','IBM','GS','INTU','NOW','T','UBER','RTX','BKNG',
    'MS','SPGI','LOW','TXN','ISRG','HON','NEE','GE','BLK'
  ]
};

const FUND_SCORE = {
  MSFT:5,AAPL:5,NVDA:5,AMZN:5,GOOGL:5,META:5,AVGO:5,V:5,MA:5,
  SPGI:5,BLK:5,ISRG:5,NOW:5,COST:5,INTU:5,
  JPM:4,BKNG:4,GS:4,ACN:4,LOW:4,HD:4,TXN:4,AXP:4,
  TSLA:4,CRM:4,ORCL:4,AMD:4,WMT:4,PG:4,UNH:4,ABT:4,
  'BRK-B':4,CAT:4,MS:4,
  IBM:3,CSCO:3,KO:3,BAC:3,WFC:3,NEE:3,GE:3,HON:3,LIN:3,XOM:3,CVX:3,
  RTX:3,NFLX:3,UBER:3,MCD:3,T:2,
};

// ─── INDICATORS ───────────────────────────────────────────────────────────────
function ema(data, period) {
  if (!data || data.length < period) return data ? data[data.length-1] : 0;
  const k = 2/(period+1);
  let e = data.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for (let i=period;i<data.length;i++) e = data[i]*k + e*(1-k);
  return e;
}
function rsi(closes, period=14) {
  if (closes.length < period+1) return 50;
  let ag=0,al=0;
  for (let i=1;i<=period;i++){const d=closes[i]-closes[i-1];d>0?ag+=d:al-=d;}
  ag/=period; al/=period;
  for (let i=period+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    ag=(ag*(period-1)+(d>0?d:0))/period;
    al=(al*(period-1)+(d<0?-d:0))/period;
  }
  return al===0?100:100-100/(1+ag/al);
}
function atr(bars, period=14) {
  if (bars.length<2) return 0;
  const trs=[];
  for (let i=1;i<bars.length;i++) trs.push(Math.max(bars[i].high-bars[i].low,Math.abs(bars[i].high-bars[i-1].close),Math.abs(bars[i].low-bars[i-1].close)));
  return trs.slice(-period).reduce((a,b)=>a+b,0)/Math.min(trs.length,period);
}

// ─── LuxAlgo SMC ─────────────────────────────────────────────────────────────
function findBullishOBs(bars, pct=0.025, fwd=4) {
  const obs=[];
  for (let i=1;i<bars.length-fwd;i++){
    const b=bars[i];
    if (b.close>=b.open) continue;
    const maxC=Math.max(...bars.slice(i+1,i+1+fwd).map(x=>x.close));
    if ((maxC-b.low)/b.low>=pct) obs.push({high:b.high,low:b.low,mid:(b.high+b.low)/2});
  }
  return obs;
}
function findFVGs(bars) {
  const bull=[];
  for (let i=2;i<bars.length;i++){
    if (bars[i].low>bars[i-2].high)
      bull.push({top:bars[i].low,bottom:bars[i-2].high,mid:(bars[i].low+bars[i-2].high)/2});
  }
  return bull;
}
function findSwings(bars, lb=5) {
  const highs=[],lows=[];
  for (let i=lb;i<bars.length-lb;i++){
    let isH=true,isL=true;
    for (let j=i-lb;j<=i+lb;j++){
      if(j===i)continue;
      if(bars[j].high>=bars[i].high)isH=false;
      if(bars[j].low<=bars[i].low)isL=false;
    }
    if(isH)highs.push({price:bars[i].high,idx:i});
    if(isL)lows.push({price:bars[i].low,idx:i});
  }
  return {highs,lows};
}
function detectStructure(bars, swingHighs) {
  const cur=bars[bars.length-1].close;
  let bos=null,choch=null;
  const recent=swingHighs.slice(-3);
  for (let i=recent.length-1;i>=0;i--){
    if(cur>recent[i].price){bos={level:recent[i].price,pct:((cur-recent[i].price)/recent[i].price*100).toFixed(2)};break;}
  }
  if(swingHighs.length>=3){
    const [a,b,c]=swingHighs.slice(-3);
    if(b.price<a.price&&c.price>b.price) choch={from:b.price.toFixed(2),to:c.price.toFixed(2)};
  }
  return {bos,choch};
}

// ─── TIMEFRAME ANALYSIS ───────────────────────────────────────────────────────
function analyzeWeekly(wBars) {
  if (!wBars||wBars.length<20) return {trend:'UNKNOWN',strength:0,posInRange:0.5,high52w:0,low52w:0};
  const closes=wBars.map(b=>b.close), highs=wBars.map(b=>b.high), lows=wBars.map(b=>b.low);
  const n=closes.length, cur=closes[n-1];
  const ema20w=ema(closes,20), ema50w=ema(closes,Math.min(50,n));
  const rH=Math.max(...highs.slice(-6)), pH=Math.max(...highs.slice(-12,-6));
  const rL=Math.min(...lows.slice(-6)),  pL=Math.min(...lows.slice(-12,-6));
  const hh=rH>pH, hl=rL>pL, lh=rH<pH, ll=rL<pL;
  const abv20=cur>ema20w, abv50=cur>ema50w;
  const high52w=Math.max(...highs.slice(-52)), low52w=Math.min(...lows.slice(-52));
  const posInRange=(high52w-low52w)>0?(cur-low52w)/(high52w-low52w):0.5;
  let trend,strength;
  if(hh&&hl&&abv20&&abv50){trend='STRONG_BULL';strength=3;}
  else if((hh||hl)&&abv20){trend='BULL';strength=2;}
  else if(abv50){trend='NEUTRAL_BULL';strength=1;}
  else if(ll&&lh){trend='BEAR';strength=-2;}
  else{trend='NEUTRAL';strength=0;}
  return {trend,strength,posInRange,high52w,low52w,ema20w,ema50w};
}

function analyzeDaily(dBars) {
  if (!dBars||dBars.length<60) return null;
  const closes=dBars.map(b=>b.close), vols=dBars.map(b=>b.volume||0);
  const n=closes.length, cur=closes[n-1];
  const rsiVal=rsi(closes);
  const ema20d=ema(closes.slice(-21),20), ema50d=ema(closes.slice(-51),50);
  const ema200d=n>=201?ema(closes.slice(-201),200):ema(closes,n);
  const atrD=atr(dBars);
  const bullOBs=findBullishOBs(dBars.slice(-120),0.025,4);
  const nearOBs=bullOBs.filter(ob=>{const d=cur-ob.mid;return d>=-atrD&&d<=atrD*3;});
  const fvgs=findFVGs(dBars.slice(-60));
  const nearFVGs=fvgs.filter(f=>cur>=f.bottom&&cur<=f.top*1.02);
  const {highs,lows}=findSwings(dBars.slice(-80),5);
  const {bos,choch}=detectStructure(dBars.slice(-80),highs);
  const avgVol=vols.slice(-25,-5).reduce((a,b)=>a+b,0)/20||1;
  const volSurge=(vols.slice(-5).reduce((a,b)=>a+b,0)/5)/avgVol;
  const ret5d=(closes[n-1]-closes[n-6])/closes[n-6]*100;
  const ret20d=(closes[n-1]-closes[n-21])/closes[n-21]*100;
  return {cur,rsiVal,ema20d,ema50d,ema200d,atrD,nearOBs,nearFVGs,bos,choch,volSurge,ret5d,ret20d,
    aboveEma20:cur>ema20d,aboveEma50:cur>ema50d,aboveEma200:cur>ema200d,emaStack:ema20d>ema50d&&ema50d>ema200d};
}

function analyze4H(h1Bars) {
  const def={rsi4h:50,trend4h:'NEUTRAL',nearOB4h:false,entry:null};
  if (!h1Bars||h1Bars.length<20) return def;
  // resample 1h -> 4h
  const bars4h=[];
  for (let i=0;i<h1Bars.length-3;i+=4){
    const s=h1Bars.slice(i,i+4); if(s.length<2)continue;
    bars4h.push({open:s[0].open,high:Math.max(...s.map(b=>b.high)),low:Math.min(...s.map(b=>b.low)),close:s[s.length-1].close,volume:s.reduce((a,b)=>a+(b.volume||0),0)});
  }
  if (bars4h.length<15) return def;
  const c4=bars4h.map(b=>b.close);
  const rsi4h=rsi(c4), atr4h=atr(bars4h), ema20_4h=ema(c4,Math.min(20,c4.length));
  const cur=c4[c4.length-1];
  const obs4h=findBullishOBs(bars4h,0.015,3);
  const nearOB4h=obs4h.some(ob=>Math.abs(cur-ob.mid)<=atr4h*2);
  const rec=bars4h.slice(-10);
  const rH=Math.max(...rec.slice(-5).map(b=>b.high)), pH=Math.max(...rec.slice(0,5).map(b=>b.high));
  const rL=Math.min(...rec.slice(-5).map(b=>b.low)),  pL=Math.min(...rec.slice(0,5).map(b=>b.low));
  let trend4h='NEUTRAL';
  if(rH>pH&&rL>pL)trend4h='BULL';
  else if(rH<pH&&rL<pL)trend4h='BEAR';
  let entry=null;
  if(trend4h==='BULL'&&rsi4h>=38&&rsi4h<=65&&(nearOB4h||cur>ema20_4h))entry='READY';
  else if(trend4h==='BULL'&&rsi4h<38)entry='WAIT';
  return {rsi4h,trend4h,nearOB4h,entry};
}

// ─── SCORE + GRADE ────────────────────────────────────────────────────────────
function scoreCombined(sym, weekly, daily, fourH) {
  if (!daily) return null;
  const signals=[],reasons=[];
  let score=0;
  const d=daily, w=weekly, f=fourH;

  // Weekly trend
  if(w.trend==='STRONG_BULL'){score+=5;signals.push('W_STRONG_BULL');reasons.push('🚀 Weekly: Strong uptrend — HH+HL above EMA 20+50');}
  else if(w.trend==='BULL'){score+=3;signals.push('W_BULL');reasons.push('📈 Weekly: Bullish structure');}
  else if(w.trend==='NEUTRAL_BULL'){score+=1;signals.push('W_NEUTRAL');reasons.push('📊 Weekly: Neutral-bullish (above EMA 50)');}
  else if(w.trend==='BEAR'){score-=2;signals.push('W_BEAR');reasons.push('📉 Weekly: Bearish — caution');}

  // Daily OBs
  if(d.nearOBs.length>=2){score+=4;signals.push('D_OB_STRONG');reasons.push(`🟢 Daily: ${d.nearOBs.length} stacked Demand OBs @ $${d.nearOBs[0].low.toFixed(2)}–$${d.nearOBs[0].high.toFixed(2)}`);}
  else if(d.nearOBs.length===1){score+=2;signals.push('D_OB');reasons.push(`🟩 Daily: Demand OB zone @ $${d.nearOBs[0].low.toFixed(2)}–$${d.nearOBs[0].high.toFixed(2)}`);}

  // FVG
  if(d.nearFVGs.length>0){score+=2;signals.push('D_FVG');reasons.push(`⬜ Daily: Bullish FVG being tested @ $${d.nearFVGs[0].bottom.toFixed(2)}–$${d.nearFVGs[0].top.toFixed(2)}`);}

  // BOS / CHoCH
  if(d.choch){score+=3;signals.push('D_CHOCH');reasons.push('🔄 Daily: Change of Character — trend reversal forming');}
  else if(d.bos){score+=2;signals.push('D_BOS');reasons.push(`💥 Daily: Break of Structure above $${d.bos.level.toFixed(2)} (+${d.bos.pct}%)`);}

  // RSI daily
  if(d.rsiVal>=35&&d.rsiVal<=55){score+=2;signals.push('D_RSI_BULL');reasons.push(`RSI-D ${d.rsiVal.toFixed(0)} — bullish zone, room to run`);}
  else if(d.rsiVal<35){score+=1;signals.push('D_RSI_OS');reasons.push(`RSI-D ${d.rsiVal.toFixed(0)} — oversold, reversal watch`);}
  else if(d.rsiVal>70){signals.push('D_RSI_OB');reasons.push(`RSI-D ${d.rsiVal.toFixed(0)} — overbought, extended`);}

  // EMA stack
  if(d.emaStack){score+=2;signals.push('D_EMA_BULL');reasons.push('EMA stack: 20 > 50 > 200 — full bull alignment');}
  else if(d.aboveEma200){score+=1;reasons.push('Above 200 EMA — long-term bullish');}

  // Volume
  if(d.volSurge>=1.5){score+=2;signals.push('D_VOL_SURGE');reasons.push(`🔊 Volume ${d.volSurge.toFixed(1)}x avg — institutional activity`);}
  else if(d.volSurge>=1.2){score+=1;signals.push('D_VOL');reasons.push(`Volume ${d.volSurge.toFixed(1)}x avg`);}

  // Discount zone (52W range position)
  const pos=w.posInRange;
  if(pos<=0.382){score+=3;signals.push('DISCOUNT_DEEP');reasons.push(`💎 Deep Discount — at ${(pos*100).toFixed(0)}% of 52W range (Golden Zone <38.2%)`);}
  else if(pos<=0.5){score+=2;signals.push('DISCOUNT');reasons.push(`💰 Discount — at ${(pos*100).toFixed(0)}% of 52W range (below midpoint)`);}
  else if(pos>=0.85){signals.push('PREMIUM');reasons.push(`Near 52W highs — ${(pos*100).toFixed(0)}% of range`);}

  // 4H entry
  if(f.entry==='READY'){score+=3;signals.push('4H_ENTRY');reasons.push(`⏱ 4H: Entry ready — ${f.trend4h} structure, RSI ${f.rsi4h.toFixed(0)}${f.nearOB4h?' + 4H OB support':''}`);}
  else if(f.trend4h==='BULL'){score+=1;signals.push('4H_BULL');reasons.push(`4H: Bullish structure, RSI ${f.rsi4h.toFixed(0)}`);}
  else if(f.entry==='WAIT'){reasons.push(`⏳ 4H: Pullback in progress — wait for bounce`);}

  // Momentum
  if(d.ret5d>0&&d.ret20d<-3){score+=2;signals.push('BOUNCE');reasons.push(`🔄 Bounce: +${d.ret5d.toFixed(1)}% week vs ${d.ret20d.toFixed(1)}% monthly`);}
  else if(d.ret5d>2){score+=1;reasons.push(`+${d.ret5d.toFixed(1)}% positive weekly momentum`);}

  const fundScore=FUND_SCORE[sym]||3;
  const total=score+fundScore;

  const mtfConfluence=
    (w.trend==='STRONG_BULL'||w.trend==='BULL')&&
    (signals.includes('D_OB')||signals.includes('D_OB_STRONG')||signals.includes('D_FVG')||signals.includes('D_CHOCH'))&&
    !signals.includes('W_BEAR');

  const isDiscountOB=
    (signals.includes('DISCOUNT')||signals.includes('DISCOUNT_DEEP'))&&
    (signals.includes('D_OB')||signals.includes('D_OB_STRONG')||signals.includes('D_FVG'));

  const swingGrade=(()=>{
    if(total>=20&&mtfConfluence)return 'A+';
    if(total>=16&&mtfConfluence)return 'A';
    if(total>=13)return 'B+';
    if(total>=10)return 'B';
    if(total>=7)return 'C';
    return 'D';
  })();

  return {
    sym, score, fundScore, totalScore:total, swingGrade, signals, reasons, mtfConfluence, isDiscountOB,
    curPrice:d.cur.toFixed(2), rsiD:d.rsiVal.toFixed(1), rsi4h:f.rsi4h.toFixed(1),
    weeklyTrend:w.trend, trend4h:f.trend4h, entry4h:f.entry,
    posInRange:(pos*100).toFixed(0),
    ret5d:d.ret5d.toFixed(1), ret20d:d.ret20d.toFixed(1),
    nearOBs:d.nearOBs.length, nearFVGs:d.nearFVGs.length,
    volSurge:d.volSurge.toFixed(2), aboveEma200:d.aboveEma200,
  };
}

// ─── DATA FETCH ───────────────────────────────────────────────────────────────
function fetchBars(sym, interval, days) {
  return new Promise((resolve) => {
    const now=Math.floor(Date.now()/1000), p1=now-days*24*3600;
    const url=`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&period1=${p1}&period2=${now}`;
    https.get(url,{headers:{'User-Agent':'Mozilla/5.0'}},(res)=>{
      let data='';
      res.on('data',d=>data+=d);
      res.on('end',()=>{
        try{
          const j=JSON.parse(data),r=j.chart?.result?.[0];
          if(!r)return resolve(null);
          const ts=r.timestamp,q=r.indicators.quote[0],adj=r.indicators.adjclose?.[0]?.adjclose;
          const bars=ts.map((t,i)=>({
            date:new Date(t*1000),open:q.open[i],high:q.high[i],low:q.low[i],
            close:(adj&&adj[i])?adj[i]:q.close[i],volume:q.volume[i]||0
          })).filter(b=>b.close&&b.close>0&&b.high&&b.low);
          resolve(bars);
        }catch(e){resolve(null);}
      });
    }).on('error',()=>resolve(null));
  });
}

// ─── EMAIL ────────────────────────────────────────────────────────────────────
function buildEmail(date, results, krishivList, vaishamList) {
  const sorted=[...results].sort((a,b)=>b.totalScore-a.totalScore);
  const swingTrades=sorted.filter(r=>r.swingGrade==='A+'||r.swingGrade==='A'||(r.swingGrade==='B+'&&r.mtfConfluence)).slice(0,8);
  const discountOB=[...sorted.filter(r=>r.isDiscountOB)].sort((a,b)=>parseInt(a.posInRange)-parseInt(b.posInRange));

  const medal=['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣'];

  function trendE(t){return t==='STRONG_BULL'?'🚀':t==='BULL'?'📈':t==='NEUTRAL_BULL'?'➡️':t==='BEAR'?'📉':'〰️';}
  function gradeColor(g){return g==='A+'?'#15803d':g==='A'?'#16a34a':g==='B+'?'#ca8a04':g==='B'?'#2563eb':'#94a3b8';}
  function wlLabel(sym){
    const k=krishivList.includes(sym),v=vaishamList.includes(sym);
    if(k&&v)return ' <span style="font-size:10px;color:#64748b">K+V</span>';
    if(k)return ' <span style="font-size:10px;color:#2563eb">K</span>';
    if(v)return ' <span style="font-size:10px;color:#7c3aed">V</span>';
    return '';
  }
  function badges(r){
    const b=[];
    if(r.signals.includes('D_OB_STRONG')||r.signals.includes('D_OB')) b.push(`<span style="background:#dcfce7;color:#166534;border-radius:3px;padding:1px 5px;font-size:10px">OB</span>`);
    if(r.signals.includes('D_FVG'))     b.push(`<span style="background:#dbeafe;color:#1e40af;border-radius:3px;padding:1px 5px;font-size:10px">FVG</span>`);
    if(r.signals.includes('D_CHOCH'))   b.push(`<span style="background:#f3e8ff;color:#6b21a8;border-radius:3px;padding:1px 5px;font-size:10px">CHoCH</span>`);
    if(r.signals.includes('D_BOS'))     b.push(`<span style="background:#ffedd5;color:#9a3412;border-radius:3px;padding:1px 5px;font-size:10px">BOS</span>`);
    if(r.signals.includes('DISCOUNT_DEEP')) b.push(`<span style="background:#fef9c3;color:#854d0e;border-radius:3px;padding:1px 5px;font-size:10px">💎DISC</span>`);
    else if(r.signals.includes('DISCOUNT')) b.push(`<span style="background:#fef3c7;color:#92400e;border-radius:3px;padding:1px 5px;font-size:10px">DISC</span>`);
    if(r.signals.includes('4H_ENTRY'))  b.push(`<span style="background:#ecfdf5;color:#065f46;border-radius:3px;padding:1px 5px;font-size:10px">⏱ENTRY</span>`);
    if(r.signals.includes('D_VOL_SURGE')) b.push(`<span style="background:#fff7ed;color:#9a3412;border-radius:3px;padding:1px 5px;font-size:10px">VOL↑</span>`);
    return b.join(' ');
  }
  function rowBg(r){
    if(r.swingGrade==='A+'||r.swingGrade==='A')return '#f0fdf4';
    if(r.swingGrade==='B+')return '#fefce8';
    if(r.swingGrade==='D')return '#fff1f2';
    return '#ffffff';
  }

  const swingRows=swingTrades.map((r,i)=>`
    <tr style="background:${i%2===0?'#f0fdf4':'#ffffff'}">
      <td style="padding:10px 12px;font-weight:700;font-size:14px">${medal[i]||'▪'} ${r.sym}${wlLabel(r.sym)}</td>
      <td style="padding:10px 12px;text-align:center;font-weight:600">$${r.curPrice}</td>
      <td style="padding:10px 12px;text-align:center">${trendE(r.weeklyTrend)} ${r.weeklyTrend.replace('_',' ')}</td>
      <td style="padding:10px 12px;text-align:center;font-size:12px">${r.rsiD} / ${r.rsi4h}</td>
      <td style="padding:10px 12px;text-align:center;color:#854d0e;font-weight:600">${r.posInRange}%</td>
      <td style="padding:10px 12px;text-align:center;color:${parseFloat(r.ret5d)>=0?'#16a34a':'#dc2626'};font-weight:600">${parseFloat(r.ret5d)>=0?'+':''}${r.ret5d}%</td>
      <td style="padding:10px 12px;text-align:center"><span style="background:${gradeColor(r.swingGrade)};color:white;border-radius:4px;padding:2px 8px;font-weight:700;font-size:13px">${r.swingGrade}</span></td>
      <td style="padding:10px 12px;text-align:center;font-weight:700;color:#1e3a5f">${r.totalScore}</td>
    </tr>
    <tr style="background:${i%2===0?'#f0fdf4':'#ffffff'}">
      <td colspan="8" style="padding:2px 12px 10px;color:#374151;font-size:11px;line-height:1.7">
        ${r.reasons.slice(0,5).map(x=>`• ${x}`).join('<br>')}
      </td>
    </tr>`).join('');

  const discountRows=discountOB.map((r,i)=>`
    <tr style="background:${i%2===0?'#fefce8':'#fffbeb'}">
      <td style="padding:9px 12px;font-weight:700;font-size:13px">💎 ${r.sym}${wlLabel(r.sym)}</td>
      <td style="padding:9px 12px;text-align:center;font-weight:600">$${r.curPrice}</td>
      <td style="padding:9px 12px;text-align:center;color:#92400e;font-weight:700">${r.posInRange}% of 52W</td>
      <td style="padding:9px 12px;text-align:center">${r.nearOBs} OBs${r.nearFVGs>0?` + ${r.nearFVGs} FVG`:''}</td>
      <td style="padding:9px 12px;text-align:center">${trendE(r.weeklyTrend)}</td>
      <td style="padding:9px 12px;text-align:center">${r.rsiD}</td>
      <td style="padding:9px 12px;text-align:center;color:${parseFloat(r.ret5d)>=0?'#16a34a':'#dc2626'};font-weight:600">${parseFloat(r.ret5d)>=0?'+':''}${r.ret5d}%</td>
      <td style="padding:9px 12px;text-align:center"><span style="background:${gradeColor(r.swingGrade)};color:white;border-radius:4px;padding:2px 7px;font-weight:700;font-size:12px">${r.swingGrade}</span></td>
    </tr>`).join('');

  const allRows=sorted.map(r=>`
    <tr style="background:${rowBg(r)}">
      <td style="padding:7px 10px;font-weight:700;font-size:12px">${r.sym}${wlLabel(r.sym)}</td>
      <td style="padding:7px 10px;text-align:center;font-size:12px">$${r.curPrice}</td>
      <td style="padding:7px 10px;text-align:center;font-size:12px">${trendE(r.weeklyTrend)}</td>
      <td style="padding:7px 10px;text-align:center;font-size:11px">${r.rsiD}</td>
      <td style="padding:7px 10px;text-align:center;font-size:11px">${r.rsi4h}</td>
      <td style="padding:7px 10px;text-align:center;font-size:11px;color:#854d0e">${r.posInRange}%</td>
      <td style="padding:7px 10px;text-align:center;font-size:11px;color:${parseFloat(r.ret5d)>=0?'#16a34a':'#dc2626'}">${parseFloat(r.ret5d)>=0?'+':''}${r.ret5d}%</td>
      <td style="padding:7px 10px;font-size:10px">${badges(r)}</td>
      <td style="padding:7px 10px;text-align:center"><span style="background:${gradeColor(r.swingGrade)};color:white;border-radius:3px;padding:1px 6px;font-size:11px;font-weight:700">${r.swingGrade}</span></td>
      <td style="padding:7px 10px;text-align:center;font-size:12px;font-weight:700;color:#334155">${r.totalScore}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;font-family:'Segoe UI',Arial,sans-serif;background:#f1f5f9">
<div style="max-width:920px;margin:0 auto;padding:20px">

  <div style="background:linear-gradient(135deg,#1e3a5f,#2563eb);border-radius:12px;padding:24px;margin-bottom:16px;color:white">
    <h1 style="margin:0;font-size:22px">📊 Morning Watchlist Scan — MTF LuxAlgo SMC</h1>
    <p style="margin:6px 0 0;opacity:.85;font-size:14px">${date} • krishiv + vaisham • ${results.length} stocks</p>
    <p style="margin:4px 0 0;opacity:.7;font-size:12px">Weekly Trend · Daily OB/FVG/BOS/CHoCH · 4H Entry · Discount Zones</p>
  </div>

  <div style="background:white;border-radius:10px;padding:13px 16px;margin-bottom:14px;font-size:11px;color:#374151;line-height:1.9;box-shadow:0 1px 3px rgba(0,0,0,.06)">
    <strong>Signals: </strong>
    <span style="background:#dcfce7;color:#166534;border-radius:3px;padding:1px 5px">OB</span> Demand Order Block &nbsp;
    <span style="background:#dbeafe;color:#1e40af;border-radius:3px;padding:1px 5px">FVG</span> Fair Value Gap &nbsp;
    <span style="background:#f3e8ff;color:#6b21a8;border-radius:3px;padding:1px 5px">CHoCH</span> Change of Character &nbsp;
    <span style="background:#ffedd5;color:#9a3412;border-radius:3px;padding:1px 5px">BOS</span> Break of Structure &nbsp;
    <span style="background:#fef9c3;color:#854d0e;border-radius:3px;padding:1px 5px">💎DISC</span> Deep Discount (&lt;38% of 52W) &nbsp;
    <span style="background:#ecfdf5;color:#065f46;border-radius:3px;padding:1px 5px">⏱ENTRY</span> 4H Entry Ready<br>
    <strong>Grade: </strong>A+ = Best MTF confluence &nbsp;| A = Strong setup &nbsp;| B+ = Good watch &nbsp;| B = Monitor &nbsp;| C/D = Skip &nbsp;&nbsp;
    <strong>52W%</strong> = position in 52-week range (&lt;50% = discount)
  </div>

  <!-- BEST SWING TRADES -->
  <div style="background:white;border-radius:12px;padding:20px;margin-bottom:14px;box-shadow:0 1px 4px rgba(0,0,0,.08)">
    <h2 style="margin:0 0 4px;font-size:17px;color:#1e3a5f">🏆 Best Swing Trade Setups</h2>
    <p style="margin:0 0 14px;font-size:12px;color:#64748b">Multi-timeframe confluence: Weekly uptrend + Daily OB/FVG/CHoCH + 4H entry aligned</p>
    ${swingTrades.length===0
      ? '<p style="color:#94a3b8;font-style:italic;padding:8px 0">No A/A+ grade setups today — market conditions not ideal for new swing entries.</p>'
      : `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#1e3a5f;color:white;font-size:12px">
        <th style="padding:9px 12px;text-align:left">Stock</th><th style="padding:9px 12px">Price</th>
        <th style="padding:9px 12px">Weekly Trend</th><th style="padding:9px 12px">RSI D/4H</th>
        <th style="padding:9px 12px">52W%</th><th style="padding:9px 12px">5D</th>
        <th style="padding:9px 12px">Grade</th><th style="padding:9px 12px">Score</th>
      </tr></thead><tbody>${swingRows}</tbody></table>`}
  </div>

  <!-- DISCOUNT ZONE + STRONG OB -->
  <div style="background:white;border-radius:12px;padding:20px;margin-bottom:14px;box-shadow:0 1px 4px rgba(0,0,0,.08)">
    <h2 style="margin:0 0 4px;font-size:17px;color:#92400e">💎 Discount Zone + Strong Order Block</h2>
    <p style="margin:0 0 14px;font-size:12px;color:#64748b">Stocks below 50% of 52W range sitting on demand OBs/FVGs — institutional value zones</p>
    ${discountOB.length===0
      ? '<p style="color:#94a3b8;font-style:italic;padding:8px 0">No stocks currently in discount zone with active order block support.</p>'
      : `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#92400e;color:white;font-size:12px">
        <th style="padding:9px 12px;text-align:left">Stock</th><th style="padding:9px 12px">Price</th>
        <th style="padding:9px 12px">52W Position</th><th style="padding:9px 12px">OBs/FVGs</th>
        <th style="padding:9px 12px">W.Trend</th><th style="padding:9px 12px">RSI-D</th>
        <th style="padding:9px 12px">5D</th><th style="padding:9px 12px">Grade</th>
      </tr></thead><tbody>${discountRows}</tbody></table>`}
  </div>

  <!-- FULL WATCHLIST -->
  <div style="background:white;border-radius:12px;padding:20px;margin-bottom:14px;box-shadow:0 1px 4px rgba(0,0,0,.08)">
    <h2 style="margin:0 0 4px;font-size:17px;color:#1e3a5f">📋 Full Watchlist — All ${results.length} Stocks</h2>
    <p style="margin:0 0 12px;font-size:11px;color:#64748b">K=Krishiv &nbsp;V=Vaisham &nbsp;K+V=Both &nbsp;| Sorted by score. 🟢Green=A/A+ &nbsp;🟡Yellow=B+ &nbsp;🔴Red=D</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      <thead><tr style="background:#334155;color:white;font-size:11px">
        <th style="padding:8px 10px;text-align:left">Symbol</th><th style="padding:8px 10px">Price</th>
        <th style="padding:8px 10px">W.Trend</th><th style="padding:8px 10px">RSI-D</th>
        <th style="padding:8px 10px">RSI-4H</th><th style="padding:8px 10px">52W%</th>
        <th style="padding:8px 10px">5D</th><th style="padding:8px 10px">Signals</th>
        <th style="padding:8px 10px">Grade</th><th style="padding:8px 10px">Score</th>
      </tr></thead>
      <tbody>${allRows}</tbody>
    </table>
  </div>

  <div style="background:#f8fafc;border-radius:10px;padding:13px 16px;font-size:11px;color:#64748b;line-height:1.7">
    <strong>Method:</strong> Weekly EMA 20/50 trend · Daily LuxAlgo SMC (OB/FVG/BOS/CHoCH) + RSI(14) + EMA 20/50/200 · 4H resampled from 1H data · Discount = below 50% of 52W range<br>
    ⚠️ <em>Not financial advice. Always do your own research before trading.</em>
  </div>
  <p style="text-align:center;font-size:11px;color:#94a3b8;margin-top:14px">
    📊 TV Morning Scanner v2 — Daily 8:00 AM IST via GitHub Actions • vaisham007@gmail.com
  </p>
</div></body></html>`;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const now=new Date();
  const date=now.toLocaleDateString('en-IN',{weekday:'long',year:'numeric',month:'long',day:'numeric',timeZone:'Asia/Kolkata'});
  const day=now.toLocaleDateString('en-US',{weekday:'short',timeZone:'Asia/Kolkata'});
  if(day==='Sat'||day==='Sun'){console.log('Weekend — no scan.');process.exit(0);}

  const allSymbols=[...new Set([...WATCHLISTS.krishiv,...WATCHLISTS.vaisham])];
  console.log(`\n📊 Morning Scan v2 — ${date}`);
  console.log(`   Timeframes: Weekly + Daily + 4H (resampled)`);
  console.log(`   LuxAlgo SMC: OB · FVG · BOS · CHoCH · Discount Zones`);
  console.log(`   Scanning ${allSymbols.length} symbols...\n`);

  const results=[];
  let done=0;
  for (const sym of allSymbols){
    process.stdout.write(`  [${++done}/${allSymbols.length}] ${sym.padEnd(8)} `);
    const [wBars,dBars,h1Bars]=await Promise.all([
      fetchBars(sym,'1wk',730),
      fetchBars(sym,'1d',500),
      fetchBars(sym,'1h',60),
    ]);
    const weekly=analyzeWeekly(wBars);
    const daily=analyzeDaily(dBars);
    const fourH=analyze4H(h1Bars);
    const result=scoreCombined(sym,weekly,daily,fourH);
    if(result){
      results.push(result);
      const flag=result.swingGrade==='A+'?'🟢':result.swingGrade==='A'?'🟩':result.swingGrade==='B+'?'🟡':'⚪';
      console.log(`${flag} ${result.weeklyTrend.padEnd(12)} RSI-D=${result.rsiD} 4H=${result.trend4h} 52W=${result.posInRange}% grade=${result.swingGrade} score=${result.totalScore}`);
    } else { console.log('⚠  no data'); }
    await new Promise(r=>setTimeout(r,400));
  }

  results.sort((a,b)=>b.totalScore-a.totalScore);
  const swingSetups=results.filter(r=>r.swingGrade==='A+'||r.swingGrade==='A');
  const discountOBs=results.filter(r=>r.isDiscountOB);
  console.log(`\n✅ Done. ${results.length} stocks analyzed`);
  console.log(`   A/A+ swing setups: ${swingSetups.length}`);
  console.log(`   Discount + OB: ${discountOBs.length}`);
  swingSetups.slice(0,5).forEach(r=>console.log(`   ${r.sym}: $${r.curPrice} ${r.weeklyTrend} RSI=${r.rsiD} 52W=${r.posInRange}% grade=${r.swingGrade}`));

  const html=buildEmail(date,results,WATCHLISTS.krishiv,WATCHLISTS.vaisham);
  const topNames=swingSetups.slice(0,3).map(r=>r.sym).join(', ')||results.slice(0,3).map(r=>r.sym).join(', ');
  const subject=`📊 Scan ${now.toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata'})} — ${swingSetups.length} A-grade setups | Top: ${topNames}`;
  const transporter=nodemailer.createTransport({service:'gmail',auth:{user:GMAIL_USER,pass:GMAIL_PASS}});
  await transporter.sendMail({from:`"📊 TV Morning Scan" <${GMAIL_USER}>`,to:ALERT_EMAIL,subject,html});
  console.log(`\n✅ Email sent → ${ALERT_EMAIL}`);
}

main().catch(e=>{console.error('Fatal:',e.message);process.exit(1);});
