#!/usr/bin/env node
import fs from "fs";
import { ClobClient, Side } from "@polymarket/clob-client";
import { Wallet } from "ethers";

const pk = process.env.POLYMARKET_Wallet_Private_Key;
const w = new Wallet(pk.startsWith("0x") ? pk : "0x" + pk);
const c = new ClobClient(
  "https://clob.polymarket.com",
  137,
  w,
  {
    key: process.env.POLYMARKET_API_KEY,
    secret: process.env.POLYMARKET_API_SECRET,
    passphrase: process.env.POLYMARKET_PASSPHRASE,
  },
  1,
  process.env.POLYMARKET_FUNDER,
);

const state = JSON.parse(
  fs.readFileSync((process.env.HOME || "/root") + "/.openclaw/polymarket-mm.json", "utf8"),
);

const YES_TOKEN = "63857979746220604077046524680268513130810638288229406997752873867883772498632";
const NO_TOKEN = "63857979746220607590394358737857281562126460174428053635528635126139956706411";
const COND = "0xb1195b23733dfbc75364d8a46f49f18a612cadeb2b5eeba35b8a8ae62b2c2598";

function parseBook(raw) {
  const bids = (raw.bids || []).map((b) => ({
    price: parseFloat(b.price),
    size: parseFloat(b.size),
  }));
  const asks = (raw.asks || []).map((a) => ({
    price: parseFloat(a.price),
    size: parseFloat(a.size),
  }));
  const bestBid = bids.length > 0 ? bids[bids.length - 1].price : 0;
  const bestAsk = asks.length > 0 ? asks[asks.length - 1].price : 1;
  return {
    bestBid,
    bestAsk,
    midpoint: (bestBid + bestAsk) / 2,
    spread: bestAsk - bestBid,
    bids,
    asks,
  };
}

// Individual books
const yesBook = await c.getOrderBook(YES_TOKEN);
const noBook = await c.getOrderBook(NO_TOKEN);
const yb = parseBook(yesBook);
const nb = parseBook(noBook);
console.log(
  "YES local book: bestBid=" +
    yb.bestBid +
    " bestAsk=" +
    yb.bestAsk +
    " mid=" +
    yb.midpoint.toFixed(4),
);
console.log(
  "NO  local book: bestBid=" +
    nb.bestBid +
    " bestAsk=" +
    nb.bestAsk +
    " mid=" +
    nb.midpoint.toFixed(4),
);

// True midpoints
let yesMid = yb.midpoint,
  noMid = nb.midpoint;
try {
  yesMid = await c.getMidpoint(YES_TOKEN);
  noMid = await c.getMidpoint(NO_TOKEN);
  console.log("True mid: YES=" + yesMid + " NO=" + noMid);
} catch (e) {
  console.log("Midpoint err:", e.message);
}

// Batch getOrderBooks
console.log("\n=== Batch getOrderBooks ===");
try {
  const params = [
    { token_id: YES_TOKEN, side: Side.BUY },
    { token_id: NO_TOKEN, side: Side.BUY },
  ];
  const books = await c.getOrderBooks(params);
  console.log("Returned " + books.length + " books");
  for (let i = 0; i < books.length; i++) {
    const b = books[i];
    if (b) {
      const pb = parseBook(b);
      console.log(
        "  [" +
          i +
          "] asset=" +
          (b.asset_id || "???").slice(0, 20) +
          "... mid=" +
          pb.midpoint.toFixed(4) +
          " bids=" +
          pb.bids.length +
          " asks=" +
          pb.asks.length,
      );
    } else {
      console.log("  [" + i + "] null");
    }
  }
} catch (e) {
  console.log("Batch books FAILED:", e.message);
}

// Batch getMidpoints
console.log("\n=== Batch getMidpoints ===");
try {
  const params = [
    { token_id: YES_TOKEN, side: Side.BUY },
    { token_id: NO_TOKEN, side: Side.BUY },
  ];
  const mids = await c.getMidpoints(params);
  console.log("Type:", typeof mids, Array.isArray(mids) ? "(array)" : "");
  console.log("Value:", JSON.stringify(mids).slice(0, 500));
} catch (e) {
  console.log("Batch mids FAILED:", e.message);
}

// Reward config
const rewards = await c.getCurrentRewards();
const r = rewards.find((x) => x.condition_id === COND);
if (r) {
  console.log(
    "\nReward: max_spread=" +
      r.rewards_max_spread +
      "c (" +
      (r.rewards_max_spread / 100).toFixed(4) +
      "), min_size=" +
      r.rewards_min_size +
      ", rate=$" +
      (r.total_daily_rate || r.native_daily_rate),
  );
} else {
  console.log("\nReward: NOT FOUND");
}

// Open orders
const orders = await c.getOpenOrders();
console.log("\nOpen orders: " + orders.length);
for (const o of orders) {
  const isYes = o.asset_id === YES_TOKEN;
  const isNo = o.asset_id === NO_TOKEN;
  console.log(
    "  " +
      o.side +
      " " +
      o.size +
      "@" +
      o.price +
      " " +
      (isYes ? "YES" : isNo ? "NO" : "??") +
      " scoring=" +
      o.is_scoring,
  );
}

// Scoring
if (orders.length > 0) {
  const ids = orders.map((o) => o.id).filter(Boolean);
  try {
    const sc = await c.areOrdersScoring({ orderIds: ids });
    console.log("Scoring result:", JSON.stringify(sc).slice(0, 500));
  } catch (e) {
    console.log("Scoring err:", e.message);
  }
}

// On-chain balances
try {
  const yesBal = await c.getBalanceAllowance({ asset_type: "CONDITIONAL", token_id: YES_TOKEN });
  const noBal = await c.getBalanceAllowance({ asset_type: "CONDITIONAL", token_id: NO_TOKEN });
  console.log(
    "\nOn-chain: YES=" +
      (parseFloat(yesBal.balance) / 1e6).toFixed(2) +
      " NO=" +
      (parseFloat(noBal.balance) / 1e6).toFixed(2),
  );
} catch (e) {
  console.log("Balance err:", e.message);
}

console.log("\nCapital: $" + (state.capital || 0).toFixed(2));
console.log(
  "Positions:",
  Object.entries(state.positions || {}).filter(([, v]) => v.netShares > 0).length,
);
