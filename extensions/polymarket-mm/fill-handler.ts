// ---------------------------------------------------------------------------
// Fill Handler: Capital recovery after order fills — v4 Market Exit
//
// When a BUY order gets filled, we accumulate inventory (position).
// This handler ensures capital gets recycled:
//
// 1. Low exposure (<40% capital):
//    - Place SELL limit at mid + spread (scoring + recovery)
//    - Urgency-based timeout (10s→5min based on price movement)
//
// 2. Medium exposure (40-70%):
//    - Widen spread 50%
//    - Market sell half positions
//
// 3. High exposure (>70%):
//    - Cancel all market orders (prevent new fills)
//    - Market sell all positions
//
// v4 improvements over v3:
//   - FAK market exit: partial fills tracked via balance query
//   - High exposure: cancel BUY orders before liquidation
//   - PendingSell merge: concurrent fills don't orphan SELL orders
//   - Faster timeout check: every 20s instead of 60s
// ---------------------------------------------------------------------------

import { OrderType, Side } from "@polymarket/clob-client";
import type { PluginLogger } from "../../src/plugins/types.js";
import type { PolymarketClient } from "./client.js";
import type { RiskController } from "./risk-controller.js";
import type { SpreadController } from "./spread-controller.js";
import type { StateManager } from "./state.js";
import type { MmConfig, MmMarket, TrackedOrder, FillEvent, PendingSell } from "./types.js";

export class FillHandler {
  private logger: PluginLogger;
  /** Condition IDs of currently active markets (set by engine). */
  private activeMarketIds: Set<string> = new Set();
  /** Risk controller reference for toxicity checks. */
  private riskController: RiskController | null = null;

  constructor(
    private client: PolymarketClient,
    private state: StateManager,
    private spreadController: SpreadController,
    private config: MmConfig,
    logger: PluginLogger,
  ) {
    this.logger = logger;
  }

  /** Inject risk controller for toxicity analysis (called by engine). */
  setRiskController(rc: RiskController): void {
    this.riskController = rc;
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
          `(retries=${ps.retryCount}, split=${ps.splitFactor}, urgency=${ps.urgency ?? "low"})`,
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
   * Check for timed-out pending sells and force-liquidate with
   * urgency-aware retry/split logic.
   *
   * Called every ~60 seconds from engine.
   */
  async checkTimeouts(): Promise<void> {
    const now = Date.now();
    const pending = this.state.getPendingSells();

    for (const [tokenId, ps] of Object.entries(pending)) {
      // Determine urgency (may update based on current price)
      const urgency = await this.updateUrgency(tokenId, ps);

      // Calculate required delay based on urgency
      const retryDelay = this.getRetryDelay(urgency, ps.retryCount);
      const initialTimeout = this.getInitialTimeout(urgency, ps.isScoring);

      const delaySinceLastAttempt = now - ps.lastAttemptAt;
      const requiredDelay = ps.retryCount === 0 ? initialTimeout : retryDelay;

      if (delaySinceLastAttempt < requiredDelay) continue;

      // Check current position
      const pos = this.state.getPosition(tokenId);
      if (!pos || pos.netShares <= 0) {
        this.logger.info(`Pending sell ${tokenId.slice(0, 10)}: position gone, cleaning up`);
        this.state.removePendingSell(tokenId);
        continue;
      }

      // Reward-aware hold: if scoring + low urgency, check if rewards outweigh risk
      if (ps.isScoring && urgency === "low" && ps.retryCount === 0) {
        const shouldHold = await this.shouldHoldForRewards(tokenId, ps);
        if (shouldHold) {
          this.logger.info(
            `Holding scoring SELL ${tokenId.slice(0, 10)} for rewards (urgency=${urgency})`,
          );
          continue;
        }
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

      const pendingSellAge = now - ps.placedAt;
      this.logger.info(
        `Force sell attempt: ${tokenId.slice(0, 10)} ${sharesToSell.toFixed(1)} shares ` +
          `(retry=${ps.retryCount}, split=${ps.splitFactor.toFixed(2)}, ` +
          `urgency=${urgency}, age=${(pendingSellAge / 60_000).toFixed(1)}min)`,
      );

      const result = await this.forceSell(tokenId, ps.conditionId, sharesToSell, pendingSellAge);

      if (result === "success" || result === "partial") {
        // Check if full position is now gone
        const posAfter = this.state.getPosition(tokenId);
        if (!posAfter || posAfter.netShares <= 0) {
          this.state.removePendingSell(tokenId);
        } else {
          // Update pending sell for remaining shares
          ps.shares = posAfter.netShares;
          ps.retryCount = result === "partial" ? ps.retryCount : 0;
          ps.lastAttemptAt = now;
          this.state.setPendingSell(tokenId, ps);
        }
      } else {
        // Failed — adapt retry strategy based on failure reason
        ps.retryCount++;
        ps.lastAttemptAt = now;

        if (result === "no_bids") {
          // No bids at all — wait longer before retrying (market illiquid)
          ps.lastAttemptAt = now + 120_000; // extra 2 min delay
        } else if (result === "insufficient_liquidity") {
          // Not enough depth — reduce split factor immediately
          const minSplit = this.config.forceSellMinSplitFactor;
          if (ps.splitFactor > minSplit) {
            ps.splitFactor *= 0.5;
            ps.retryCount = 0; // reset retries at new split level
          }
        }
        // "below_min_price" and "error" use standard retry progression

        const maxRetries = this.config.forceSellMaxRetriesPerSplit;
        const minSplit = this.config.forceSellMinSplitFactor;

        if (ps.retryCount >= maxRetries) {
          // Reduce split factor and reset retries
          if (ps.splitFactor > minSplit) {
            const newSplit = Math.max(ps.splitFactor * 0.5, minSplit);
            this.logger.warn(
              `Force sell exhausted retries at split=${ps.splitFactor.toFixed(2)}, reducing to ${newSplit.toFixed(2)}`,
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
            ps.lastAttemptAt = now + 300_000 - retryDelay;
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
  async forceSellPublic(
    tokenId: string,
    conditionId: string,
    shares: number,
    pendingSellAge = 0,
  ): Promise<boolean> {
    const result = await this.forceSell(tokenId, conditionId, shares, pendingSellAge);
    return result === "success" || result === "partial";
  }

  // ---- Internal -----------------------------------------------------------

  /**
   * Calculate exposure ratio including ALL positions with shares > 0.
   */
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

  /**
   * Determine urgency based on price movement since fill.
   * Updates the PendingSell urgency field.
   */
  private async updateUrgency(
    tokenId: string,
    ps: PendingSell,
  ): Promise<"low" | "medium" | "high" | "critical"> {
    const now = Date.now();
    const age = now - ps.placedAt;

    // Critical if very old (>10 min)
    if (age > this.config.maxPendingSellAgeMs) {
      ps.urgency = "critical";
      this.state.setPendingSell(tokenId, ps);
      return "critical";
    }

    // If we don't have fill midpoint, default to low
    if (!ps.fillMidpoint) {
      ps.urgency = ps.urgency ?? "low";
      return ps.urgency;
    }

    // Get current midpoint
    let currentMid: number;
    try {
      currentMid = await this.client.getMidpoint(tokenId);
      if (currentMid <= 0 || currentMid >= 1) {
        return ps.urgency ?? "low";
      }
    } catch {
      return ps.urgency ?? "low";
    }

    // Calculate price change since fill (negative = adverse for us)
    // We bought, so price dropping = bad
    const priceChange = (currentMid - ps.fillMidpoint) / ps.fillMidpoint;

    // Check toxicity from risk controller
    let isToxic = false;
    if (this.riskController) {
      const toxicity = this.riskController.analyzeToxicity(ps.conditionId);
      isToxic = toxicity.isToxic;
    }

    let urgency: "low" | "medium" | "high" | "critical";

    if (priceChange < -0.05) {
      urgency = "critical"; // >5% adverse
    } else if (priceChange < -0.03 || (isToxic && priceChange < -0.01)) {
      urgency = "high"; // 3-5% adverse, or toxic + 1%
    } else if (priceChange < -0.01) {
      urgency = "medium"; // 1-3% adverse
    } else {
      urgency = "low"; // favorable or flat
    }

    // Log urgency change
    if (urgency !== ps.urgency) {
      this.logger.info(
        `Urgency updated: ${tokenId.slice(0, 10)} ${ps.urgency ?? "new"} → ${urgency} ` +
          `(price Δ=${(priceChange * 100).toFixed(2)}%, toxic=${isToxic})`,
      );
    }

    ps.urgency = urgency;
    this.state.setPendingSell(tokenId, ps);
    return urgency;
  }

  /**
   * Get initial timeout before first force sell attempt, based on urgency.
   */
  private getInitialTimeout(
    urgency: "low" | "medium" | "high" | "critical",
    isScoring?: boolean,
  ): number {
    switch (urgency) {
      case "critical":
        return 10_000; // 10s
      case "high":
        return 30_000; // 30s
      case "medium":
        return 120_000; // 2min
      case "low":
        // If scoring, extend timeout to earn more rewards
        return isScoring ? 600_000 : this.config.fillRecoveryTimeoutMs; // 10min or 5min
    }
  }

  /**
   * Get retry delay based on urgency.
   */
  private getRetryDelay(
    urgency: "low" | "medium" | "high" | "critical",
    retryCount: number,
  ): number {
    switch (urgency) {
      case "critical":
        return this.config.forceSellUrgentRetryDelayMs; // 10s
      case "high":
        return 15_000; // 15s
      case "medium":
        return 15_000; // 15s
      case "low":
        return this.config.forceSellRetryDelayMs; // 30s
    }
  }

  /**
   * Check if we should hold a scoring SELL order for rewards.
   * Hold if: urgency=low + expected rewards > adverse price movement cost.
   */
  private async shouldHoldForRewards(tokenId: string, ps: PendingSell): Promise<boolean> {
    if (!ps.fillMidpoint || !ps.isScoring) return false;

    let currentMid: number;
    try {
      currentMid = await this.client.getMidpoint(tokenId);
      if (currentMid <= 0 || currentMid >= 1) return false;
    } catch {
      return false;
    }

    const priceChange = (currentMid - ps.fillMidpoint) / ps.fillMidpoint;

    // Any adverse movement >1% → don't hold, exit normally
    if (priceChange < -0.01) return false;

    // Still favorable or flat → hold for rewards
    return true;
  }

  private async handleLowExposure(
    order: TrackedOrder,
    fillSize: number,
    market: MmMarket,
  ): Promise<void> {
    this.logger.info(
      `Low exposure fill recovery: ${order.tokenId.slice(0, 10)} ${fillSize.toFixed(1)} shares`,
    );

    // Get current midpoint for urgency tracking
    let fillMidpoint: number | undefined;
    try {
      fillMidpoint = await this.client.getMidpoint(order.tokenId);
      if (fillMidpoint <= 0 || fillMidpoint >= 1) fillMidpoint = undefined;
    } catch {
      // non-critical
    }

    // Track pending sell with timeout — persisted to state
    // Merge with existing PendingSell if one exists (concurrent fills on same token)
    const now = Date.now();
    const existingPs = this.state.getPendingSells()[order.tokenId];
    if (existingPs) {
      // Merge: accumulate shares, keep existing sellOrderId and tracking
      existingPs.shares += fillSize;
      existingPs.fillMidpoint = fillMidpoint ?? existingPs.fillMidpoint;
      this.state.setPendingSell(order.tokenId, existingPs);
      this.logger.info(
        `Merged pending sell ${order.tokenId.slice(0, 10)}: +${fillSize.toFixed(1)} → ${existingPs.shares.toFixed(1)} total`,
      );
    } else {
      this.state.setPendingSell(order.tokenId, {
        tokenId: order.tokenId,
        conditionId: order.conditionId,
        shares: fillSize,
        placedAt: now,
        retryCount: 0,
        lastAttemptAt: now,
        splitFactor: 1.0,
        fillMidpoint,
        urgency: "low",
        isScoring: false, // will be set to true if SELL lands in scoring range
      });
    }

    // Place a SELL limit at midpoint + spread for extra scoring
    try {
      const mid = fillMidpoint ?? (await this.client.getMidpoint(order.tokenId));
      if (mid <= 0 || mid >= 1) return;

      const tick = parseFloat(market.tickSize);
      const spread = this.spreadController.calculateSpread(
        market.rewardsMaxSpread,
        market.conditionId,
        tick,
        market.negRisk,
        mid,
      );
      let askPrice = mid + spread;
      // Round up to tick grid
      const decimals = market.tickSize === "0.001" ? 3 : market.tickSize === "0.0001" ? 4 : 2;
      askPrice = parseFloat((Math.ceil(askPrice / tick) * tick).toFixed(decimals));
      askPrice = Math.min(askPrice, 1 - tick);

      if (askPrice <= mid || askPrice >= 1) return;

      // Check if SELL would be within scoring range
      const isInScoringRange = askPrice - mid <= market.rewardsMaxSpread;

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
          ps.isScoring = isInScoringRange;
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
          scoring: isInScoringRange,
          placedAt: Date.now(),
          level: 0,
        });

        this.logger.info(
          `Placed recovery SELL: ${fillSize.toFixed(1)} @ ${askPrice.toFixed(3)} ` +
            `(scoring=${isInScoringRange})`,
        );
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
      const result = await this.forceSell(order.tokenId, order.conditionId, sellShares);
      if (result !== "success") {
        // Track as pending sell for retry with medium urgency
        const now = Date.now();
        let fillMidpoint: number | undefined;
        try {
          fillMidpoint = await this.client.getMidpoint(order.tokenId);
          if (fillMidpoint <= 0 || fillMidpoint >= 1) fillMidpoint = undefined;
        } catch {
          /* non-critical */
        }

        this.state.setPendingSell(order.tokenId, {
          tokenId: order.tokenId,
          conditionId: order.conditionId,
          shares: available,
          placedAt: now,
          retryCount: 0,
          lastAttemptAt: now,
          splitFactor: 1.0,
          fillMidpoint,
          urgency: "medium",
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

    // Cancel all orders for this market first to prevent new BUY fills during liquidation
    try {
      await this.client.cancelMarketOrders(market.conditionId);
      // Clean up tracked orders
      const tracked = this.state.getMarketOrders(market.conditionId);
      for (const o of tracked) {
        this.state.removeOrder(o.orderId);
      }
      this.logger.info(
        `Cancelled all orders for ${market.conditionId.slice(0, 10)} before liquidation`,
      );
    } catch (err: any) {
      this.logger.warn(`Failed to cancel orders before liquidation: ${err.message}`);
    }

    // Only sell positions in THIS active market — not all positions globally
    for (const token of market.tokens) {
      const pos = this.state.getPosition(token.tokenId);
      if (pos && pos.netShares > 0) {
        const result = await this.forceSell(token.tokenId, market.conditionId, pos.netShares);
        if (result !== "success") {
          // Track as pending sell with high urgency
          const now = Date.now();
          let fillMidpoint: number | undefined;
          try {
            fillMidpoint = await this.client.getMidpoint(token.tokenId);
            if (fillMidpoint <= 0 || fillMidpoint >= 1) fillMidpoint = undefined;
          } catch {
            /* non-critical */
          }

          this.state.setPendingSell(token.tokenId, {
            tokenId: token.tokenId,
            conditionId: market.conditionId,
            shares: pos.netShares,
            placedAt: now,
            retryCount: 0,
            lastAttemptAt: now,
            splitFactor: 1.0,
            fillMidpoint,
            urgency: "high",
          });
        }
      }
    }
  }

  /**
   * Market sell via FAK with price floor gate and partial fill tracking.
   *
   * Strategy: check bestBid against floor → submit FAK at floor price →
   * query actual balance to determine real fill amount.
   *
   * Returns: "success" | "partial" | "no_bids" | "below_min_price" | "insufficient_liquidity" | "error"
   */
  private async forceSell(
    tokenId: string,
    conditionId: string,
    shares: number,
    pendingSellAge = 0,
  ): Promise<
    "success" | "partial" | "no_bids" | "below_min_price" | "insufficient_liquidity" | "error"
  > {
    if (shares <= 0) return "success";

    try {
      // Get current orderbook for bid liquidity check
      const book = await this.client.getOrderBook(tokenId);
      const bids = book.bids || [];
      // CLOB API returns bids ascending (lowest first) — best bid is LAST
      const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;

      if (bestBid <= 0 || bids.length === 0) {
        this.logger.warn(`Force sell ${tokenId.slice(0, 10)}: no bids available`);
        return "no_bids";
      }

      // Price floor gate: don't submit if market price is unacceptable
      const pos = this.state.getPosition(tokenId);
      const avgEntry = pos?.avgEntry ?? 0;
      const emergency = pendingSellAge > this.config.maxPendingSellAgeMs;

      const entryFloor = avgEntry * this.config.minSellPriceRatio;
      const minPrice = emergency ? 0.01 : entryFloor;

      if (bestBid < minPrice && minPrice > 0.01) {
        this.logger.warn(
          `Force sell ${tokenId.slice(0, 10)}: bestBid ${bestBid.toFixed(3)} below floor ` +
            `${minPrice.toFixed(3)} (entry=${avgEntry.toFixed(3)}×${this.config.minSellPriceRatio}, ` +
            `age=${(pendingSellAge / 1000).toFixed(0)}s, emergency=${emergency})`,
        );
        return "below_min_price";
      }

      if (emergency && bestBid < entryFloor) {
        this.logger.warn(
          `EMERGENCY sell ${tokenId.slice(0, 10)}: selling at ${bestBid.toFixed(3)} (below normal floor) ` +
            `after ${(pendingSellAge / 60_000).toFixed(1)}min stuck`,
        );
      }

      // Market sell: FAK at floor price sweeps all bids down to floor
      const sellPrice = Math.max(0.01, minPrice);
      const tickSize = (book.tick_size || "0.01") as import("@polymarket/clob-client").TickSize;
      const negRisk = book.neg_risk || false;
      const sharesBefore = pos?.netShares ?? shares;

      await this.client.createAndPostOrder(
        {
          tokenID: tokenId,
          price: sellPrice,
          size: shares,
          side: Side.SELL,
          feeRateBps: 0,
        },
        { tickSize, negRisk },
        OrderType.FAK,
        false, // NOT postOnly — we want to cross the spread
      );

      // Query actual balance to determine real fill (FAK may partially fill)
      let actualSold = shares; // assume full fill as fallback
      try {
        const remaining = await this.client.getConditionalBalance(tokenId);
        if (remaining >= 0) {
          actualSold = Math.max(0, sharesBefore - remaining);
        }
      } catch {
        // balance query failed — use assumed full fill (reconcile will fix later)
      }

      const isPartial = actualSold < shares * 0.99;

      this.logger.info(
        `Force SELL: ${actualSold.toFixed(1)}/${shares.toFixed(1)} shares of ${tokenId.slice(0, 10)} ` +
          `@ ${sellPrice} (FAK, bestBid=${bestBid.toFixed(3)}${isPartial ? ", PARTIAL" : ""})`,
      );

      // Update position tracking with actual sold amount
      if (actualSold > 0 && pos) {
        this.state.updatePosition(tokenId, conditionId, pos.outcome, actualSold, sellPrice, "SELL");
      }

      if (actualSold <= 0) return "insufficient_liquidity";
      return isPartial ? "partial" : "success";
    } catch (err: any) {
      this.logger.error(`Force sell failed for ${tokenId.slice(0, 10)}: ${err.message}`);
      return "error";
    }
  }
}
