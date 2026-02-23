// ---------------------------------------------------------------------------
// Fill Handler: Capital recovery after order fills
//
// When a BUY order gets filled, we accumulate inventory (position).
// This handler ensures capital gets recycled:
//
// 1. Low exposure (<30% capital):
//    - Immediately re-place BUY orders (keep scoring)
//    - Place SELL limit at mid + spread (extra scoring from ASK side)
//    - After timeout: FOK market sell if limit SELL didn't fill
//
// 2. Medium exposure (30-50%):
//    - Widen spread 50%
//    - FOK sell some positions immediately
//    - Re-place BUY at wider spread
//
// 3. High exposure (>50%):
//    - Cancel all orders
//    - FOK sell all positions
//    - Wait for capital recovery, restart with defensive spread
// ---------------------------------------------------------------------------

import { OrderType, Side } from "@polymarket/clob-client";
import type { PluginLogger } from "../../src/plugins/types.js";
import type { PolymarketClient } from "./client.js";
import type { SpreadController } from "./spread-controller.js";
import type { StateManager } from "./state.js";
import type { MmConfig, MmMarket, TrackedOrder, FillEvent } from "./types.js";

interface PendingSell {
  tokenId: string;
  conditionId: string;
  shares: number;
  placedAt: number;
  sellOrderId?: string; // limit SELL order ID if placed
}

export class FillHandler {
  private logger: PluginLogger;
  private pendingSells: Map<string, PendingSell> = new Map(); // key = tokenId

  constructor(
    private client: PolymarketClient,
    private state: StateManager,
    private spreadController: SpreadController,
    private config: MmConfig,
    logger: PluginLogger,
  ) {
    this.logger = logger;
  }

  /**
   * Handle a detected fill. Determine exposure level and respond.
   */
  async handleFill(
    order: TrackedOrder,
    fillSize: number,
    market: MmMarket | undefined,
  ): Promise<void> {
    if (order.side !== "BUY" || fillSize <= 0) return;

    // Record fill event for spread controller
    const fillEvent: FillEvent = {
      orderId: order.orderId,
      tokenId: order.tokenId,
      conditionId: order.conditionId,
      side: order.side,
      price: order.price,
      size: fillSize,
      timestamp: Date.now(),
    };
    this.state.recordFill(fillEvent);

    if (!market) return;

    const exposureRatio = this.getExposureRatio();

    if (exposureRatio > this.config.maxExposureForHardSell) {
      await this.handleHighExposure(market);
    } else if (exposureRatio > this.config.maxExposureForSoftSell) {
      await this.handleMediumExposure(order, fillSize, market);
    } else {
      await this.handleLowExposure(order, fillSize, market);
    }
  }

  /**
   * Check for timed-out pending sells and force-liquidate.
   * Called every ~60 seconds from engine.
   */
  async checkTimeouts(): Promise<void> {
    const now = Date.now();

    for (const [tokenId, pending] of this.pendingSells) {
      if (now - pending.placedAt < this.config.fillRecoveryTimeoutMs) continue;

      this.logger.info(
        `Fill recovery timeout: ${tokenId.slice(0, 10)} — force selling ${pending.shares.toFixed(1)} shares`,
      );

      // Cancel the limit SELL if it exists
      if (pending.sellOrderId) {
        try {
          await this.client.cancelOrder(pending.sellOrderId);
          this.state.removeOrder(pending.sellOrderId);
        } catch {
          // may already be filled or cancelled
        }
      }

      // Check current balance before attempting sell
      const pos = this.state.getPosition(tokenId);
      if (!pos || pos.netShares <= 0) {
        this.pendingSells.delete(tokenId);
        continue;
      }

      // FOK market sell remaining shares
      await this.forceSell(tokenId, pending.conditionId, pos.netShares);
      this.pendingSells.delete(tokenId);
    }
  }

  // ---- Internal -----------------------------------------------------------

  private getExposureRatio(): number {
    const st = this.state.get();
    let totalExposure = 0;
    for (const pos of Object.values(st.positions)) {
      if (pos.netShares > 0) {
        totalExposure += pos.netShares * pos.avgEntry;
      }
    }
    return totalExposure / this.config.totalCapital;
  }

  private async handleLowExposure(
    order: TrackedOrder,
    fillSize: number,
    market: MmMarket,
  ): Promise<void> {
    this.logger.info(
      `Low exposure fill recovery: ${order.tokenId.slice(0, 10)} ${fillSize.toFixed(1)} shares`,
    );

    // Track pending sell with timeout
    this.pendingSells.set(order.tokenId, {
      tokenId: order.tokenId,
      conditionId: order.conditionId,
      shares: fillSize,
      placedAt: Date.now(),
    });

    // Place a SELL limit at midpoint + spread for extra scoring
    // (ASK on YES contributes to Q_two, ASK on NO to Q_one)
    try {
      const mid = await this.client.getMidpoint(order.tokenId);
      if (mid <= 0 || mid >= 1) return;

      const tick = parseFloat(market.tickSize);
      const spread = this.spreadController.calculateSpread(
        market.rewardsMaxSpread,
        market.conditionId,
        tick,
        market.negRisk,
      );
      let askPrice = mid + spread;
      // Round up to tick grid
      const decimals = market.tickSize === "0.001" ? 3 : market.tickSize === "0.0001" ? 4 : 2;
      askPrice = parseFloat((Math.ceil(askPrice / tick) * tick).toFixed(decimals));
      askPrice = Math.min(askPrice, 1 - tick);

      if (askPrice <= mid || askPrice >= 1) return;

      const result = await this.client.createAndPostOrder(
        {
          tokenID: order.tokenId,
          price: askPrice,
          size: fillSize,
          side: Side.SELL,
          feeRateBps: 0,
        },
        { tickSize: market.tickSize, negRisk: market.negRisk },
        OrderType.GTC,
        true, // postOnly
      );

      const sellId = result?.orderID || result?.orderHashes?.[0];
      if (sellId) {
        const pending = this.pendingSells.get(order.tokenId);
        if (pending) pending.sellOrderId = sellId;

        this.state.trackOrder({
          orderId: sellId,
          tokenId: order.tokenId,
          conditionId: order.conditionId,
          side: "SELL",
          price: askPrice,
          originalSize: fillSize,
          filledSize: 0,
          status: "live",
          scoring: false,
          placedAt: Date.now(),
          level: 0,
        });

        this.logger.info(`Placed recovery SELL: ${fillSize.toFixed(1)} @ ${askPrice.toFixed(3)}`);
      }
    } catch (err: any) {
      this.logger.warn(`Failed to place recovery SELL: ${err.message}`);
    }
  }

  private async handleMediumExposure(
    order: TrackedOrder,
    fillSize: number,
    market: MmMarket,
  ): Promise<void> {
    this.logger.warn(`Medium exposure fill recovery: widening spread + partial sell`);

    // Widen spread
    this.spreadController.widenSpread(order.conditionId, 1.5);

    // FOK sell half the filled amount
    const sellShares = fillSize * 0.5;
    await this.forceSell(order.tokenId, order.conditionId, sellShares);
  }

  private async handleHighExposure(market: MmMarket): Promise<void> {
    this.logger.warn(
      `HIGH exposure! Liquidating all positions for ${market.conditionId.slice(0, 10)}`,
    );

    // Sell all positions in this market
    for (const token of market.tokens) {
      const pos = this.state.getPosition(token.tokenId);
      if (pos && pos.netShares > 0) {
        await this.forceSell(token.tokenId, market.conditionId, pos.netShares);
      }
    }
  }

  /**
   * FOK market sell — accepts best available price.
   */
  private async forceSell(tokenId: string, conditionId: string, shares: number): Promise<void> {
    if (shares <= 0) return;

    try {
      // Get current best bid to set a reasonable floor price
      const book = await this.client.getOrderBook(tokenId);
      const bids = book.bids || [];
      const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0.01;

      // Use FOK at slightly below best bid to ensure fill
      const sellPrice = Math.max(0.01, bestBid - 0.01);
      const tickSize = (book.tick_size || "0.01") as import("@polymarket/clob-client").TickSize;
      const negRisk = book.neg_risk || false;

      const result = await this.client.createAndPostOrder(
        {
          tokenID: tokenId,
          price: sellPrice,
          size: shares,
          side: Side.SELL,
          feeRateBps: 0,
        },
        { tickSize, negRisk },
        OrderType.FOK,
        false, // NOT postOnly — we want to cross the spread
      );

      this.logger.info(
        `Force SELL: ${shares.toFixed(1)} shares of ${tokenId.slice(0, 10)} @ ${sellPrice} (FOK)`,
      );

      // Update position tracking
      const pos = this.state.getPosition(tokenId);
      if (pos) {
        this.state.updatePosition(tokenId, conditionId, pos.outcome, shares, sellPrice, "SELL");
      }
    } catch (err: any) {
      this.logger.error(`Force sell failed for ${tokenId.slice(0, 10)}: ${err.message}`);
    }
  }
}
