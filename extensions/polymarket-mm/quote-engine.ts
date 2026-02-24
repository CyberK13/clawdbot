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
import type { SpreadController } from "./spread-controller.js";
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
    private spreadController: SpreadController,
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

    // Q_min balanced allocation: distribute combined budget proportionally
    // to token prices so both sides get similar share counts.
    // This maximizes Q_min = min(Q_one, Q_two) for extreme price markets.
    const tokenBudgets = this.calculateTokenBudgets(market, books, sizeFactor);

    for (const token of market.tokens) {
      const book = books.get(token.tokenId);
      if (!book) {
        this.logger.warn(`No book for ${token.tokenId} (${token.outcome})`);
        continue;
      }

      const budget = tokenBudgets.get(token.tokenId) ?? this.config.orderSize * sizeFactor;
      const tokenQuotes = this.generateTokenQuotes(market, token.tokenId, book, v, budget);
      if (tokenQuotes.length === 0) {
        this.logger.warn(
          `No quotes for ${token.outcome} (mid=${book.midpoint.toFixed(3)}, budget=$${budget.toFixed(1)})`,
        );
      }
      quotes.push(...tokenQuotes);
    }

    return quotes;
  }

  /**
   * Calculate per-token USDC budgets that maximize Q_min.
   *
   * For extreme price markets (e.g. YES=0.03, NO=0.97), equal USDC split
   * gives hugely imbalanced shares (YES=2000, NO=65). Since Q_min = min(Q_one, Q_two)
   * and Q scores are weighted by shares, the expensive side bottlenecks Q_min.
   *
   * Solution: allocate proportionally to midpoint price so both sides get
   * approximately equal share counts: budget_i/price_i ≈ constant.
   */
  private calculateTokenBudgets(
    market: MmMarket,
    books: Map<string, BookSnapshot>,
    sizeFactor: number,
  ): Map<string, number> {
    const budgets = new Map<string, number>();
    const perTokenBudget = this.config.orderSize * sizeFactor;

    if (market.tokens.length !== 2) {
      for (const t of market.tokens) budgets.set(t.tokenId, perTokenBudget);
      return budgets;
    }

    const [t0, t1] = market.tokens;
    const mid0 = books.get(t0.tokenId)?.midpoint ?? t0.price;
    const mid1 = books.get(t1.tokenId)?.midpoint ?? t1.price;
    const totalMid = mid0 + mid1;

    // Sanity check: prices should sum to ~1.0 for binary markets
    if (totalMid <= 0 || totalMid > 1.5) {
      for (const t of market.tokens) budgets.set(t.tokenId, perTokenBudget);
      return budgets;
    }

    // Combined budget = 2 × perTokenBudget (total for both tokens)
    const combinedBudget = perTokenBudget * 2;

    // Q_min optimal: allocate proportionally to price
    // budget_i = combined × mid_i / (mid_0 + mid_1)
    // → shares_i = budget_i / mid_i = combined / totalMid (equal for both!)
    let budget0 = (combinedBudget * mid0) / totalMid;
    let budget1 = (combinedBudget * mid1) / totalMid;

    // Floor: ensure each side can afford rewardsMinSize shares
    const minBudget0 = market.rewardsMinSize * mid0 * 1.1; // 10% headroom
    const minBudget1 = market.rewardsMinSize * mid1 * 1.1;
    if (budget0 < minBudget0 && minBudget0 < combinedBudget * 0.5) {
      budget0 = minBudget0;
      budget1 = combinedBudget - budget0;
    }
    if (budget1 < minBudget1 && minBudget1 < combinedBudget * 0.5) {
      budget1 = minBudget1;
      budget0 = combinedBudget - budget1;
    }

    budgets.set(t0.tokenId, budget0);
    budgets.set(t1.tokenId, budget1);

    // Log allocation when significantly unequal (ratio > 3:1)
    const ratio = Math.max(budget0, budget1) / Math.max(Math.min(budget0, budget1), 0.01);
    if (ratio > 3) {
      this.logger.info(
        `Q_min balanced: ${t0.outcome}=$${budget0.toFixed(1)} (${((budget0 / combinedBudget) * 100).toFixed(0)}%) ` +
          `${t1.outcome}=$${budget1.toFixed(1)} (${((budget1 / combinedBudget) * 100).toFixed(0)}%) ` +
          `shares≈${(budget0 / mid0).toFixed(0)}/${(budget1 / mid1).toFixed(0)}`,
      );
    }

    return budgets;
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
    tokenBudget: number, // Q_min-optimized USDC budget for this token
  ): TargetQuote[] {
    const quotes: TargetQuote[] = [];
    const tickSize = market.tickSize;
    const tick = parseFloat(tickSize);
    const midpoint = book.midpoint;

    // Calculate inventory skew
    const skew = this.inventory.calculateSkew(market, midpoint);

    // Dynamic spread: use SpreadController to calculate optimal spread
    // based on fill rate, volatility, inventory, and market's maxSpread.
    // Falls back to legacy fixed spread when maxSpread is unavailable.
    const baseHalfSpread =
      maxSpread > 0
        ? this.spreadController.calculateSpread(
            maxSpread,
            market.conditionId,
            tick,
            market.negRisk,
            midpoint,
          )
        : Math.max(market.negRisk ? 2 * tick : tick, this.config.defaultSpread);
    const minTicks = market.negRisk ? 2 * tick : tick;

    // Adaptive order sizing: ensure shares >= minScoringSize for reward eligibility.
    // If fixed orderSize doesn't produce enough shares, auto-scale up.
    const minScoringSize = market.rewardsMinSize;
    // Per-token cap: use the Q_min-optimized token budget.
    // Allow some headroom for minScoringSize adjustments.
    const maxOrderUsdc = tokenBudget * 1.2;

    // Check available inventory for SELL orders
    const pos = this.state.getPosition(tokenId);
    const availableShares = pos ? Math.max(0, pos.netShares) : 0;
    const canSell = availableShares > 0;

    // Size weights for multi-level quoting
    const weights = this.config.levelSizeWeights;
    const spreadMult = this.config.levelSpreadMultiplier;

    // Pre-compute usable levels and normalize weights so they sum to 1.0
    // (higher levels may be skipped when their spread exceeds maxSpread)
    let totalUsableWeight = 0;
    for (let l = 0; l < this.config.numLevels; l++) {
      const mult = l === 0 ? 1.0 : Math.pow(spreadMult, l);
      if (baseHalfSpread * mult >= maxSpread) break;
      totalUsableWeight += l < weights.length ? weights[l] : 1.0 / this.config.numLevels;
    }
    const weightNorm = totalUsableWeight > 0 ? 1.0 / totalUsableWeight : 1.0;

    for (let level = 0; level < this.config.numLevels; level++) {
      // Multi-level: each level uses geometrically increasing spread
      const levelSpreadMult = level === 0 ? 1.0 : Math.pow(spreadMult, level);
      const levelSpread = baseHalfSpread * levelSpreadMult;

      // Skip if this level would exceed max scoring spread
      if (levelSpread >= maxSpread) break;

      // Size weight for this level, normalized to sum to 1.0 across usable levels
      const rawWeight = level < weights.length ? weights[level] : 1.0 / this.config.numLevels;
      const sizeWeight = rawWeight * weightNorm;

      // --- BID (buy) ---
      // When long (positive skew): widen bid (less aggressive buying)
      // When short (negative skew): tighten bid (more aggressive buying)
      const bidSpread = Math.max(minTicks, levelSpread + skew);
      let bidPrice = midpoint - bidSpread;
      bidPrice = roundPrice(clampPrice(bidPrice, tickSize), tickSize, "BUY");

      // If rounding pushed spread to/beyond maxSpread, nudge one tick toward midpoint
      if (midpoint - bidPrice >= maxSpread && bidPrice + tick < midpoint) {
        bidPrice += tick;
        bidPrice = roundPrice(bidPrice, tickSize, "BUY");
      }

      // Ensure bid doesn't cross the book (must be < best ask for post-only)
      if (book.bestAsk > 0 && bidPrice >= book.bestAsk) {
        bidPrice = roundPrice(book.bestAsk - tick, tickSize, "BUY");
      }

      // Ensure bid stays within scoring range
      const bidActualSpread = midpoint - bidPrice;
      if (bidActualSpread <= maxSpread && bidPrice > 0) {
        // Adaptive sizing with level weight: guarantee shares >= minScoringSize
        const levelOrderSize = tokenBudget * sizeWeight;
        const baseShares = usdcToShares(levelOrderSize, bidPrice);
        const targetShares = Math.max(minScoringSize, baseShares);
        const adjustedUsdc = targetShares * bidPrice;
        const cappedUsdc = Math.min(adjustedUsdc, maxOrderUsdc * sizeWeight);
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

      // If rounding pushed spread to/beyond maxSpread, nudge one tick toward midpoint
      if (askPrice - midpoint >= maxSpread && askPrice - tick > midpoint) {
        askPrice -= tick;
        askPrice = roundPrice(askPrice, tickSize, "SELL");
      }

      // Ensure ask doesn't cross the book (must be > best bid for post-only)
      if (book.bestBid > 0 && askPrice <= book.bestBid) {
        askPrice = roundPrice(book.bestBid + tick, tickSize, "SELL");
      }

      // Ensure ask stays within scoring range
      const askActualSpread = askPrice - midpoint;
      if (askActualSpread <= maxSpread && askPrice < 1) {
        // Cap sell size at available inventory, weighted by level
        const levelAskSize = this.config.orderSize * sizeWeight;
        const askShares = Math.min(usdcToShares(levelAskSize, askPrice), availableShares);
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

    // CLOB API returns bids ascending (lowest first) — best bid is LAST
    const bestBid = bids.length > 0 ? bids[bids.length - 1].price : 0;
    // Asks are also ascending (lowest first) — best ask is FIRST (correct)
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
