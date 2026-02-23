#!/usr/bin/env node
/**
 * Redeem resolved/won Polymarket positions via on-chain CTF call
 * Requires: MATIC in EOA for gas (~0.01 MATIC)
 *
 * Usage: node redeem-positions.mjs [--dry-run]
 */
import { createRequire } from "node:module";
import dotenv from "dotenv";

dotenv.config({ path: "/opt/clawdbot/.env" });

const require = createRequire(import.meta.url);
const clobPath = require.resolve("@polymarket/clob-client");
const ethersPath = require.resolve("ethers", { paths: [clobPath] });
const { ethers } = await import(ethersPath);

const DRY_RUN = process.argv.includes("--dry-run");

const PRIVATE_KEY = process.env.POLYMARKET_Wallet_Private_Key;
const FUNDER = process.env.POLYMARKET_FUNDER; // Proxy wallet address
const RPC_URL = "https://polygon-bor-rpc.publicnode.com";

// Contract addresses
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Resolved markets we WON
const WINNING_POSITIONS = [
  {
    name: "Prince Andrew released by Feb 19",
    conditionId: "0xb8526689cafa6150f6f957059eb8f84e7c968f46d9e62b9122c82466df666e85",
    shares: 113.63,
    outcome: "Yes",
  },
  {
    name: "Elon Musk 115-139 tweets",
    conditionId: "0xa56c7d32f8573a0c7e3bfc50573387f26f6a6c5420b818a02c61f3dd27591ef3",
    shares: 50,
    outcome: "Yes",
  },
];

// ABI fragments
const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
];

const PROXY_ABI = ["function execute(address to, uint256 value, bytes data) returns (bytes)"];

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL, { chainId: 137, name: "matic" });
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log("EOA:", wallet.address);
  console.log("Proxy:", FUNDER);

  // Check MATIC balance
  const maticBal = await provider.getBalance(wallet.address);
  const maticStr = ethers.utils.formatEther(maticBal);
  console.log(`EOA MATIC: ${maticStr}`);

  if (maticBal.lt(ethers.utils.parseEther("0.005"))) {
    console.log("\nERROR: Not enough MATIC for gas!");
    console.log("Send at least 0.01 MATIC to:", wallet.address);
    console.log("(On Polygon network)");
    if (!DRY_RUN) {
      process.exit(1);
    }
    console.log("\n[DRY RUN] Continuing anyway...\n");
  }

  // Check USDC balance before
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
  const usdcBefore = await usdc.balanceOf(FUNDER);
  console.log(`Proxy USDC before: $${(usdcBefore.toNumber() / 1e6).toFixed(2)}`);

  const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
  const proxy = new ethers.Contract(FUNDER, PROXY_ABI, wallet);

  // Redeem each winning position
  for (const pos of WINNING_POSITIONS) {
    console.log(`\n--- Redeeming: ${pos.name} ---`);
    console.log(`  Condition: ${pos.conditionId}`);
    console.log(`  Shares: ${pos.shares} (${pos.outcome})`);
    console.log(`  Expected USDC: ~$${pos.shares.toFixed(2)}`);

    if (DRY_RUN) {
      console.log("  [DRY RUN] Would call redeemPositions via proxy");
      continue;
    }

    try {
      // Encode the CTF.redeemPositions call
      const redeemCalldata = ctf.interface.encodeFunctionData("redeemPositions", [
        USDC_ADDRESS, // collateralToken
        ethers.constants.HashZero, // parentCollectionId (0x0 for top-level)
        pos.conditionId, // conditionId
        [1, 2], // indexSets: [1=Yes, 2=No] for binary
      ]);

      console.log("  Calling proxy.execute(CTF, 0, redeemCalldata)...");

      // Call through proxy
      const tx = await proxy.execute(CTF_ADDRESS, 0, redeemCalldata, {
        gasLimit: 300000,
      });

      console.log(`  TX: ${tx.hash}`);
      console.log("  Waiting for confirmation...");

      const receipt = await tx.wait();
      console.log(
        `  Confirmed! Block: ${receipt.blockNumber}, Gas used: ${receipt.gasUsed.toString()}`,
      );

      // Check USDC balance after
      const usdcAfter = await usdc.balanceOf(FUNDER);
      console.log(`  Proxy USDC now: $${(usdcAfter.toNumber() / 1e6).toFixed(2)}`);
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      if (err.reason) {
        console.log(`  Reason: ${err.reason}`);
      }
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  // Final balance check
  const usdcFinal = await usdc.balanceOf(FUNDER);
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Final Proxy USDC: $${(usdcFinal.toNumber() / 1e6).toFixed(2)}`);
  console.log(`Recovered: $${((usdcFinal.toNumber() - usdcBefore.toNumber()) / 1e6).toFixed(2)}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
