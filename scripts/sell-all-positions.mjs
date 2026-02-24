#!/usr/bin/env node
/**
 * Sell all Polymarket MM positions at market price
 * Usage: node sell-all-positions.mjs [--dry-run] [--force]
 *   --dry-run: show what would happen without selling
 *   --force:   sell at any price (bypass safety checks)
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";

// Use ethers v5 from CLOB client (not project's ethers v6)
const require = createRequire(import.meta.url);
const clobPath = require.resolve("@polymarket/clob-client");
const ethersPath = require.resolve("ethers", { paths: [clobPath] });
const { ethers } = await import(ethersPath);

const STATE_FILE = (process.env.HOME || "/root") + "/.openclaw/polymarket-mm.json";
const CLOB_URL = "https://clob.polymarket.com";

const PRIVATE_KEY = process.env.POLYMARKET_Wallet_Private_Key;
const API_KEY = process.env.POLYMARKET_API_KEY;
const API_SECRET = process.env.POLYMARKET_API_SECRET;
const PASSPHRASE = process.env.POLYMARKET_PASSPHRASE;
const FUNDER = process.env.POLYMARKET_FUNDER;

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

if (!PRIVATE_KEY || !API_KEY || !API_SECRET || !PASSPHRASE || !FUNDER) {
  console.error("Missing POLYMARKET env vars. Source .env first.");
  process.exit(1);
}

const wallet = new ethers.Wallet(PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : "0x" + PRIVATE_KEY);
const client = new ClobClient(
  CLOB_URL,
  137,
  wallet,
  {
    key: API_KEY,
    secret: API_SECRET,
    passphrase: PASSPHRASE,
  },
  1,
  FUNDER,
);

async function getMarketInfo(conditionId) {
  const resp = await fetch(`${CLOB_URL}/markets/${conditionId}`);
  if (!resp.ok) {
    throw new Error(`Market API ${resp.status}`);
  }
  return resp.json();
}

async function getBook(tokenId) {
  const resp = await fetch(`${CLOB_URL}/book?token_id=${tokenId}`);
  if (!resp.ok) {
    throw new Error(`Book API ${resp.status}`);
  }
  return resp.json();
}

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  const positions = state.positions || {};
  const entries = Object.entries(positions).filter(([, p]) => p.netShares > 0);

  console.log(`Wallet: ${wallet.address}`);
  console.log(`Proxy:  ${FUNDER}`);
  console.log(`Balance: $${state.capital?.toFixed(2)}`);
  console.log(`Positions with shares: ${entries.length}`);
  if (DRY_RUN) {
    console.log(">>> DRY RUN MODE <<<");
  }
  if (FORCE) {
    console.log(">>> FORCE MODE (no price protection) <<<");
  }

  if (entries.length === 0) {
    console.log("\nNo positions to sell.");

    // Check on-chain for orphan tokens not in state
    console.log("\nChecking on-chain for orphan tokens...");
    await checkOrphans();
    return;
  }

  // Step 1: Cancel all open orders
  console.log("\n=== Step 1: Cancel all open orders ===");
  try {
    const openOrders = await client.getOpenOrders();
    console.log(`Open orders: ${openOrders.length}`);
    if (openOrders.length > 0 && !DRY_RUN) {
      await client.cancelAll();
      console.log("All orders cancelled.");
      await sleep(1000);
    }
  } catch (e) {
    console.error("Cancel failed:", e.message);
  }

  // Step 2: Sell each position
  console.log("\n=== Step 2: Sell positions ===");
  let totalRecovered = 0;
  let totalCostBasis = 0;

  for (const [tokenId, pos] of entries) {
    const { outcome, netShares, avgEntry, conditionId } = pos;
    totalCostBasis += netShares * avgEntry;

    console.log(
      `\n--- ${outcome} ${netShares.toFixed(1)} shares (entry $${avgEntry.toFixed(3)}) ---`,
    );
    console.log(`  Condition: ${conditionId.slice(0, 16)}...`);

    try {
      // Get market metadata
      const market = await getMarketInfo(conditionId);
      const tickSize = market.minimum_tick_size || "0.01";
      const negRisk = market.neg_risk || false;
      console.log(`  Market: ${market.question?.slice(0, 60)}`);
      console.log(
        `  Active: ${market.active}, End: ${market.end_date_iso?.slice(0, 10)}, Tick: ${tickSize}, NegRisk: ${negRisk}`,
      );

      // Check on-chain balance
      let onChainShares = netShares; // default to tracked
      try {
        const bal = await client.getBalanceAllowance({
          asset_type: "CONDITIONAL",
          token_id: tokenId,
        });
        onChainShares = parseFloat(bal.balance) / 1e6;
        console.log(
          `  On-chain: ${onChainShares.toFixed(2)} shares (tracked: ${netShares.toFixed(2)})`,
        );
      } catch (e) {
        console.log(`  On-chain check failed: ${e.message}`);
      }

      const sharesToSell = Math.min(netShares, onChainShares);
      if (sharesToSell <= 0) {
        console.log("  No shares to sell (on-chain balance is 0)");
        continue;
      }

      // Get orderbook
      const book = await getBook(tokenId);
      const bids = book.bids || [];
      if (bids.length === 0) {
        console.log("  NO BIDS in orderbook — cannot sell");
        continue;
      }

      // CLOB API returns bids ascending — show highest (best) bids
      console.log(`  Top bids (best first):`);
      let _availableLiq = 0;
      for (const b of bids.slice(-5).toReversed()) {
        console.log(`    $${b.price} x ${b.size}`);
        _availableLiq += parseFloat(b.price) * parseFloat(b.size);
      }

      // Best bid is LAST (ascending order)
      const bestBidPrice = parseFloat(bids[bids.length - 1].price);
      const bestBidSize = parseFloat(bids[bids.length - 1].size);
      const minSafePrice = avgEntry * 0.1; // 10% of entry — very generous
      const estRecovery = sharesToSell * bestBidPrice;

      console.log(`  Best bid: $${bestBidPrice} (${bestBidSize} shares)`);
      console.log(
        `  Est recovery: $${estRecovery.toFixed(2)} vs cost $${(sharesToSell * avgEntry).toFixed(2)}`,
      );

      if (bestBidPrice < minSafePrice && !FORCE) {
        console.log(`  SKIP: bestBid $${bestBidPrice} < 10% of entry $${avgEntry.toFixed(3)}`);
        console.log(`  Use --force to sell anyway`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would sell ${sharesToSell.toFixed(1)} @ $${bestBidPrice}`);
        totalRecovered += estRecovery;
        continue;
      }

      // Sell via FOK — sell into available bids
      const sellSize = Math.min(sharesToSell, bestBidSize * 0.95); // 95% of available
      console.log(`  SELLING ${sellSize.toFixed(1)} shares @ $${bestBidPrice} (FOK)...`);

      const result = await client.createAndPostOrder(
        {
          tokenID: tokenId,
          price: bestBidPrice,
          size: sellSize,
          side: Side.SELL,
          feeRateBps: 0,
        },
        { tickSize, negRisk },
        OrderType.FOK,
      );

      const orderId = result?.orderID || result?.orderHashes?.[0];
      if (orderId) {
        console.log(`  SOLD! Order: ${orderId}`);
        totalRecovered += sellSize * bestBidPrice;

        // If we have remaining shares, try next bid level
        const remaining = sharesToSell - sellSize;
        if (remaining > 1 && bids.length > 1) {
          console.log(`  Remaining: ${remaining.toFixed(1)} shares, trying next bid...`);
          await sleep(500);
          const nextBid = parseFloat(bids[1].price);
          const nextSize = Math.min(remaining, parseFloat(bids[1].size) * 0.95);
          try {
            const r2 = await client.createAndPostOrder(
              { tokenID: tokenId, price: nextBid, size: nextSize, side: Side.SELL, feeRateBps: 0 },
              { tickSize, negRisk },
              OrderType.FOK,
            );
            if (r2?.orderID || r2?.orderHashes?.[0]) {
              console.log(`  SOLD chunk 2: ${nextSize.toFixed(1)} @ $${nextBid}`);
              totalRecovered += nextSize * nextBid;
            }
          } catch (e2) {
            console.log(`  Chunk 2 failed: ${e2.message?.slice(0, 100)}`);
          }
        }
      } else {
        console.log(`  FAILED:`, JSON.stringify(result)?.slice(0, 200));
      }
    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
    }

    await sleep(500);
  }

  // Summary
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Cost basis:     $${totalCostBasis.toFixed(2)}`);
  console.log(`Recovered:      $${totalRecovered.toFixed(2)}`);
  console.log(`Loss:           $${(totalCostBasis - totalRecovered).toFixed(2)}`);
  console.log(`Balance before: $${state.capital?.toFixed(2)}`);
  console.log(`Balance after:  ~$${((state.capital || 0) + totalRecovered).toFixed(2)}`);

  if (!DRY_RUN && totalRecovered > 0) {
    // Clean up state
    console.log("\nCleaning up state file...");
    for (const [tokenId, pos] of entries) {
      if (pos.netShares > 0) {
        state.positions[tokenId].netShares = 0;
        state.positions[tokenId].avgEntry = 0;
      }
    }
    state.pendingSells = {};
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log("State cleaned.");
  }
}

async function checkOrphans() {
  // Check a few known token IDs from state history
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  const allTokens = [
    ...Object.keys(state.positions || {}),
    ...Object.keys(state.pendingSells || {}),
  ];
  const unique = [...new Set(allTokens)];
  for (const tokenId of unique) {
    try {
      const bal = await client.getBalanceAllowance({
        asset_type: "CONDITIONAL",
        token_id: tokenId,
      });
      const shares = parseFloat(bal.balance) / 1e6;
      if (shares > 0.1) {
        console.log(`  Orphan: ${tokenId.slice(0, 20)}... = ${shares.toFixed(2)} shares`);
      }
    } catch {}
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
