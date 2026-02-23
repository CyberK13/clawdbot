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
  // Capital
  totalCapital: number;
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
  dailyPnl: number;
  dailyDate: string; // YYYY-MM-DD
  totalPnl: number;
  totalRewardsEstimate: number;
  positions: Record<string, Position>; // key = tokenId
  trackedOrders: Record<string, TrackedOrder>; // key = orderId
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
}

// ---- Spread controller state -----------------------------------------------

export interface SpreadState {
  /** Current spread ratio (0.20 - 0.80 of maxSpread) */
  currentRatio: number;
  /** Fills in the last hour per market */
  fillsPerHour: Record<string, number>;
  /** Timestamp of last adjustment */
  lastAdjustedAt: number;
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
