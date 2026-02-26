import { createRequire } from "node:module";
import { ClobClient, Chain, Side, OrderType } from "@polymarket/clob-client";
import dotenv from "dotenv";
dotenv.config();

const require = createRequire(import.meta.url);
const ethers5 = require(
  require.resolve("ethers", { paths: [require.resolve("@polymarket/clob-client")] }),
);

const signer = new ethers5.Wallet(process.env.POLYMARKET_Wallet_Private_Key);
const client = new ClobClient(
  "https://clob.polymarket.com",
  Chain.POLYGON,
  signer,
  {
    key: process.env.POLYMARKET_API_KEY,
    secret: process.env.POLYMARKET_API_SECRET,
    passphrase: process.env.POLYMARKET_PASSPHRASE,
  },
  1,
  process.env.POLYMARKET_FUNDER,
);

await client.getOk();
console.log("Client OK");

// Hardcoded Hyperlend FDV $20M YES token
const TOKEN_ID = "102588100686072261614302675623043366245067716749362021352212366888454556803941";
const CONDITION_ID = "0x6e3f567b878e83b0fd8ba737a7a04af8df4866bce1126fc3fdf3dca546fe0e60";

// Check balance
const bal = await client.getBalanceAllowance({
  asset_type: "CONDITIONAL",
  token_id: TOKEN_ID,
  signature_type: 1,
});
console.log("Balance:", bal.balance, "Allowance:", JSON.stringify(bal.allowances));

const balNum = parseInt(bal.balance) / 1e6;
console.log(`Shares: ${balNum}`);

if (balNum < 0.1) {
  console.log("No significant balance to sell. Done.");
  process.exit(0);
}

// Get orderbook
const book = await client.getOrderBook(TOKEN_ID);
const bids = book.bids || [];
console.log(`Bids: ${bids.length}`);
const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;
console.log(`Best bid: ${bestBid}`);

if (bestBid <= 0) {
  console.log("No bids available. Cannot sell.");
  process.exit(1);
}

// Get market info for tick/negRisk
const mkt = await client.getMarket(CONDITION_ID);
console.log(`Market: ${mkt.question}`);
console.log(`Tick: ${mkt.minimum_tick_size}, negRisk: ${mkt.neg_risk}`);

// Sell FOK at best bid
console.log(`\nSelling ${balNum.toFixed(1)} shares @ ${bestBid} (FOK)...`);
const result = await client.createAndPostOrder(
  {
    tokenID: TOKEN_ID,
    price: bestBid,
    size: balNum,
    side: Side.SELL,
    feeRateBps: 0,
  },
  { tickSize: mkt.minimum_tick_size || "0.01", negRisk: mkt.neg_risk },
  OrderType.FOK,
  false,
);
console.log("SELL result:", JSON.stringify(result));
console.log("\nDone");
