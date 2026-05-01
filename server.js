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
});

const db = admin.firestore();

// ── Price fetchers ────────────────────────────────────────────────────────

async function getBinancePrice(symbol) {
  // symbol = "BTCUSDT", "XAUUSDT" etc.
  try {
    const r = await axios.get(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
      { timeout: 5000 }
    );
    return parseFloat(r.data.price);
  } catch { return 0; }
}

async function getFuturesPrice(symbol) {
  // For metals: XAUUSDT, XAGUSDT
  try {
    const r = await axios.get(
      `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`,
      { timeout: 5000 }
    );
    return parseFloat(r.data.price);
  } catch { return 0; }
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
  if (METAL_SYMBOLS[pairSymbol])  return getFuturesPrice(METAL_SYMBOLS[pairSymbol]);
  if (CRYPTO_SYMBOLS[pairSymbol]) return getBinancePrice(CRYPTO_SYMBOLS[pairSymbol]);
  if (INDEX_SYMBOLS[pairSymbol])  return getYahooPrice(INDEX_SYMBOLS[pairSymbol]);
  if (FOREX_SYMBOLS[pairSymbol])  return getTwelveDataPrice(FOREX_SYMBOLS[pairSymbol]);
  return 0;
}

// ── FCM sender ────────────────────────────────────────────────────────────

async function sendAlarmPush(fcmToken, alert, currentPrice) {
  const hitType = alert.candleClose
    ? `Candle Close · ${alert.timeframe}`
    : "Instant Hit";

  const message = {
    token: fcmToken,
    data: {
      // data-only message so app can handle it even when killed
      type:          "PRICE_ALERT",
      alertId:       alert.id,
      pairSymbol:    alert.pairSymbol,
      pairName:      alert.pairName,
      pairEmoji:     alert.pairEmoji || "",
      targetPrice:   String(alert.targetPrice),
      currentPrice:  String(currentPrice),
      direction:     alert.direction,
      hitType:       hitType,
      isAlarm:       String(alert.alarm !== false),
      isSoundEnabled:String(alert.soundEnabled !== false),
      isVibration:   String(alert.vibrationEnabled !== false),
    },
    android: {
      priority: "high",   // wakes device even in Doze mode
    },
  };

  await admin.messaging().send(message);
  console.log(`✅ FCM sent: ${alert.pairSymbol} → ${currentPrice}`);
}

// ── Main check logic ──────────────────────────────────────────────────────

async function checkAlerts() {
  console.log(`[${new Date().toISOString()}] Checking alerts...`);

  // Load all active alerts from Firestore
  const snapshot = await db.collection("alerts")
    .where("triggered", "==", false)
    .get();

  if (snapshot.empty) {
    console.log("No active alerts.");
    return;
  }

  // Group by pairSymbol to avoid fetching same price multiple times
  const alertsByPair = {};
  snapshot.forEach(doc => {
    const alert = { id: doc.id, ...doc.data() };
    if (!alertsByPair[alert.pairSymbol]) alertsByPair[alert.pairSymbol] = [];
    alertsByPair[alert.pairSymbol].push(alert);
  });

  // Fetch prices and check each alert
  const promises = Object.entries(alertsByPair).map(async ([pair, alerts]) => {
    const price = await fetchPrice(pair);
    if (!price || price <= 0) return;

    for (const alert of alerts) {
      const hit = alert.direction === "above"
        ? price >= alert.targetPrice
        : price <= alert.targetPrice;

      if (!hit) continue;

      console.log(`🎯 HIT: ${pair} price=${price} target=${alert.targetPrice}`);

      try {
        // Mark as triggered in Firestore
        await db.collection("alerts").doc(alert.id).update({
          triggered: true,
          hitAt: Date.now(),
          hitPrice: price,
        });

        // Get user FCM token
        const userDoc = await db.collection("users").doc(alert.userId).get();
        if (!userDoc.exists) continue;
        const fcmToken = userDoc.data().fcmToken;
        if (!fcmToken) continue;

        // Send push notification
        await sendAlarmPush(fcmToken, alert, price);

      } catch (err) {
        console.error(`Error processing alert ${alert.id}:`, err.message);
      }
    }
  });

  await Promise.all(promises);
  console.log("Check complete.");
}

// ── Routes ────────────────────────────────────────────────────────────────

// cron-job.org hits this every minute
app.get("/check", async (req, res) => {
  try {
    await checkAlerts();
    res.json({ ok: true, time: new Date().toISOString() });
  } catch (err) {
    console.error("Check error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Health check for Render
app.get("/", (req, res) => {
  res.json({ status: "TradeAlert server running", time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
