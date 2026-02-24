// ---------------------------------------------------------------------------
// Fill Handler: Livermore Trailing Stop Exit System
//
// After a BUY fill, positions are managed with a simple trailing stop:
//   1. Hard stop: price drops >2% below entry → immediate market sell
//   2. Trailing activation: price rises >1% above entry
//   3. Trailing stop: price drops >1% from peak → market sell
//
// All sells are FAK @ bestBid (pure market sells, no floor protection).
// We're earning rewards, not betting — minimize loss exposure.
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
  /** Callback to engine for auto-redeeming resolved market positions. */
  private redeemCallback: ((conditionId: string) => Promise<void>) | null = null;

  constructor(
    private client: PolymarketClient,
    private state: StateManager,
    private _spreadController: SpreadController,
    private config: MmConfig,
    logger: PluginLogger,
  ) {
    this.logger = logger;
  }

  /** Inject risk controller (called by engine). */
  setRiskController(rc: RiskController): void {
    this.riskController = rc;
  }

  /** Inject redeem callback (called by engine). */
  setRedeemCallback(cb: (conditionId: string) => Promise<void>): void {
    this.redeemCallback = cb;
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
        this.state.removePendingSell(tokenId);
        continue;
      }

      if (pos.netShares < ps.shares) {
        ps.shares = pos.netShares;
        this.state.setPendingSell(tokenId, ps);
      }

      // Clear stale sellOrderId — the limit order is gone after restart
      if (ps.sellOrderId) {
        ps.sellOrderId = undefined;
        this.state.setPendingSell(tokenId, ps);
      }

      this.logger.info(
        `Restored pending sell: ${tokenId.slice(0, 10)} ${ps.shares.toFixed(1)} shares (retries=${ps.retryCount})`,
      );
    }

    this.state.forceSave();
  }

  /**
   * Handle a detected BUY fill. Initialize trailing peak on position.
   */
  async handleFill(
    order: TrackedOrder,
    fillSize: number,
    market: MmMarket | undefined,
    currentMid?: number,
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

    // Initialize trailing peak on position
    const pos = this.state.getPosition(order.tokenId);
    if (pos) {
      const mid = currentMid ?? order.price;
      if (!pos.trailingPeak || pos.trailingPeak <= 0) {
        pos.trailingPeak = mid;
      } else {
        pos.trailingPeak = Math.max(pos.trailingPeak, mid);
      }
      this.state.markDirty();

      const hardStop = pos.avgEntry * (1 - this.config.trailingStopLoss);
      const activation = pos.avgEntry * (1 + this.config.trailingActivation);
      this.logger.info(
        `📍 Trailing stop: ${pos.outcome} ${pos.netShares.toFixed(1)} shares ` +
          `entry=${pos.avgEntry.toFixed(4)}, peak=${pos.trailingPeak.toFixed(4)}, ` +
          `hardStop=${hardStop.toFixed(4)}, activation=${activation.toFixed(4)}`,
      );
    }
  }

  /**
   * Check trailing stops for all positions. Called every tick (5s).
   *
   * Logic:
   *   1. Update trailingPeak = max(peak, currentMid)
   *   2. Hard stop: mid < entry × (1 - stopLoss) → sell
   *   3. Trailing: if peak > entry × (1 + activation) AND mid < peak × (1 - distance) → sell
   */
  async checkTrailingStops(priceMap: Map<string, number>): Promise<void> {
    const positions = this.state.get().positions;

    for (const [tokenId, pos] of Object.entries(positions)) {
      if (pos.netShares <= 0) continue;

      // Skip if already has a pending sell (being processed)
      const pendingSells = this.state.getPendingSells();
      if (pendingSells[tokenId]) continue;

      const currentMid = priceMap.get(tokenId);
      if (!currentMid || currentMid <= 0 || currentMid >= 1) continue;

      // Update trailing peak
      if (!pos.trailingPeak || pos.trailingPeak <= 0) {
        pos.trailingPeak = currentMid;
      } else {
        pos.trailingPeak = Math.max(pos.trailingPeak, currentMid);
      }
      this.state.markDirty();

      const entry = pos.avgEntry;
      if (entry <= 0) continue;

      const pctFromEntry = ((currentMid - entry) / entry) * 100;
      const hardStopPrice = entry * (1 - this.config.trailingStopLoss);
      const activationPrice = entry * (1 + this.config.trailingActivation);
      const trailingStopPrice = pos.trailingPeak * (1 - this.config.trailingDistance);

      // 1. Hard stop loss
      if (currentMid <= hardStopPrice) {
        this.logger.warn(
          `🔴 硬止损: ${pos.outcome} ${pos.netShares.toFixed(1)} shares ` +
            `mid=${currentMid.toFixed(4)} <= stop=${hardStopPrice.toFixed(4)} ` +
            `(entry=${entry.toFixed(4)}, ${pctFromEntry.toFixed(2)}%)`,
        );
        await this.triggerSell(tokenId, pos.conditionId, pos.netShares, "hard_stop");
        continue;
      }

      // 2. Trailing stop (only after activation)
      if (pos.trailingPeak > activationPrice && currentMid <= trailingStopPrice) {
        const pctFromPeak = ((pos.trailingPeak - currentMid) / pos.trailingPeak) * 100;
        this.logger.warn(
          `📉 追踪止损: ${pos.outcome} ${pos.netShares.toFixed(1)} shares ` +
            `mid=${currentMid.toFixed(4)} <= peak×${(1 - this.config.trailingDistance).toFixed(3)}` +
            `=${trailingStopPrice.toFixed(4)} ` +
            `(peak=${pos.trailingPeak.toFixed(4)}, 回撤=${pctFromPeak.toFixed(2)}%, 涨幅=${pctFromEntry.toFixed(2)}%)`,
        );
        await this.triggerSell(tokenId, pos.conditionId, pos.netShares, "trailing_stop");
        continue;
      }
    }
  }

  /**
   * Check pending sells and retry. Simple: retry every 15s.
   * Called every ~20s from engine.
   */
  async checkTimeouts(): Promise<void> {
    const now = Date.now();
    const pending = this.state.getPendingSells();

    for (const [tokenId, ps] of Object.entries(pending)) {
      // Retry every 15s
      if (now - ps.lastAttemptAt < 15_000) continue;

      const pos = this.state.getPosition(tokenId);
      if (!pos || pos.netShares <= 0) {
        this.state.removePendingSell(tokenId);
        continue;
      }

      const sharesToSell = Math.min(ps.shares, pos.netShares);
      if (sharesToSell <= 0) {
        this.state.removePendingSell(tokenId);
        continue;
      }

      this.logger.info(
        `Pending sell retry: ${tokenId.slice(0, 10)} ${sharesToSell.toFixed(1)} shares (retry=${ps.retryCount})`,
      );

      const result = await this.forceSell(tokenId, ps.conditionId, sharesToSell);

      if (result === "success" || result === "partial") {
        const posAfter = this.state.getPosition(tokenId);
        if (!posAfter || posAfter.netShares <= 0) {
          this.state.removePendingSell(tokenId);
        } else {
          ps.shares = posAfter.netShares;
          ps.retryCount = 0;
          ps.lastAttemptAt = now;
          this.state.setPendingSell(tokenId, ps);
        }
      } else {
        ps.retryCount++;
        ps.lastAttemptAt = now;

        // No bids = illiquid market, wait longer
        if (result === "no_bids") {
          ps.lastAttemptAt = now + 120_000;

          // After 3+ consecutive no_bids, check if market resolved → auto-redeem
          if (ps.retryCount >= 3 && this.redeemCallback) {
            const redeemed = await this.tryAutoRedeem(tokenId, ps);
            if (redeemed) continue;
          }
        }

        this.state.setPendingSell(tokenId, ps);
      }
    }
  }

  /**
   * Public forceSell wrapper for engine liquidation / orphan selling.
   */
  async forceSellPublic(
    tokenId: string,
    conditionId: string,
    shares: number,
    _pendingSellAge = 0,
    _forceEmergency = false,
  ): Promise<boolean> {
    const result = await this.forceSell(tokenId, conditionId, shares);
    return result === "success" || result === "partial";
  }

  // ---- Internal -----------------------------------------------------------

  /**
   * Check if a market is resolved and auto-redeem if so.
   * Called after 3+ consecutive no_bids in pending sell retry.
   */
  private async tryAutoRedeem(tokenId: string, ps: PendingSell): Promise<boolean> {
    if (!this.redeemCallback) return false;
    try {
      const market = await this.client.getMarket(ps.conditionId);
      const endDate = market?.end_date_iso || market?.end_date;
      const isResolved = !market?.active || (endDate && new Date(endDate).getTime() < Date.now());

      if (!isResolved) return false;

      this.logger.info(`🏦 市场已结算, 自动赎回 ${ps.conditionId.slice(0, 16)}...`);
      await this.redeemCallback(ps.conditionId);
      this.state.removePendingSell(tokenId);
      return true;
    } catch (err: any) {
      this.logger.warn(`Auto-redeem failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Trigger a market sell and track as pending if it fails.
   */
  private async triggerSell(
    tokenId: string,
    conditionId: string,
    shares: number,
    reason: string,
  ): Promise<void> {
    const result = await this.forceSell(tokenId, conditionId, shares);

    if (result === "success") return;

    // Determine remaining shares
    let remaining = shares;
    if (result === "partial") {
      const posAfter = this.state.getPosition(tokenId);
      if (!posAfter || posAfter.netShares <= 0) return;
      remaining = posAfter.netShares;
    }

    // Track as pending sell for retry
    this.state.setPendingSell(tokenId, {
      tokenId,
      conditionId,
      shares: remaining,
      placedAt: Date.now(),
      retryCount: 0,
      lastAttemptAt: Date.now(),
      splitFactor: 1.0,
    });

    this.logger.warn(
      `${reason}: ${tokenId.slice(0, 10)} ${result}, ${remaining.toFixed(1)} shares pending retry`,
    );
  }

  /**
   * Market sell via FAK @ bestBid. No floor protection.
   * Simple and direct — we're earning rewards, not betting.
   */
  private async forceSell(
    tokenId: string,
    conditionId: string,
    shares: number,
  ): Promise<"success" | "partial" | "no_bids" | "error"> {
    if (shares <= 0) return "success";

    try {
      const book = await this.client.getOrderBook(tokenId);
      const bids = book.bids || [];
      // CLOB API returns bids ascending — best bid is LAST
      const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;

      if (bestBid <= 0 || bids.length === 0) {
        this.logger.warn(`Force sell ${tokenId.slice(0, 10)}: no bids`);
        return "no_bids";
      }

      const sellPrice = Math.max(0.01, bestBid);
      const tickSize = (book.tick_size || "0.01") as import("@polymarket/clob-client").TickSize;
      const negRisk = book.neg_risk || false;
      const pos = this.state.getPosition(tokenId);
      const sharesBefore = pos?.netShares ?? shares;

      // FAK sell with settle retry (tokens need ~5s to arrive after BUY fill)
      let sellAttempts = 0;
      while (sellAttempts < 2) {
        try {
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
            false,
          );
          break;
        } catch (sellErr: any) {
          sellAttempts++;
          if (
            sellAttempts < 2 &&
            (sellErr.message?.includes("balance") || sellErr.message?.includes("allowance"))
          ) {
            this.logger.warn(`Force sell ${tokenId.slice(0, 10)}: tokens settling, retry in 5s`);
            await new Promise((r) => setTimeout(r, 5_000));
            continue;
          }
          throw sellErr;
        }
      }

      // Check actual fill via balance query
      let actualSold = shares;
      try {
        const remaining = await this.client.getConditionalBalance(tokenId);
        if (remaining >= 0) {
          actualSold = Math.max(0, sharesBefore - remaining);
        }
      } catch {
        // fallback: assume full fill
      }

      const isPartial = actualSold < shares * 0.99;

      this.logger.info(
        `Force SELL: ${actualSold.toFixed(1)}/${shares.toFixed(1)} @ ${sellPrice.toFixed(3)} ` +
          `(FAK, bestBid=${bestBid.toFixed(3)}${isPartial ? ", PARTIAL" : ""}) ${tokenId.slice(0, 10)}`,
      );

      // Update position tracking
      if (actualSold > 0 && pos) {
        this.state.updatePosition(tokenId, conditionId, pos.outcome, actualSold, sellPrice, "SELL");
      }

      if (actualSold <= 0) return "no_bids";
      return isPartial ? "partial" : "success";
    } catch (err: any) {
      this.logger.error(`Force sell failed ${tokenId.slice(0, 10)}: ${err.message}`);
      return "error";
    }
  }
}
