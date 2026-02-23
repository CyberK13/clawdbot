// ---------------------------------------------------------------------------
// Risk Controller: Kill switch, drawdown limits, circuit breakers — v3
//
// Check interval: every tick (5s in main loop)
// Decision tree:
//   1. Total P&L < -maxDrawdownPercent? → KILL SWITCH
//   2. Daily loss > maxDailyLoss? → Pause day
//   3. Market exposure > max? → Cancel one side
//   4. Total exposure > max? → Reduce all sizes by 50%
//   5. Consecutive API errors > 3? → Cancel all, wait
//   6. Rapid price movement? → Pause market
//   7. High fill rate? → Widen spread (adverse selection)
//   8. Toxic flow detected? → Emergency exit
// ---------------------------------------------------------------------------

import type { PluginLogger } from "../../src/plugins/types.js";
import type { PolymarketClient } from "./client.js";
import type { InventoryManager } from "./inventory-manager.js";
import type { StateManager } from "./state.js";
import type { MmConfig, MmMarket, RiskAction, BookSnapshot, ToxicityAnalysis } from "./types.js";

/** Price history for circuit breaker. */
interface PriceSnapshot {
  price: number;
  timestamp: number;
}

/** Fill rate tracking with directional analysis for toxic flow detection. */
interface FillCounter {
  count: number;
  windowStart: number;
  /** Per-side fill tracking for directionality */
  buys: number;
  sells: number;
  /** Running sum of fill sizes for anomaly detection */
  totalSize: number;
  /** Per-tokenId fill counts for granular tracking */
  tokenFills: Record<string, { buys: number; sells: number }>;
}

export class RiskController {
  private logger: PluginLogger;
  private priceHistory: Map<string, PriceSnapshot[]> = new Map();
  private fillCounters: Map<string, FillCounter> = new Map();

  /** Price move threshold: >10% in 5 minutes triggers circuit breaker. */
  private readonly PRICE_MOVE_THRESHOLD = 0.1;
  private readonly PRICE_MOVE_WINDOW_MS = 5 * 60 * 1000;
  /** Fill rate: >5 fills in 60 seconds suggests adverse selection. */
  private readonly FILL_RATE_THRESHOLD = 5;
  private readonly FILL_RATE_WINDOW_MS = 60 * 1000;
  /** Consecutive API errors before emergency cancel. */
  private readonly MAX_CONSECUTIVE_ERRORS = 3;
  /** Toxicity thresholds */
  private readonly TOXICITY_DIRECTIONALITY_THRESHOLD = 0.6;
  private readonly TOXICITY_MIN_FILLS = 3;

  constructor(
    private client: PolymarketClient,
    private state: StateManager,
    private inventory: InventoryManager,
    private config: MmConfig,
    logger: PluginLogger,
  ) {
    this.logger = logger;
  }

  /**
   * Run all risk checks. Returns the MOST SEVERE action needed.
   */
  check(
    markets: MmMarket[],
    books: Map<string, BookSnapshot>,
    priceMap: Map<string, number>,
  ): RiskAction {
    const st = this.state.get();

    // 1. Kill switch: total drawdown
    const totalPnl = st.totalPnl + this.state.getUnrealizedPnl(priceMap);
    const drawdownPct = (Math.abs(Math.min(0, totalPnl)) / this.config.totalCapital) * 100;
    if (drawdownPct >= this.config.maxDrawdownPercent) {
      return {
        type: "kill",
        reason: `总回撤 ${drawdownPct.toFixed(1)}% 超过限制 ${this.config.maxDrawdownPercent}%`,
      };
    }

    // 2. Daily loss limit
    if (st.dailyPnl < -this.config.maxDailyLoss) {
      return {
        type: "pause_day",
        reason: `日亏损 $${Math.abs(st.dailyPnl).toFixed(2)} 超过限制 $${this.config.maxDailyLoss}`,
      };
    }

    // 3. Consecutive API errors
    if (this.client.getConsecutiveErrors() >= this.MAX_CONSECUTIVE_ERRORS) {
      return {
        type: "kill",
        reason: `连续 ${this.client.getConsecutiveErrors()} 次 API 错误`,
      };
    }

    // 4. Per-market checks
    for (const market of markets) {
      // Inventory limit per market
      const invSide = this.inventory.checkInventoryLimit(market, priceMap);
      if (invSide) {
        return {
          type: "reduce_market",
          conditionId: market.conditionId,
          side: invSide,
          reason: `市场 ${market.question.slice(0, 20)}… 持仓过重`,
        };
      }

      // Circuit breaker: rapid price movement
      for (const token of market.tokens) {
        const book = books.get(token.tokenId);
        if (book) {
          const priceAction = this.checkPriceMovement(token.tokenId, book.midpoint);
          if (priceAction) {
            return {
              type: "pause_market",
              conditionId: market.conditionId,
              reason: `价格剧烈波动 (${token.outcome}): ${priceAction}`,
            };
          }
        }
      }

      // Adverse selection: high fill rate
      const fillAction = this.checkFillRate(market.conditionId);
      if (fillAction) {
        return {
          type: "widen_spread",
          conditionId: market.conditionId,
          factor: 1.5,
          reason: `高填充率 (可能被知情交易者吃单)`,
        };
      }
    }

    // 5. Total exposure check
    if (this.inventory.isTotalExposureExceeded(priceMap)) {
      return {
        type: "reduce_all",
        factor: 0.5,
        reason: `总敞口超过限制 $${this.config.maxTotalExposure}`,
      };
    }

    return { type: "ok" };
  }

  /**
   * Record a fill for adverse selection + toxic flow tracking.
   * Extended in v3 to include tokenId, side, and size for directionality analysis.
   */
  recordFill(conditionId: string, tokenId?: string, side?: "BUY" | "SELL", size?: number): void {
    const now = Date.now();
    let counter = this.fillCounters.get(conditionId);
    if (!counter || now - counter.windowStart > this.FILL_RATE_WINDOW_MS) {
      counter = {
        count: 0,
        windowStart: now,
        buys: 0,
        sells: 0,
        totalSize: 0,
        tokenFills: {},
      };
      this.fillCounters.set(conditionId, counter);
    }
    counter.count++;

    // Track directional data if provided
    if (side === "BUY") counter.buys++;
    else if (side === "SELL") counter.sells++;
    if (size) counter.totalSize += size;

    // Track per-token fills
    if (tokenId) {
      if (!counter.tokenFills[tokenId]) {
        counter.tokenFills[tokenId] = { buys: 0, sells: 0 };
      }
      if (side === "BUY") counter.tokenFills[tokenId].buys++;
      else if (side === "SELL") counter.tokenFills[tokenId].sells++;
    }
  }

  /**
   * Analyze toxic flow for a market.
   *
   * Toxicity = informed traders systematically hitting one side.
   * Detection: directionality > 0.6 (fills mostly one-sided) + count >= 3.
   * Size anomaly: average fill size > 2× historical average (large informed orders).
   */
  analyzeToxicity(conditionId: string): ToxicityAnalysis {
    const counter = this.fillCounters.get(conditionId);

    const defaultResult: ToxicityAnalysis = {
      conditionId,
      directionality: 0,
      sizeAnomaly: false,
      isToxic: false,
      totalFills: 0,
      dominantSide: "BUY",
    };

    if (!counter || counter.count < this.TOXICITY_MIN_FILLS) {
      return defaultResult;
    }

    const now = Date.now();
    if (now - counter.windowStart > this.FILL_RATE_WINDOW_MS) {
      return defaultResult;
    }

    // Directionality: how one-sided are the fills?
    // 0 = perfectly balanced, 1 = all one side
    const maxSide = Math.max(counter.buys, counter.sells);
    const minSide = Math.min(counter.buys, counter.sells);
    const total = counter.buys + counter.sells;
    const directionality = total > 0 ? (maxSide - minSide) / total : 0;

    // Size anomaly: average fill size compared to typical order size
    const avgFillSize = counter.totalSize / counter.count;
    const historicalAvg = this.config.orderSize; // use configured order size as baseline
    const sizeAnomaly = avgFillSize > historicalAvg * 2;

    // Toxic determination
    const isToxic =
      directionality > this.TOXICITY_DIRECTIONALITY_THRESHOLD &&
      counter.count >= this.TOXICITY_MIN_FILLS;

    const dominantSide: "BUY" | "SELL" = counter.buys >= counter.sells ? "BUY" : "SELL";

    if (isToxic) {
      this.logger.warn(
        `🧪 Toxic flow detected: ${conditionId.slice(0, 10)} ` +
          `dir=${directionality.toFixed(2)} fills=${counter.count} ` +
          `(${counter.buys}B/${counter.sells}S) sizeAnomaly=${sizeAnomaly} ` +
          `avgSize=${avgFillSize.toFixed(1)} dominant=${dominantSide}`,
      );
    }

    return {
      conditionId,
      directionality,
      sizeAnomaly,
      isToxic,
      totalFills: counter.count,
      dominantSide,
    };
  }

  /** Record a price snapshot for circuit breaker. */
  recordPrice(tokenId: string, price: number): void {
    const now = Date.now();
    let history = this.priceHistory.get(tokenId);
    if (!history) {
      history = [];
      this.priceHistory.set(tokenId, history);
    }
    history.push({ price, timestamp: now });

    // Trim old entries
    const cutoff = now - this.PRICE_MOVE_WINDOW_MS;
    this.priceHistory.set(
      tokenId,
      history.filter((h) => h.timestamp >= cutoff),
    );
  }

  /**
   * Get 5-minute realized volatility for a token.
   * Used by engine to feed SpreadController.
   */
  getRealizedVolatility(tokenId: string): number {
    const history = this.priceHistory.get(tokenId);
    if (!history || history.length < 3) return 0;

    // Calculate returns and standard deviation
    const returns: number[] = [];
    for (let i = 1; i < history.length; i++) {
      if (history[i - 1].price > 0) {
        returns.push((history[i].price - history[i - 1].price) / history[i - 1].price);
      }
    }

    if (returns.length < 2) return 0;

    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
  }

  // ---- Internal checks ----------------------------------------------------

  private checkPriceMovement(tokenId: string, currentPrice: number): string | null {
    const history = this.priceHistory.get(tokenId);
    if (!history || history.length < 2) return null;

    const oldest = history[0];
    if (oldest.price <= 0) return null;

    const move = Math.abs(currentPrice - oldest.price) / oldest.price;
    if (move >= this.PRICE_MOVE_THRESHOLD) {
      return `${(move * 100).toFixed(1)}% 在 ${((Date.now() - oldest.timestamp) / 1000).toFixed(0)}s 内`;
    }
    return null;
  }

  private checkFillRate(conditionId: string): boolean {
    const counter = this.fillCounters.get(conditionId);
    if (!counter) return false;
    const now = Date.now();
    if (now - counter.windowStart > this.FILL_RATE_WINDOW_MS) return false;
    return counter.count >= this.FILL_RATE_THRESHOLD;
  }
}
