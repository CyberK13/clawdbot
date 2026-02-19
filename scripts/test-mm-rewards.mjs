#!/usr/bin/env node
/**
 * 获取 Polymarket 可获取 rewards 的市场列表
 * getCurrentRewards() 只返回 condition_id + rewards_config
 * 需要额外调 getMarket() 获取 question / tokens
 */
import { config } from "dotenv";
config({ quiet: true });

import { ClobClient, Chain } from "@polymarket/clob-client";
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

const signer5 = new ethers5.Wallet(pk);
const client = new ClobClient(
  "https://clob.polymarket.com",
  Chain.POLYGON,
  signer5,
  { key: apiKey, secret: apiSecret, passphrase },
  1,
  funder,
);

console.log("🎯 Polymarket 流动性奖励市场列表");
console.log("=".repeat(60));

try {
  // 1. 获取所有奖励市场
  const rewards = await client.getCurrentRewards();
  console.log(`\n共 ${rewards.length} 个奖励市场`);

  // 2. 按日奖励排序（使用 total_daily_rate 或计算）
  const sorted = rewards
    .map((r) => {
      const dailyRate = r.total_daily_rate || r.native_daily_rate || 0;
      return { ...r, dailyRate };
    })
    .filter((r) => r.dailyRate > 0)
    .toSorted((a, b) => b.dailyRate - a.dailyRate);

  console.log(`其中 ${sorted.length} 个当前有活跃奖励\n`);

  // 3. 汇总统计
  const totalDaily = sorted.reduce((s, r) => s + r.dailyRate, 0);
  console.log(`💰 总日奖励池: $${totalDaily.toFixed(2)}`);
  console.log(`📊 平均每市场: $${(totalDaily / sorted.length).toFixed(2)}/日`);
  console.log(`🏆 最高日奖励: $${sorted[0]?.dailyRate.toFixed(2)}`);
  console.log(`📉 最低日奖励: $${sorted[sorted.length - 1]?.dailyRate.toFixed(2)}`);

  // 分档统计
  const tiers = [
    { label: "$100+/日", min: 100 },
    { label: "$50-100/日", min: 50 },
    { label: "$20-50/日", min: 20 },
    { label: "$10-20/日", min: 10 },
    { label: "$5-10/日", min: 5 },
    { label: "$1-5/日", min: 1 },
    { label: "<$1/日", min: 0 },
  ];
  console.log("\n奖励分布:");
  for (const tier of tiers) {
    const nextMin = tiers[tiers.indexOf(tier) - 1]?.min ?? Infinity;
    const count = sorted.filter((r) => r.dailyRate >= tier.min && r.dailyRate < nextMin).length;
    if (count > 0) {
      console.log(`  ${tier.label}: ${count} 个市场`);
    }
  }

  // 4. 前20名简表
  console.log(`\n\n📋 前20名奖励市场 (condition_id | 日奖励 | 最大spread | 最小size):`);
  console.log("-".repeat(80));
  for (let i = 0; i < Math.min(20, sorted.length); i++) {
    const r = sorted[i];
    console.log(
      `${String(i + 1).padStart(3)}. ${r.condition_id.slice(0, 20)}… | ` +
        `$${r.dailyRate.toFixed(2).padStart(7)} | ` +
        `spread≤${r.rewards_max_spread} | ` +
        `size≥${r.rewards_min_size}`,
    );
  }

  // 5. 获取前10名的市场详情（question, tokens, orderbook）
  console.log("\n\n📊 前10名市场详情（获取市场信息 + orderbook）:");
  console.log("=".repeat(60));

  for (let i = 0; i < Math.min(10, sorted.length); i++) {
    const r = sorted[i];
    console.log(`\n${i + 1}. condition_id: ${r.condition_id}`);
    console.log(
      `   日奖励: $${r.dailyRate.toFixed(2)} | 最大spread: ${r.rewards_max_spread} | 最小size: ${r.rewards_min_size}`,
    );

    try {
      const market = await client.getMarket(r.condition_id);
      if (market) {
        console.log(`   问题: ${market.question || "(无)"}`);
        console.log(
          `   状态: ${market.active ? "活跃" : "不活跃"} | end_date: ${market.end_date_iso || "?"}`,
        );

        // Tokens
        const tokens = market.tokens || [];
        for (const t of tokens) {
          console.log(`   ${t.outcome}: price=${t.price}, token_id=${t.token_id?.slice(0, 20)}…`);

          // Orderbook
          try {
            const book = await client.getOrderBook(t.token_id);
            const bestBid = book.bids?.[0] ? parseFloat(book.bids[0].price) : 0;
            const bestAsk = book.asks?.[0] ? parseFloat(book.asks[0].price) : 1;
            const spread = bestAsk - bestBid;
            const bidLevels = (book.bids || []).length;
            const askLevels = (book.asks || []).length;
            const bidDepth = (book.bids || []).reduce(
              (s, b) => s + parseFloat(b.size) * parseFloat(b.price),
              0,
            );
            const askDepth = (book.asks || []).reduce(
              (s, a) => s + parseFloat(a.size) * parseFloat(a.price),
              0,
            );
            console.log(
              `     📖 bid=${bestBid.toFixed(3)} ask=${bestAsk.toFixed(3)} spread=${spread.toFixed(3)} ` +
                `(${bidLevels}/${askLevels} levels) depth: bid$${bidDepth.toFixed(0)}/ask$${askDepth.toFixed(0)} ` +
                `tick=${book.tick_size}`,
            );
          } catch (e) {
            console.log(`     📖 ❌ ${e.message?.slice(0, 60)}`);
          }
        }

        // 奖励配置
        for (const rc of r.rewards_config || []) {
          console.log(
            `   💰 奖励: $${rc.rate_per_day}/日, ${rc.start_date?.slice(0, 10)} ~ ${rc.end_date?.slice(0, 10)}`,
          );
        }
      }
    } catch (e) {
      console.log(`   ❌ 获取市场详情失败: ${e.message?.slice(0, 80)}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("完成!");
} catch (e) {
  console.error("❌ 获取奖励失败:", e.message);
}
