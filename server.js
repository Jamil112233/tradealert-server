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
  const now = new Date().toISOString();
  console.log(`\n========== CHECK at ${now} ==========`);

  let snapshot;
  try {
    snapshot = await db.collection("alerts")
      .where("triggered", "==", false)
      .get();
  } catch (err) {
    console.error("Firestore read failed:", err.message);
    return;
  }

  if (snapshot.empty) {
    console.log("No active alerts in Firestore.");
    return;
  }

  console.log(`Found ${snapshot.size} active alert(s)`);

  // Group by pairSymbol
  const alertsByPair = {};
  snapshot.forEach(doc => {
    const alert = { id: doc.id, ...doc.data() };
    console.log(`  Alert: ${alert.pairSymbol} target=${alert.targetPrice} dir=${alert.direction}`);
    if (!alertsByPair[alert.pairSymbol]) alertsByPair[alert.pairSymbol] = [];
    alertsByPair[alert.pairSymbol].push(alert);
  });

  const promises = Object.entries(alertsByPair).map(async ([pair, alerts]) => {
    const price = await fetchPrice(pair);
    console.log(`  Price check: ${pair} = ${price}`);
    if (!price || price <= 0) {
      console.log(`  ⚠️ Could not fetch price for ${pair}`);
      return;
    }

    for (const alert of alerts) {
      const hit = alert.direction === "above"
        ? price >= alert.targetPrice
        : price <= alert.targetPrice;

      console.log(`  ${pair}: price=${price} target=${alert.targetPrice} dir=${alert.direction} hit=${hit}`);

      if (!hit) continue;

      console.log(`  🎯 HIT DETECTED: ${pair} price=${price} target=${alert.targetPrice}`);

      try {
        await db.collection("alerts").doc(alert.id).update({
          triggered: true,
          hitAt: Date.now(),
          hitPrice: price,
        });
        console.log(`  ✅ Marked triggered in Firestore`);

        const userDoc = await db.collection("users").doc(alert.userId).get();
        if (!userDoc.exists) {
          console.log(`  ❌ User not found: ${alert.userId}`);
          continue;
        }
        const fcmToken = userDoc.data().fcmToken;
        if (!fcmToken) {
          console.log(`  ❌ No FCM token for user: ${alert.userId}`);
          continue;
        }
        console.log(`  📤 Sending FCM push...`);
        await sendAlarmPush(fcmToken, alert, price);
      } catch (err) {
        console.error(`  ❌ Error for alert ${alert.id}:`, err.message);
      }
    }
  });

  await Promise.all(promises);
  console.log(`========== CHECK DONE ==========\n`);
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

// Health check for Render
app.get("/", (req, res) => {
  res.json({ status: "TradeAlert server running", time: new Date().toISOString() });
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
