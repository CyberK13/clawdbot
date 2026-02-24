// Check all on-chain positions with market names and values
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ClobClient, Chain } = require("@polymarket/clob-client");
const ethers5 = require(
  require.resolve("ethers", { paths: [require.resolve("@polymarket/clob-client")] }),
);
const { readFileSync } = require("fs");

const envLines = readFileSync("/opt/clawdbot/.env", "utf8").split("\n");
const env = {};
for (const line of envLines) {
  const eq = line.indexOf("=");
  if (eq > 0) {
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
}

const signer = new ethers5.Wallet(env.POLYMARKET_Wallet_Private_Key || env.POLYMARKET_PRIVATE_KEY);
const client = new ClobClient(
  "https://clob.polymarket.com",
  Chain.POLYGON,
  signer,
  {
    key: env.POLYMARKET_API_KEY,
    secret: env.POLYMARKET_API_SECRET,
    passphrase: env.POLYMARKET_PASSPHRASE,
  },
  1,
  env.POLYMARKET_FUNDER,
);
await client.getOk();

// 1. Get all traded asset IDs
const trades = await client.getTrades({}, true);
const assetIds = [...new Set(trades.map((t) => t.asset_id).filter(Boolean))];
console.log("Traded assets:", assetIds.length);

// 2. Check balance for each
const holdings = [];
for (const aid of assetIds) {
  try {
    const bal = await client.getBalanceAllowance({ asset_type: "CONDITIONAL", token_id: aid });
    const shares = parseInt(bal.balance) / 1e6;
    if (shares > 0.1) {
      let mid = -1;
      try {
        const raw = await client.getMidpoint(aid);
        mid = parseFloat(raw?.mid || raw || "0");
      } catch {
        mid = -1; // no orderbook = resolved/expired
      }
      holdings.push({ tokenId: aid, shares, mid });
    }
  } catch {}
}

console.log("\nPositions with balance:", holdings.length);

// 3. Find market names from sampling markets
// Build a token->market lookup from all sampling pages
const tokenMap = new Map();
let cursor;
for (let page = 0; page < 30; page++) {
  const res = await client.getSamplingMarkets(cursor);
  const data = Array.isArray(res) ? res : res.data || [];
  for (const m of data) {
    for (const t of m.tokens || []) {
      tokenMap.set(t.token_id, {
        question: m.question,
        outcome: t.outcome,
        conditionId: m.condition_id,
        endDate: m.end_date_iso,
        active: m.active,
      });
    }
  }
  cursor = res.next_cursor;
  if (!cursor || cursor === "LTE=" || data.length === 0) {
    break;
  }
}

// 4. Display
let totalValue = 0;
console.log("\n========== OPEN POSITIONS ==========\n");
for (const h of holdings) {
  const info = tokenMap.get(h.tokenId);
  const value = h.mid > 0 ? h.shares * h.mid : 0;
  totalValue += value;

  const midStr = h.mid > 0 ? h.mid.toFixed(3) : "N/A (resolved?)";
  const valStr = h.mid > 0 ? "$" + value.toFixed(2) : "???";

  if (info) {
    console.log(
      info.outcome + " " + h.shares.toFixed(1) + " shares @ mid " + midStr + " = " + valStr,
    );
    console.log("  " + info.question);
    console.log(
      "  end: " + (info.endDate || "?") + " | cond: " + info.conditionId.slice(0, 20) + "...",
    );
  } else {
    console.log("??? " + h.shares.toFixed(1) + " shares @ mid " + midStr + " = " + valStr);
    console.log("  token: " + h.tokenId.slice(0, 30) + "...");
  }
  console.log("");
}

const usdc = await client.getBalanceAllowance({ asset_type: "COLLATERAL" });
const usdcBal = parseInt(usdc.balance) / 1e6;
console.log("========== SUMMARY ==========");
console.log("USDC:      $" + usdcBal.toFixed(2));
console.log("Positions: $" + totalValue.toFixed(2));
console.log("Total:     $" + (usdcBal + totalValue).toFixed(2));
