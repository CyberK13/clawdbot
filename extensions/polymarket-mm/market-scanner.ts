// ---------------------------------------------------------------------------
// Market discovery & ranking by reward/competition ratio
//
// getCurrentRewards() returns only:
//   { condition_id, rewards_config, rewards_max_spread, rewards_min_size,
//     native_daily_rate, total_daily_rate }
//
// No tokens or question — must call getMarket(conditionId) for details.
// rewards_max_spread is in CENTS (e.g. 3.5 = 3.5 cents = 0.035 in price).
//
// Strategy: pre-sort by daily rate, only fetch full details for top candidates.
// ---------------------------------------------------------------------------

import type { MarketReward, TickSize } from "@polymarket/clob-client";
import type { PluginLogger } from "../../src/plugins/types.js";
import type { PolymarketClient } from "./client.js";
import type { MmConfig, MmMarket, MmToken } from "./types.js";
import { scoringFunction } from "./utils.js";

/** How many candidates to fetch full details for (avoid 3000+ API calls). */
const CANDIDATE_POOL_SIZE = 30;

export class MarketScanner {
  private logger: PluginLogger;
  private cachedMarkets: MmMarket[] = [];
  private lastScanTime = 0;

  constructor(
    private client: PolymarketClient,
    private config: MmConfig,
    logger: PluginLogger,
  ) {
    this.logger = logger;
  }

  getMarkets(): MmMarket[] {
    return this.cachedMarkets;
  }

  /**
   * Full scan:
   *   1. Fetch all reward configs (lightweight, single call)
   *   2. Pre-sort by daily rate, take top CANDIDATE_POOL_SIZE
   *   3. Fetch market details + orderbook for candidates
   *   4. Score, rank, cache
   */
  async scan(): Promise<MmMarket[]> {
    this.logger.info("Scanning markets for reward opportunities...");

    // 1. Fetch all reward entries
    const rewards = await this.client.getCurrentRewards();
    if (!rewards || rewards.length === 0) {
      this.logger.warn("No reward markets found");
      return [];
    }
    this.logger.info(`Found ${rewards.length} reward entries`);

    // 2. Pre-sort by daily rate, filter minimum
    const candidates = rewards
      .map((r) => ({
        ...r,
        dailyRate: (r as any).total_daily_rate || (r as any).native_daily_rate || 0,
      }))
      .filter((r) => r.dailyRate >= this.config.minRewardRate && r.dailyRate > 0)
      .sort((a, b) => b.dailyRate - a.dailyRate)
      .slice(0, CANDIDATE_POOL_SIZE);

    this.logger.info(
      `Pre-sorted: top ${candidates.length} by daily rate ` +
        `(range: $${candidates[0]?.dailyRate ?? 0} ~ $${candidates[candidates.length - 1]?.dailyRate ?? 0})`,
    );

    // 3. Fetch full details for each candidate
    const scored: MmMarket[] = [];
    for (const cand of candidates) {
      try {
        const market = await this.evaluateCandidate(cand);
        if (market) scored.push(market);
      } catch (err: any) {
        this.logger.warn(`Failed to evaluate ${cand.condition_id.slice(0, 16)}…: ${err.message}`);
      }
    }

    // 4. Final sort by score
    scored.sort((a, b) => b.score - a.score);
    this.cachedMarkets = scored;
    this.lastScanTime = Date.now();

    this.logger.info(
      `Ranked ${scored.length} markets. Top ${Math.min(scored.length, this.config.maxConcurrentMarkets)}:\n` +
        scored
          .slice(0, this.config.maxConcurrentMarkets)
          .map(
            (m, i) =>
              `  ${i + 1}. ${m.question.slice(0, 40)}… ($${m.rewardsDailyRate}/d, need=$${m.requiredCapital.toFixed(0)}, score=${m.score.toFixed(2)})`,
          )
          .join("\n"),
    );

    return this.cachedMarkets;
  }

  selectActiveMarkets(excludeConditionIds: string[] = []): MmMarket[] {
    return this.cachedMarkets
      .filter((m) => !excludeConditionIds.includes(m.conditionId))
      .slice(0, this.config.maxConcurrentMarkets);
  }

  shouldRescan(): boolean {
    return Date.now() - this.lastScanTime > 30 * 60 * 1000;
  }

  // ---------- Internal -------------------------------------------------------

  private async evaluateCandidate(
    cand: MarketReward & { dailyRate: number },
  ): Promise<MmMarket | null> {
    // Fetch market details (question, tokens, active status)
    const detail = await this.client.getMarket(cand.condition_id);
    if (!detail || !detail.active) return null;

    // Skip expired markets — API sometimes marks resolved markets as active
    const endDate = detail.end_date_iso || detail.end_date;
    if (endDate) {
      const endMs = new Date(endDate).getTime();
      if (endMs < Date.now()) {
        this.logger.info(`Skipping ${cand.condition_id.slice(0, 16)}: expired (end=${endDate})`);
        return null;
      }
    }

    const tokens: Array<{ outcome: string; token_id: string; price: number }> = detail.tokens || [];
    if (tokens.length < 2) return null;

    // Find YES/NO or first two outcomes (some markets use Up/Down etc)
    const token0 = tokens[0];
    const token1 = tokens[1];
    if (!token0?.token_id || !token1?.token_id) return null;

    // Skip effectively resolved markets where prices are extreme
    const p0 = token0.price || 0;
    const p1 = token1.price || 0;
    if ((p0 < 0.02 || p0 > 0.98) && (p1 < 0.02 || p1 > 0.98)) {
      this.logger.info(
        `Skipping ${cand.condition_id.slice(0, 16)}: resolved prices (${p0.toFixed(4)}/${p1.toFixed(4)})`,
      );
      return null;
    }

    // Capital-aware filtering: calculate the minimum USDC needed to enter
    // this market with orders meeting the rewards_min_size requirement.
    // BUY YES costs minSize × yesPrice, BUY NO costs minSize × noPrice.
    // We need both sides for optimal two-sided scoring.
    const minSize = cand.rewards_min_size || 0;
    const yesPrice = token0.price || 0.5;
    const noPrice = token1.price || 0.5;
    const yesCostForMinSize = minSize * yesPrice;
    const noCostForMinSize = minSize * noPrice;
    const requiredCapital = yesCostForMinSize + noCostForMinSize;

    if (requiredCapital > this.config.maxCapitalPerMarket) {
      this.logger.info(
        `Skipping ${cand.condition_id.slice(0, 16)}: requiredCapital=$${requiredCapital.toFixed(0)} > maxPerMarket=$${this.config.maxCapitalPerMarket} (minSize=${minSize}, yes=$${yesPrice.toFixed(2)}, no=$${noPrice.toFixed(2)})`,
      );
      return null;
    }

    // rewards_max_spread is in CENTS → convert to price units
    const maxSpreadCents = cand.rewards_max_spread || 5;
    const maxSpreadPrice = maxSpreadCents / 100; // 3.5 cents → 0.035

    // Fetch orderbook to assess competition
    let competition = 0;
    let tickSize: TickSize = "0.01";
    let negRisk = false;

    try {
      const book = await this.client.getOrderBook(token0.token_id);
      tickSize = (book.tick_size as TickSize) || "0.01";
      negRisk = book.neg_risk || false;

      const mid = this.midFromBook(book);
      competition = this.measureCompetition(book, mid, maxSpreadPrice);
    } catch {
      // non-critical
    }

    // Score: reward per dollar deployed, adjusted for scoring-weighted competition
    // Wider maxSpread markets are easier to score in → boost with sqrt(maxSpread/0.03)
    const TWO_SIDED_BOOST = 3.0;
    const spreadBoost = Math.sqrt(maxSpreadPrice / 0.03);
    const score =
      (cand.dailyRate * TWO_SIDED_BOOST * spreadBoost) / (competition + 50) / (requiredCapital + 1);

    const mmTokens: MmToken[] = [
      {
        tokenId: token0.token_id,
        outcome: token0.outcome || "A",
        price: token0.price || 0.5,
        complementTokenId: token1.token_id,
      },
      {
        tokenId: token1.token_id,
        outcome: token1.outcome || "B",
        price: token1.price || 0.5,
        complementTokenId: token0.token_id,
      },
    ];

    return {
      conditionId: cand.condition_id,
      question: detail.question || cand.condition_id.slice(0, 20),
      slug: detail.market_slug || "",
      tokens: mmTokens,
      rewardsMaxSpread: maxSpreadPrice, // stored as price units (0.035)
      rewardsMinSize: minSize,
      rewardsDailyRate: cand.dailyRate,
      tickSize,
      negRisk,
      requiredCapital,
      score,
      active: true,
    };
  }

  private midFromBook(book: any): number {
    const bids = book.bids || [];
    const asks = book.asks || [];
    // CLOB API returns bids ascending (lowest first) — best bid is LAST
    const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;
    const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 1;
    return (bestBid + bestAsk) / 2;
  }

  /**
   * Score-weighted competition within the scoring spread.
   * Uses the actual scoring function S(v,s) to weight orders by their
   * reward contribution, not just raw USDC volume.
   */
  private measureCompetition(book: any, mid: number, maxSpread: number): number {
    let weightedScore = 0;
    for (const bid of book.bids || []) {
      const price = parseFloat(bid.price);
      const spread = mid - price;
      if (spread > 0 && spread <= maxSpread) {
        weightedScore += scoringFunction(maxSpread, spread, parseFloat(bid.size));
      }
    }
    for (const ask of book.asks || []) {
      const price = parseFloat(ask.price);
      const spread = price - mid;
      if (spread > 0 && spread <= maxSpread) {
        weightedScore += scoringFunction(maxSpread, spread, parseFloat(ask.size));
      }
    }
    return weightedScore;
  }
}
