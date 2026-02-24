// ---------------------------------------------------------------------------
// Order Manager: Order lifecycle — place, cancel, refresh, track fills
// ---------------------------------------------------------------------------

import type { TickSize, PostOrdersArgs } from "@polymarket/clob-client";
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
  async refreshMarketOrders(market: MmMarket, targets: TargetQuote[]): Promise<void> {
    const liveOrders = this.state.getMarketOrders(market.conditionId);
    const tick = parseFloat(market.tickSize);

    // Classify live orders: keep or cancel
    const toCancel: string[] = [];
    const matched = new Set<string>(); // target indices that are matched

    for (const live of liveOrders) {
      // Find a matching target (same token, side, close price)
      const matchIdx = targets.findIndex(
        (t, idx) =>
          !matched.has(`${idx}`) &&
          t.tokenId === live.tokenId &&
          t.side === live.side &&
          Math.abs(t.price - live.price) < tick * 1.5, // within ~1 tick
      );

      if (matchIdx >= 0) {
        matched.add(`${matchIdx}`);
        // Order is still valid, keep it
      } else {
        // Order is stale, cancel it
        toCancel.push(live.orderId);
      }
    }

    // Cancel stale orders
    if (toCancel.length > 0) {
      try {
        await this.client.cancelOrders(toCancel);
        for (const id of toCancel) {
          this.state.removeOrder(id);
        }
        this.logger.info(
          `Cancelled ${toCancel.length} stale orders on ${market.question.slice(0, 30)}`,
        );
      } catch (err: any) {
        this.logger.error(`Failed to cancel orders: ${err.message}`);
      }
    }

    // Place new orders for unmatched targets — batch when possible
    const toPlace = targets.filter((_, idx) => !matched.has(`${idx}`));
    if (toPlace.length > 1) {
      await this.placeOrdersBatch(market, toPlace);
    } else {
      for (const target of toPlace) {
        await this.placeOrder(market, target);
      }
    }
  }

  /** Place a single limit order. BUY uses GTD (auto-expire) for crash protection. */
  async placeOrder(market: MmMarket, target: TargetQuote): Promise<TrackedOrder | null> {
    try {
      // BUY orders use GTD with 60s expiry — prevents stale buys during crashes
      const isBuy = target.side === "BUY";
      const orderType = isBuy ? OrderType.GTD : OrderType.GTC;
      const expiration = isBuy
        ? Math.floor(Date.now() / 1000) + 60 + 60 // API has 60s security buffer, so +60+60 = 60s effective lifetime
        : undefined;

      const result = await this.client.createAndPostOrder(
        {
          tokenID: target.tokenId,
          price: target.price,
          size: target.size,
          side: isBuy ? Side.BUY : Side.SELL,
          feeRateBps: 0,
          ...(expiration ? { expiration } : {}),
        },
        {
          tickSize: market.tickSize,
          negRisk: market.negRisk,
        },
        orderType,
        true, // postOnly: critical for MM to avoid crossing spread
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
        scoring: false, // will be checked separately
        placedAt: Date.now(),
        level: target.level,
      };

      this.state.trackOrder(tracked);
      return tracked;
    } catch (err: any) {
      // postOnly rejection is expected when our price crosses the spread
      if (err.message?.includes("post only")) {
        this.logger.info(
          `PostOnly rejected: ${target.side} ${target.size.toFixed(1)} @ ${target.price} (would cross spread)`,
        );
      } else if (
        err.message?.includes("not enough balance") ||
        err.message?.includes("not enough allowance")
      ) {
        this.logger.info(
          `Insufficient balance: ${target.side} ${target.size.toFixed(1)} @ ${target.price} ` +
            `(~$${(target.size * target.price).toFixed(0)} needed)`,
        );
      } else {
        this.logger.error(
          `Failed to place order ${target.side} ${target.size.toFixed(1)} @ ${target.price}: ${err.message}`,
        );
      }
      return null;
    }
  }

  /** Batch-sign and post multiple orders at once (max 15 per request). */
  private async placeOrdersBatch(market: MmMarket, targets: TargetQuote[]): Promise<void> {
    const batchArgs: { args: PostOrdersArgs; target: TargetQuote }[] = [];

    for (const target of targets) {
      try {
        const isBuy = target.side === "BUY";
        const orderType = isBuy ? OrderType.GTD : OrderType.GTC;
        const expiration = isBuy ? Math.floor(Date.now() / 1000) + 60 + 60 : undefined;

        const signedOrder = await this.client.createOrder(
          {
            tokenID: target.tokenId,
            price: target.price,
            size: target.size,
            side: isBuy ? Side.BUY : Side.SELL,
            feeRateBps: 0,
            ...(expiration ? { expiration } : {}),
          },
          { tickSize: market.tickSize, negRisk: market.negRisk },
        );
        batchArgs.push({
          args: { order: signedOrder, orderType, postOnly: true },
          target,
        });
      } catch (err: any) {
        this.logger.warn(
          `Failed to sign order ${target.side} ${target.size.toFixed(1)} @ ${target.price}: ${err.message}`,
        );
      }
    }

    if (batchArgs.length === 0) return;

    const BATCH_SIZE = 15;
    for (let i = 0; i < batchArgs.length; i += BATCH_SIZE) {
      const chunk = batchArgs.slice(i, i + BATCH_SIZE);
      try {
        const result = await this.client.postOrders(
          chunk.map((c) => c.args),
          true,
        );

        // Parse order IDs from response and track
        // postOrders returns array of { orderID, status, success } per order
        const orderIds: string[] = Array.isArray(result)
          ? result.map((r: any) => r.orderID || r.orderHash).filter(Boolean)
          : result?.orderIDs || result?.orderHashes || [];
        for (let j = 0; j < chunk.length; j++) {
          const orderId = orderIds[j];
          if (!orderId) continue;

          const { target } = chunk[j];
          this.state.trackOrder({
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
          });
        }

        this.logger.info(
          `Batch placed ${orderIds.length}/${chunk.length} orders on ${market.question.slice(0, 30)}`,
        );
      } catch (err: any) {
        // Fallback: place individually
        this.logger.warn(`Batch post failed, falling back to individual: ${err.message}`);
        for (const { target } of chunk) {
          await this.placeOrder(market, target);
        }
      }
    }
  }

  /**
   * Detect fills by comparing tracked orders with exchange state.
   * When orders disappear, verify via getTrades() first, then on-chain
   * balance as fallback, to distinguish real fills from external cancellations.
   */
  async detectFills(): Promise<Array<{ order: TrackedOrder; fillSize: number }>> {
    const fills: Array<{ order: TrackedOrder; fillSize: number }> = [];

    try {
      const openOrders = await this.client.getOpenOrders();
      const trackedOrders = this.state.getTrackedOrders();

      // Fetch recent trades for fill verification (only if we have disappeared orders)
      const disappearedOrders = trackedOrders.filter(
        (t) => t.status === "live" && !openOrders.find((o) => o.id === t.orderId),
      );
      let recentTrades: import("@polymarket/clob-client").Trade[] | null = null;
      if (disappearedOrders.length > 0) {
        try {
          recentTrades = await this.client.getTrades();
        } catch {
          // If getTrades() fails, fall back to assume-fill behavior for safety
          this.logger.warn(
            "getTrades() failed, falling back to assume-fill for disappeared orders",
          );
        }
      }

      for (const tracked of trackedOrders) {
        if (tracked.status !== "live") continue;

        const onExchange = openOrders.find((o) => o.id === tracked.orderId);

        if (!onExchange) {
          // Order disappeared — verify with trades
          const fillSize = tracked.originalSize - tracked.filledSize;

          if (fillSize > 0 && recentTrades !== null) {
            // Look for matching trade
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
              // Confirmed fill via trade history
              const confirmedSize = parseFloat(matchingTrade.size) || fillSize;
              fills.push({ order: tracked, fillSize: confirmedSize });
              tracked.status = "filled";
              tracked.filledSize = tracked.originalSize;
              this.logger.info(
                `Verified fill via trade: ${tracked.side} ${confirmedSize.toFixed(1)} @ ${tracked.price.toFixed(3)}`,
              );
            } else {
              // No matching trade — check on-chain balance as fallback.
              // getTrades() can miss fills due to pagination/time window limits.
              // On-chain balance is the ground truth.
              let confirmedByBalance = false;
              try {
                const onChainShares = await this.client.getConditionalBalance(tracked.tokenId);
                if (onChainShares >= 0) {
                  const existingPos = this.state.getPosition(tracked.tokenId);
                  const trackedShares = existingPos?.netShares ?? 0;
                  if (tracked.side === "BUY" && onChainShares > trackedShares + fillSize * 0.5) {
                    // On-chain has more than tracked → BUY was filled
                    confirmedByBalance = true;
                    const actualFill = Math.min(fillSize, onChainShares - trackedShares);
                    fills.push({ order: tracked, fillSize: actualFill });
                    tracked.status = "filled";
                    tracked.filledSize = tracked.originalSize;
                    this.logger.info(
                      `Verified fill via on-chain balance: ${tracked.side} ${actualFill.toFixed(1)} @ ${tracked.price.toFixed(3)} ` +
                        `(on-chain=${onChainShares.toFixed(1)}, tracked=${trackedShares.toFixed(1)})`,
                    );
                  } else if (
                    tracked.side === "SELL" &&
                    onChainShares < trackedShares - fillSize * 0.5
                  ) {
                    // On-chain has less than tracked → SELL was filled
                    confirmedByBalance = true;
                    const actualFill = Math.min(fillSize, trackedShares - onChainShares);
                    fills.push({ order: tracked, fillSize: actualFill });
                    tracked.status = "filled";
                    tracked.filledSize = tracked.originalSize;
                    this.logger.info(
                      `Verified fill via on-chain balance: ${tracked.side} ${actualFill.toFixed(1)} @ ${tracked.price.toFixed(3)} ` +
                        `(on-chain=${onChainShares.toFixed(1)}, tracked=${trackedShares.toFixed(1)})`,
                    );
                  }
                }
              } catch {
                // Balance check failed — will fall through to cancel
              }

              if (!confirmedByBalance) {
                this.logger.info(
                  `Order ${tracked.orderId.slice(0, 10)} disappeared with no matching trade or balance change — treating as external cancel`,
                );
                tracked.status = "cancelled";
              }
            }
          } else if (fillSize > 0) {
            // getTrades() failed — assume fill for safety (old behavior)
            fills.push({ order: tracked, fillSize });
            tracked.status = "filled";
            tracked.filledSize = tracked.originalSize;
          } else {
            tracked.status = "cancelled";
          }

          this.state.trackOrder(tracked); // update status
        } else {
          // Check for partial fills
          const sizeMatched = parseFloat(onExchange.size_matched || "0");
          if (sizeMatched > tracked.filledSize) {
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

  /** Cancel all orders for a specific market. */
  async cancelMarketOrders(conditionId: string): Promise<void> {
    try {
      await this.client.cancelMarketOrders(conditionId);
      const orders = this.state.getMarketOrders(conditionId);
      for (const o of orders) {
        this.state.removeOrder(o.orderId);
      }
      this.logger.info(`Cancelled all orders for market ${conditionId.slice(0, 10)}…`);
    } catch (err: any) {
      this.logger.error(`Failed to cancel market orders: ${err.message}`);
    }
  }

  /** Cancel ALL open orders (emergency). */
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

  /** Cancel orders on a specific side for a market (for inventory management). */
  async cancelSideOrders(conditionId: string, side: "BUY" | "SELL"): Promise<void> {
    const orders = this.state.getMarketOrders(conditionId).filter((o) => o.side === side);

    if (orders.length === 0) return;

    const ids = orders.map((o) => o.orderId);
    try {
      await this.client.cancelOrders(ids);
      for (const id of ids) {
        this.state.removeOrder(id);
      }
      this.logger.info(
        `Cancelled ${ids.length} ${side} orders on market ${conditionId.slice(0, 10)}…`,
      );
    } catch (err: any) {
      this.logger.error(`Failed to cancel ${side} orders: ${err.message}`);
    }
  }

  /** Get count of live tracked orders. */
  getLiveOrderCount(): number {
    return this.state.getTrackedOrders().filter((o) => o.status === "live").length;
  }
}
