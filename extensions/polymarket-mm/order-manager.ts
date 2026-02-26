// ---------------------------------------------------------------------------
// Order Manager — v5 simplified: place, cancel, refresh, detect fills
// ---------------------------------------------------------------------------

import type { TickSize } from "@polymarket/clob-client";
import { OrderType, Side } from "@polymarket/clob-client";
import type { PluginLogger } from "../../src/plugins/types.js";
import type { PolymarketClient } from "./client.js";
import type { StateManager } from "./state.js";
import type { MmConfig, MmMarket, TargetQuote, TrackedOrder } from "./types.js";

export class OrderManager {
  private logger: PluginLogger;

  constructor(
    private client: PolymarketClient,
    private state: StateManager,
    private config: MmConfig,
    logger: PluginLogger,
  ) {
    this.logger = logger;
  }

  /**
   * Refresh orders for a market: compare targets with live orders,
   * cancel stale ones, place new ones.
   */
  async refreshMarketOrders(market: MmMarket, targets: TargetQuote[]): Promise<string[]> {
    const liveOrders = this.state.getMarketOrders(market.conditionId);
    const tick = parseFloat(market.tickSize);

    const toCancel: string[] = [];
    const matched = new Set<string>();

    for (const live of liveOrders) {
      const matchIdx = targets.findIndex(
        (t, idx) =>
          !matched.has(`${idx}`) &&
          t.tokenId === live.tokenId &&
          t.side === live.side &&
          Math.abs(t.price - live.price) < tick * 1.5,
      );

      if (matchIdx >= 0) {
        matched.add(`${matchIdx}`);
      } else {
        toCancel.push(live.orderId);
      }
    }

    if (toCancel.length > 0) {
      try {
        await this.client.cancelOrders(toCancel);
        for (const id of toCancel) {
          this.state.removeOrder(id);
        }
      } catch (err: any) {
        this.logger.error(`Failed to cancel orders: ${err.message}`);
      }
    }

    const placedIds: string[] = [];
    const toPlace = targets.filter((_, idx) => !matched.has(`${idx}`));
    for (const target of toPlace) {
      const tracked = await this.placeOrder(market, target);
      if (tracked) placedIds.push(tracked.orderId);
    }

    return placedIds;
  }

  /** Place a single limit order. BUY uses GTD 5min for crash protection. */
  async placeOrder(market: MmMarket, target: TargetQuote): Promise<TrackedOrder | null> {
    try {
      const isBuy = target.side === "BUY";
      const orderType = isBuy ? OrderType.GTD : OrderType.GTC;
      // GTD 5min: API has 60s security buffer, so +60+300 = 5min effective
      const expiration = isBuy ? Math.floor(Date.now() / 1000) + 60 + 300 : undefined;

      const result = await this.client.createAndPostOrder(
        {
          tokenID: target.tokenId,
          price: target.price,
          size: target.size,
          side: isBuy ? Side.BUY : Side.SELL,
          feeRateBps: 0,
          ...(expiration ? { expiration } : {}),
        },
        { tickSize: market.tickSize, negRisk: market.negRisk },
        orderType,
        true, // postOnly
      );

      const orderId = result?.orderID || result?.orderHashes?.[0];
      if (!orderId) {
        this.logger.warn(`Order placed but no ID returned: ${JSON.stringify(result)}`);
        return null;
      }

      const tracked: TrackedOrder = {
        orderId,
        tokenId: target.tokenId,
        conditionId: market.conditionId,
        side: target.side,
        price: target.price,
        originalSize: target.size,
        filledSize: 0,
        status: "live",
        scoring: false,
        placedAt: Date.now(),
        level: target.level,
      };

      this.state.trackOrder(tracked);
      return tracked;
    } catch (err: any) {
      if (err.message?.includes("post only")) {
        this.logger.info(
          `PostOnly rejected: ${target.side} ${target.size.toFixed(1)} @ ${target.price} (would cross spread)`,
        );
      } else if (
        err.message?.includes("not enough balance") ||
        err.message?.includes("not enough allowance")
      ) {
        this.logger.info(
          `Insufficient balance: ${target.side} ${target.size.toFixed(1)} @ ${target.price}`,
        );
      } else {
        this.logger.error(
          `Failed to place order ${target.side} ${target.size.toFixed(1)} @ ${target.price}: ${err.message}`,
        );
      }
      return null;
    }
  }

  /**
   * Detect fills by comparing tracked orders with exchange state.
   */
  async detectFills(): Promise<Array<{ order: TrackedOrder; fillSize: number }>> {
    const fills: Array<{ order: TrackedOrder; fillSize: number }> = [];

    try {
      const openOrders = await this.client.getOpenOrders();
      const trackedOrders = this.state.getTrackedOrders();

      const disappearedOrders = trackedOrders.filter(
        (t) => t.status === "live" && !openOrders.find((o) => o.id === t.orderId),
      );
      let recentTrades: import("@polymarket/clob-client").Trade[] | null = null;
      if (disappearedOrders.length > 0) {
        try {
          recentTrades = await this.client.getTrades();
        } catch {
          this.logger.warn("getTrades() failed, falling back to assume-fill");
        }
      }

      for (const tracked of trackedOrders) {
        if (tracked.status !== "live") continue;

        const onExchange = openOrders.find((o) => o.id === tracked.orderId);

        if (!onExchange) {
          const fillSize = tracked.originalSize - tracked.filledSize;

          if (fillSize > 0 && recentTrades !== null) {
            const matchingTrade = recentTrades.find(
              (t) =>
                t.taker_order_id === tracked.orderId ||
                t.maker_orders?.some((m) => m.order_id === tracked.orderId) ||
                (t.asset_id === tracked.tokenId &&
                  t.side === tracked.side &&
                  Math.abs(parseFloat(t.price) - tracked.price) < 0.01 &&
                  Math.abs(parseFloat(t.size) - fillSize) < 1),
            );

            if (matchingTrade) {
              const confirmedSize = parseFloat(matchingTrade.size) || fillSize;
              fills.push({ order: tracked, fillSize: confirmedSize });
              tracked.status = "filled";
              tracked.filledSize = tracked.originalSize;
            } else {
              // Check on-chain balance as fallback
              let confirmedByBalance = false;
              try {
                const onChainShares = await this.client.getConditionalBalance(tracked.tokenId);
                if (onChainShares >= 0) {
                  const existingPos = this.state.getPosition(tracked.tokenId);
                  const trackedShares = existingPos?.netShares ?? 0;
                  if (tracked.side === "BUY" && onChainShares > trackedShares + fillSize * 0.5) {
                    confirmedByBalance = true;
                    const actualFill = Math.min(fillSize, onChainShares - trackedShares);
                    fills.push({ order: tracked, fillSize: actualFill });
                    tracked.status = "filled";
                    tracked.filledSize = tracked.originalSize;
                  } else if (
                    tracked.side === "SELL" &&
                    onChainShares < trackedShares - fillSize * 0.5
                  ) {
                    confirmedByBalance = true;
                    const actualFill = Math.min(fillSize, trackedShares - onChainShares);
                    fills.push({ order: tracked, fillSize: actualFill });
                    tracked.status = "filled";
                    tracked.filledSize = tracked.originalSize;
                  }
                }
              } catch {
                // Balance check failed
              }

              if (!confirmedByBalance) {
                tracked.status = "cancelled";
              }
            }
          } else if (fillSize > 0) {
            fills.push({ order: tracked, fillSize });
            tracked.status = "filled";
            tracked.filledSize = tracked.originalSize;
          } else {
            tracked.status = "cancelled";
          }

          this.state.trackOrder(tracked);
        } else {
          // Check for partial fills
          const sizeMatched = parseFloat(onExchange.size_matched || "0");
          if (sizeMatched > tracked.filledSize + 0.001) {
            const newFill = sizeMatched - tracked.filledSize;
            fills.push({ order: tracked, fillSize: newFill });
            tracked.filledSize = sizeMatched;
            this.state.trackOrder(tracked);
          }
        }
      }
    } catch (err: any) {
      this.logger.error(`Fill detection failed: ${err.message}`);
    }

    return fills;
  }

  async cancelMarketOrders(conditionId: string): Promise<void> {
    try {
      await this.client.cancelMarketOrders(conditionId);
      const orders = this.state.getMarketOrders(conditionId);
      for (const o of orders) {
        this.state.removeOrder(o.orderId);
      }
    } catch (err: any) {
      this.logger.error(`Failed to cancel market orders: ${err.message}`);
    }
  }

  async cancelAllOrders(): Promise<void> {
    try {
      await this.client.cancelAll();
      const tracked = this.state.getTrackedOrders();
      for (const o of tracked) {
        this.state.removeOrder(o.orderId);
      }
      this.logger.info("Cancelled ALL orders");
    } catch (err: any) {
      this.logger.error(`Failed to cancel all orders: ${err.message}`);
    }
  }

  async cancelSideOrders(conditionId: string, side: "BUY" | "SELL"): Promise<void> {
    const orders = this.state.getMarketOrders(conditionId).filter((o) => o.side === side);
    if (orders.length === 0) return;

    const ids = orders.map((o) => o.orderId);
    try {
      await this.client.cancelOrders(ids);
      for (const id of ids) {
        this.state.removeOrder(id);
      }
    } catch (err: any) {
      this.logger.error(`Failed to cancel ${side} orders: ${err.message}`);
    }
  }

  getLiveOrderCount(): number {
    return this.state.getTrackedOrders().filter((o) => o.status === "live").length;
  }
}
