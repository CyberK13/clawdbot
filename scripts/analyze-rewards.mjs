// Analyze Polymarket reward market distribution
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
const rewards = await client.getCurrentRewards();

// Group by min_size
const byMinSize = {};
for (const r of rewards) {
  const ms = r.rewards_min_size || 0;
  byMinSize[ms] = (byMinSize[ms] || 0) + 1;
}

console.log("=== min_size distribution ===");
for (const [size, count] of Object.entries(byMinSize).toSorted(
  (a, b) => Number(a[0]) - Number(b[0]),
)) {
  console.log(`  minSize=${size}: ${count} markets`);
}

// Rate distribution
let above100 = 0,
  above50 = 0,
  above20 = 0,
  above5 = 0,
  below5 = 0;
for (const r of rewards) {
  const rate = r.total_daily_rate || r.native_daily_rate || 0;
  if (rate >= 100) {
    above100++;
  } else if (rate >= 50) {
    above50++;
  } else if (rate >= 20) {
    above20++;
  } else if (rate >= 5) {
    above5++;
  } else {
    below5++;
  }
}
console.log("\n=== daily rate distribution ===");
console.log(`  $100+/day: ${above100} markets`);
console.log(`  $50-100/day: ${above50} markets`);
console.log(`  $20-50/day: ${above20} markets`);
console.log(`  $5-20/day: ${above5} markets`);
console.log(`  <$5/day: ${below5} markets`);

// Top affordable (minSize<=100)
const affordable = rewards
  .filter((r) => r.rewards_min_size <= 100)
  .toSorted((a, b) => (b.total_daily_rate || 0) - (a.total_daily_rate || 0))
  .slice(0, 15);

console.log("\n=== Top 15 affordable (minSize<=100) ===");
for (const r of affordable) {
  const rate = r.total_daily_rate || r.native_daily_rate || 0;
  console.log(
    `  $${rate.toFixed(2)}/d | minSize=${r.rewards_min_size} | spread=${r.rewards_max_spread}c | ${r.condition_id.slice(0, 16)}`,
  );
}

// Top with minSize<=200 (we have $237)
const mid200 = rewards
  .filter((r) => r.rewards_min_size <= 200)
  .toSorted((a, b) => (b.total_daily_rate || 0) - (a.total_daily_rate || 0))
  .slice(0, 15);

console.log("\n=== Top 15 (minSize<=200, all within our capital) ===");
for (const r of mid200) {
  const rate = r.total_daily_rate || r.native_daily_rate || 0;
  console.log(
    `  $${rate.toFixed(2)}/d | minSize=${r.rewards_min_size} | spread=${r.rewards_max_spread}c | ${r.condition_id.slice(0, 16)}`,
  );
}

// maxSpread distribution
const bySpread = {};
for (const r of rewards) {
  const s = r.rewards_max_spread || 0;
  bySpread[s] = (bySpread[s] || 0) + 1;
}
console.log("\n=== max_spread distribution (in cents) ===");
for (const [spread, count] of Object.entries(bySpread).toSorted(
  (a, b) => Number(a[0]) - Number(b[0]),
)) {
  console.log(`  ${spread}c: ${count} markets`);
}
