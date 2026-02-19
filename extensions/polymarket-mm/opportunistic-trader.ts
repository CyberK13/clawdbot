// ---------------------------------------------------------------------------
// Opportunistic Trader: Detect price deviations and place directional bets
//
// When current price deviates significantly from fair value:
//   deviation = |current_price - fair_value| / fair_value
//   if deviation > threshold: place limit order toward fair value
// ---------------------------------------------------------------------------

import { OrderType, Side } from "@polymarket/clob-client";
import type { PluginLogger } from "../../src/plugins/types.js";
import type { PolymarketClient } from "./client.js";
import type { StateManager } from "./state.js";
import type { MmConfig, MmMarket, BookSnapshot } from "./types.js";
import { roundPrice, clampPrice, roundSize, usdcToShares } from "./utils.js";

/** Track VWAP for fair value estimation. */
interface VwapTracker {
  priceSum: number;
  volumeSum: number;
  samples: number;
  windowStart: number;
}

export class OpportunisticTrader {
  private logger: PluginLogger;
  private vwapTrackers: Map<string, VwapTracker> = new Map();
  /** Track recent opportunistic orders to avoid spamming. */
  private recentOrders: Map<string, number> = new Map(); // tokenId → timestamp
  /** Cooldown between opportunistic orders on same token. */
  private readonly COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private client: PolymarketClient,
    private state: StateManager,
    private config: MmConfig,
    logger: PluginLogger,
  ) {
    this.logger = logger;
  }

  /**
   * Update VWAP tracker with current price data.
   * Call this every tick to build fair value estimate.
   */
  updateFairValue(tokenId: string, price: number, volume: number): void {
    const now = Date.now();
    let tracker = this.vwapTrackers.get(tokenId);

    // Reset window every 30 minutes
    if (!tracker || now - tracker.windowStart > 30 * 60 * 1000) {
      tracker = { priceSum: 0, volumeSum: 0, samples: 0, windowStart: now };
      this.vwapTrackers.set(tokenId, tracker);
    }

    tracker.priceSum += price * volume;
    tracker.volumeSum += volume;
    tracker.samples++;
  }

  /**
   * Get estimated fair value for a token.
   * Uses VWAP if available, falls back to midpoint.
   */
  getFairValue(tokenId: string, currentMidpoint: number): number {
    const tracker = this.vwapTrackers.get(tokenId);
    if (tracker && tracker.volumeSum > 0 && tracker.samples >= 5) {
      const vwap = tracker.priceSum / tracker.volumeSum;
      // Blend VWAP with current midpoint (70% VWAP, 30% current)
      return vwap * 0.7 + currentMidpoint * 0.3;
    }
    return currentMidpoint;
  }

  /**
   * Check for and execute opportunistic trades across all markets.
   */
  async checkOpportunities(markets: MmMarket[], books: Map<string, BookSnapshot>): Promise<number> {
    let tradesPlaced = 0;

    for (const market of markets) {
      for (const token of market.tokens) {
        const book = books.get(token.tokenId);
        if (!book) continue;

        // Update VWAP with current midpoint (use midpoint as proxy for volume)
        this.updateFairValue(token.tokenId, book.midpoint, 1);

        // Check for deviation
        const fairValue = this.getFairValue(token.tokenId, book.midpoint);
        const currentPrice = book.midpoint;

        if (fairValue <= 0) continue;
        const deviation = Math.abs(currentPrice - fairValue) / fairValue;

        if (deviation >= this.config.deviationThreshold) {
          const placed = await this.placeOpportunisticOrder(
            market,
            token.tokenId,
            currentPrice,
            fairValue,
          );
          if (placed) tradesPlaced++;
        }
      }
    }

    return tradesPlaced;
  }

  private async placeOpportunisticOrder(
    market: MmMarket,
    tokenId: string,
    currentPrice: number,
    fairValue: number,
  ): Promise<boolean> {
    // Check cooldown
    const lastOrder = this.recentOrders.get(tokenId);
    if (lastOrder && Date.now() - lastOrder < this.COOLDOWN_MS) return false;

    // Direction: buy if price below fair value, sell if above
    const side = currentPrice < fairValue ? "BUY" : "SELL";
    const price = roundPrice(clampPrice(currentPrice, market.tickSize), market.tickSize, side);

    const shares = usdcToShares(this.config.opportunisticSize, price);
    const roundedShares = roundSize(shares, market.tickSize);

    if (roundedShares <= 0) return false;

    try {
      // Use GTD with 1-hour expiry for opportunistic orders
      const expiration = Math.floor(Date.now() / 1000) + 3600 + 60; // +1h +60s safety

      const result = await this.client.createAndPostOrder(
        {
          tokenID: tokenId,
          price,
          size: roundedShares,
          side: side === "BUY" ? Side.BUY : Side.SELL,
          feeRateBps: 0,
          expiration,
        },
        {
          tickSize: market.tickSize,
          negRisk: market.negRisk,
        },
        OrderType.GTD,
        false, // not postOnly — we want to cross if favorable
      );

      this.recentOrders.set(tokenId, Date.now());

      const deviation = Math.abs(currentPrice - fairValue) / fairValue;
      this.logger.info(
        `🎯 机会交易: ${side} ${roundedShares.toFixed(1)} shares @ ${price} ` +
          `(偏差 ${(deviation * 100).toFixed(1)}%, fair=${fairValue.toFixed(3)})`,
      );

      return true;
    } catch (err: any) {
      this.logger.warn(`机会交易失败: ${side} ${tokenId.slice(0, 10)}… @ ${price}: ${err.message}`);
      return false;
    }
  }
}
