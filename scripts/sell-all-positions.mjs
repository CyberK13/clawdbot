#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";
/**
 * Sell all Polymarket MM positions at market price
 * Usage: node sell-all-positions.mjs [--dry-run]
 */
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import dotenv from "dotenv";

// Load .env
dotenv.config({ path: "/opt/clawdbot/.env" });

// Use ethers v5 from CLOB client (not project's ethers v6)
const require = createRequire(import.meta.url);
const clobPath = require.resolve("@polymarket/clob-client");
const ethersPath = require.resolve("ethers", { paths: [clobPath] });
const { ethers } = await import(ethersPath);

const STATE_FILE = "/root/.openclaw/polymarket-mm.json";
const CLOB_URL = "https://clob.polymarket.com";
const CHAIN_ID = 137;

const PRIVATE_KEY = process.env.POLYMARKET_Wallet_Private_Key;
const API_KEY = process.env.POLYMARKET_API_KEY;
const API_SECRET = process.env.POLYMARKET_API_SECRET;
const PASSPHRASE = process.env.POLYMARKET_PASSPHRASE;
const FUNDER = process.env.POLYMARKET_FUNDER;

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  // Load state
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  const positions = state.positions || {};
  const entries = Object.entries(positions);

  console.log(`Balance: $${state.capital?.toFixed(2)}`);
  console.log(`Positions to sell: ${entries.length}`);
  if (DRY_RUN) {
    console.log(">>> DRY RUN MODE <<<\n");
  }

  if (entries.length === 0) {
    console.log("No positions to sell.");
    return;
  }

  // Init CLOB client (signature_type=1 for Poly Proxy wallet)
  const wallet = new ethers.Wallet(PRIVATE_KEY);
  const clobClient = new ClobClient(
    CLOB_URL,
    CHAIN_ID,
    wallet,
    {
      key: API_KEY,
      secret: API_SECRET,
      passphrase: PASSPHRASE,
    },
    1,
    FUNDER,
  );

  let totalRecovered = 0;

  for (const [tokenId, pos] of entries) {
    const { outcome, netShares, avgEntry, conditionId } = pos;
    if (netShares <= 0) {
      console.log(`Skip ${conditionId.slice(0, 16)}: zero shares`);
      continue;
    }

    console.log(`\n--- Selling ${outcome} ${netShares} shares ---`);
    console.log(`  Condition: ${conditionId.slice(0, 20)}...`);
    console.log(`  Token: ${tokenId.slice(0, 20)}...`);
    console.log(`  Entry: $${avgEntry.toFixed(4)}`);

    try {
      // Get current market price + tick size + neg_risk
      const book = await clobClient.getOrderBook(tokenId);
      const bestBid = book?.bids?.[0];

      if (!bestBid) {
        console.log("  WARNING: No bids in orderbook, skipping");
        continue;
      }

      const tickSize = book.tick_size || "0.01";
      const negRisk = book.neg_risk || false;
      const tick = parseFloat(tickSize);
      const decimals = { 0.1: 1, 0.01: 2, 0.001: 3, 0.0001: 4 }[tickSize] ?? 2;

      const bidPrice = parseFloat(bestBid.price);
      const bidSize = parseFloat(bestBid.size);
      console.log(
        `  Best bid: $${bidPrice} (size: ${bidSize}) tick=${tickSize} negRisk=${negRisk}`,
      );

      // Round sell price DOWN to tick grid (for SELL, we want to match/undercut bid)
      const sellPrice = parseFloat((Math.floor(bidPrice / tick) * tick).toFixed(decimals));
      if (sellPrice <= 0) {
        console.log("  WARNING: Sell price rounds to 0, skipping");
        continue;
      }

      // Round shares DOWN to tick precision
      const sellShares = parseFloat(
        (Math.floor(Math.min(netShares, bidSize) * 10 ** decimals) / 10 ** decimals).toFixed(
          decimals,
        ),
      );
      if (sellShares <= 0) {
        console.log("  WARNING: Zero rounded shares, skipping");
        continue;
      }

      const pnl = (sellPrice - avgEntry) * sellShares;
      const usdcBack = sellPrice * sellShares;
      console.log(`  Selling ${sellShares} shares @ $${sellPrice}`);
      console.log(
        `  Expected USDC back: ~$${usdcBack.toFixed(2)} (PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)})`,
      );

      if (DRY_RUN) {
        console.log("  [DRY RUN] Skipping actual sell");
        totalRecovered += usdcBack;
        continue;
      }

      // Use createAndPostOrder with proper options (like the MM extension does)
      const result = await clobClient.createAndPostOrder(
        {
          tokenID: tokenId,
          price: sellPrice,
          size: sellShares,
          side: Side.SELL,
          feeRateBps: 0,
        },
        {
          tickSize,
          negRisk,
        },
        OrderType.FOK,
      );

      console.log(`  Result: ${JSON.stringify(result).slice(0, 300)}`);

      if (result?.orderID || result?.success) {
        totalRecovered += usdcBack;
        console.log("  SOLD!");
      } else {
        console.log("  FAILED:", JSON.stringify(result).slice(0, 200));
      }

      // Rate limit
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.log(`  ERROR: ${err.message || err}`);
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Total estimated recovery: ~$${totalRecovered.toFixed(2)}`);
  console.log(`Previous balance: $${state.capital?.toFixed(2)}`);
  console.log(`Expected new balance: ~$${(state.capital + totalRecovered).toFixed(2)}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
