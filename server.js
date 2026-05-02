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

async function getBinancePrice(symbol) {
  // Coinbase API — no geo-block, no rate limit on free tier, works from Render
  const coinbaseMap = {
    BTCUSDT:"BTC-USD", ETHUSDT:"ETH-USD", BNBUSDT:"BNB-USD",
    SOLUSDT:"SOL-USD", XRPUSDT:"XRP-USD", ADAUSDT:"ADA-USD",
    DOGEUSDT:"DOGE-USD", AVAXUSDT:"AVAX-USD", DOTUSDT:"DOT-USD",
    MATICUSDT:"MATIC-USD", LINKUSDT:"LINK-USD", UNIUSDT:"UNI-USD",
    ATOMUSDT:"ATOM-USD", LTCUSDT:"LTC-USD", BCHUSDT:"BCH-USD",
    NEARUSDT:"NEAR-USD", ARBUSDT:"ARB-USD", OPUSDT:"OP-USD",
    SHIBUSDT:"SHIB-USD", TRXUSDT:"TRX-USD"
  };
  const cbSymbol = coinbaseMap[symbol];
  if (!cbSymbol) return 0;
  try {
    const r = await axios.get(
      `https://api.coinbase.com/v2/prices/${cbSymbol}/spot`,
      { timeout: 6000, headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const p = parseFloat(r.data?.data?.amount) || 0;
    if (p > 0) { console.log(`  [Coinbase] ${symbol} = ${p}`); return p; }
  } catch (e) { console.log(`  Coinbase failed for ${symbol}: ${e.message}`); }

  // Fallback: CoinCap API (also free, no key, no rate limit issues)
  const coinCapMap = {
    BTCUSDT:"bitcoin", ETHUSDT:"ethereum", BNBUSDT:"binance-coin",
    SOLUSDT:"solana", XRPUSDT:"xrp", ADAUSDT:"cardano",
    DOGEUSDT:"dogecoin", LTCUSDT:"litecoin", BCHUSDT:"bitcoin-cash",
    AVAXUSDT:"avalanche", DOTUSDT:"polkadot", LINKUSDT:"chainlink",
    TRXUSDT:"tron", NEARUSDT:"near-protocol", SHIBUSDT:"shiba-inu"
  };
  const capId = coinCapMap[symbol];
  if (!capId) return 0;
  try {
    const r = await axios.get(
      `https://api.coincap.io/v2/assets/${capId}`,
      { timeout: 6000 }
    );
    const p = parseFloat(r.data?.data?.priceUsd) || 0;
    if (p > 0) { console.log(`  [CoinCap] ${symbol} = ${p}`); return p; }
  } catch (e) { console.log(`  CoinCap failed: ${e.message}`); }
  return 0;
}

async function getFuturesPrice(symbol) {
  // Gold/Silver: use Open Exchange Rates / Frankfurter won't have metals
  // Best free source for live XAU/XAG: use Coinbase which has XAU-USD pair
  const cbMap = { XAUUSDT: "XAU-USD", XAGUSDT: "XAG-USD" };
  const cbSym = cbMap[symbol];
  if (cbSym) {
    try {
      const r = await axios.get(
        `https://api.coinbase.com/v2/prices/${cbSym}/spot`,
        { timeout: 6000, headers: { "User-Agent": "Mozilla/5.0" } }
      );
      const p = parseFloat(r.data?.data?.amount) || 0;
      if (p > 0) { console.log(`  [Coinbase] ${symbol} = ${p}`); return p; }
    } catch (e) { console.log(`  Coinbase metals failed: ${e.message}`); }
  }
  // Fallback: Yahoo Finance spot
  const yahooMap = { XAUUSDT: "XAUUSD%3DX", XAGUSDT: "XAGUSD%3DX" };
  const ySym = yahooMap[symbol];
  if (!ySym) return 0;
  try {
    const r = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ySym}?interval=1m&range=1d`,
      { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } }
    );
    const p = parseFloat(r.data?.chart?.result?.[0]?.meta?.regularMarketPrice) || 0;
    if (p > 0) { console.log(`  [Yahoo spot ${symbol}] = ${p}`); return p; }
  } catch (e) { console.log(`  Yahoo metals failed: ${e.message}`); }
  return 0;
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

        // Get user FCM token - try by userId first, fallback to any user
        let fcmToken = null;
        try {
          const userDoc = await db.collection("users").doc(alert.userId).get();
          if (userDoc.exists) {
            fcmToken = userDoc.data().fcmToken;
            console.log(`  ✅ Found user by ID: ${alert.userId}`);
          } else {
            console.log(`  ⚠️ User not found by ID: ${alert.userId}, searching all users...`);
            // Fallback: get first user (for single-device apps)
            const allUsers = await db.collection("users").limit(1).get();
            if (!allUsers.empty) {
              fcmToken = allUsers.docs[0].data().fcmToken;
              console.log(`  ✅ Found fallback user: ${allUsers.docs[0].id}`);
            }
          }
        } catch (e) {
          console.error(`  ❌ User lookup error: ${e.message}`);
        }

        if (!fcmToken) {
          console.log(`  ❌ No FCM token found for alert ${alert.id}`);
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
