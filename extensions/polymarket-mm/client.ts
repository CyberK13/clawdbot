// ---------------------------------------------------------------------------
// Polymarket CLOB client wrapper
// - ethers v5 signer resolution (clob-client requires v5)
// - signature_type = 1 (Poly Proxy)
// - Rate limiting with exponential backoff
// ---------------------------------------------------------------------------

import { createRequire } from "node:module";
import type {
  OrderBookSummary,
  OpenOrder,
  Trade,
  MarketReward,
  TickSize,
  BalanceAllowanceResponse,
  OrdersScoring,
  UserOrder,
  CreateOrderOptions,
  OrderType as OT,
  PostOrdersArgs,
} from "@polymarket/clob-client";
import { ClobClient, Chain } from "@polymarket/clob-client";
import { OrderType, Side } from "@polymarket/clob-client";
// SignedOrder type from clob-client's internal dependency
type SignedOrder = any;
import type { PluginLogger } from "../../src/plugins/types.js";
import { createRateLimiter, withRetry, sleep } from "./utils.js";

const require = createRequire(import.meta.url);

/** Resolve ethers v5 from clob-client's own dependency tree. */
function getEthers5(): any {
  return require(
    require.resolve("ethers", {
      paths: [require.resolve("@polymarket/clob-client")],
    }),
  );
}

export interface ClientOptions {
  privateKey: string;
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  funder: string;
  logger: PluginLogger;
}

/**
 * Thin wrapper around ClobClient with rate limiting and error handling.
 */
export class PolymarketClient {
  private client!: ClobClient;
  private rateLimit: () => Promise<void>;
  private logger: PluginLogger;
  private eoaAddress = "";
  private consecutiveErrors = 0;
  private _initialized = false;

  constructor(private opts: ClientOptions) {
    this.logger = opts.logger;
    // CLOB API: 9000 req/10s general, but trading is more restrictive.
    // Use conservative 8 req/s to leave headroom.
    this.rateLimit = createRateLimiter(8);
  }

  async init(): Promise<void> {
    const ethers5 = getEthers5();
    const signer = new ethers5.Wallet(this.opts.privateKey);
    this.eoaAddress = await signer.getAddress();

    this.client = new ClobClient(
      "https://clob.polymarket.com",
      Chain.POLYGON,
      signer,
      {
        key: this.opts.apiKey,
        secret: this.opts.apiSecret,
        passphrase: this.opts.passphrase,
      },
      1, // signatureType: Poly Proxy
      this.opts.funder,
    );

    // Verify connectivity
    await this.client.getOk();
    this._initialized = true;
    this.logger.info(`CLOB client initialized (EOA: ${this.eoaAddress})`);
  }

  get initialized(): boolean {
    return this._initialized;
  }

  get eoa(): string {
    return this.eoaAddress;
  }

  get funder(): string {
    return this.opts.funder;
  }

  // ---------- Market data ---------------------------------------------------

  async getBalance(): Promise<number> {
    await this.rateLimit();
    const res = await this.wrap(() =>
      this.client.getBalanceAllowance({ asset_type: "COLLATERAL" as any }),
    );
    return parseInt(res.balance) / 1e6;
  }

  async getOrderBook(tokenId: string): Promise<OrderBookSummary> {
    await this.rateLimit();
    return this.wrap(() => this.client.getOrderBook(tokenId));
  }

  async getMidpoint(tokenId: string): Promise<number> {
    await this.rateLimit();
    const raw = await this.wrap(() => this.client.getMidpoint(tokenId));
    return parseFloat(raw?.mid ?? raw ?? "0.5");
  }

  async getTickSize(tokenId: string): Promise<TickSize> {
    await this.rateLimit();
    return this.wrap(() => this.client.getTickSize(tokenId));
  }

  async getNegRisk(tokenId: string): Promise<boolean> {
    await this.rateLimit();
    return this.wrap(() => this.client.getNegRisk(tokenId));
  }

  // ---------- Rewards -------------------------------------------------------

  async getCurrentRewards(): Promise<MarketReward[]> {
    await this.rateLimit();
    return this.wrap(() => this.client.getCurrentRewards());
  }

  async areOrdersScoring(orderIds: string[]): Promise<OrdersScoring> {
    if (orderIds.length === 0) return {};
    await this.rateLimit();
    return this.wrap(() => this.client.areOrdersScoring({ orderIds }));
  }

  async getUserEarnings(date: string): Promise<any[]> {
    await this.rateLimit();
    return this.wrap(() => this.client.getEarningsForUserForDay(date));
  }

  async getUserRewardsAndMarkets(date: string): Promise<any[]> {
    await this.rateLimit();
    return this.wrap(() => this.client.getUserEarningsAndMarketsConfig(date));
  }

  // ---------- Orders --------------------------------------------------------

  async createOrder(
    userOrder: UserOrder,
    options?: Partial<CreateOrderOptions>,
  ): Promise<SignedOrder> {
    await this.rateLimit();
    return this.wrap(() => this.client.createOrder(userOrder, options));
  }

  async postOrder(
    signedOrder: SignedOrder,
    orderType: OT = OrderType.GTC,
    postOnly = true,
  ): Promise<any> {
    await this.rateLimit();
    return this.wrap(() => this.client.postOrder(signedOrder, orderType, false, postOnly));
  }

  async createAndPostOrder(
    userOrder: UserOrder,
    options?: Partial<CreateOrderOptions>,
    orderType?: OT,
    postOnly = true,
  ): Promise<any> {
    await this.rateLimit();
    return this.wrap(() =>
      this.client.createAndPostOrder(userOrder, options, orderType as any, false, postOnly),
    );
  }

  async postOrders(args: PostOrdersArgs[], postOnly = true): Promise<any> {
    await this.rateLimit();
    return this.wrap(() => this.client.postOrders(args, false, postOnly));
  }

  async cancelOrder(orderId: string): Promise<any> {
    await this.rateLimit();
    return this.wrap(() => this.client.cancelOrder({ orderID: orderId }));
  }

  async cancelOrders(orderIds: string[]): Promise<any> {
    if (orderIds.length === 0) return;
    await this.rateLimit();
    return this.wrap(() => this.client.cancelOrders(orderIds));
  }

  async cancelAll(): Promise<any> {
    await this.rateLimit();
    return this.wrap(() => this.client.cancelAll());
  }

  async cancelMarketOrders(conditionId: string): Promise<any> {
    await this.rateLimit();
    return this.wrap(() => this.client.cancelMarketOrders({ market: conditionId }));
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    await this.rateLimit();
    return this.wrap(() => this.client.getOpenOrders());
  }

  async getTrades(): Promise<Trade[]> {
    await this.rateLimit();
    return this.wrap(() => this.client.getTrades({}, true));
  }

  // ---------- Markets -------------------------------------------------------

  async getMarkets(cursor?: string): Promise<any> {
    await this.rateLimit();
    return this.wrap(() => this.client.getSamplingMarkets(cursor));
  }

  async getMarket(conditionId: string): Promise<any> {
    await this.rateLimit();
    return this.wrap(() => this.client.getMarket(conditionId));
  }

  /**
   * Get conditional token balance via CLOB API (works for NegRisk markets).
   * Uses getBalanceAllowance with asset_type CONDITIONAL.
   */
  async getConditionalBalance(tokenId: string): Promise<number> {
    await this.rateLimit();
    try {
      const res = await this.wrap(() =>
        this.client.getBalanceAllowance({
          asset_type: "CONDITIONAL" as any,
          token_id: tokenId,
        } as any),
      );
      return parseFloat(res.balance) / 1e6;
    } catch (err: any) {
      this.logger.warn(`getConditionalBalance failed for ${tokenId.slice(0, 10)}: ${err.message}`);
      return -1; // signal failure
    }
  }

  // ---------- On-chain (CTF contract) ----------------------------------------

  private getProvider(): any {
    const ethers5 = getEthers5();
    return new ethers5.providers.JsonRpcProvider("https://polygon-rpc.com");
  }

  private getSigner(): any {
    const ethers5 = getEthers5();
    return new ethers5.Wallet(this.opts.privateKey, this.getProvider());
  }

  /**
   * Get on-chain conditional token balance for the proxy wallet.
   * CTF is ERC1155: balanceOf(address, tokenId).
   */
  async getOnChainBalance(tokenId: string): Promise<number> {
    const ethers5 = getEthers5();
    const ctf = new ethers5.Contract(
      "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
      ["function balanceOf(address owner, uint256 id) view returns (uint256)"],
      this.getProvider(),
    );
    const bal = await ctf.balanceOf(this.opts.funder, tokenId);
    // CTF tokens have 6 decimals like USDC (actually they use raw units matching collateral)
    return parseFloat(ethers5.utils.formatUnits(bal, 6));
  }

  /**
   * Redeem resolved positions from the CTF contract.
   * Burns winning conditional tokens and returns USDC collateral.
   *
   * @param conditionId - The market's condition ID (bytes32 hex string)
   * @param indexSets - Outcome index sets to redeem. [1]=YES, [2]=NO, [1,2]=both
   * @returns Transaction hash
   */
  async redeemPositions(conditionId: string, indexSets: number[] = [1, 2]): Promise<string> {
    const ethers5 = getEthers5();
    const signer = this.getSigner();

    const ctfAbi = [
      "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external",
    ];
    const ctf = new ethers5.Contract("0x4D97DCd97eC945f40cF65F87097ACe5EA0476045", ctfAbi, signer);

    const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
    const ZERO_PARENT = ethers5.constants.HashZero;

    this.logger.info(
      `Redeeming positions for condition ${conditionId.slice(0, 16)}... indexSets=${JSON.stringify(indexSets)}`,
    );

    const tx = await ctf.redeemPositions(USDC_E, ZERO_PARENT, conditionId, indexSets);
    const receipt = await tx.wait();

    this.logger.info(
      `Redeemed! tx=${receipt.transactionHash} gasUsed=${receipt.gasUsed.toString()}`,
    );
    return receipt.transactionHash;
  }

  // ---------- Internal ------------------------------------------------------

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await withRetry(fn, 2, 500);
      this.consecutiveErrors = 0;
      return result;
    } catch (err: any) {
      this.consecutiveErrors++;
      this.logger.error(
        `CLOB API error (consecutive=${this.consecutiveErrors}): ${err.message ?? err}`,
      );
      throw err;
    }
  }

  getConsecutiveErrors(): number {
    return this.consecutiveErrors;
  }
}
