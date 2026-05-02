const express = require("express");
const admin   = require("firebase-admin");
const axios   = require("axios");

const app = express();
app.use(express.json());

// ── Firebase Admin init ───────────────────────────────────────────────────
// On Render: set env var FIREBASE_SERVICE_ACCOUNT = contents of your JSON key
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: "tradealert-2602c",
});

const db = admin.firestore();
const messaging = admin.messaging();

console.log("Firebase initialized for project: tradealert-2602c");

// ── Price fetchers ────────────────────────────────────────────────────────

// Binance is geo-blocked on Render US servers (error 451)
// Use these working alternatives that return same Binance prices:
// - CoinGecko for crypto (free, no key, uses Binance data)
// - Metals-API alternative for XAU/XAG

// ── Coinbase API — works from Render, no geo-block, no rate limits ─────────
// Prices match Binance within cents for crypto, exact for metals

const COINBASE_MAP = {
  // Crypto
  BTCUSDT:"BTC-USD", ETHUSDT:"ETH-USD", BNBUSDT:"BNB-USD",
  SOLUSDT:"SOL-USD", XRPUSDT:"XRP-USD", ADAUSDT:"ADA-USD",
  DOGEUSDT:"DOGE-USD", AVAXUSDT:"AVAX-USD", DOTUSDT:"DOT-USD",
  MATICUSDT:"MATIC-USD", LINKUSDT:"LINK-USD", UNIUSDT:"UNI-USD",
  ATOMUSDT:"ATOM-USD", LTCUSDT:"LTC-USD", BCHUSDT:"BCH-USD",
  NEARUSDT:"NEAR-USD", ARBUSDT:"ARB-USD", OPUSDT:"OP-USD",
  SHIBUSDT:"SHIB-USD", TRXUSDT:"TRX-USD",
  // Metals — Coinbase has XAU/XAG spot prices
  XAUUSDT:"XAU-USD", XAGUSDT:"XAG-USD",
};

// App symbol → Coinbase product ID (for candle close)
const COINBASE_APP_MAP = {
  BTC:"BTC-USD", ETH:"ETH-USD", BNB:"BNB-USD", SOL:"SOL-USD",
  XRP:"XRP-USD", ADA:"ADA-USD", DOGE:"DOGE-USD", AVAX:"AVAX-USD",
  DOT:"DOT-USD", MATIC:"MATIC-USD", LINK:"LINK-USD", UNI:"UNI-USD",
  ATOM:"ATOM-USD", LTC:"LTC-USD", BCH:"BCH-USD", NEAR:"NEAR-USD",
  ARB:"ARB-USD", OP:"OP-USD", SHIB:"SHIB-USD", TRX:"TRX-USD",
  XAU:"XAU-USD", XAG:"XAG-USD",
};

// Coinbase granularity in seconds for each timeframe
const CB_GRANULARITY = { M1:60, M5:300, M15:900, H1:3600 };

async function getBinancePrice(symbol) {
  // Use Coinbase — same prices, no geo-block
  const cbSym = COINBASE_MAP[symbol];
  if (!cbSym) return 0;
  try {
    const r = await axios.get(
      `https://api.coinbase.com/v2/prices/${cbSym}/spot`,
      { timeout: 6000, headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const p = parseFloat(r.data?.data?.amount) || 0;
    if (p > 0) { console.log(`  [Coinbase] ${symbol} = ${p}`); return p; }
  } catch (e) { console.log(`  Coinbase failed for ${symbol}: ${e.message}`); }
  return 0;
}

async function getFuturesPrice(symbol) {
  // Metals use same Coinbase endpoint
  return getBinancePrice(symbol);
}

async function getCoinbaseLastClose(cbProductId, timeframe) {
  // Coinbase Advanced Trade candles API
  // GET /api/v3/brokerage/market/products/{product_id}/candles
  const granularity = CB_GRANULARITY[timeframe] || 300;
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = nowSec - granularity * 5; // last 5 candles

  try {
    const r = await axios.get(
      `https://api.coinbase.com/api/v3/brokerage/market/products/${cbProductId}/candles`,
      {
        params: { start: startSec, end: nowSec, granularity: `ONE_${getGranularityName(timeframe)}` },
        timeout: 8000,
        headers: { "User-Agent": "Mozilla/5.0" }
      }
    );
    const candles = r.data?.candles;
    if (!candles || candles.length < 2) return 0;
    // Candles sorted newest first — candles[0] may still be open
    // candles[1] = last completed candle
    const close = parseFloat(candles[1]?.close) || 0;
    console.log(`    [Coinbase candle] ${cbProductId} [${timeframe}] close=${close}`);
    return close;
  } catch (e) {
    console.log(`    Coinbase candle failed: ${e.message}`);
    return 0;
  }
}

function getGranularityName(tf) {
  switch(tf) { case"M1":return"MINUTE"; case"M5":return"FIVE_MINUTE"; case"M15":return"FIFTEEN_MINUTE"; case"H1":return"HOUR"; default:return"FIVE_MINUTE"; }
}

async function getYahooPrice(yahooSymbol) {
  // For indices: %5EGSPC, %5EDJI etc.
  try {
    const r = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1m&range=1d`,
      { timeout: 5000, headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const meta = r.data.chart.result[0].meta;
    return parseFloat(meta.regularMarketPrice) || 0;
  } catch { return 0; }
}

async function getTwelveDataPrice(symbol) {
  // For forex: EUR/USD, GBP/USD etc.
  try {
    const r = await axios.get(
      `https://api.twelvedata.com/price?apikey=99b51c33d39e42b0bde39e5162a70976&symbol=${symbol}`,
      { timeout: 5000 }
    );
    return parseFloat(r.data.price) || 0;
  } catch { return 0; }
}

// ── Symbol maps ───────────────────────────────────────────────────────────

const CRYPTO_SYMBOLS = {
  BTC:"BTCUSDT", ETH:"ETHUSDT", BNB:"BNBUSDT", SOL:"SOLUSDT",
  XRP:"XRPUSDT", ADA:"ADAUSDT", DOGE:"DOGEUSDT", AVAX:"AVAXUSDT",
  DOT:"DOTUSDT", MATIC:"MATICUSDT", LINK:"LINKUSDT", UNI:"UNIUSDT",
  ATOM:"ATOMUSDT", LTC:"LTCUSDT", BCH:"BCHUSDT", NEAR:"NEARUSDT",
  ARB:"ARBUSDT", OP:"OPUSDT", SHIB:"SHIBUSDT", TRX:"TRXUSDT"
};

const METAL_SYMBOLS = { XAU:"XAUUSDT", XAG:"XAGUSDT" };

const INDEX_SYMBOLS = {
  SPX500:"%5EGSPC", US30:"%5EDJI", US100:"%5EIXIC",
  DXY:"DX-Y.NYB", NIF50:"%5ENSEI"
};

const FOREX_SYMBOLS = {
  EURUSD:"EUR/USD", GBPUSD:"GBP/USD", USDJPY:"USD/JPY",
  GBPJPY:"GBP/JPY", AUDUSD:"AUD/USD", USDGBP:"USD/GBP"
};

async function fetchPrice(pairSymbol) {
  let price = 0;
  let source = "";
  try {
    if (METAL_SYMBOLS[pairSymbol]) {
      price = await getFuturesPrice(METAL_SYMBOLS[pairSymbol]);
      source = "Binance Futures";
    } else if (CRYPTO_SYMBOLS[pairSymbol]) {
      price = await getBinancePrice(CRYPTO_SYMBOLS[pairSymbol]);
      source = "Binance Spot";
    } else if (INDEX_SYMBOLS[pairSymbol]) {
      price = await getYahooPrice(INDEX_SYMBOLS[pairSymbol]);
      source = "Yahoo Finance";
    } else if (FOREX_SYMBOLS[pairSymbol]) {
      price = await getTwelveDataPrice(FOREX_SYMBOLS[pairSymbol]);
      source = "TwelveData";
    } else {
      console.log(`  ⚠️ Unknown pair: ${pairSymbol}`);
      return 0;
    }
    console.log(`  [${source}] ${pairSymbol} = ${price}`);
    return price;
  } catch (err) {
    console.error(`  fetchPrice error for ${pairSymbol}:`, err.message);
    return 0;
  }
}

// ── FCM sender ────────────────────────────────────────────────────────────

async function sendAlarmPush(fcmToken, alert, currentPrice) {
  const hitType = alert.candleClose
    ? `Candle Close · ${alert.timeframe}`
    : "Instant Hit";

  const message = {
    token: fcmToken,
    data: {
      type:           "PRICE_ALERT",
      alertId:        String(alert.id),
      pairSymbol:     String(alert.pairSymbol || ""),
      pairName:       String(alert.pairName || ""),
      pairEmoji:      String(alert.pairEmoji || ""),
      targetPrice:    String(alert.targetPrice),
      currentPrice:   String(currentPrice),
      direction:      String(alert.direction || ""),
      hitType:        hitType,
      isAlarm:        String(alert.alarm !== false),
      isSoundEnabled: String(alert.soundEnabled !== false),
      isVibration:    String(alert.vibrationEnabled !== false),
    },
    android: {
      priority: "high",
    },
  };

  console.log(`📤 Sending FCM to token: ${fcmToken.substring(0, 20)}...`);
  const response = await messaging.send(message);
  console.log(`✅ FCM sent successfully: ${response}`);
  return response;
}

// ── Main check logic ──────────────────────────────────────────────────────

async function checkAlerts() {
  const now = new Date();
  const nowMs = now.getTime();
  console.log(`\n========== CHECK at ${now.toISOString()} ==========`);

  let snapshot;
  try {
    snapshot = await db.collection("alerts").where("triggered", "==", false).get();
  } catch (err) { console.error("Firestore read failed:", err.message); return; }

  if (snapshot.empty) { console.log("No active alerts in Firestore."); return; }
  console.log(`Found ${snapshot.size} active alert(s)`);

  const instantAlerts = [];
  const candleAlerts  = [];
  snapshot.forEach(doc => {
    const alert = { id: doc.id, ...doc.data() };
    const type = alert.candleClose ? `candle_${alert.timeframe}` : "instant";
    console.log(`  Alert: ${alert.pairSymbol} target=${alert.targetPrice} dir=${alert.direction} type=${type}`);
    if (alert.candleClose) candleAlerts.push(alert);
    else instantAlerts.push(alert);
  });

  // ── Instant alerts ─────────────────────────────────────────────────────
  const instantByPair = {};
  for (const a of instantAlerts) {
    if (!instantByPair[a.pairSymbol]) instantByPair[a.pairSymbol] = [];
    instantByPair[a.pairSymbol].push(a);
  }
  for (const [pair, alerts] of Object.entries(instantByPair)) {
    const price = await fetchPrice(pair);
    console.log(`  [Instant] ${pair} = ${price}`);
    if (!price) { console.log(`  ⚠️ Could not fetch price for ${pair}`); continue; }
    for (const alert of alerts) {
      const hit = alert.direction === "above" ? price >= alert.targetPrice : price <= alert.targetPrice;
      console.log(`    ${pair}: price=${price} target=${alert.targetPrice} hit=${hit}`);
      if (hit) await triggerAlert(alert, price);
    }
  }

  // ── Candle close alerts ────────────────────────────────────────────────
  // Group by pair+timeframe, only check within 90s of candle boundary
  const candleGroups = {};
  for (const a of candleAlerts) {
    const key = `${a.pairSymbol}_${a.timeframe}`;
    if (!candleGroups[key]) candleGroups[key] = [];
    candleGroups[key].push(a);
  }

  for (const [key, alerts] of Object.entries(candleGroups)) {
    const [pair, tf] = key.split("_");
    const candleMs = getCandleMs(tf);
    const lastBoundary = Math.floor(nowMs / candleMs) * candleMs;
    const secondsAfter = (nowMs - lastBoundary) / 1000;
    console.log(`  [Candle ${tf}] ${pair}: ${secondsAfter.toFixed(0)}s after boundary`);

    if (secondsAfter > 90) {
      console.log(`    ⏳ Not within 90s of candle close — skipping`);
      continue;
    }

    const closePrice = await getLastCandleClose(pair, tf);
    console.log(`    Last closed candle: ${closePrice}`);
    if (!closePrice) continue;

    for (const alert of alerts) {
      const hit = alert.direction === "above" ? closePrice >= alert.targetPrice : closePrice <= alert.targetPrice;
      console.log(`    ${pair}[${tf}]: close=${closePrice} target=${alert.targetPrice} dir=${alert.direction} hit=${hit}`);
      if (hit) await triggerAlert(alert, closePrice);
    }
  }

  console.log(`========== CHECK DONE ==========\n`);
}

async function getLastCandleClose(pairSymbol, timeframe) {
  // Forex → TwelveData
  const forexMap = {
    EURUSD:"EUR/USD", GBPUSD:"GBP/USD", USDJPY:"USD/JPY",
    GBPJPY:"GBP/JPY", AUDUSD:"AUD/USD", USDGBP:"USD/GBP"
  };
  if (forexMap[pairSymbol]) return getTwelveDataLastClose(forexMap[pairSymbol], timeframe);

  // Indices → Yahoo Finance
  const indexYahoo = {
    SPX500:"%5EGSPC", US30:"%5EDJI", US100:"%5EIXIC",
    DXY:"DX-Y.NYB", NIF50:"%5ENSEI"
  };
  if (indexYahoo[pairSymbol]) return getYahooLastClose(indexYahoo[pairSymbol], timeframe);

  // Crypto + Metals → Coinbase candles
  const cbProduct = COINBASE_APP_MAP[pairSymbol];
  if (cbProduct) return getCoinbaseLastClose(cbProduct, timeframe);

  console.log(`    No candle source for ${pairSymbol}`);
  return 0;
}

async function getYahooLastClose(ySymbol, timeframe) {
  const yInterval = { M1:"1m", M5:"5m", M15:"15m", H1:"60m" }[timeframe] || "5m";
  try {
    const r = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ySymbol}?interval=${yInterval}&range=2d`,
      { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0)" } }
    );
    const result = r.data?.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close;
    const times  = result?.timestamp;
    if (!closes || !times) return 0;
    const nowSec    = Date.now() / 1000;
    const candleSec = getCandleMs(timeframe) / 1000;
    for (let i = times.length - 1; i >= 0; i--) {
      if (times[i] + candleSec <= nowSec && closes[i] != null) {
        console.log(`    [Yahoo kline] ${ySymbol} [${timeframe}] close=${closes[i]}`);
        return closes[i];
      }
    }
  } catch (e) { console.log(`    Yahoo kline failed: ${e.message}`); }
  return 0;
}

async function getTwelveDataLastClose(symbol, timeframe) {
  const intervalMap = { M1:"1min", M5:"5min", M15:"15min", H1:"1h" };
  const interval = intervalMap[timeframe] || "5min";
  try {
    const r = await axios.get(
      `https://api.twelvedata.com/time_series?apikey=99b51c33d39e42b0bde39e5162a70976&symbol=${symbol}&interval=${interval}&outputsize=3`,
      { timeout: 8000 }
    );
    const values = r.data?.values;
    if (!values || values.length < 2) return 0;
    const close = parseFloat(values[1]?.close) || 0;
    console.log(`    TwelveData candle [${timeframe}]: ${close}`);
    return close;
  } catch (e) { console.log(`    TwelveData candle failed: ${e.message}`); return 0; }
}

async function triggerAlert(alert, price) {
  console.log(`  🎯 HIT: ${alert.pairSymbol} price=${price} target=${alert.targetPrice}`);
  try {
    await db.collection("alerts").doc(alert.id).update({ triggered:true, hitAt:Date.now(), hitPrice:price });
    console.log(`  ✅ Marked triggered`);
    let fcmToken = null;
    const userDoc = await db.collection("users").doc(alert.userId).get();
    if (userDoc.exists) { fcmToken = userDoc.data().fcmToken; }
    else {
      const all = await db.collection("users").limit(1).get();
      if (!all.empty) fcmToken = all.docs[0].data().fcmToken;
    }
    if (!fcmToken) { console.log(`  ❌ No FCM token`); return; }
    await sendAlarmPush(fcmToken, alert, price);
  } catch (err) { console.error(`  ❌ triggerAlert error:`, err.message); }
}

function getCandleMs(tf) {
  switch(tf) { case"M1":return 60000; case"M5":return 300000; case"M15":return 900000; case"H1":return 3600000; default:return 300000; }
}
function getYahooInterval(tf) {
  switch(tf) { case"M1":return"1m"; case"M5":return"5m"; case"M15":return"15m"; case"H1":return"60m"; default:return"5m"; }
}


// ── Routes ────────────────────────────────────────────────────────────────

// cron-job.org hits this every minute
app.get("/check", async (req, res) => {
  console.log(`\n🔔 /check called at ${new Date().toISOString()} from ${req.ip}`);
  try {
    await checkAlerts();
    res.json({ ok: true, time: new Date().toISOString() });
  } catch (err) {
    console.error("Check error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Log every incoming request
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} from ${req.ip}`);
  next();
});

// Health check — also runs alert check so ANY ping triggers it
// This way even if cron-job.org hits "/" instead of "/check" it still works
app.get("/", async (req, res) => {
  console.log(`Root ping — running check...`);
  try {
    await checkAlerts();
    res.json({ status: "ok", time: new Date().toISOString() });
  } catch (err) {
    res.json({ status: "error", error: err.message });
  }
});

// Manual test endpoint — call this to send a test FCM push
// Usage: https://your-render-url.onrender.com/test?token=YOUR_FCM_TOKEN
app.get("/test", async (req, res) => {
  const token = req.query.token;
  if (!token) {
    // Auto-find first user token from Firestore
    try {
      const users = await db.collection("users").limit(1).get();
      if (users.empty) return res.json({ error: "No users found in Firestore" });
      const fcmToken = users.docs[0].data().fcmToken;
      const userId   = users.docs[0].id;
      console.log(`Test: found user ${userId}, token: ${fcmToken.substring(0,20)}...`);
      await messaging.send({
        token: fcmToken,
        data: {
          type:         "PRICE_ALERT",
          alertId:      "test-123",
          pairSymbol:   "BTC",
          pairName:     "Bitcoin",
          pairEmoji:    "₿",
          targetPrice:  "50000",
          currentPrice: "50001",
          direction:    "above",
          hitType:      "Instant Hit",
          isAlarm:      "true",
          isSoundEnabled: "true",
          isVibration:  "true",
        },
        android: { priority: "high" },
      });
      return res.json({ ok: true, message: "Test FCM sent!", userId, tokenPreview: fcmToken.substring(0,20) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
});

// Show current active alerts in Firestore
app.get("/status", async (req, res) => {
  try {
    const alerts = await db.collection("alerts").where("triggered", "==", false).get();
    const users  = await db.collection("users").get();
    const data = [];
    alerts.forEach(doc => data.push({ id: doc.id, ...doc.data() }));
    const userCount = users.size;
    res.json({ activeAlerts: data.length, userCount, alerts: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
