// ---------------------------------------------------------------------------
// Polymarket Market-Making Types
// ---------------------------------------------------------------------------

import type {
  OpenOrder,
  OrderBookSummary,
  Trade,
  MarketReward,
  TickSize,
} from "@polymarket/clob-client";

// ---- Configuration ---------------------------------------------------------

export interface MmConfig {
  // Capital — dynamic from balance
  /** Fraction of balance to deploy per market (e.g. 0.95 = 95%) */
  deployRatio: number;
  /** Fraction of balance for per-token order size (e.g. 0.475 = 47.5%) */
  orderSizeRatio: number;
  /** Computed at runtime from balance × deployRatio */
  maxCapitalPerMarket: number;
  /** Fraction of capital to keep as reserve (0-1) */
  reserveRatio: number;

  // Quoting — dynamic spread ratios (fraction of market's maxSpread)
  defaultSpreadRatio: number;
  minSpreadRatio: number;
  maxSpreadRatio: number;
  /** Legacy fixed spread fields (used as fallback) */
  defaultSpread: number;
  minSpread: number;
  maxSpread: number;
  orderSize: number;
  numLevels: number;
  refreshIntervalMs: number;

  // Inventory management
  maxInventoryPerMarket: number;
  skewFactor: number;

  // Risk
  maxTotalExposure: number;
  maxDrawdownPercent: number;
  maxDailyLoss: number;

  // Opportunistic
  deviationThreshold: number;
  opportunisticSize: number;

  // Markets
  maxConcurrentMarkets: number;
  minDailyVolume: number;
  minRewardRate: number;

  // Fill recovery
  fillRecoveryTimeoutMs: number;
  maxExposureForSoftSell: number;
  maxExposureForHardSell: number;

  // Reconciliation
  reconcileIntervalMs: number;

  // Exit / liquidation safety
  /** Min sell price as fraction of avgEntry (e.g. 0.5 = won't sell below 50% of entry) */
  minSellPriceRatio: number;
  /** Max retries per split level before reducing split factor */
  forceSellMaxRetries: number;
  /** Delay between force sell retries (ms) */
  forceSellRetryDelayMs: number;
  /** Whether to liquidate positions on graceful stop */
  liquidateOnStop: boolean;
  /** Whether to liquidate positions on emergency kill */
  liquidateOnKill: boolean;
  /** Max age for pending sells before disabling min price protection (ms) */
  maxPendingSellAgeMs: number;

  // Multi-level quoting
  /** Size distribution weights per level (must sum to ~1.0) */
  levelSizeWeights: number[];
  /** Spread multiplier between successive levels */
  levelSpreadMultiplier: number;

  // Continuous spread model factors
  /** Weight for realized volatility adjustment (0 disables) */
  volatilityWeight: number;
  /** Penalty for inventory/exposure ratio on spread (0 disables) */
  inventorySpreadPenalty: number;

  // Fast split progression
  /** Max retries per split level before reducing */
  forceSellMaxRetriesPerSplit: number;
  /** Minimum split factor before reset */
  forceSellMinSplitFactor: number;
  /** Retry delay for urgent/critical pending sells (ms) */
  forceSellUrgentRetryDelayMs: number;

  // Protective sell
  /** Max loss from entry price for protective SELL (e.g. 0.005 = -0.5%) */
  protectiveSellSpread: number;

  // Trailing stop (Livermore)
  /** Hard stop loss: sell if price drops this fraction below entry (e.g. 0.02 = -2%) */
  trailingStopLoss: number;
  /** Activation threshold: trailing stop activates when price rises this fraction above entry */
  trailingActivation: number;
  /** Trailing distance: sell if price drops this fraction below peak */
  trailingDistance: number;

  // Single-sided quoting
  /** Only place BUY on one token per market (cheaper token, 1/3 reward but half fill risk) */
  singleSided: boolean;
}

// ---- Market ----------------------------------------------------------------

export interface MmMarket {
  conditionId: string;
  question: string;
  slug: string;
  tokens: MmToken[];
  rewardsMaxSpread: number;
  rewardsMinSize: number;
  rewardsDailyRate: number;
  tickSize: TickSize;
  negRisk: boolean;
  requiredCapital: number;
  score: number;
  active: boolean;
}

export interface MmToken {
  tokenId: string;
  outcome: string; // "Yes" | "No"
  price: number;
  complementTokenId: string;
}

// ---- Orderbook snapshot ----------------------------------------------------

export interface BookSnapshot {
  tokenId: string;
  midpoint: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  timestamp: number;
}

// ---- Quoting ---------------------------------------------------------------

/** A target quote to be placed on the exchange */
export interface TargetQuote {
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number; // in shares (conditional tokens)
  level: number; // 0 = tightest
}

// ---- Orders ----------------------------------------------------------------

export interface TrackedOrder {
  orderId: string;
  tokenId: string;
  conditionId: string;
  side: "BUY" | "SELL";
  price: number;
  originalSize: number;
  filledSize: number;
  status: "live" | "filled" | "cancelled";
  scoring: boolean;
  placedAt: number;
  level: number;
}

// ---- Inventory / Position ---------------------------------------------------

export interface Position {
  conditionId: string;
  tokenId: string;
  outcome: string;
  /** Net shares held (positive = long, negative = short) */
  netShares: number;
  /** Volume-weighted average entry price */
  avgEntry: number;
  /** Realized P&L from closed portion */
  realizedPnl: number;
  /** Trailing stop: highest price since entry (high watermark) */
  trailingPeak?: number;
}

// ---- Risk ------------------------------------------------------------------

export type RiskAction =
  | { type: "kill"; reason: string }
  | { type: "pause_day"; reason: string }
  | { type: "reduce_market"; conditionId: string; side: "BUY" | "SELL"; reason: string }
  | { type: "reduce_all"; factor: number; reason: string }
  | { type: "pause_market"; conditionId: string; reason: string }
  | { type: "widen_spread"; conditionId: string; factor: number; reason: string }
  | { type: "ok" };

// ---- State (persisted) -----------------------------------------------------

export interface MmState {
  running: boolean;
  startedAt: number | null;
  capital: number;
  /** High watermark balance for drawdown calculation */
  peakBalance: number;
  dailyPnl: number;
  dailyDate: string; // YYYY-MM-DD
  totalPnl: number;
  totalRewardsEstimate: number;
  positions: Record<string, Position>; // key = tokenId
  trackedOrders: Record<string, TrackedOrder>; // key = orderId
  pendingSells: Record<string, PendingSell>; // key = tokenId
  activeMarkets: string[]; // conditionIds
  pausedMarkets: string[];
  errorCount: number;
  lastRefreshAt: number;
  lastScanAt: number;
  killSwitchTriggered: boolean;
  dayPaused: boolean;
  rewardHistory: Array<{ date: string; estimated: number; actual?: number }>;
  /** Fill history for spread controller */
  fillHistory: FillEvent[];
  /** Dynamic spread state */
  spreadState: SpreadState;
}

// ---- Reward scoring (Polymarket formula) -----------------------------------

/**
 * Polymarket liquidity reward scoring:
 *   S(v, s) = ((v - s) / v)² × b
 *
 * Q_one = Σ S(v, spread_i) × bidSize_i  (on market m)
 *       + Σ S(v, spread_j) × askSize_j  (on complement m')
 *
 * Q_two = Σ S(v, spread_i) × askSize_i  (on market m)
 *       + Σ S(v, spread_j) × bidSize_j  (on complement m')
 *
 * When midpoint ∈ [0.10, 0.90]:
 *   Q_min = max(min(Q_one, Q_two), max(Q_one / c, Q_two / c))
 *   → Single-sided scores at 1/c (currently c=3.0)
 *   → Two-sided scores at min of both sides (up to 3x single-sided)
 *
 * When midpoint < 0.10 or > 0.90:
 *   Q_min = min(Q_one, Q_two)
 *   → MUST be two-sided, single-sided gets zero
 *
 * c = 3.0 (current scaling factor)
 * v = rewards_max_spread (per market, from API)
 * b = order size in shares (the "in-game multiplier")
 */
export interface RewardScore {
  conditionId: string;
  qOne: number;
  qTwo: number;
  qMin: number;
  midpoint: number;
  twoSided: boolean;
  timestamp: number;
  /** Estimated competition (scoring-weighted USDC within spread) */
  competition: number;
}

// ---- Spread controller state -----------------------------------------------

export interface SpreadState {
  /** @deprecated Use ratioOverrides per market. Kept for state migration. */
  currentRatio: number;
  /** Per-market spread ratio overrides from widen_spread risk action */
  ratioOverrides: Record<string, number>;
  /** Fills in the last hour per market */
  fillsPerHour: Record<string, number>;
  /** Timestamp of last adjustment per market */
  lastAdjustedAt: number;
  /** Realized volatility per market (5min window) */
  volatility: Record<string, number>;
}

// ---- Fill events -----------------------------------------------------------

export interface FillEvent {
  orderId: string;
  tokenId: string;
  conditionId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  timestamp: number;
}

// ---- Pending Sell (persisted for crash recovery) ----------------------------

export interface PendingSell {
  tokenId: string;
  conditionId: string;
  shares: number;
  placedAt: number;
  sellOrderId?: string; // limit SELL order ID if placed
  retryCount: number;
  lastAttemptAt: number;
  /** Earliest time to retry (overrides lastAttemptAt for long delays like no_bids) */
  nextRetryAt?: number;
  /** Split progression: 1.0 → 0.5 → 0.25 → 0.10 of original shares */
  splitFactor: number;
  /** Midpoint at the time of the fill that created this pending sell */
  fillMidpoint?: number;
  /** Urgency level based on adverse price movement */
  urgency?: "low" | "medium" | "high" | "critical";
  /** Whether the SELL order is within scoring spread (earning rewards) */
  isScoring?: boolean;
  /** Current phase: "protective" (tight stop-loss) or "scoring" (wider profit-seeking) */
  phase?: "protective" | "scoring";
  /** Market tick size (stored for phase upgrade calculations) */
  marketTickSize?: string;
  /** Market rewards max spread (stored for phase upgrade calculations) */
  marketMaxSpread?: number;
  /** Market negRisk flag */
  marketNegRisk?: boolean;
}

// ---- Toxicity analysis ---------------------------------------------------

export interface ToxicityAnalysis {
  conditionId: string;
  /** Directionality: 0 = balanced fills, 1 = all one-sided */
  directionality: number;
  /** Whether average fill size is anomalously large */
  sizeAnomaly: boolean;
  /** Final toxic determination */
  isToxic: boolean;
  /** Total fills in window */
  totalFills: number;
  /** Dominant side */
  dominantSide: "BUY" | "SELL";
}

// ---- Events ----------------------------------------------------------------

export type MmEvent =
  | { type: "started" }
  | { type: "stopped"; reason: string }
  | { type: "order_placed"; order: TrackedOrder }
  | { type: "order_filled"; order: TrackedOrder; fillSize: number }
  | { type: "order_cancelled"; orderId: string }
  | { type: "market_added"; conditionId: string; question: string }
  | { type: "market_removed"; conditionId: string; reason: string }
  | { type: "risk_action"; action: RiskAction }
  | { type: "error"; message: string }
  | { type: "reward_check"; scores: RewardScore[] };
