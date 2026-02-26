// ---------------------------------------------------------------------------
// Quote Engine — v5: Simple dual BUY for reward harvesting
//
// Strategy: BUY YES + BUY NO at targetSpread = maxSpread × spreadRatio
// No SELL orders (we don't hold inventory).
// No multi-level (single layer, concentrate capital for max score).
// No inventory skew (target 0 inventory).
// ---------------------------------------------------------------------------

import type { TickSize, OrderBookSummary } from "@polymarket/clob-client";
import type { PluginLogger } from "../../src/plugins/types.js";
import type { StateManager } from "./state.js";
import type { MmConfig, MmMarket, TargetQuote, BookSnapshot } from "./types.js";
import { roundPrice, clampPrice, roundSize, usdcToShares, scoringFunction } from "./utils.js";

const REWARD_C = 3.0;

export class QuoteEngine {
  private logger: PluginLogger;

  constructor(
    private state: StateManager,
    private config: MmConfig,
    logger: PluginLogger,
  ) {
    this.logger = logger;
  }

  /**
   * Generate target BUY quotes for both YES and NO tokens.
   * Simple: one BUY per token at targetSpread from midpoint.
   */
  generateQuotes(market: MmMarket, books: Map<string, BookSnapshot>): TargetQuote[] {
    const quotes: TargetQuote[] = [];
    const maxSpread = market.rewardsMaxSpread;
    const targetSpread = maxSpread * this.config.spreadRatio;

    // Single-sided: only quote cheaper token
    let tokensToQuote = market.tokens;
    if (this.config.singleSided && market.tokens.length === 2) {
      const [t0, t1] = market.tokens;
      const mid0 = books.get(t0.tokenId)?.midpoint ?? t0.price;
      const mid1 = books.get(t1.tokenId)?.midpoint ?? t1.price;
      const yesMid = t0.outcome === "Yes" ? mid0 : mid1;
      // Extreme prices MUST be two-sided
      if (yesMid >= 0.1 && yesMid <= 0.9) {
        tokensToQuote = [mid0 <= mid1 ? t0 : t1];
      }
    }

    // Q_min balanced allocation
    const tokenBudgets = this.calculateTokenBudgets(market, books);

    for (const token of tokensToQuote) {
      const book = books.get(token.tokenId);
      if (!book) continue;

      const budget = tokenBudgets.get(token.tokenId) ?? this.config.orderSize;
      const quote = this.generateTokenBuyQuote(
        market,
        token.tokenId,
        book,
        maxSpread,
        targetSpread,
        budget,
      );
      if (quote) quotes.push(quote);
    }

    return quotes;
  }

  /**
   * Generate a single BUY quote for a token.
   */
  private generateTokenBuyQuote(
    market: MmMarket,
    tokenId: string,
    book: BookSnapshot,
    maxSpread: number,
    targetSpread: number,
    tokenBudget: number,
  ): TargetQuote | null {
    const tickSize = market.tickSize;
    const tick = parseFloat(tickSize);
    const midpoint = book.midpoint;
    const minTicks = market.negRisk ? 2 * tick : tick;

    // BUY price: midpoint - targetSpread
    const bidSpread = Math.max(minTicks, targetSpread);
    let bidPrice = midpoint - bidSpread;
    bidPrice = roundPrice(clampPrice(bidPrice, tickSize), tickSize, "BUY");

    // Don't exceed maxSpread
    if (midpoint - bidPrice >= maxSpread && bidPrice + tick < midpoint) {
      bidPrice += tick;
      bidPrice = roundPrice(bidPrice, tickSize, "BUY");
    }

    // Don't cross the book
    if (book.bestAsk > 0 && bidPrice >= book.bestAsk) {
      bidPrice = roundPrice(book.bestAsk - tick, tickSize, "BUY");
    }

    const actualSpread = midpoint - bidPrice;
    if (actualSpread >= maxSpread || bidPrice <= 0) return null;

    // Sizing: ensure shares >= minScoringSize
    const minScoringSize = market.rewardsMinSize;
    const baseShares = usdcToShares(tokenBudget, bidPrice);
    const targetShares = Math.max(minScoringSize, baseShares);
    const adjustedUsdc = targetShares * bidPrice;
    const cappedUsdc = Math.min(adjustedUsdc, tokenBudget * 1.2);
    const bidShares = usdcToShares(cappedUsdc, bidPrice);
    const roundedShares = roundSize(bidShares, tickSize);

    if (roundedShares < minScoringSize || roundedShares <= 0) return null;

    return {
      tokenId,
      side: "BUY" as const,
      price: bidPrice,
      size: roundedShares,
      level: 0,
    };
  }

  /**
   * Q_min balanced per-token budgets.
   * Allocate proportionally to price so both sides get ~equal share counts.
   */
  private calculateTokenBudgets(
    market: MmMarket,
    books: Map<string, BookSnapshot>,
  ): Map<string, number> {
    const budgets = new Map<string, number>();
    const perTokenBudget = this.config.orderSize;

    if (market.tokens.length !== 2) {
      for (const t of market.tokens) budgets.set(t.tokenId, perTokenBudget);
      return budgets;
    }

    const [t0, t1] = market.tokens;
    const mid0 = books.get(t0.tokenId)?.midpoint ?? t0.price;
    const mid1 = books.get(t1.tokenId)?.midpoint ?? t1.price;
    const totalMid = mid0 + mid1;

    if (totalMid <= 0 || totalMid > 1.5) {
      for (const t of market.tokens) budgets.set(t.tokenId, perTokenBudget);
      return budgets;
    }

    const combinedBudget = perTokenBudget * 2;
    let budget0 = (combinedBudget * mid0) / totalMid;
    let budget1 = (combinedBudget * mid1) / totalMid;

    // Floor: ensure each side can afford rewardsMinSize
    const minBudget0 = market.rewardsMinSize * mid0 * 1.1;
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
    return budgets;
  }

  /**
   * Estimate reward score for monitoring.
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

    let qOne = 0;
    let qTwo = 0;

    for (const q of quotes) {
      const isYes = q.tokenId === yesToken.tokenId;
      const mid = isYes ? yesMid : noMid;
      const spread = Math.abs(q.price - mid);
      const s = scoringFunction(v, spread, q.size);

      // BUY YES → Q_one, BUY NO → Q_two
      if (isYes && q.side === "BUY") qOne += s;
      else if (isYes && q.side === "SELL") qTwo += s;
      else if (!isYes && q.side === "SELL") qOne += s;
      else if (!isYes && q.side === "BUY") qTwo += s;
    }

    const midpoint = yesMid;
    let qMin: number;
    const isExtreme = midpoint < 0.1 || midpoint > 0.9;

    if (isExtreme) {
      qMin = Math.min(qOne, qTwo);
    } else {
      qMin = Math.max(Math.min(qOne, qTwo), Math.max(qOne / REWARD_C, qTwo / REWARD_C));
    }

    const twoSided = qOne > 0 && qTwo > 0;
    return { qOne, qTwo, qMin, twoSided };
  }

  /**
   * Parse raw orderbook into BookSnapshot.
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

    // CLOB API: bids ascending (best bid = LAST), asks descending (best ask = LAST)
    const bestBid = bids.length > 0 ? bids[bids.length - 1].price : 0;
    const bestAsk = asks.length > 0 ? asks[asks.length - 1].price : 1;
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
