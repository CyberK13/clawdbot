// ---------------------------------------------------------------------------
// WebSocket User Channel: Real-time fill detection (<1s latency)
//
// Connects to Polymarket's authenticated user WebSocket channel.
// On trade events, immediately routes to the engine's fill handler.
// Falls back to polling if WebSocket disconnects.
// ---------------------------------------------------------------------------

import WebSocket from "ws";
import type { PluginLogger } from "../../src/plugins/types.js";
import type { StateManager } from "./state.js";
import type { TrackedOrder } from "./types.js";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/user";

/** Trade event from Polymarket WebSocket user channel */
interface WsTradeEvent {
  event_type: "trade";
  asset_id: string;
  market: string; // conditionId
  side: string;
  price: string;
  size: string;
  status: string; // MATCHED, MINED, CONFIRMED, RETRYING, FAILED
  taker_order_id: string;
  maker_orders?: Array<{
    order_id: string;
    asset_id: string;
    matched_amount: string;
    price: string;
  }>;
  timestamp: string;
  type: string; // "TRADE"
}

/** Order event from Polymarket WebSocket user channel */
interface WsOrderEvent {
  event_type: "order";
  id: string; // orderId
  asset_id: string;
  market: string;
  side: string;
  price: string;
  original_size: string;
  size_matched: string;
  type: string; // PLACEMENT, UPDATE, CANCELLATION
  timestamp: string;
}

type WsEvent = WsTradeEvent | WsOrderEvent;

export interface WsFeedOptions {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

/** Callback when a fill is detected via WebSocket */
export type FillCallback = (order: TrackedOrder, fillSize: number) => Promise<void>;

export class WsFeed {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private reconnectDelay = 1000; // starts at 1s, backs off to 30s
  private subscribedMarkets: string[] = [];

  /** Set of trade IDs already processed (prevent double-handling) */
  private processedTrades = new Set<string>();
  /** Prune processed trades every 5 min */
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private opts: WsFeedOptions,
    private state: StateManager,
    private onFill: FillCallback,
    private logger: PluginLogger,
  ) {}

  /** Start the WebSocket connection. */
  start(marketConditionIds: string[]): void {
    if (this.running) return;
    this.running = true;
    this.subscribedMarkets = marketConditionIds;
    this.connect();

    // Prune old trade IDs every 5 minutes
    this.pruneTimer = setInterval(() => {
      if (this.processedTrades.size > 1000) {
        this.processedTrades.clear();
      }
    }, 300_000);
  }

  /** Stop the WebSocket connection. */
  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.processedTrades.clear();
  }

  /** Update subscribed markets (e.g. after market scan). */
  updateMarkets(marketConditionIds: string[]): void {
    this.subscribedMarkets = marketConditionIds;
    // Reconnect with new subscription if connected
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
      // Will auto-reconnect with new markets
    }
  }

  private connect(): void {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(WS_URL);
    } catch (err: any) {
      this.logger.warn(`WS: Failed to create connection: ${err.message}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.logger.info(`WS: Connected to user channel`);
      this.reconnectDelay = 1000; // reset backoff

      // Subscribe to user channel with auth
      const sub = {
        auth: {
          apiKey: this.opts.apiKey,
          secret: this.opts.apiSecret,
          passphrase: this.opts.passphrase,
        },
        markets: this.subscribedMarkets,
        type: "user",
      };
      this.ws!.send(JSON.stringify(sub));

      // Ping every 30s to keep connection alive
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 30_000);
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (err: any) {
        this.logger.warn(`WS: Failed to parse message: ${err.message}`);
      }
    });

    this.ws.on("close", (code, reason) => {
      this.logger.info(`WS: Disconnected (code=${code}, reason=${reason?.toString() || "none"})`);
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      this.logger.warn(`WS: Error: ${err.message}`);
      // close event will follow, triggering reconnect
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.reconnectTimer = setTimeout(() => {
      this.logger.info(`WS: Reconnecting (delay=${this.reconnectDelay}ms)...`);
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s max
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }

  private handleMessage(msg: any): void {
    // Array of events or single event
    const events: any[] = Array.isArray(msg) ? msg : [msg];

    for (const event of events) {
      if (event.event_type === "trade") {
        this.handleTradeEvent(event as WsTradeEvent);
      }
      // Order events (PLACEMENT, CANCELLATION) can be used later for tracking
    }
  }

  private handleTradeEvent(trade: WsTradeEvent): void {
    // Only process MATCHED status (first notification of a fill)
    // MINED/CONFIRMED are follow-up statuses for the same trade
    if (trade.status !== "MATCHED") return;

    // Deduplicate by trade ID
    const tradeKey = trade.taker_order_id + "_" + trade.timestamp;
    if (this.processedTrades.has(tradeKey)) return;
    this.processedTrades.add(tradeKey);

    const fillSize = parseFloat(trade.size);
    const fillPrice = parseFloat(trade.price);
    if (fillSize <= 0) return;

    // Find matching tracked order
    const trackedOrders = this.state.getTrackedOrders();

    // Check if we're the taker
    let matched = trackedOrders.find(
      (o) => o.orderId === trade.taker_order_id && o.status === "live",
    );

    // Check if we're a maker
    if (!matched && trade.maker_orders) {
      for (const maker of trade.maker_orders) {
        matched = trackedOrders.find((o) => o.orderId === maker.order_id && o.status === "live");
        if (matched) break;
      }
    }

    if (!matched) {
      // Not our order or already processed by polling — ignore
      return;
    }

    const actualFill = Math.min(fillSize, matched.originalSize - matched.filledSize);
    if (actualFill <= 0) return;

    this.logger.info(
      `⚡ WS fill: ${matched.side} ${actualFill.toFixed(1)} @ ${fillPrice.toFixed(3)} ` +
        `(order=${matched.orderId.slice(0, 10)}, latency=WS)`,
    );

    // Update tracked order status
    matched.filledSize += actualFill;
    if (matched.filledSize >= matched.originalSize) {
      matched.status = "filled";
    }
    this.state.trackOrder(matched);

    // Route to engine's fill handler
    this.onFill(matched, actualFill).catch((err) => {
      this.logger.error(`WS fill handler error: ${err.message}`);
    });
  }

  /** Whether the WebSocket is currently connected. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
