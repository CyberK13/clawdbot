// ---------------------------------------------------------------------------
// Reward Tracker: Estimate rewards, validate scoring, track epochs
//
// - Rewards sampled every minute (10,080 samples per weekly epoch)
// - Distributed daily at UTC midnight
// - Primary: local estimation (spread/size check vs reward params)
// - Secondary: areOrdersScoring() API (only works for native rewards,
//   returns false for sponsored-only markets — which is most markets)
// ---------------------------------------------------------------------------

import type { PluginLogger } from "../../src/plugins/types.js";
import type { PolymarketClient } from "./client.js";
import type { QuoteEngine } from "./quote-engine.js";
import type { StateManager } from "./state.js";
import type { MmMarket, RewardScore, BookSnapshot } from "./types.js";
import { todayUTC, fmtUsd, scoringFunction } from "./utils.js";

export class RewardTracker {
  private logger: PluginLogger;
  private lastScoringCheck = 0;
  private lastEarningsCheck = 0;
  private scoringResults: Map<string, boolean> = new Map(); // orderId → scoring

  constructor(
    private client: PolymarketClient,
    private state: StateManager,
    private quoteEngine: QuoteEngine,
    logger: PluginLogger,
  ) {
    this.logger = logger;
  }

  /**
   * Check if our orders are scoring. Call every ~60s.
   *
   * Primary method: local estimation — our quote engine always places within
   * targetSpread < maxSpread, so all live orders are assumed scoring.
   *
   * The areOrdersScoring() API only checks native maker rebates, NOT
   * sponsored rewards (which are the majority of reward markets). So we
   * use local estimation as the primary source of truth.
   */
  async checkScoring(): Promise<{ scoring: number; total: number }> {
    const now = Date.now();
    if (now - this.lastScoringCheck < 30_000) {
      return this.getCurrentScoringStats();
    }
    this.lastScoringCheck = now;

    const trackedOrders = this.state.getTrackedOrders();
    const live = trackedOrders.filter((o) => o.status === "live");

    if (live.length === 0) {
      return { scoring: 0, total: 0 };
    }

    // Local estimation: all live orders placed by our quote engine are scoring
    // (quote engine always places within targetSpread < maxSpread and above minSize)
    for (const order of live) {
      if (!order.scoring) {
        order.scoring = true;
        this.state.trackOrder(order);
      }
    }

    return { scoring: live.length, total: live.length };
  }

  /** Get current scoring stats from cache. */
  getCurrentScoringStats(): { scoring: number; total: number } {
    const tracked = this.state.getTrackedOrders();
    const live = tracked.filter((o) => o.status === "live");
    const scoring = live.filter((o) => o.scoring).length;
    return { scoring, total: live.length };
  }

  /**
   * Estimate reward score for all active markets.
   * Uses the exact Polymarket formula to estimate our share.
   */
  estimateRewards(
    markets: MmMarket[],
    books: Map<string, BookSnapshot>,
    currentQuotes: Map<string, import("./types.js").TargetQuote[]>,
  ): RewardScore[] {
    const scores: RewardScore[] = [];

    for (const market of markets) {
      const quotes = currentQuotes.get(market.conditionId) || [];
      if (quotes.length === 0) continue;

      const yesToken = market.tokens.find((t) => t.outcome === "Yes");
      const yesBook = yesToken ? books.get(yesToken.tokenId) : undefined;
      const midpoint = yesBook?.midpoint ?? 0.5;

      const { qOne, qTwo, qMin, twoSided } = this.quoteEngine.estimateRewardScore(
        market,
        quotes,
        books,
      );

      // Measure competition from book (scoring-weighted USDC within spread)
      const competition = yesBook
        ? this.measureCompetition(yesBook, midpoint, market.rewardsMaxSpread)
        : 0;

      scores.push({
        conditionId: market.conditionId,
        qOne,
        qTwo,
        qMin,
        midpoint,
        twoSided,
        timestamp: Date.now(),
        competition,
      });
    }

    return scores;
  }

  /**
   * Fetch actual earnings from the API (daily check).
   */
  async fetchDailyEarnings(): Promise<number> {
    const now = Date.now();
    // Only check once per hour
    if (now - this.lastEarningsCheck < 3600_000) return 0;
    this.lastEarningsCheck = now;

    try {
      // Check yesterday's earnings (today's not finalized yet)
      const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
      const earnings = await this.client.getUserEarnings(yesterday);

      let totalEarned = 0;
      if (Array.isArray(earnings)) {
        for (const e of earnings) {
          totalEarned += e.earnings || 0;
        }
      }

      if (totalEarned > 0) {
        this.logger.info(`昨日奖励收入: ${fmtUsd(totalEarned)}`);

        // Update reward history
        const history = this.state.get().rewardHistory;
        const existing = history.find((h) => h.date === yesterday);
        if (existing) {
          existing.actual = totalEarned;
        } else {
          history.push({ date: yesterday, estimated: 0, actual: totalEarned });
        }
        this.state.update({ rewardHistory: history });
      }

      return totalEarned;
    } catch (err: any) {
      this.logger.warn(`Failed to fetch earnings: ${err.message}`);
      return 0;
    }
  }

  /**
   * Estimate our share of the daily reward for a market.
   *
   * Our share ≈ (ourQmin / (ourQmin + competitorQmin)) × dailyRate
   * Since we can't see competitor totals, we estimate using the
   * competition metric (total resting USDC in spread) as a proxy.
   * This is a rough order-of-magnitude estimate.
   */
  estimateOurShare(market: MmMarket, ourQmin: number, competitionUsdc: number): number {
    if (ourQmin <= 0 || market.rewardsDailyRate <= 0) return 0;
    // Rough heuristic: assume competitor Q_min is proportional to their USDC in spread
    // A $100 USDC competitor at similar spread might produce Q_min ~50-200
    // We use a simple ratio model with a floor
    const competitorQEstimate = Math.max(competitionUsdc * 0.5, 50);
    const ourFraction = ourQmin / (ourQmin + competitorQEstimate);
    return ourFraction * market.rewardsDailyRate;
  }

  /**
   * Build structured reward data for API/dashboard.
   */
  getRewardData(
    scores: RewardScore[],
    markets: MmMarket[],
  ): {
    scoring: { scoring: number; total: number };
    markets: Array<{
      question: string;
      conditionId: string;
      qOne: number;
      qTwo: number;
      qMin: number;
      twoSided: boolean;
      dailyRate: number;
      estimatedShare: number;
    }>;
    totalEstDaily: number;
    yesterdayActual: number | null;
    weekAvg: number;
    rewardHistory: Array<{ date: string; estimated: number; actual?: number }>;
  } {
    const scoringStats = this.getCurrentScoringStats();
    const state = this.state.get();

    let totalEstDaily = 0;
    const marketData = scores.map((score) => {
      const market = markets.find((m) => m.conditionId === score.conditionId);
      const dailyRate = market?.rewardsDailyRate ?? 0;
      const estimatedShare = this.estimateOurShare(market!, score.qMin, score.competition);
      totalEstDaily += estimatedShare;

      return {
        question: market?.question ?? score.conditionId.slice(0, 20),
        conditionId: score.conditionId,
        qOne: score.qOne,
        qTwo: score.qTwo,
        qMin: score.qMin,
        twoSided: score.twoSided,
        dailyRate,
        estimatedShare,
      };
    });

    const history = state.rewardHistory || [];
    const recent = history.slice(-7);
    const weekAvg =
      recent.length > 0
        ? recent.reduce((s, h) => s + (h.actual ?? h.estimated), 0) / recent.length
        : 0;

    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const yesterdayEntry = history.find((h) => h.date === yesterday);

    return {
      scoring: scoringStats,
      markets: marketData,
      totalEstDaily,
      yesterdayActual: yesterdayEntry?.actual ?? null,
      weekAvg,
      rewardHistory: history.slice(-30), // last 30 days
    };
  }

  /**
   * Measure scoring-weighted competition within the reward spread.
   * Uses the same scoring function as Polymarket to weight orders.
   */
  private measureCompetition(book: BookSnapshot, mid: number, maxSpread: number): number {
    let weightedScore = 0;
    for (const bid of book.bids) {
      const spread = mid - bid.price;
      if (spread > 0 && spread <= maxSpread) {
        weightedScore += scoringFunction(maxSpread, spread, bid.size);
      }
    }
    for (const ask of book.asks) {
      const spread = ask.price - mid;
      if (spread > 0 && spread <= maxSpread) {
        weightedScore += scoringFunction(maxSpread, spread, ask.size);
      }
    }
    return weightedScore;
  }

  /** Format reward status for display (Telegram). */
  formatRewardStatus(scores: RewardScore[], markets: MmMarket[]): string {
    const data = this.getRewardData(scores, markets);

    const lines: string[] = [
      "🎯 奖励计分状态",
      "━".repeat(24),
      `📊 计分: ${data.scoring.scoring}/${data.scoring.total}` +
        (data.scoring.total > 0
          ? ` (${Math.round((data.scoring.scoring / data.scoring.total) * 100)}%)`
          : ""),
      "",
    ];

    for (let i = 0; i < data.markets.length; i++) {
      const m = data.markets[i];
      const twoSidedFlag = m.twoSided ? "✅双边" : "⚠️单边";
      lines.push(`${i + 1}. ${m.question.slice(0, 30)}…`);
      lines.push(`   Q_min=${m.qMin.toFixed(1)} (${twoSidedFlag}) | $${m.dailyRate.toFixed(2)}/日`);
      lines.push(`   我的份额: ~${fmtUsd(m.estimatedShare)}/日`);
    }

    lines.push("");
    lines.push(`💰 估算日收益: ~${fmtUsd(data.totalEstDaily)}`);
    if (data.yesterdayActual !== null) {
      lines.push(`📈 昨日实际: ${fmtUsd(data.yesterdayActual)}`);
    }
    if (data.weekAvg > 0) {
      lines.push(`📊 7日平均: ${fmtUsd(data.weekAvg)}/日`);
    }

    return lines.join("\n");
  }
}
