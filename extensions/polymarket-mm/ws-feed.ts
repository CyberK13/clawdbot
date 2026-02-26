// ---------------------------------------------------------------------------
// WebSocket Feed — v5: User channel (fills) + Market channel (book updates)
//
// Two WS connections:
//   1. wss://.../ws/user  — authenticated, real-time fill detection (<1s)
//   2. wss://.../ws/market — public, real-time book updates for danger zone
// ---------------------------------------------------------------------------

import WebSocket from "ws";
import type { PluginLogger } from "../../src/plugins/types.js";
import type { StateManager } from "./state.js";
import type { TrackedOrder } from "./types.js";

const WS_USER_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
const WS_MARKET_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

/** Trade event from user channel */
interface WsTradeEvent {
  event_type: "trade";
  id: string;
  asset_id: string;
  market: string;
  side: string;
  price: string;
  size: string;
  status: string;
  taker_order_id: string;
  maker_orders?: Array<{
    order_id: string;
    asset_id: string;
    matched_amount: string;
    price: string;
  }>;
  timestamp: string;
  type: string;
}

/** Book update from market channel */
interface WsBookUpdate {
  event_type: "book";
  asset_id: string;
  market: string;
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
  timestamp: string;
  hash?: string;
}

/** Price change event from market channel (contains array of per-asset changes) */
interface WsPriceChange {
  event_type: "price_change";
  market: string;
  price_changes: Array<{
    asset_id: string;
    price: string;
    size: string;
    side: string;
    best_bid: string;
    best_ask: string;
  }>;
  timestamp: string;
}

export interface WsFeedOptions {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

export type FillCallback = (order: TrackedOrder, fillSize: number) => Promise<void>;
export type MidUpdateCallback = (tokenId: string, newMid: number) => void;

export class WsFeed {
  // User channel
  private userWs: WebSocket | null = null;
  private userReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private userPingTimer: ReturnType<typeof setInterval> | null = null;
  private userReconnectDelay = 1000;

  // Market channel
  private marketWs: WebSocket | null = null;
  private marketReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private marketPingTimer: ReturnType<typeof setInterval> | null = null;
  private marketReconnectDelay = 1000;

  private running = false;
  private subscribedMarkets: string[] = [];
  /** Token IDs currently subscribed to market channel */
  private subscribedTokens: string[] = [];

  private processedTrades = new Set<string>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private fillQueue: Promise<void> = Promise.resolve();

  /** Callback for mid-price updates from market channel */
  onMidUpdate: MidUpdateCallback | null = null;

  constructor(
    private opts: WsFeedOptions,
    private state: StateManager,
    private onFill: FillCallback,
    private logger: PluginLogger,
  ) {}

  /** Start both WS connections. */
  start(marketConditionIds: string[], tokenIds: string[]): void {
    if (this.running) return;
    this.running = true;
    this.subscribedMarkets = marketConditionIds;
    this.subscribedTokens = tokenIds;

    this.connectUser();
    this.connectMarket();

    this.pruneTimer = setInterval(() => {
      if (this.processedTrades.size > 1000) {
        this.processedTrades.clear();
      }
    }, 300_000);
  }

  stop(): void {
    this.running = false;

    // User channel cleanup
    if (this.userReconnectTimer) {
      clearTimeout(this.userReconnectTimer);
      this.userReconnectTimer = null;
    }
    if (this.userPingTimer) {
      clearInterval(this.userPingTimer);
      this.userPingTimer = null;
    }
    if (this.userWs) {
      try {
        this.userWs.close();
      } catch {}
      this.userWs = null;
    }

    // Market channel cleanup
    if (this.marketReconnectTimer) {
      clearTimeout(this.marketReconnectTimer);
      this.marketReconnectTimer = null;
    }
    if (this.marketPingTimer) {
      clearInterval(this.marketPingTimer);
      this.marketPingTimer = null;
    }
    if (this.marketWs) {
      try {
        this.marketWs.close();
      } catch {}
      this.marketWs = null;
    }

    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.processedTrades.clear();
  }

  /** Update subscribed markets and tokens (e.g. after market scan). */
  updateMarkets(marketConditionIds: string[], tokenIds: string[]): void {
    this.subscribedMarkets = marketConditionIds;
    this.subscribedTokens = tokenIds;

    // Reconnect user channel with new markets
    if (this.userWs && this.userWs.readyState === WebSocket.OPEN) {
      this.userWs.close(); // will auto-reconnect
    }
    // Reconnect market channel with new tokens
    if (this.marketWs && this.marketWs.readyState === WebSocket.OPEN) {
      this.marketWs.close(); // will auto-reconnect
    }
  }

  // ---- User channel (fills) -----------------------------------------------

  private connectUser(): void {
    if (!this.running) return;

    try {
      this.userWs = new WebSocket(WS_USER_URL);
    } catch (err: any) {
      this.logger.warn(`WS/user: Failed to create connection: ${err.message}`);
      this.scheduleUserReconnect();
      return;
    }

    this.userWs.on("open", () => {
      this.logger.info("WS/user: Connected");
      this.userReconnectDelay = 1000;

      const sub = {
        auth: {
          apiKey: this.opts.apiKey,
          secret: this.opts.apiSecret,
          passphrase: this.opts.passphrase,
        },
        markets: this.subscribedMarkets,
        type: "user",
      };
      this.userWs!.send(JSON.stringify(sub));

      this.userPingTimer = setInterval(() => {
        if (this.userWs?.readyState === WebSocket.OPEN) {
          this.userWs.ping();
        }
      }, 30_000);
    });

    this.userWs.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleUserMessage(msg);
      } catch (err: any) {
        this.logger.warn(`WS/user: Failed to parse: ${err.message}`);
      }
    });

    this.userWs.on("close", () => {
      if (this.userPingTimer) {
        clearInterval(this.userPingTimer);
        this.userPingTimer = null;
      }
      this.scheduleUserReconnect();
    });

    this.userWs.on("error", (err) => {
      this.logger.warn(`WS/user error: ${err.message}`);
    });
  }

  private scheduleUserReconnect(): void {
    if (!this.running) return;
    this.userReconnectTimer = setTimeout(() => {
      this.connectUser();
    }, this.userReconnectDelay);
    this.userReconnectDelay = Math.min(this.userReconnectDelay * 2, 30_000);
  }

  private handleUserMessage(msg: any): void {
    const events: any[] = Array.isArray(msg) ? msg : [msg];
    for (const event of events) {
      if (event.event_type === "trade") {
        this.handleTradeEvent(event as WsTradeEvent);
      }
    }
  }

  private handleTradeEvent(trade: WsTradeEvent): void {
    if (trade.status !== "MATCHED") return;

    const tradeKey = trade.id || trade.taker_order_id + "_" + trade.timestamp;
    if (this.processedTrades.has(tradeKey)) return;
    this.processedTrades.add(tradeKey);

    const fillSize = parseFloat(trade.size);
    const fillPrice = parseFloat(trade.price);
    if (fillSize <= 0) return;

    const trackedOrders = this.state.getTrackedOrders();

    let matched = trackedOrders.find(
      (o) => o.orderId === trade.taker_order_id && o.status === "live",
    );

    if (!matched && trade.maker_orders) {
      for (const maker of trade.maker_orders) {
        matched = trackedOrders.find((o) => o.orderId === maker.order_id && o.status === "live");
        if (matched) break;
      }
    }

    if (!matched) return;

    const actualFill = Math.min(fillSize, matched.originalSize - matched.filledSize);
    if (actualFill <= 0) return;

    this.logger.info(
      `⚡ WS fill: ${matched.side} ${actualFill.toFixed(1)} @ ${fillPrice.toFixed(3)} ` +
        `(order=${matched.orderId.slice(0, 10)})`,
    );

    matched.filledSize += actualFill;
    if (matched.filledSize >= matched.originalSize) {
      matched.status = "filled";
    }
    this.state.trackOrder(matched);

    this.fillQueue = this.fillQueue
      .then(() => this.onFill(matched!, actualFill))
      .catch((err) => {
        this.logger.error(`WS fill handler error: ${err.message}`);
      });
  }

  // ---- Market channel (book updates for danger zone) ----------------------

  private connectMarket(): void {
    if (!this.running) return;
    if (this.subscribedTokens.length === 0) return;

    try {
      this.marketWs = new WebSocket(WS_MARKET_URL);
    } catch (err: any) {
      this.logger.warn(`WS/market: Failed to create connection: ${err.message}`);
      this.scheduleMarketReconnect();
      return;
    }

    this.marketWs.on("open", () => {
      this.logger.info(
        `WS/market: Connected, subscribing to ${this.subscribedTokens.length} tokens`,
      );
      this.marketReconnectDelay = 1000;

      // Subscribe to all tokens' orderbook updates (assets_ids plural, array)
      this.marketWs!.send(JSON.stringify({ assets_ids: this.subscribedTokens, type: "market" }));

      this.marketPingTimer = setInterval(() => {
        if (this.marketWs?.readyState === WebSocket.OPEN) {
          this.marketWs.ping();
        }
      }, 30_000);
    });

    this.marketWs.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMarketMessage(msg);
      } catch (err: any) {
        // Silently ignore parse errors on market channel (high frequency)
      }
    });

    this.marketWs.on("close", () => {
      if (this.marketPingTimer) {
        clearInterval(this.marketPingTimer);
        this.marketPingTimer = null;
      }
      this.scheduleMarketReconnect();
    });

    this.marketWs.on("error", (err) => {
      this.logger.warn(`WS/market error: ${err.message}`);
    });
  }

  private scheduleMarketReconnect(): void {
    if (!this.running) return;
    this.marketReconnectTimer = setTimeout(() => {
      this.connectMarket();
    }, this.marketReconnectDelay);
    this.marketReconnectDelay = Math.min(this.marketReconnectDelay * 2, 30_000);
  }

  private handleMarketMessage(msg: any): void {
    const events: any[] = Array.isArray(msg) ? msg : [msg];
    for (const event of events) {
      if (event.event_type === "book") {
        this.handleBookUpdate(event as WsBookUpdate);
      } else if (event.event_type === "price_change") {
        this.handlePriceChange(event as WsPriceChange);
      }
    }
  }

  private handleBookUpdate(update: WsBookUpdate): void {
    if (!this.onMidUpdate) return;

    const bids = update.bids || [];
    const asks = update.asks || [];
    if (bids.length === 0 && asks.length === 0) return;

    // Compute midpoint from top of book
    // WS may send delta updates — don't assume sort order, use max/min
    let bestBid = 0;
    for (const b of bids) {
      const p = parseFloat(b.price);
      if (p > bestBid) bestBid = p;
    }
    let bestAsk = 1;
    for (const a of asks) {
      const p = parseFloat(a.price);
      if (p > 0 && p < bestAsk) bestAsk = p;
    }

    if (bestBid > 0 && bestAsk < 1 && bestAsk > bestBid) {
      const mid = (bestBid + bestAsk) / 2;
      this.onMidUpdate(update.asset_id, mid);
    }
  }

  private handlePriceChange(event: WsPriceChange): void {
    if (!this.onMidUpdate) return;
    const changes = event.price_changes;
    if (!Array.isArray(changes)) return;

    for (const ch of changes) {
      const bestBid = parseFloat(ch.best_bid);
      const bestAsk = parseFloat(ch.best_ask);
      if (bestBid > 0 && bestAsk > 0 && bestAsk > bestBid) {
        const mid = (bestBid + bestAsk) / 2;
        this.onMidUpdate(ch.asset_id, mid);
      }
    }
  }

  get userConnected(): boolean {
    return this.userWs?.readyState === WebSocket.OPEN;
  }

  get marketConnected(): boolean {
    return this.marketWs?.readyState === WebSocket.OPEN;
  }
}
