#!/usr/bin/env node
// ============================================================================
// Polymarket Signature Diagnostic — 最小化排查签名问题
// Usage: node scripts/diagnose-signature.mjs
// ============================================================================

import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

// --- Load .env ---
const envPaths = ["/opt/clawdbot/.env", ".env"];
for (const p of envPaths) {
  if (existsSync(p)) {
    console.log(`Loading env from: ${p}`);
    const content = readFileSync(p, "utf8");
    for (const line of content.split("\n")) {
      if (line.startsWith("#") || !line.includes("=")) {
        continue;
      }
      const idx = line.indexOf("=");
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (key && val) {
        process.env[key] = val;
      }
    }
    break;
  }
}

const require = createRequire(import.meta.url);
const { ClobClient, Chain, OrderType, Side } = require("@polymarket/clob-client");
const ethers5 = require(
  require.resolve("ethers", { paths: [require.resolve("@polymarket/clob-client")] }),
);

// --- Credentials ---
const PRIVATE_KEY = process.env.POLYMARKET_Wallet_Private_Key || process.env.POLYMARKET_PRIVATE_KEY;
const API_KEY = process.env.POLYMARKET_API_KEY;
const API_SECRET = process.env.POLYMARKET_API_SECRET;
const PASSPHRASE = process.env.POLYMARKET_PASSPHRASE || process.env.POLYMARKET_API_PASSPHRASE;
const FUNDER = process.env.POLYMARKET_FUNDER;

console.log("\n=== 1. CREDENTIALS CHECK ===");
console.log(
  "PRIVATE_KEY:",
  PRIVATE_KEY
    ? `${PRIVATE_KEY.slice(0, 6)}...${PRIVATE_KEY.slice(-4)} (${PRIVATE_KEY.length} chars)`
    : "❌ MISSING",
);
console.log("API_KEY:", API_KEY ? `${API_KEY.slice(0, 8)}...` : "❌ MISSING");
console.log("API_SECRET:", API_SECRET ? `${API_SECRET.slice(0, 8)}...` : "❌ MISSING");
console.log("PASSPHRASE:", PASSPHRASE ? `${PASSPHRASE.slice(0, 8)}...` : "❌ MISSING");
console.log("FUNDER:", FUNDER || "❌ MISSING");

// Derive EOA from private key
let wallet;
try {
  wallet = new ethers5.Wallet(PRIVATE_KEY);
  console.log("EOA (derived):", wallet.address);
  console.log(
    "FUNDER == EOA?",
    wallet.address.toLowerCase() === FUNDER?.toLowerCase()
      ? "⚠️ YES (should be proxy, not EOA!)"
      : "No (good, funder is proxy)",
  );
} catch (e) {
  console.log("❌ Invalid private key:", e.message);
  process.exit(1);
}

// --- Check proxy on-chain ---
console.log("\n=== 2. ON-CHAIN PROXY CHECK ===");
try {
  const provider = new ethers5.providers.JsonRpcProvider("https://polygon-bor-rpc.publicnode.com");
  const code = await provider.getCode(FUNDER);
  console.log(
    "Proxy bytecode:",
    code === "0x" ? "❌ EMPTY (not deployed!)" : `✅ ${code.length} chars`,
  );

  const eoaBalance = await provider.getBalance(wallet.address);
  console.log("EOA POL balance:", ethers5.utils.formatEther(eoaBalance), "POL");

  const proxyBalance = await provider.getBalance(FUNDER);
  console.log("Proxy POL balance:", ethers5.utils.formatEther(proxyBalance), "POL");
} catch (e) {
  console.log("RPC error:", e.message?.slice(0, 100));
}

// --- Test with signatureType=1 (POLY_PROXY) ---
console.log("\n=== 3. CLOB CLIENT — signatureType=1 (POLY_PROXY) ===");
const creds = { key: API_KEY, secret: API_SECRET, passphrase: PASSPHRASE };
const client1 = new ClobClient(
  "https://clob.polymarket.com",
  Chain.POLYGON,
  wallet,
  creds,
  1,
  FUNDER,
);

try {
  await client1.getOk();
  console.log("✅ getOk() passed");
} catch (e) {
  console.log("❌ getOk() failed:", e.message?.slice(0, 200));
}

try {
  const bal = await client1.getBalanceAllowance({ asset_type: "COLLATERAL" });
  console.log("✅ Balance:", parseInt(bal.balance) / 1e6, "USDC");
} catch (e) {
  console.log("❌ getBalance failed:", e.message?.slice(0, 200));
}

// Try deriveApiKey (tests L1 auth)
try {
  const keys = await client1.deriveApiKey();
  console.log("✅ deriveApiKey:", JSON.stringify(keys).slice(0, 100));
} catch (e) {
  console.log("❌ deriveApiKey failed:", e.message?.slice(0, 200));
}

// Find a cheap market to test order
let testTokenId;
try {
  const rewards = await client1.getCurrentRewards();
  if (rewards.length > 0) {
    const market = await client1.getMarket(rewards[0].condition_id);
    testTokenId = market?.tokens?.[0]?.token_id;
    console.log("Test market:", market?.question?.slice(0, 50));
    console.log("Test token:", testTokenId?.slice(0, 20) + "...");
  }
} catch (e) {
  console.log("Failed to find test market:", e.message?.slice(0, 100));
}

if (testTokenId) {
  // Try placing a minimal order (BUY 1 share @ $0.01 — will likely be rejected but shows signature status)
  console.log("\n--- Order test: signatureType=1, BUY 10 @ $0.01 ---");
  try {
    const tick = await client1.getTickSize(testTokenId);
    const negRisk = await client1.getNegRisk(testTokenId);
    console.log("tickSize:", tick, "negRisk:", negRisk);

    const result = await client1.createAndPostOrder(
      { tokenID: testTokenId, price: 0.01, size: 10, side: Side.BUY, feeRateBps: 0 },
      { tickSize: tick, negRisk },
      OrderType.GTC,
      false,
      true, // postOnly
    );
    console.log("✅ ORDER SUCCESS:", JSON.stringify(result));
    // Cancel immediately
    if (result?.orderID) {
      await client1.cancelOrder({ orderID: result.orderID });
      console.log("✅ Order cancelled");
    }
  } catch (e) {
    console.log("❌ ORDER FAILED:", e.message?.slice(0, 300));
    if (e.response?.data) {
      console.log("   Response data:", JSON.stringify(e.response.data).slice(0, 300));
    }
    if (e.response?.status) {
      console.log("   HTTP status:", e.response.status);
    }
  }

  // Also try createOrder separately to see if signing alone works
  console.log("\n--- Sign-only test: createOrder (no post) ---");
  try {
    const tick = await client1.getTickSize(testTokenId);
    const negRisk = await client1.getNegRisk(testTokenId);
    const signedOrder = await client1.createOrder(
      { tokenID: testTokenId, price: 0.01, size: 10, side: Side.BUY, feeRateBps: 0 },
      { tickSize: tick, negRisk },
    );
    console.log("✅ createOrder (signing) succeeded");
    console.log("   maker:", signedOrder?.maker);
    console.log("   signer:", signedOrder?.signer);
    console.log("   signature:", signedOrder?.signature?.slice(0, 40) + "...");

    // Post it separately to see exact error
    console.log("\n--- Post signed order ---");
    try {
      const postResult = await client1.postOrder(signedOrder, OrderType.GTC, false, true);
      console.log("✅ postOrder succeeded:", JSON.stringify(postResult));
      if (postResult?.orderID) {
        await client1.cancelOrder({ orderID: postResult.orderID });
      }
    } catch (pe) {
      console.log("❌ postOrder failed:", pe.message?.slice(0, 300));
      if (pe.response?.data) {
        console.log("   Response data:", JSON.stringify(pe.response.data).slice(0, 300));
      }
    }
  } catch (e) {
    console.log("❌ createOrder failed:", e.message?.slice(0, 300));
  }
}

// --- Test with signatureType=0 (EOA) for comparison ---
console.log("\n=== 4. CLOB CLIENT — signatureType=0 (EOA) ===");
const client0 = new ClobClient("https://clob.polymarket.com", Chain.POLYGON, wallet, creds, 0);

if (testTokenId) {
  console.log("--- Order test: signatureType=0, BUY 10 @ $0.01 ---");
  try {
    const tick = await client0.getTickSize(testTokenId);
    const negRisk = await client0.getNegRisk(testTokenId);
    const result = await client0.createAndPostOrder(
      { tokenID: testTokenId, price: 0.01, size: 10, side: Side.BUY, feeRateBps: 0 },
      { tickSize: tick, negRisk },
      OrderType.GTC,
      false,
      true,
    );
    console.log("✅ ORDER SUCCESS:", JSON.stringify(result));
    if (result?.orderID) {
      await client0.cancelOrder({ orderID: result.orderID });
    }
  } catch (e) {
    console.log("❌ ORDER FAILED:", e.message?.slice(0, 300));
    if (e.response?.data) {
      console.log("   Response data:", JSON.stringify(e.response.data).slice(0, 300));
    }
  }
}

// --- Check clob-client version ---
console.log("\n=== 5. SDK VERSION ===");
try {
  const pkgPath = require.resolve("@polymarket/clob-client/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  console.log("@polymarket/clob-client:", pkg.version);
} catch {
  console.log("Could not read SDK version");
}
try {
  const pkgPath = require.resolve("@polymarket/order-utils/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  console.log("@polymarket/order-utils:", pkg.version);
} catch {
  console.log("Could not read order-utils version");
}

// --- Check currently deployed code version ---
console.log("\n=== 6. DEPLOYMENT INFO ===");
try {
  const { execSync } = await import("node:child_process");
  const gitHash = execSync("git rev-parse --short HEAD 2>/dev/null", { encoding: "utf8" }).trim();
  const gitMsg = execSync("git log -1 --format=%s 2>/dev/null", { encoding: "utf8" }).trim();
  console.log("Git HEAD:", gitHash, "-", gitMsg);
} catch {
  console.log("Git info unavailable");
}

console.log("\n=== DONE ===");
