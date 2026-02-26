// ---------------------------------------------------------------------------
// Accidental Fill Handler — v5: 4-stage exit for unexpected fills
//
// Fill = accident (v5 paradigm: we cancel before fill).
// When filled anyway:
//   Stage 1 (0-5min):  Limit SELL @ mid (still earns scoring)
//   Stage 2 (5-15min): Limit SELL @ bestBid + 1tick (aggressive exit)
//   Stage 3 (15-30min): FAK @ bestBid (market sell)
//   Stage 4 (30min+):  Try redeem (resolved?) or abandon + alert
//
// Price protection: never sell below entry × minSellPriceRatio (first 30min)
// ---------------------------------------------------------------------------

import { OrderType, Side } from "@polymarket/clob-client";
import type { PluginLogger } from "../../src/plugins/types.js";
import type { PolymarketClient } from "./client.js";
import type { StateManager } from "./state.js";
import type {
  MmConfig,
  MmMarket,
  AccidentalFill,
  MarketState,
  FillEvent,
  TrackedOrder,
} from "./types.js";

export class AccidentalFillHandler {
  private logger: PluginLogger;
  private redeemCallback: ((conditionId: string) => Promise<void>) | null = null;

  constructor(
    private client: PolymarketClient,
    private state: StateManager,
    private config: MmConfig,
    logger: PluginLogger,
  ) {
    this.logger = logger;
  }

  setRedeemCallback(cb: (conditionId: string) => Promise<void>): void {
    this.redeemCallback = cb;
  }

  /**
   * Handle an unexpected fill. Cancel all market orders, enter exit phase.
   */
  async handleFill(
    order: TrackedOrder,
    fillSize: number,
    market: MmMarket,
    ms: MarketState,
    priceMap: Map<string, number>,
  ): Promise<void> {
    if (order.side !== "BUY" || fillSize <= 0) return;

    // Record fill event
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

    // Update position
    this.state.updatePosition(
      order.tokenId,
      order.conditionId,
      market.tokens.find((t) => t.tokenId === order.tokenId)?.outcome ?? "?",
      fillSize,
      order.price,
      order.side,
    );

    const currentMid = priceMap.get(order.tokenId) ?? order.price;

    this.logger.warn(
      `🚨 意外成交: BUY ${fillSize.toFixed(1)} @ ${order.price.toFixed(3)} ` +
        `(${market.question.slice(0, 30)}…), mid=${currentMid.toFixed(3)}, 进入退出模式`,
    );

    // Record the accidental fill
    ms.accidentalFill = {
      tokenId: order.tokenId,
      shares: fillSize,
      entryPrice: order.price,
      filledAt: Date.now(),
      stage: 1,
    };
    ms.phase = "exiting";
    this.state.setMarketState(ms.conditionId, ms);

    // Stage 1: immediately place limit sell @ mid
    await this.placeLimitSell(ms, market, currentMid);
  }

  /**
   * Check exit progress and advance stages. Called from engine tick.
   */
  async checkExitProgress(
    ms: MarketState,
    market: MmMarket,
    priceMap: Map<string, number>,
  ): Promise<boolean> {
    const fill = ms.accidentalFill;
    if (!fill) return true; // no fill, exit complete

    // Check if position is already sold
    const pos = this.state.getPosition(fill.tokenId);
    if (!pos || pos.netShares <= 0) {
      this.logger.info(`✅ 意外成交已清仓: ${market.question.slice(0, 30)}…`);
      ms.accidentalFill = undefined;
      ms.phase = "quoting";
      this.state.setMarketState(ms.conditionId, ms);
      return true;
    }

    const elapsed = Date.now() - fill.filledAt;
    const [t1, t2, t3, t4] = this.config.accidentalFillTimeouts.map((m) => m * 60_000);
    const mid = priceMap.get(fill.tokenId) ?? fill.entryPrice;
    const floor = fill.entryPrice * this.config.minSellPriceRatio;

    if (elapsed < t1) {
      // Stage 1: Limit SELL @ mid — still earning scoring while we wait
      if (fill.stage < 1) {
        fill.stage = 1;
        await this.placeLimitSell(ms, market, mid);
      }
    } else if (elapsed < t2) {
      // Stage 2: More aggressive — Limit SELL @ bestBid + 1 tick
      if (fill.stage < 2) {
        fill.stage = 2;
        this.logger.info(`📉 Stage 2: 积极出货 ${fill.tokenId.slice(0, 10)}`);
        await this.cancelExistingSell(fill);
        await this.placeAggressiveSell(fill, market, priceMap);
        this.state.setMarketState(ms.conditionId, ms);
      }
    } else if (elapsed < t3) {
      // Stage 3: FAK market sell @ bestBid
      if (fill.stage < 3) {
        fill.stage = 3;
        this.logger.warn(`🔴 Stage 3: FAK市价出 ${fill.tokenId.slice(0, 10)}`);
        await this.cancelExistingSell(fill);
        if (mid >= floor) {
          await this.fakSell(fill, market);
        } else {
          this.logger.warn(
            `FAK跳过: mid=${mid.toFixed(3)} < floor=${floor.toFixed(3)} (entry×${this.config.minSellPriceRatio})`,
          );
        }
        this.state.setMarketState(ms.conditionId, ms);
      }
    } else {
      // Stage 4: Try redeem or abandon
      if (fill.stage < 4) {
        fill.stage = 4;
        this.logger.warn(`🚨 Stage 4: 尝试赎回或放弃 ${fill.tokenId.slice(0, 10)}`);
        await this.cancelExistingSell(fill);
        await this.tryRedeemOrAbandon(fill, ms, market);
        this.state.setMarketState(ms.conditionId, ms);
      }
    }

    return false; // still exiting
  }

  /**
   * Force sell for engine liquidation / orphan selling.
   */
  async forceSell(tokenId: string, conditionId: string, shares: number): Promise<boolean> {
    if (shares <= 0) return true;

    try {
      const book = await this.client.getOrderBook(tokenId);
      const bids = book.bids || [];
      const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;

      if (bestBid <= 0) {
        this.logger.warn(`Force sell ${tokenId.slice(0, 10)}: no bids`);
        return false;
      }

      const sellPrice = Math.max(0.01, bestBid);
      const tickSize = (book.tick_size || "0.01") as import("@polymarket/clob-client").TickSize;
      const negRisk = book.neg_risk || false;

      // FAK sell with settle retry
      let attempts = 0;
      while (attempts < 3) {
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
          attempts++;
          if (
            attempts < 3 &&
            (sellErr.message?.includes("balance") || sellErr.message?.includes("allowance"))
          ) {
            await new Promise((r) => setTimeout(r, 5_000));
            continue;
          }
          throw sellErr;
        }
      }

      // Update position
      const pos = this.state.getPosition(tokenId);
      if (pos) {
        this.state.updatePosition(tokenId, conditionId, pos.outcome, shares, sellPrice, "SELL");
      }

      this.logger.info(
        `Force SELL: ${shares.toFixed(1)} @ ${sellPrice.toFixed(3)} (FAK) ${tokenId.slice(0, 10)}`,
      );
      return true;
    } catch (err: any) {
      this.logger.error(`Force sell failed ${tokenId.slice(0, 10)}: ${err.message}`);
      return false;
    }
  }

  // ---- Internal -----------------------------------------------------------

  private async placeLimitSell(ms: MarketState, market: MmMarket, mid: number): Promise<void> {
    const fill = ms.accidentalFill;
    if (!fill) return;

    const pos = this.state.getPosition(fill.tokenId);
    const shares = pos?.netShares ?? fill.shares;
    if (shares <= 0) return;

    const tick = parseFloat(market.tickSize);
    // Sell at mid (rounded up to next tick)
    let sellPrice = Math.ceil(mid / tick) * tick;
    sellPrice = Math.max(tick, Math.min(1 - tick, sellPrice));

    try {
      const result = await this.client.createAndPostOrder(
        {
          tokenID: fill.tokenId,
          price: sellPrice,
          size: shares,
          side: Side.SELL,
          feeRateBps: 0,
        },
        { tickSize: market.tickSize, negRisk: market.negRisk },
        OrderType.GTC,
        false,
      );
      fill.sellOrderId = result?.orderID || result?.orderHashes?.[0];
      this.state.setMarketState(ms.conditionId, ms);
      this.logger.info(
        `Stage ${fill.stage}: Limit SELL ${shares.toFixed(1)} @ ${sellPrice.toFixed(3)} (${fill.tokenId.slice(0, 10)})`,
      );
    } catch (err: any) {
      this.logger.error(`Failed to place limit sell: ${err.message}`);
    }
  }

  private async placeAggressiveSell(
    fill: AccidentalFill,
    market: MmMarket,
    priceMap: Map<string, number>,
  ): Promise<void> {
    const pos = this.state.getPosition(fill.tokenId);
    const shares = pos?.netShares ?? fill.shares;
    if (shares <= 0) return;

    try {
      const book = await this.client.getOrderBook(fill.tokenId);
      const bids = book.bids || [];
      const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;
      if (bestBid <= 0) return;

      const tick = parseFloat(market.tickSize);
      const sellPrice = Math.max(tick, bestBid + tick);
      const floor = fill.entryPrice * this.config.minSellPriceRatio;
      if (sellPrice < floor) {
        this.logger.warn(
          `Aggressive sell skip: price ${sellPrice.toFixed(3)} < floor ${floor.toFixed(3)}`,
        );
        return;
      }

      const result = await this.client.createAndPostOrder(
        {
          tokenID: fill.tokenId,
          price: sellPrice,
          size: shares,
          side: Side.SELL,
          feeRateBps: 0,
        },
        { tickSize: market.tickSize, negRisk: market.negRisk },
        OrderType.GTC,
        false,
      );
      fill.sellOrderId = result?.orderID || result?.orderHashes?.[0];
      this.logger.info(
        `Stage 2: Limit SELL ${shares.toFixed(1)} @ ${sellPrice.toFixed(3)} (bestBid+tick) ${fill.tokenId.slice(0, 10)}`,
      );
    } catch (err: any) {
      this.logger.error(`Aggressive sell failed: ${err.message}`);
    }
  }

  private async fakSell(fill: AccidentalFill, market: MmMarket): Promise<void> {
    const pos = this.state.getPosition(fill.tokenId);
    const shares = pos?.netShares ?? fill.shares;
    if (shares <= 0) return;

    try {
      const book = await this.client.getOrderBook(fill.tokenId);
      const bids = book.bids || [];
      const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;
      if (bestBid <= 0) return;

      await this.client.createAndPostOrder(
        {
          tokenID: fill.tokenId,
          price: Math.max(0.01, bestBid),
          size: shares,
          side: Side.SELL,
          feeRateBps: 0,
        },
        { tickSize: market.tickSize, negRisk: market.negRisk },
        OrderType.FAK,
        false,
      );

      if (pos) {
        this.state.updatePosition(fill.tokenId, fill.tokenId, pos.outcome, shares, bestBid, "SELL");
      }
      this.logger.info(
        `Stage 3: FAK SELL ${shares.toFixed(1)} @ ${bestBid.toFixed(3)} ${fill.tokenId.slice(0, 10)}`,
      );
    } catch (err: any) {
      this.logger.error(`FAK sell failed: ${err.message}`);
    }
  }

  private async cancelExistingSell(fill: AccidentalFill): Promise<void> {
    if (!fill.sellOrderId) return;
    try {
      await this.client.cancelOrders([fill.sellOrderId]);
      fill.sellOrderId = undefined;
    } catch {
      // Best effort
    }
  }

  private async tryRedeemOrAbandon(
    fill: AccidentalFill,
    ms: MarketState,
    market: MmMarket,
  ): Promise<void> {
    if (this.redeemCallback) {
      try {
        const mktData = await this.client.getMarket(ms.conditionId);
        const endDate = mktData?.end_date_iso || mktData?.end_date;
        const isResolved =
          !mktData?.active || (endDate && new Date(endDate).getTime() < Date.now());

        if (isResolved) {
          this.logger.info(`🏦 市场已结算, 赎回 ${ms.conditionId.slice(0, 16)}...`);
          await this.redeemCallback(ms.conditionId);
          ms.accidentalFill = undefined;
          ms.phase = "quoting";
          return;
        }
      } catch (err: any) {
        this.logger.warn(`Redeem check failed: ${err.message}`);
      }
    }

    this.logger.error(
      `🚨 放弃: ${fill.tokenId.slice(0, 10)} ${fill.shares.toFixed(1)} shares 卡了 ${((Date.now() - fill.filledAt) / 60_000).toFixed(0)}min, 需要人工处理`,
    );
  }
}
