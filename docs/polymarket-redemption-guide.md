# Polymarket Position Redemption Guide

## Overview

This guide covers how to redeem won Polymarket positions programmatically on Polygon mainnet.

## Contract Addresses

- **CTF (Conditional Token Framework)**: `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`
- **NegRiskAdapter**: `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`
- **USDCe (Bridged USDC)**: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`

## Redemption Methods

### Method 1: Direct CTF Contract Call (Requires MATIC)

**When to Use**: If you have MATIC for gas and can call the CTF contract directly from the wallet holding the tokens.

**Function Signature**:

```solidity
function redeemPositions(
    address collateralToken,
    bytes32 parentCollectionId,
    bytes32 conditionId,
    uint256[] indexSets
) external
```

**Complete ABI**:

```json
{
  "name": "redeemPositions",
  "type": "function",
  "stateMutability": "nonpayable",
  "inputs": [
    { "name": "collateralToken", "type": "address" },
    { "name": "parentCollectionId", "type": "bytes32" },
    { "name": "conditionId", "type": "bytes32" },
    { "name": "indexSets", "type": "uint256[]" }
  ],
  "outputs": []
}
```

**Parameters**:

- `collateralToken`: Always `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` (USDCe) for Polymarket
- `parentCollectionId`: Always `0x0000000000000000000000000000000000000000000000000000000000000000` (bytes32 zero) for Polymarket
- `conditionId`: The market's condition ID (bytes32)
- `indexSets`: Array of outcome indices, e.g., `[1, 2]` for binary YES/NO markets

**Example with ethers.js v5**:

```javascript
const ethers = require("ethers");

const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const redeemABI = [
  {
    name: "redeemPositions",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" },
    ],
    outputs: [],
  },
];

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const ctf = new ethers.Contract(CTF_ADDRESS, redeemABI, wallet);

// Redeem positions
const tx = await ctf.redeemPositions(
  USDC_ADDRESS,
  ethers.constants.HashZero, // parentCollectionId
  conditionId, // from market data
  [1, 2], // YES and NO tokens
);

await tx.wait();
console.log("Redemption complete!");
```

**Python Example**:

```python
from web3 import Web3
from web3.constants import HASH_ZERO

w3 = Web3(Web3.HTTPProvider(RPC_URL))
w3.middleware_onion.add(construct_sign_and_send_raw_middleware(PRIVATE_KEY))

usdc_address = w3.to_checksum_address("0x2791bca1f2de4661ed88a30c99a7a9449aa84174")
ctf_address = w3.to_checksum_address("0x4d97dcd97ec945f40cf65f87097ace5ea0476045")

redeem_abi = [{
    "name": "redeemPositions",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
        {"name": "collateralToken", "type": "address"},
        {"name": "parentCollectionId", "type": "bytes32"},
        {"name": "conditionId", "type": "bytes32"},
        {"name": "indexSets", "type": "uint256[]"}
    ],
    "outputs": []
}]

ctf = w3.eth.contract(ctf_address, abi=redeem_abi)

tx_hash = ctf.functions.redeemPositions(
    usdc_address,
    HASH_ZERO,
    condition_id,
    [1, 2]
).transact()

w3.eth.wait_for_transaction_receipt(tx_hash)
print("Redemption complete!")
```

### Method 2: Gasless Redemption via Polymarket Relayer (Requires Builder Credentials)

**When to Use**: If you have Builder API credentials and want gasless redemption.

**Requirements**:

- Builder Program membership (apply at https://polymarket.com/settings?tab=builder)
- Builder API credentials: `POLY_BUILDER_API_KEY`, `POLY_BUILDER_SECRET`, `POLY_BUILDER_PASSPHRASE`

**How It Works**:

1. Your EOA signs the transaction
2. Polymarket's relayer submits it on-chain and pays gas fees
3. Works for Proxy (signature_type=1) and Safe (signature_type=2) wallets

**TypeScript Example** (from Polymarket docs):

```typescript
import { RelayerClient } from "@polymarket/relayer-client";
import { encodeFunctionData } from "viem";

const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const redeemTx = {
  to: CTF_ADDRESS,
  data: encodeFunctionData({
    abi: [
      {
        name: "redeemPositions",
        type: "function",
        inputs: [
          { name: "collateralToken", type: "address" },
          { name: "parentCollectionId", type: "bytes32" },
          { name: "conditionId", type: "bytes32" },
          { name: "indexSets", type: "uint256[]" },
        ],
        outputs: [],
      },
    ],
    functionName: "redeemPositions",
    args: [
      USDC_ADDRESS,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      conditionId,
      [1, 2],
    ],
  }),
  value: "0",
};

const response = await relayerClient.execute([redeemTx], "Redeem positions");
await response.wait();
```

**Python Example** (using poly-web3):

```python
from poly_web3 import PolyWeb3Service

service = PolyWeb3Service(
    clob_client=clob_client,  # Your ClobClient with signature_type=1
    relayer_client=relayer_client  # Initialized with Builder credentials
)

# Redeem specific conditions
service.redeem([condition_id_1, condition_id_2], batch_size=10)

# Or redeem all winning positions
service.redeem_all(batch_size=10)
```

**Limitations**:

- Requires Builder API credentials (not publicly available)
- Relayer rate limit: ~100 requests/day
- API latency: Position data has 1-3 minute delays

## Proxy Wallet Considerations

### Architecture

- **EOA (Your Private Key)** → Controls → **Proxy Contract (FUNDER)** → Holds tokens
- For signature_type=1 (Proxy wallets), tokens are held by the proxy contract
- The EOA signs transactions, but the proxy contract executes them

### Direct vs Relayer Calls

**Option A: Direct Call from Proxy**

- The CTF contract must be called by the wallet that holds the tokens (the proxy)
- **Problem**: Your EOA cannot directly call CTF - the proxy contract must make the call
- **Solution**: Either:
  1. Use the relayer (which knows how to call through the proxy) ✅
  2. Manually encode a transaction for the proxy to execute (complex)

**Option B: Gasless via Relayer**

- The relayer handles the proxy contract interaction automatically
- Requires Builder credentials
- Completely gasless - Polymarket pays all fees

## Getting MATIC for Gas

If you choose Method 1 (direct call) and have 0 MATIC, you have several options:

### Option 1: Polygon Wallet Gas Swap (Recommended)

**URL**: https://wallet.polygon.technology/gas-swap

**Requirements**:

- Must have tokens in the wallet that holds the assets (your proxy contract)
- Minimum: 1 MATIC swap
- Maximum: 20 MATIC swap
- Supported tokens: USDCe, DAI, WETH, bridged tokens

**Process**:

1. Connect your wallet (the proxy wallet address)
2. Select amount of MATIC needed (1-20)
3. Select token to swap from (USDCe)
4. Approve and swap (gasless)

**Notes**:

- 1 MATIC = ~1000 transactions on Polygon
- The swap itself is gasless (no MATIC needed upfront)

### Option 2: SmolRefuel

**URL**: https://smolrefuel.com/on/polygon

**Features**:

- Swap ANY token for MATIC gas-free
- Works with USDCe and other tokens
- Connect wallet → Select Polygon → Choose amount

### Option 3: Polygon Faucets

**URL**: https://maticfaucet.com

**Features**:

- Free MATIC every hour
- Small amounts (0.001 MATIC per claim)
- May require social verification

### Option 4: Bridge Small Amount

- Bridge $1-5 from Ethereum/other chains to Polygon
- Use official Polygon bridge or LayerSwap
- Converts to MATIC automatically

## Recommended Approach for Your Situation

Given your constraints:

- EOA: `0x443Be6bc4CC7690Cb4bdf28A258c700e1Bbc7a66`
- Proxy (FUNDER): `0x7EA591Dc638AdA9EA5924308E3df76f14666928F`
- Both have 0 MATIC
- ~$65 USDC in proxy
- Need to redeem 113.63 + 50 shares

### Best Option: Use Polygon Gas Swap

1. **Connect to Polygon Wallet Suite**: https://wallet.polygon.technology/gas-swap
   - Use MetaMask or WalletConnect
   - Switch to the proxy wallet address (FUNDER)

2. **Swap USDCe for MATIC**:
   - Select 1-2 MATIC (costs ~$0.50-1.00 USDCe)
   - Choose USDCe as source token
   - Execute gasless swap

3. **Redeem Positions**:
   - Use Method 1 (direct CTF call) from your EOA
   - The EOA needs MATIC for gas
   - Transfer the swapped MATIC from proxy to EOA first (small amount)

**Wait - Problem**: The proxy holds the tokens AND the USDCe, but your EOA needs MATIC to sign transactions.

### Alternative: Apply for Builder Program

If direct swaps don't work for your proxy wallet setup:

1. **Apply for Builder credentials**: https://polymarket.com/settings?tab=builder
2. **Use gasless redemption** via RelayerClient
3. **No MATIC needed** - fully gasless

This is the cleanest solution for proxy wallets.

## Function Signature Hash

The `redeemPositions` function signature hash is: `0x01b7037c`

You can verify calls to CTF contract on PolygonScan by looking for transactions with this method ID.

## NegRiskAdapter

The NegRiskAdapter contract (`0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`) also has a `redeemPositions` function that forwards calls to the CTF contract. It's used for markets with negative risk tokens (special market types).

For standard binary markets, call the CTF contract directly.

## Additional Resources

- [Polymarket CTF Redemption Docs](https://docs.polymarket.com/developers/CTF/redeem)
- [Polymarket Gasless Transactions](https://docs.polymarket.com/trading/gasless.md)
- [Polymarket Builder Program](https://docs.polymarket.com/developers/builders/relayer-client)
- [CTF Contract on PolygonScan](https://polygonscan.com/address/0x4d97dcd97ec945f40cf65f87097ace5ea0476045)
- [Polygon Gas Swap](https://wallet.polygon.technology/gas-swap)
- [SmolRefuel](https://smolrefuel.com/on/polygon)
- [poly-web3 (Python SDK)](https://github.com/tosmart01/poly-web3)
- [Polymarket Wallet Recovery Tool](https://github.com/0-don/polymarket-wallet-recovery)

## Summary

| Method            | MATIC Required     | Builder Credentials | Best For                   |
| ----------------- | ------------------ | ------------------- | -------------------------- |
| Direct CTF Call   | ✅ Yes (~$0.01/tx) | ❌ No               | EOA wallets, simple setup  |
| Relayer (Gasless) | ❌ No              | ✅ Yes              | Proxy/Safe wallets, no gas |

For your proxy wallet situation, **applying for Builder credentials and using the gasless relayer is the recommended approach**.
