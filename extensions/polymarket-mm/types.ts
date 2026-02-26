// ---------------------------------------------------------------------------
// Polymarket Market-Making Types — v5 Cancel-Before-Fill
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
  deployRatio: number;
  orderSizeRatio: number;
  maxCapitalPerMarket: number; // runtime
  reserveRatio: number;

  // Quoting — simple: targetSpread = maxSpread × spreadRatio
  spreadRatio: number; // 0.35 of maxSpread
  orderSize: number; // runtime
  refreshIntervalMs: number;

  // Danger zone — core v5 innovation
  dangerSpreadRatio: number; // 0.15 of maxSpread
  cooldownMs: number; // 120_000 (2min)

  // Market selection
  maxConcurrentMarkets: number;
  minRewardRate: number;
  minBidDepthUsd: number;
  minDailyVolume: number;

  // Accidental fill exit
  accidentalFillTimeouts: [number, number, number, number]; // [5, 15, 30, 60] minutes
  minSellPriceRatio: number; // 0.5

  // Risk
  maxDrawdownPercent: number;
  maxDailyLoss: number;

  // Exit behavior
  singleSided: boolean;
  liquidateOnStop: boolean;
  liquidateOnKill: boolean;
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

export interface TargetQuote {
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  level: number;
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

// ---- Position (kept for P&L tracking) --------------------------------------

export interface Position {
  conditionId: string;
  tokenId: string;
  outcome: string;
  netShares: number;
  avgEntry: number;
  realizedPnl: number;
}

// ---- Market phase (v5 core) ------------------------------------------------

export type MarketPhase = "quoting" | "cooldown" | "exiting";

export interface MarketState {
  conditionId: string;
  phase: MarketPhase;
  cooldownUntil: number;
  activeOrderIds: string[];
  /** GTD expiration timestamp of current orders (for refresh) */
  ordersExpireAt: number;
  accidentalFill?: AccidentalFill;
}

export interface AccidentalFill {
  tokenId: string;
  shares: number;
  entryPrice: number;
  filledAt: number;
  sellOrderId?: string;
  stage: 1 | 2 | 3 | 4;
}

// ---- Reward scoring (Polymarket formula) -----------------------------------

/**
 * S(v, s) = ((v - s) / v)^2 * b
 * Q_one = bids(m) + asks(m'), Q_two = asks(m) + bids(m')
 * Mid [0.10,0.90]: Q_min = max(min(Q1,Q2), max(Q1/3, Q2/3))
 * Extreme: Q_min = min(Q1,Q2)
 */
export interface RewardScore {
  conditionId: string;
  qOne: number;
  qTwo: number;
  qMin: number;
  midpoint: number;
  twoSided: boolean;
  timestamp: number;
  competition: number;
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

// ---- State (persisted) — v5 simplified ------------------------------------

export interface MmState {
  running: boolean;
  startedAt: number | null;
  capital: number;
  peakBalance: number;
  dailyPnl: number;
  dailyDate: string;
  totalPnl: number;
  totalRewardsEstimate: number;
  positions: Record<string, Position>;
  trackedOrders: Record<string, TrackedOrder>;
  activeMarkets: string[];
  pausedMarkets: string[];
  errorCount: number;
  lastRefreshAt: number;
  lastScanAt: number;
  killSwitchTriggered: boolean;
  dayPaused: boolean;
  rewardHistory: Array<{ date: string; estimated: number; actual?: number }>;
  fillHistory: FillEvent[];
  /** v5: per-market runtime state (not persisted in detail, rebuilt on start) */
  marketStates: Record<string, MarketState>;
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
  | { type: "error"; message: string }
  | { type: "reward_check"; scores: RewardScore[] };
