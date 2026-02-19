// ---------------------------------------------------------------------------
// Quote Engine: Two-sided quote generation optimized for Polymarket rewards
//
// Polymarket Liquidity Reward Scoring:
//   S(v, s) = ((v - s) / v)² × b
//     v = rewards_max_spread (per market)
//     s = spread from size-cutoff-adjusted midpoint
//     b = order size in shares
//
//   Q_one = Σ S(v, spread_i) × bidSize_i (market m)
//         + Σ S(v, spread_j) × askSize_j (complement m')
//
//   Q_two = Σ S(v, spread_i) × askSize_i (market m)
//         + Σ S(v, spread_j) × bidSize_j (complement m')
//
//   Midpoint ∈ [0.10, 0.90]:
//     Q_min = max(min(Q_one, Q_two), max(Q_one/c, Q_two/c))
//     c = 3.0 → two-sided gets up to 3× single-sided
//
//   Midpoint < 0.10 or > 0.90:
//     Q_min = min(Q_one, Q_two)
//     → MUST be two-sided, single-sided = 0
//
// Strategy:
//   1. Always quote two-sided on both YES and NO to maximize Q_min
//   2. Place orders close to midpoint for ((v-s)/v)² benefit
//   3. Respect rewards_min_size and rewards_max_spread
//   4. Apply inventory skew without breaking scoring eligibility
// ---------------------------------------------------------------------------

import type { TickSize, OrderBookSummary } from "@polymarket/clob-client";
import type { PluginLogger } from "../../src/plugins/types.js";
import type { InventoryManager } from "./inventory-manager.js";
import type { StateManager } from "./state.js";
import type { MmConfig, MmMarket, TargetQuote, BookSnapshot } from "./types.js";
import { roundPrice, clampPrice, roundSize, usdcToShares, scoringFunction } from "./utils.js";

/** The c parameter from Polymarket's reward formula (single-sided penalty). */
const REWARD_C = 3.0;

export class QuoteEngine {
  private logger: PluginLogger;

  constructor(
    private inventory: InventoryManager,
    private state: StateManager,
    private config: MmConfig,
    logger: PluginLogger,
  ) {
    this.logger = logger;
  }

  /**
   * Generate target quotes for a market (both YES and NO tokens).
   *
   * For each token we place:
   *   - BID levels (buy orders) at decreasing prices below midpoint
   *   - ASK levels (sell orders) at increasing prices above midpoint
   *
   * Two-sided quoting on both YES and NO means:
   *   Q_one contributions: bids on YES + asks on NO
   *   Q_two contributions: asks on YES + bids on NO
   *
   * Both Q_one and Q_two get populated → maximizes Q_min.
   */
  generateQuotes(
    market: MmMarket,
    books: Map<string, BookSnapshot>,
    sizeFactor: number, // 0-1 from risk/exposure limits
  ): TargetQuote[] {
    if (sizeFactor <= 0) return [];

    const quotes: TargetQuote[] = [];
    const v = market.rewardsMaxSpread;

    for (const token of market.tokens) {
      const book = books.get(token.tokenId);
      if (!book) {
        this.logger.warn(`No book for ${token.tokenId} (${token.outcome})`);
        continue;
      }

      const tokenQuotes = this.generateTokenQuotes(market, token.tokenId, book, v, sizeFactor);
      if (tokenQuotes.length === 0) {
        this.logger.warn(
          `No quotes for ${token.outcome} (mid=${book.midpoint.toFixed(3)}, maxSpread=${v}, minSize=${market.rewardsMinSize}, orderSize=$${this.config.orderSize}×${sizeFactor.toFixed(2)})`,
        );
      }
      quotes.push(...tokenQuotes);
    }

    return quotes;
  }

  /**
   * Generate bid and ask quotes for a single token.
   *
   * SELL (ask) orders require holding tokens. If we have no inventory
   * for this token, only BUY orders are generated. Two-sided reward
   * scoring still works because BUY YES + BUY NO cover both Q_one
   * and Q_two in the reward formula.
   */
  private generateTokenQuotes(
    market: MmMarket,
    tokenId: string,
    book: BookSnapshot,
    maxSpread: number,
    sizeFactor: number,
  ): TargetQuote[] {
    const quotes: TargetQuote[] = [];
    const tickSize = market.tickSize;
    const tick = parseFloat(tickSize);
    const midpoint = book.midpoint;

    // Calculate inventory skew
    const skew = this.inventory.calculateSkew(market, midpoint);

    // Optimal spread: as tight as possible for maximum ((v-s)/v)² reward score.
    // At 1 tick vs 60% maxSpread, the score ratio is ~3.2x better.
    // Risk: easier to get filled (adverse selection), mitigated by small size + skew.
    //
    // negRisk markets: local orderbook is sparse (bid~0.001, ask~0.999) because
    // real liquidity comes from complement-implied orders invisible in our book.
    // Using 1-tick spread causes "crosses book" errors. Use 2 ticks minimum.
    const minTicks = market.negRisk ? 2 * tick : tick;
    const baseHalfSpread = Math.max(minTicks, Math.min(this.config.defaultSpread, maxSpread * 0.9));

    // Adaptive order sizing: ensure shares >= minScoringSize for reward eligibility.
    // If fixed orderSize doesn't produce enough shares, auto-scale up.
    const minScoringSize = market.rewardsMinSize;
    const maxOrderUsdc = this.config.maxCapitalPerMarket * 0.5; // single-side cap

    // Check available inventory for SELL orders
    const pos = this.state.getPosition(tokenId);
    const availableShares = pos ? Math.max(0, pos.netShares) : 0;
    const canSell = availableShares > 0;

    for (let level = 0; level < this.config.numLevels; level++) {
      const levelSpread = baseHalfSpread + level * tick;

      // Skip if this level would exceed max scoring spread
      if (levelSpread >= maxSpread) break;

      // --- BID (buy) ---
      // When long (positive skew): widen bid (less aggressive buying)
      // When short (negative skew): tighten bid (more aggressive buying)
      const bidSpread = Math.max(minTicks, levelSpread + skew);
      let bidPrice = midpoint - bidSpread;
      bidPrice = roundPrice(clampPrice(bidPrice, tickSize), tickSize, "BUY");

      // Ensure bid doesn't cross the book (must be < best ask for post-only)
      if (book.bestAsk > 0 && bidPrice >= book.bestAsk) {
        bidPrice = roundPrice(book.bestAsk - tick, tickSize, "BUY");
      }

      // Ensure bid stays within scoring range
      const bidActualSpread = midpoint - bidPrice;
      if (bidActualSpread < maxSpread && bidPrice > 0) {
        // Adaptive sizing: guarantee shares >= minScoringSize
        const baseShares = usdcToShares(this.config.orderSize * sizeFactor, bidPrice);
        const targetShares = Math.max(minScoringSize, baseShares);
        const adjustedUsdc = targetShares * bidPrice;
        const cappedUsdc = Math.min(adjustedUsdc, maxOrderUsdc);
        const bidShares = usdcToShares(cappedUsdc, bidPrice);
        const roundedBidShares = roundSize(bidShares, tickSize);

        if (roundedBidShares >= minScoringSize && roundedBidShares > 0) {
          quotes.push({
            tokenId,
            side: "BUY",
            price: bidPrice,
            size: roundedBidShares,
            level,
          });
        }
      }

      // --- ASK (sell) --- only if we have inventory
      if (!canSell) continue;

      // When long (positive skew): tighten ask (more aggressive selling)
      // When short (negative skew): widen ask (less aggressive selling)
      const askSpread = Math.max(minTicks, levelSpread - skew);
      let askPrice = midpoint + askSpread;
      askPrice = roundPrice(clampPrice(askPrice, tickSize), tickSize, "SELL");

      // Ensure ask doesn't cross the book (must be > best bid for post-only)
      if (book.bestBid > 0 && askPrice <= book.bestBid) {
        askPrice = roundPrice(book.bestBid + tick, tickSize, "SELL");
      }

      // Ensure ask stays within scoring range
      const askActualSpread = askPrice - midpoint;
      if (askActualSpread < maxSpread && askPrice < 1) {
        // Cap sell size at available inventory
        const askShares = Math.min(usdcToShares(this.config.orderSize, askPrice), availableShares);
        const roundedAskShares = roundSize(askShares, tickSize);

        if (roundedAskShares >= minScoringSize && roundedAskShares > 0) {
          quotes.push({
            tokenId,
            side: "SELL",
            price: askPrice,
            size: roundedAskShares,
            level,
          });
        }
      }
    }

    return quotes;
  }

  /**
   * Estimate our reward score for the generated quotes.
   * Useful for monitoring and optimization.
   */
  estimateRewardScore(
    market: MmMarket,
    quotes: TargetQuote[],
    books: Map<string, BookSnapshot>,
  ): { qOne: number; qTwo: number; qMin: number; twoSided: boolean } {
    const v = market.rewardsMaxSpread;
    const yesToken = market.tokens.find((t) => t.outcome === "Yes");
    const noToken = market.tokens.find((t) => t.outcome === "No");
    if (!yesToken || !noToken) return { qOne: 0, qTwo: 0, qMin: 0, twoSided: false };

    const yesBook = books.get(yesToken.tokenId);
    const noBook = books.get(noToken.tokenId);
    const yesMid = yesBook?.midpoint ?? 0.5;
    const noMid = noBook?.midpoint ?? 0.5;

    // Q_one = bids on YES × S + asks on NO × S
    let qOne = 0;
    // Q_two = asks on YES × S + bids on NO × S
    let qTwo = 0;

    for (const q of quotes) {
      const isYes = q.tokenId === yesToken.tokenId;
      const mid = isYes ? yesMid : noMid;
      const spread = Math.abs(q.price - mid);
      const s = scoringFunction(v, spread, q.size);

      if (isYes && q.side === "BUY") qOne += s;
      else if (isYes && q.side === "SELL") qTwo += s;
      else if (!isYes && q.side === "SELL") qOne += s;
      else if (!isYes && q.side === "BUY") qTwo += s;
    }

    // Apply Q_min formula based on midpoint range
    const midpoint = yesMid;
    let qMin: number;
    const isExtreme = midpoint < 0.1 || midpoint > 0.9;

    if (isExtreme) {
      // Equation 4b: strict two-sided
      qMin = Math.min(qOne, qTwo);
    } else {
      // Equation 4a: allows single-sided at 1/c penalty
      qMin = Math.max(Math.min(qOne, qTwo), Math.max(qOne / REWARD_C, qTwo / REWARD_C));
    }

    const twoSided = qOne > 0 && qTwo > 0;

    return { qOne, qTwo, qMin, twoSided };
  }

  /**
   * Parse raw orderbook into our BookSnapshot format.
   */
  parseBook(raw: OrderBookSummary): BookSnapshot {
    const bids = (raw.bids || []).map((b) => ({
      price: parseFloat(b.price),
      size: parseFloat(b.size),
    }));
    const asks = (raw.asks || []).map((a) => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size),
    }));

    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const bestAsk = asks.length > 0 ? asks[0].price : 1;
    const midpoint = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;

    return {
      tokenId: raw.asset_id,
      midpoint,
      bestBid,
      bestAsk,
      spread,
      bids,
      asks,
      timestamp: Date.now(),
    };
  }
}
