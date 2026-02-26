// ---------------------------------------------------------------------------
// Configuration — v5 Cancel-Before-Fill Reward Harvester
// ---------------------------------------------------------------------------

import type { MmConfig } from "./types.js";

export const DEFAULT_CONFIG: MmConfig = {
  // Capital — dynamic from balance
  deployRatio: 0.5,
  orderSizeRatio: 0.475,
  maxCapitalPerMarket: 0, // computed at runtime
  reserveRatio: 0.02,

  // Quoting — simple: targetSpread = maxSpread × spreadRatio
  // P27: increased from 0.35 to 0.55 — place orders deeper in book to reduce
  // taker-sweep fill risk. Scoring at 0.55: (0.45)² = 20% of max (was 42%).
  spreadRatio: 0.55,
  orderSize: 0, // computed at runtime
  refreshIntervalMs: 10_000,

  // Danger zone — core v5: cancel before fill
  // P27: increased from 0.15 to 0.40 — wider danger zone (1.4c for 3.5c market).
  // Buffer between order and danger zone = (0.55 - 0.40) × maxSpread = 0.525c.
  dangerSpreadRatio: 0.4, // if |mid - orderPrice| < maxSpread × 0.40 → cancel
  cooldownMs: 120_000, // 2 minutes cooldown after danger zone cancel
  // P27: minimum book-depth cushion — if bid liquidity between our order and mid
  // is less than this × orderSize, cancel (protects against taker sweeps)
  minCushionRatio: 1.5,

  // Market selection
  maxConcurrentMarkets: 1,
  minDailyVolume: 100,
  minRewardRate: 50,
  minBidDepthUsd: 200,

  // Accidental fill exit (4 stages, minutes)
  accidentalFillTimeouts: [5, 15, 30, 60],
  minSellPriceRatio: 0.5,

  // Risk
  maxDrawdownPercent: 30,
  maxDailyLoss: 30,

  // Exit behavior
  singleSided: false,
  liquidateOnStop: false,
  liquidateOnKill: true,
};

/** Merge user overrides onto defaults, validating ranges. */
export function resolveConfig(overrides?: Partial<MmConfig>): MmConfig {
  const cfg = { ...DEFAULT_CONFIG, ...overrides };

  cfg.deployRatio = clamp(cfg.deployRatio, 0.5, 1.0);
  cfg.orderSizeRatio = clamp(cfg.orderSizeRatio, 0.1, 0.5);
  cfg.reserveRatio = clamp(cfg.reserveRatio, 0, 0.5);
  cfg.spreadRatio = clamp(cfg.spreadRatio, 0.1, 0.9);
  cfg.orderSize = Math.max(0, cfg.orderSize);
  cfg.refreshIntervalMs = Math.max(5_000, cfg.refreshIntervalMs);
  cfg.dangerSpreadRatio = clamp(cfg.dangerSpreadRatio, 0.05, 0.8);
  cfg.minCushionRatio = clamp(cfg.minCushionRatio ?? 1.5, 0, 5);
  cfg.cooldownMs = clamp(cfg.cooldownMs, 30_000, 600_000);
  cfg.maxConcurrentMarkets = clamp(cfg.maxConcurrentMarkets, 1, 50);
  cfg.minBidDepthUsd = Math.max(0, cfg.minBidDepthUsd);
  cfg.maxDrawdownPercent = clamp(cfg.maxDrawdownPercent, 1, 100);
  cfg.maxDailyLoss = Math.max(1, cfg.maxDailyLoss);
  cfg.minSellPriceRatio = clamp(cfg.minSellPriceRatio, 0.1, 0.95);

  // Validate accidentalFillTimeouts
  if (!Array.isArray(cfg.accidentalFillTimeouts) || cfg.accidentalFillTimeouts.length !== 4) {
    cfg.accidentalFillTimeouts = [5, 15, 30, 60];
  }

  return cfg;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Format config for Telegram display */
export function formatConfig(cfg: MmConfig): string {
  const lines = [
    `💰 资金: 动态(余额×${(cfg.deployRatio * 100).toFixed(0)}%), 单笔=${(cfg.orderSizeRatio * 100).toFixed(1)}%余额`,
    `📊 报价: spreadRatio=${cfg.spreadRatio}, size=$${cfg.orderSize.toFixed(0)}`,
    `⚠️ 危险区: dangerRatio=${cfg.dangerSpreadRatio}, cushion=${cfg.minCushionRatio}×, 冷却=${cfg.cooldownMs / 1000}s`,
    `🏪 市场: max=${cfg.maxConcurrentMarkets}, minReward=$${cfg.minRewardRate}`,
    `🛡️ 风控: drawdown=${cfg.maxDrawdownPercent}%, dailyLoss=$${cfg.maxDailyLoss}`,
    `🚪 意外成交: 阶段=[${cfg.accidentalFillTimeouts.join(",")}]min, 地板=${(cfg.minSellPriceRatio * 100).toFixed(0)}%`,
    `📋 单边=${cfg.singleSided}, 停止清仓=${cfg.liquidateOnStop}, kill清仓=${cfg.liquidateOnKill}`,
  ];
  return lines.join("\n");
}
