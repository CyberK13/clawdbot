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
//
// Safety features (v2):
//   - pendingSells persisted to state (survives restart)
//   - Min price protection (won't sell below avgEntry * minSellPriceRatio)
//   - Retry with exponential backoff + split progression (100% → 50% → 25%)
//   - Liquidity check before FOK to avoid rejection on thin books
// ---------------------------------------------------------------------------

import { OrderType, Side } from "@polymarket/clob-client";
import type { PluginLogger } from "../../src/plugins/types.js";
import type { PolymarketClient } from "./client.js";
import type { SpreadController } from "./spread-controller.js";
import type { StateManager } from "./state.js";
import type { MmConfig, MmMarket, TrackedOrder, FillEvent, PendingSell } from "./types.js";

export class FillHandler {
  private logger: PluginLogger;
  /** Condition IDs of currently active markets (set by engine). */
  private activeMarketIds: Set<string> = new Set();

  constructor(
    private client: PolymarketClient,
    private state: StateManager,
    private spreadController: SpreadController,
    private config: MmConfig,
    logger: PluginLogger,
  ) {
    this.logger = logger;
  }

  /** Update the set of active market condition IDs (called by engine on scan). */
  setActiveMarkets(conditionIds: string[]): void {
    this.activeMarketIds = new Set(conditionIds);
  }

  /**
   * Restore pending sells from persisted state on startup.
   * Validates each against current position, cleans stale entries.
   */
  async restorePendingSells(): Promise<void> {
    const pending = this.state.getPendingSells();
    const keys = Object.keys(pending);
    if (keys.length === 0) return;

    this.logger.info(`Restoring ${keys.length} pending sells from state...`);

    for (const tokenId of keys) {
      const ps = pending[tokenId];
      const pos = this.state.getPosition(tokenId);

      if (!pos || pos.netShares <= 0) {
        // Position no longer exists — clean up
        this.logger.info(
          `Pending sell for ${tokenId.slice(0, 10)} no longer has position, removing`,
        );
        this.state.removePendingSell(tokenId);
        continue;
      }

      // Update shares to match actual position (may have changed)
      if (pos.netShares < ps.shares) {
        this.logger.info(
          `Pending sell ${tokenId.slice(0, 10)}: adjusting shares ${ps.shares.toFixed(1)} → ${pos.netShares.toFixed(1)}`,
        );
        ps.shares = pos.netShares;
        this.state.setPendingSell(tokenId, ps);
      }

      // Clear stale sellOrderId — the limit order is gone after restart
      if (ps.sellOrderId) {
        ps.sellOrderId = undefined;
        this.state.setPendingSell(tokenId, ps);
      }

      this.logger.info(
        `Restored pending sell: ${tokenId.slice(0, 10)} ${ps.shares.toFixed(1)} shares ` +
          `(retries=${ps.retryCount}, split=${ps.splitFactor})`,
      );
    }

    this.state.forceSave();
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
    this.logger.info(
      `Exposure ratio: ${(exposureRatio * 100).toFixed(1)}% (active markets only, ` +
        `thresholds: soft=${(this.config.maxExposureForSoftSell * 100).toFixed(0)}%, ` +
        `hard=${(this.config.maxExposureForHardSell * 100).toFixed(0)}%)`,
    );

    if (exposureRatio > this.config.maxExposureForHardSell) {
      await this.handleHighExposure(market);
    } else if (exposureRatio > this.config.maxExposureForSoftSell) {
      await this.handleMediumExposure(order, fillSize, market);
    } else {
      await this.handleLowExposure(order, fillSize, market);
    }
  }

  /**
   * Check for timed-out pending sells and force-liquidate with retry/split logic.
   * Called every ~60 seconds from engine.
   */
  async checkTimeouts(): Promise<void> {
    const now = Date.now();
    const pending = this.state.getPendingSells();

    for (const [tokenId, ps] of Object.entries(pending)) {
      // Check if enough time has passed since last attempt
      const delaySinceLastAttempt = now - ps.lastAttemptAt;
      const requiredDelay =
        ps.retryCount === 0
          ? this.config.fillRecoveryTimeoutMs
          : this.config.forceSellRetryDelayMs * Math.min(ps.retryCount, 5); // exponential cap at 5x

      if (delaySinceLastAttempt < requiredDelay) continue;

      // Check current position
      const pos = this.state.getPosition(tokenId);
      if (!pos || pos.netShares <= 0) {
        this.logger.info(`Pending sell ${tokenId.slice(0, 10)}: position gone, cleaning up`);
        this.state.removePendingSell(tokenId);
        continue;
      }

      // Cancel the limit SELL if it exists
      if (ps.sellOrderId) {
        try {
          await this.client.cancelOrder(ps.sellOrderId);
          this.state.removeOrder(ps.sellOrderId);
        } catch {
          // may already be filled or cancelled
        }
        ps.sellOrderId = undefined;
      }

      // Calculate shares to sell based on split factor
      const sharesToSell = Math.min(pos.netShares * ps.splitFactor, pos.netShares);
      if (sharesToSell <= 0) {
        this.state.removePendingSell(tokenId);
        continue;
      }

      this.logger.info(
        `Force sell attempt: ${tokenId.slice(0, 10)} ${sharesToSell.toFixed(1)} shares ` +
          `(retry=${ps.retryCount}, split=${ps.splitFactor})`,
      );

      const success = await this.forceSell(tokenId, ps.conditionId, sharesToSell);

      if (success) {
        // Check if full position is now gone
        const posAfter = this.state.getPosition(tokenId);
        if (!posAfter || posAfter.netShares <= 0) {
          this.state.removePendingSell(tokenId);
        } else {
          // Update pending sell for remaining shares
          ps.shares = posAfter.netShares;
          ps.retryCount = 0;
          ps.lastAttemptAt = now;
          this.state.setPendingSell(tokenId, ps);
        }
      } else {
        // Failed — advance retry/split progression
        ps.retryCount++;
        ps.lastAttemptAt = now;

        if (ps.retryCount >= this.config.forceSellMaxRetries) {
          // Reduce split factor and reset retries
          if (ps.splitFactor > 0.25) {
            const newSplit = ps.splitFactor * 0.5;
            this.logger.warn(
              `Force sell exhausted retries at split=${ps.splitFactor}, reducing to ${newSplit.toFixed(2)}`,
            );
            ps.splitFactor = newSplit;
            ps.retryCount = 0;
          } else {
            // At minimum split — reset with long delay (don't fully give up)
            this.logger.warn(
              `Force sell exhausted all split levels for ${tokenId.slice(0, 10)}, resetting with long delay`,
            );
            ps.splitFactor = 1.0;
            ps.retryCount = 0;
            // Set lastAttemptAt far enough that next retry is delayed by 5 min
            ps.lastAttemptAt = now + 300_000 - this.config.forceSellRetryDelayMs;
          }
        }

        this.state.setPendingSell(tokenId, ps);
      }
    }
  }

  /**
   * Public forceSell wrapper for engine liquidation / orphan selling.
   * Returns true if the sell succeeded.
   */
  async forceSellPublic(tokenId: string, conditionId: string, shares: number): Promise<boolean> {
    return this.forceSell(tokenId, conditionId, shares);
  }

  // ---- Internal -----------------------------------------------------------

  /**
   * Calculate exposure ratio considering ONLY positions in active markets.
   * Stale positions from resolved/expired markets are excluded to prevent
   * false high-exposure triggers.
   */
  private getExposureRatio(): number {
    const st = this.state.get();
    let totalExposure = 0;
    for (const pos of Object.values(st.positions)) {
      if (pos.netShares > 0 && this.activeMarketIds.has(pos.conditionId)) {
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

    // Track pending sell with timeout — persisted to state
    const now = Date.now();
    this.state.setPendingSell(order.tokenId, {
      tokenId: order.tokenId,
      conditionId: order.conditionId,
      shares: fillSize,
      placedAt: now,
      retryCount: 0,
      lastAttemptAt: now,
      splitFactor: 1.0,
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
        const ps = this.state.getPendingSells()[order.tokenId];
        if (ps) {
          ps.sellOrderId = sellId;
          this.state.setPendingSell(order.tokenId, ps);
        }

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
    this.logger.warn(
      `Medium exposure fill recovery: widening spread + partial sell ` +
        `(${order.tokenId.slice(0, 10)}, ${fillSize.toFixed(1)} shares)`,
    );

    // Widen spread
    this.spreadController.widenSpread(order.conditionId, 1.5);

    // FOK sell half the filled amount — only from the token that was just filled
    const pos = this.state.getPosition(order.tokenId);
    const available = pos ? Math.max(0, pos.netShares) : 0;
    const sellShares = Math.min(fillSize * 0.5, available);
    if (sellShares > 0) {
      const success = await this.forceSell(order.tokenId, order.conditionId, sellShares);
      if (!success) {
        // Track as pending sell for retry
        const now = Date.now();
        this.state.setPendingSell(order.tokenId, {
          tokenId: order.tokenId,
          conditionId: order.conditionId,
          shares: available,
          placedAt: now,
          retryCount: 0,
          lastAttemptAt: now,
          splitFactor: 1.0,
        });
      }
    } else {
      this.logger.warn(`No shares available to sell for ${order.tokenId.slice(0, 10)}`);
    }
  }

  private async handleHighExposure(market: MmMarket): Promise<void> {
    this.logger.warn(
      `HIGH exposure! Liquidating positions for market ${market.conditionId.slice(0, 10)}`,
    );

    // Only sell positions in THIS active market — not all positions globally
    for (const token of market.tokens) {
      const pos = this.state.getPosition(token.tokenId);
      if (pos && pos.netShares > 0) {
        const success = await this.forceSell(token.tokenId, market.conditionId, pos.netShares);
        if (!success) {
          // Track as pending sell for retry
          const now = Date.now();
          this.state.setPendingSell(token.tokenId, {
            tokenId: token.tokenId,
            conditionId: market.conditionId,
            shares: pos.netShares,
            placedAt: now,
            retryCount: 0,
            lastAttemptAt: now,
            splitFactor: 1.0,
          });
        }
      }
    }
  }

  /**
   * FOK market sell with min price protection and liquidity check.
   * Returns true if the sell succeeded.
   */
  private async forceSell(tokenId: string, conditionId: string, shares: number): Promise<boolean> {
    if (shares <= 0) return true;

    try {
      // Get current orderbook for bid liquidity check
      const book = await this.client.getOrderBook(tokenId);
      const bids = book.bids || [];
      const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;

      if (bestBid <= 0 || bids.length === 0) {
        this.logger.warn(`Force sell ${tokenId.slice(0, 10)}: no bids available`);
        return false;
      }

      // Min price protection: don't sell below avgEntry * minSellPriceRatio
      const pos = this.state.getPosition(tokenId);
      const avgEntry = pos?.avgEntry ?? 0;
      const minPrice = avgEntry * this.config.minSellPriceRatio;
      if (bestBid < minPrice && minPrice > 0.01) {
        this.logger.warn(
          `Force sell ${tokenId.slice(0, 10)}: bestBid ${bestBid.toFixed(3)} below min price ` +
            `${minPrice.toFixed(3)} (entry=${avgEntry.toFixed(3)} × ratio=${this.config.minSellPriceRatio})`,
        );
        return false;
      }

      // Check available bid liquidity (sum of bid sizes up to our sell amount)
      let availableLiquidity = 0;
      for (const bid of bids) {
        availableLiquidity += parseFloat(bid.size);
        if (availableLiquidity >= shares) break;
      }

      // Sell only what liquidity allows (with 5% safety margin)
      const maxSellable = availableLiquidity * 0.95;
      const actualShares = Math.min(shares, maxSellable);
      if (actualShares < 1) {
        this.logger.warn(
          `Force sell ${tokenId.slice(0, 10)}: insufficient liquidity (${availableLiquidity.toFixed(1)} available, need ${shares.toFixed(1)})`,
        );
        return false;
      }

      // Use FOK at slightly below best bid to ensure fill
      const sellPrice = Math.max(0.01, bestBid - 0.01);
      const tickSize = (book.tick_size || "0.01") as import("@polymarket/clob-client").TickSize;
      const negRisk = book.neg_risk || false;

      await this.client.createAndPostOrder(
        {
          tokenID: tokenId,
          price: sellPrice,
          size: actualShares,
          side: Side.SELL,
          feeRateBps: 0,
        },
        { tickSize, negRisk },
        OrderType.FOK,
        false, // NOT postOnly — we want to cross the spread
      );

      this.logger.info(
        `Force SELL: ${actualShares.toFixed(1)} shares of ${tokenId.slice(0, 10)} @ ${sellPrice} (FOK)`,
      );

      // Update position tracking
      if (pos) {
        this.state.updatePosition(
          tokenId,
          conditionId,
          pos.outcome,
          actualShares,
          sellPrice,
          "SELL",
        );
      }

      return true;
    } catch (err: any) {
      this.logger.error(`Force sell failed for ${tokenId.slice(0, 10)}: ${err.message}`);
      return false;
    }
  }
}
