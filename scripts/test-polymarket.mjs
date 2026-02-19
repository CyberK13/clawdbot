#!/usr/bin/env node
import { config } from "dotenv";
config({ quiet: true });

import { ClobClient, Chain } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const ethers5 = require(
  require.resolve("ethers", { paths: [require.resolve("@polymarket/clob-client")] }),
);

const pk = process.env.POLYMARKET_Wallet_Private_Key || process.env.POLYMARKET_PRIVATE_KEY;
const apiKey = process.env.POLYMARKET_API_KEY;
const apiSecret = process.env.POLYMARKET_API_SECRET;
const passphrase = process.env.POLYMARKET_PASSPHRASE;
const funder = process.env.POLYMARKET_FUNDER;

console.log("🔮 Polymarket 账户测试");
console.log("=".repeat(50));

// ethers v5 signer (clob-client 需要)
const signer5 = new ethers5.Wallet(pk);
const eoaAddress = await signer5.getAddress();

console.log("\n  EOA 地址:", eoaAddress);
console.log("  Proxy Wallet (Funder):", funder);

// 初始化客户端: (host, chainId, signer, creds, signatureType, funder)
// signatureType: 0 = EOA, 1 = Poly Proxy, 2 = Gnosis Safe
const client = new ClobClient(
  "https://clob.polymarket.com",
  Chain.POLYGON,
  signer5,
  { key: apiKey, secret: apiSecret, passphrase },
  1, // signatureType: Poly Proxy
  funder, // proxy wallet 地址
);

// 1. API 连接
console.log("\n--- 1. API 连接 ---");
try {
  const ok = await client.getOk();
  console.log("  ✅", ok);
} catch (e) {
  console.log("  ❌", e.message);
}

// 2. API Key 信息
console.log("\n--- 2. API Key ---");
try {
  const keys = await client.getApiKeys();
  console.log("  ✅ Keys:", JSON.stringify(keys));
} catch (e) {
  console.log("  ❌", e.message?.slice(0, 200));
}

// 3. CLOB 余额 (signatureType=1 查 Proxy Wallet)
console.log("\n--- 3. CLOB 余额 ---");
try {
  const collateral = await client.getBalanceAllowance({ asset_type: "COLLATERAL" });
  const usdcBalance = (parseInt(collateral.balance) / 1e6).toFixed(2);
  console.log(`  ✅ USDC 余额: $${usdcBalance}`);
  // 检查 allowance 状态
  const hasAllowance = Object.values(collateral.allowances || {}).some((v) => BigInt(v) > 0n);
  console.log(`  授权状态: ${hasAllowance ? "✅ 已授权" : "❌ 未授权"}`);
} catch (e) {
  console.log("  ❌ Collateral:", e.message?.slice(0, 200));
}

// 4. 交易历史
console.log("\n--- 4. 交易历史 ---");
try {
  const trades = await client.getTrades({}, true);
  const count = Array.isArray(trades) ? trades.length : 0;
  console.log(`  ✅ ${count} 笔交易`);
  if (Array.isArray(trades)) {
    trades.slice(0, 5).forEach((t) => {
      console.log(`     ${t.side} ${t.size} @ ${t.price} | ${t.status} | ${t.outcome}`);
    });
    if (count > 5) {
      console.log(`     ... 还有 ${count - 5} 笔`);
    }
  }
} catch (e) {
  console.log("  ❌", e.message?.slice(0, 200));
}

// 5. 未结订单
console.log("\n--- 5. 未结订单 ---");
try {
  const orders = await client.getOpenOrders();
  const count = Array.isArray(orders) ? orders.length : 0;
  console.log(`  ${count > 0 ? "✅" : "ℹ️"} ${count} 个未结订单`);
  if (Array.isArray(orders)) {
    orders.slice(0, 5).forEach((o) => {
      console.log(`     ${o.side} ${o.size} @ ${o.price} | ${o.status || ""}`);
    });
  }
} catch (e) {
  console.log("  ❌", e.message?.slice(0, 200));
}

// 6. 链上余额
console.log("\n--- 6. 链上余额 ---");
try {
  const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com");
  const erc20Abi = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
  ];
  const USDCE = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
  const usdce = new ethers.Contract(USDCE, erc20Abi, provider);

  for (const [label, addr] of [
    ["EOA", eoaAddress],
    ["Proxy Wallet", funder],
  ]) {
    if (!addr) {
      continue;
    }
    const pol = await provider.getBalance(addr);
    let usdcBal = "0";
    try {
      const bal = await usdce.balanceOf(addr);
      const dec = await usdce.decimals();
      usdcBal = ethers.formatUnits(bal, dec);
    } catch {
      try {
        const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
        const usdc = new ethers.Contract(USDC, erc20Abi, provider);
        const bal = await usdc.balanceOf(addr);
        const dec = await usdc.decimals();
        usdcBal = ethers.formatUnits(bal, dec);
      } catch {
        /* ignore */
      }
    }
    console.log(
      `  ${label} (${addr.slice(0, 10)}...): POL=${parseFloat(ethers.formatEther(pol)).toFixed(4)} | USDC.e=$${usdcBal}`,
    );
  }
} catch (e) {
  console.log("  ❌", e.message?.slice(0, 300));
}

console.log("\n" + "=".repeat(50));
