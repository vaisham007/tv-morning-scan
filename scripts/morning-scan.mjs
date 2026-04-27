#!/usr/bin/env node
/**
 * TV Morning Watchlist Scanner
 * Runs daily via GitHub Actions at 8:00 AM IST (2:30 AM UTC)
 * Scans krishiv + vaisham watchlists — all 50 stocks
 * Sends full report to vaisham007@gmail.com
 */

import https    from 'https';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const nodemailer = require('nodemailer');

// ─── CREDENTIALS (from GitHub Secrets / env vars) ────────────────────────────
const GMAIL_USER     = process.env.GMAIL_USER;
const GMAIL_PASS     = process.env.GMAIL_APP_PASSWORD;
const ALERT_EMAIL    = process.env.ALERT_EMAIL || GMAIL_USER;

if (!GMAIL_USER || !GMAIL_PASS) {
  console.error('❌ Missing GMAIL_USER or GMAIL_APP_PASSWORD env vars');
  process.exit(1);
}

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

// ─── FUNDAMENTAL QUALITY (1-5) ────────────────────────────────────────────────
const FUND_SCORE = {
  MSFT:5,AAPL:5,NVDA:5,AMZN:5,GOOGL:5,META:5,AVGO:5,V:5,MA:5,
  SPGI:5,BLK:5,ISRG:5,NOW:5,COST:5,INTU:5,
  JPM:4,BKNG:4,GS:4,ACN:4,LOW:4,HD:4,TXN:4,AXP:4,
  TSLA:4,CRM:4,ORCL:4,AMD:4,WMT:4,PG:4,UNH:4,ABT:4,
  'BRK-B':4,CAT:4,MS:4,
  IBM:3,CSCO:3,KO:3,BAC:3,WFC:3,NEE:3,GE:3,HON:3,LIN:3,XOM:3,CVX:3,
  RTX:3,NFLX:3,UBER:3,MCD:3,T:2,
};

// ─── TECHNICAL HELPERS ────────────────────────────────────────────────────────
function ema(data, period) {
  const k = 2 / (period + 1); let e = data[0];
  for (let i = 1; i < data.length; i++) e = data[i] * k + e * (1 - k);
  return e;
}
function rsi(closes, period = 14) {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i]-closes[i-1]; d>0?gains+=d:losses-=d; }
  let ag = gains/period, al = losses/period;
  for (let i = period+1; i < closes.length; i++) {
    const d = closes[i]-closes[i-1];
    ag = (ag*(period-1)+(d>0?d:0))/period;
    al = (al*(period-1)+(d<0?-d:0))/period;
  }
  return al===0 ? 100 : 100 - 100/(1+ag/al);
}
function atr(bars, period = 14) {
  let sum = 0;
  const start = Math.max(1, bars.length-period);
  for (let i = start; i < bars.length; i++) {
    sum += Math.max(bars[i].high-bars[i].low, Math.abs(bars[i].high-bars[i-1].close), Math.abs(bars[i].low-bars[i-1].close));
  }
  return sum/period;
}
function findBullishOBs(bars, thresh=0.025, lookback=3) {
  const obs = [];
  for (let i = 2; i < bars.length-lookback; i++) {
    const b = bars[i];
    if (b.close >= b.open) continue;
    const maxClose = Math.max(...bars.slice(i+1,i+1+lookback).map(x=>x.close));
    if ((maxClose-b.low)/b.low >= thresh) {
      const prev = bars[i-1];
      const prevMax = Math.max(...bars.slice(i,i+lookback).map(x=>x.close));
      if (!(prev.close < prev.open && (prevMax-prev.low)/prev.low >= thresh))
        obs.push({ high:b.high, low:b.low, mid:(b.high+b.low)/2 });
    }
  }
  return obs;
}
function findSwingLows(bars, lookback=5) {
  const swings = [];
  for (let i = lookback; i < bars.length-lookback; i++) {
    const low = bars[i].low; let isSwing = true;
    for (let j = i-lookback; j <= i+lookback; j++) { if(j!==i && bars[j].low<=low){isSwing=false;break;} }
    if (isSwing) swings.push({ price: low });
  }
  return swings;
}

// ─── ANALYSIS ENGINE ──────────────────────────────────────────────────────────
function analyze(sym, bars) {
  if (!bars || bars.length < 60) return null;
  const closes = bars.map(b=>b.close), highs=bars.map(b=>b.high), lows=bars.map(b=>b.low), vols=bars.map(b=>b.volume||0);
  const n = closes.length, curPrice=closes[n-1];
  const atrVal=atr(bars), rsiVal=rsi(closes);
  const ema20val=ema(closes.slice(-21),20), ema50val=ema(closes.slice(-51),50);
  const ema200val=n>=201?ema(closes.slice(-201),200):ema(closes,n);
  const recent20High=Math.max(...highs.slice(-20)), recent20Low=Math.min(...lows.slice(-20));
  const prev20High=Math.max(...highs.slice(-40,-20)), prev20Low=Math.min(...lows.slice(-40,-20));
  const bullOBs=findBullishOBs(bars.slice(-100));
  const swingLows=findSwingLows(bars.slice(-60));
  const nearOBs=bullOBs.filter(ob=>{const d=curPrice-ob.mid;return d>=-atrVal&&d<=atrVal*3;});
  const nearSwings=swingLows.filter(sw=>{const d=curPrice-sw.price;return d>=0&&d<=atrVal*2.5;});
  const aboveEma20=curPrice>ema20val, aboveEma50=curPrice>ema50val, aboveEma200=curPrice>ema200val;
  const ema20Above50=ema20val>ema50val, higherHighs=recent20High>prev20High, higherLows=recent20Low>prev20Low;
  const avgVol=vols.slice(-25,-5).reduce((a,b)=>a+b,0)/20||1;
  const recentVol=vols.slice(-5).reduce((a,b)=>a+b,0)/5;
  const volSurge=recentVol/avgVol;
  const high52w=Math.max(...highs.slice(-252));
  const pullbackPct=(high52w-curPrice)/high52w*100;
  const ret5d=(closes[n-1]-closes[n-6])/closes[n-6]*100;
  const ret20d=(closes[n-1]-closes[n-21])/closes[n-21]*100;

  let score=0; const reasons=[], signals=[];
  if(rsiVal>=35&&rsiVal<=58){score+=2;reasons.push(`RSI ${rsiVal.toFixed(0)} — bullish zone, room to run`);signals.push('RSI_BULL');}
  else if(rsiVal<35){score+=1;reasons.push(`RSI ${rsiVal.toFixed(0)} — oversold, reversal watch`);signals.push('RSI_OS');}
  if(nearOBs.length>0){score+=3;reasons.push(`🟢 Demand OB @ $${nearOBs[0].mid.toFixed(2)} (${nearOBs.length} OBs stacked)`);signals.push('OB_SUPPORT');}
  if(nearSwings.length>0){score+=2;reasons.push(`📍 Swing low support @ $${nearSwings[0].price.toFixed(2)}`);signals.push('SWING_SUPPORT');}
  if(higherHighs&&higherLows){score+=2;reasons.push('📈 Higher highs + higher lows — uptrend intact');signals.push('UPTREND');}
  else if(higherLows){score+=1;reasons.push('Higher lows forming — basing');signals.push('BASING');}
  if(aboveEma200){score+=1;reasons.push('Above 200 EMA (long-term bull)');}
  if(aboveEma50){score+=1;reasons.push('Above 50 EMA');}
  if(ema20Above50&&aboveEma20){score+=1;reasons.push('EMA bullish stack: 20 > 50');}
  if(pullbackPct>=5&&pullbackPct<=20){score+=2;reasons.push(`${pullbackPct.toFixed(1)}% healthy pullback — buy zone`);signals.push('PULLBACK');}
  else if(pullbackPct>20&&pullbackPct<=35){score+=1;reasons.push(`${pullbackPct.toFixed(1)}% deeper pullback`);}
  if(ret5d>0&&ret20d<0){score+=2;reasons.push(`🔄 Bounce: +${ret5d.toFixed(1)}% wk vs ${ret20d.toFixed(1)}% monthly`);signals.push('BOUNCING');}
  else if(ret5d>0){score+=1;reasons.push(`+${ret5d.toFixed(1)}% positive weekly momentum`);}
  if(volSurge>=1.3){score+=1;reasons.push(`🔊 Volume ${volSurge.toFixed(1)}x avg — institutional interest`);signals.push('VOL_SURGE');}

  const fundScore=FUND_SCORE[sym]||3;
  return { sym, score, fundScore, totalScore:score+fundScore,
    curPrice:curPrice.toFixed(2), rsi:rsiVal.toFixed(1),
    aboveEma50, aboveEma200, pullbackPct:pullbackPct.toFixed(1),
    ret5d:ret5d.toFixed(1), ret20d:ret20d.toFixed(1),
    nearOBs:nearOBs.length, nearSwings:nearSwings.length,
    volSurge:volSurge.toFixed(2), signals, reasons };
}

// ─── DATA FETCH (Yahoo Finance v8) ────────────────────────────────────────────
function fetchBars(sym) {
  return new Promise((resolve) => {
    const now=Math.floor(Date.now()/1000), year_ago=now-400*24*3600;
    const url=`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&period1=${year_ago}&period2=${now}`;
    https.get(url,{headers:{'User-Agent':'Mozilla/5.0'}},(res)=>{
      let data='';
      res.on('data',d=>data+=d);
      res.on('end',()=>{
        try {
          const j=JSON.parse(data), r=j.chart?.result?.[0];
          if(!r) return resolve(null);
          const ts=r.timestamp, q=r.indicators.quote[0], adj=r.indicators.adjclose?.[0]?.adjclose;
          const bars=ts.map((t,i)=>({
            date:new Date(t*1000),open:q.open[i],high:q.high[i],low:q.low[i],
            close:(adj&&adj[i])?adj[i]:q.close[i],volume:q.volume[i]||0
          })).filter(b=>b.close&&b.close>0&&b.high&&b.low);
          resolve(bars);
        } catch(e){resolve(null);}
      });
    }).on('error',()=>resolve(null));
  });
}

// ─── EMAIL HTML ───────────────────────────────────────────────────────────────
function buildEmail(date, allResults) {
  const sorted=[...allResults].sort((a,b)=>b.totalScore-a.totalScore);
  const topPicks=sorted.filter(r=>r.signals.includes('OB_SUPPORT')).slice(0,5);
  const medal=['🥇','🥈','🥉','4️⃣','5️⃣'];

  const pickRows=topPicks.map((r,i)=>`
    <tr style="background:${i%2===0?'#f0fdf4':'#ffffff'}">
      <td style="padding:10px 14px;font-weight:700;font-size:15px">${medal[i]||'▪'} ${r.sym}</td>
      <td style="padding:10px 14px;text-align:center;font-weight:600">$${r.curPrice}</td>
      <td style="padding:10px 14px;text-align:center">${r.rsi}</td>
      <td style="padding:10px 14px;text-align:center">${r.nearOBs}</td>
      <td style="padding:10px 14px;text-align:center;color:${parseFloat(r.ret5d)>=0?'#16a34a':'#dc2626'};font-weight:600">${parseFloat(r.ret5d)>=0?'+':''}${r.ret5d}%</td>
      <td style="padding:10px 14px;text-align:center">${r.pullbackPct}%</td>
      <td style="padding:10px 14px;text-align:center;font-weight:700;color:#1e3a5f">${r.totalScore}/20</td>
    </tr>
    <tr style="background:${i%2===0?'#f0fdf4':'#ffffff'}">
      <td colspan="7" style="padding:2px 14px 10px;color:#374151;font-size:12px;line-height:1.6">
        ${r.reasons.map(x=>`• ${x}`).join('<br>')}
      </td>
    </tr>`).join('');

  function rowBg(r){
    if(r.totalScore>=15&&r.signals.includes('OB_SUPPORT')) return '#f0fdf4';
    if(r.totalScore>=12&&r.signals.includes('OB_SUPPORT')) return '#fefce8';
    if(r.totalScore<9) return '#fff1f2';
    return '#ffffff';
  }
  function scoreColor(s){return s>=15?'#16a34a':s>=12?'#ca8a04':s>=9?'#2563eb':'#dc2626';}
  function obBadge(n){
    if(n>=7) return `<span style="background:#16a34a;color:white;border-radius:4px;padding:1px 6px;font-size:11px">${n} OBs</span>`;
    if(n>=3) return `<span style="background:#ca8a04;color:white;border-radius:4px;padding:1px 6px;font-size:11px">${n} OBs</span>`;
    return `<span style="color:#94a3b8;font-size:12px">${n} OBs</span>`;
  }
  function badges(r){
    const b=[];
    if(r.signals.includes('OB_SUPPORT'))  b.push(`<span style="background:#dcfce7;color:#166534;border-radius:3px;padding:1px 5px;font-size:10px;margin-right:2px">OB</span>`);
    if(r.signals.includes('UPTREND'))     b.push(`<span style="background:#dbeafe;color:#1e40af;border-radius:3px;padding:1px 5px;font-size:10px;margin-right:2px">↗TREND</span>`);
    if(r.signals.includes('BOUNCING'))    b.push(`<span style="background:#fef9c3;color:#854d0e;border-radius:3px;padding:1px 5px;font-size:10px;margin-right:2px">BOUNCE</span>`);
    if(r.signals.includes('PULLBACK'))    b.push(`<span style="background:#f3e8ff;color:#6b21a8;border-radius:3px;padding:1px 5px;font-size:10px;margin-right:2px">PULL</span>`);
    if(r.signals.includes('VOL_SURGE'))   b.push(`<span style="background:#ffedd5;color:#9a3412;border-radius:3px;padding:1px 5px;font-size:10px;margin-right:2px">VOL↑</span>`);
    if(r.signals.includes('RSI_OS'))      b.push(`<span style="background:#fee2e2;color:#991b1b;border-radius:3px;padding:1px 5px;font-size:10px;margin-right:2px">OS</span>`);
    return b.join('');
  }

  const allRows=sorted.map(r=>`
    <tr style="background:${rowBg(r)}">
      <td style="padding:8px 12px;font-weight:700;font-size:13px">${r.sym}</td>
      <td style="padding:8px 12px;text-align:center;font-size:13px">$${r.curPrice}</td>
      <td style="padding:8px 12px;text-align:center;font-size:13px">${r.rsi}</td>
      <td style="padding:8px 12px;text-align:center">${obBadge(r.nearOBs)}</td>
      <td style="padding:8px 12px;text-align:center;color:${parseFloat(r.ret5d)>=0?'#16a34a':'#dc2626'};font-weight:600;font-size:13px">${parseFloat(r.ret5d)>=0?'+':''}${r.ret5d}%</td>
      <td style="padding:8px 12px;text-align:center;color:${parseFloat(r.ret20d)>=0?'#16a34a':'#dc2626'};font-size:13px">${parseFloat(r.ret20d)>=0?'+':''}${r.ret20d}%</td>
      <td style="padding:8px 12px;text-align:center;font-size:12px">${r.pullbackPct}%</td>
      <td style="padding:8px 12px;text-align:center">${badges(r)}</td>
      <td style="padding:8px 12px;text-align:center;font-weight:700;color:${scoreColor(r.totalScore)};font-size:13px">${r.totalScore}/20</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;font-family:'Segoe UI',Arial,sans-serif;background:#f1f5f9">
<div style="max-width:780px;margin:0 auto;padding:20px">
  <div style="background:linear-gradient(135deg,#1e3a5f,#2563eb);border-radius:12px;padding:24px;margin-bottom:20px;color:white">
    <h1 style="margin:0;font-size:22px">📊 Morning Watchlist Scan</h1>
    <p style="margin:6px 0 0;opacity:.85;font-size:14px">${date} • krishiv + vaisham • ${allResults.length} stocks</p>
    <p style="margin:6px 0 0;opacity:.7;font-size:12px">Order Blocks · Demand Zones · EMA Stack · RSI · Uptrend Structure</p>
  </div>
  <div style="background:white;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.08)">
    <h2 style="margin:0 0 16px;font-size:17px;color:#1e3a5f">🏆 Top 5 — Best Setups Today</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">
      <thead><tr style="background:#1e3a5f;color:white">
        <th style="padding:10px 14px;text-align:left">Stock</th><th style="padding:10px 14px">Price</th>
        <th style="padding:10px 14px">RSI</th><th style="padding:10px 14px">OBs</th>
        <th style="padding:10px 14px">5D</th><th style="padding:10px 14px">Pull%</th><th style="padding:10px 14px">Score</th>
      </tr></thead>
      <tbody>${pickRows}</tbody>
    </table>
  </div>
  <div style="background:white;border-radius:12px;padding:20px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.08)">
    <h2 style="margin:0 0 6px;font-size:17px;color:#1e3a5f">📋 Full Watchlist — All ${allResults.length} Stocks</h2>
    <p style="margin:0 0 14px;font-size:12px;color:#64748b">🟢 Green = Strong &nbsp;|&nbsp; 🟡 Yellow = Good &nbsp;|&nbsp; 🔴 Red = Weak</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#334155;color:white">
        <th style="padding:9px 12px;text-align:left">Symbol</th><th style="padding:9px 12px">Price</th>
        <th style="padding:9px 12px">RSI</th><th style="padding:9px 12px">Demand OBs</th>
        <th style="padding:9px 12px">5D</th><th style="padding:9px 12px">20D</th>
        <th style="padding:9px 12px">Off High</th><th style="padding:9px 12px">Signals</th><th style="padding:9px 12px">Score</th>
      </tr></thead>
      <tbody>${allRows}</tbody>
    </table>
  </div>
  <div style="background:#f8fafc;border-radius:10px;padding:14px 18px;font-size:12px;color:#64748b;line-height:1.7">
    <strong>Score</strong> = Technical (max 15) + Fundamental (max 5) &nbsp;|&nbsp;
    <strong>OB</strong> = Order Block demand zone near price &nbsp;|&nbsp;
    <strong>BOUNCE</strong> = Green week after red month<br>
    ⚠️ <em>Not financial advice. Do your own research before trading.</em>
  </div>
  <p style="text-align:center;font-size:11px;color:#94a3b8;margin-top:16px">
    📊 TradingView Morning Scanner • Daily 8:00 AM IST via GitHub Actions • vaisham007@gmail.com
  </p>
</div></body></html>`;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const now  = new Date();
  const date = now.toLocaleDateString('en-IN',{weekday:'long',year:'numeric',month:'long',day:'numeric',timeZone:'Asia/Kolkata'});
  const day  = now.toLocaleDateString('en-US',{weekday:'short',timeZone:'Asia/Kolkata'});

  if (day==='Sat'||day==='Sun') { console.log('Weekend — no scan.'); process.exit(0); }

  const allSymbols=[...new Set([...WATCHLISTS.krishiv,...WATCHLISTS.vaisham])];
  console.log(`\n📊 Morning Scan — ${date}`);
  console.log(`   Scanning ${allSymbols.length} symbols from krishiv + vaisham...\n`);

  const results=[]; let done=0;
  for(const sym of allSymbols){
    process.stdout.write(`  [${++done}/${allSymbols.length}] ${sym.padEnd(8)}`);
    const bars=await fetchBars(sym);
    const analysis=analyze(sym,bars);
    if(analysis){
      results.push(analysis);
      const flag=analysis.signals.includes('OB_SUPPORT')?'🟢':'⚪';
      console.log(`${flag} score=${analysis.totalScore} RSI=${analysis.rsi} OBs=${analysis.nearOBs} pull=${analysis.pullbackPct}%`);
    } else { console.log('⚠  no data'); }
    await new Promise(r=>setTimeout(r,300));
  }

  results.sort((a,b)=>b.totalScore-a.totalScore);
  const topPicks=results.filter(r=>r.signals.includes('OB_SUPPORT'));
  console.log(`\n✅ Done. Top setups: ${topPicks.length}`);
  topPicks.slice(0,5).forEach(r=>console.log(`   ${r.sym}: $${r.curPrice} RSI=${r.rsi} OBs=${r.nearOBs} score=${r.totalScore}`));

  const html    = buildEmail(date, results);
  const subject = `📊 Morning Scan ${now.toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata'})} — Top: ${topPicks.slice(0,3).map(r=>r.sym).join(', ')}`;

  const transporter = nodemailer.createTransport({ service:'gmail', auth:{ user:GMAIL_USER, pass:GMAIL_PASS } });
  await transporter.sendMail({ from:`"📊 TV Morning Scan" <${GMAIL_USER}>`, to:ALERT_EMAIL, subject, html });
  console.log(`\n✅ Email sent to: ${ALERT_EMAIL}`);
}

main().catch(e=>{ console.error('Fatal:', e.message); process.exit(1); });
