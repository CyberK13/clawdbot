// ---------------------------------------------------------------------------
// Configuration — v5 Cancel-Before-Fill Reward Harvester
// ---------------------------------------------------------------------------

import type { MmConfig } from "./types.js";

export const DEFAULT_CONFIG: MmConfig = {
  // Capital — dynamic from balance
  deployRatio: 0.95,
  orderSizeRatio: 0.25,
  maxCapitalPerMarket: 0, // computed at runtime
  reserveRatio: 0.02,

  // Quoting — simple: targetSpread = maxSpread × spreadRatio
  // P27→P51: increased from 0.55 to 0.65 — further from mid to reduce fill risk.
  // Scoring at 0.65: (0.35)² = 12.25% of max (was 20% at 0.55).
  // Tradeoff: ~40% less rewards but dramatically fewer accidental fills.
  spreadRatio: 0.65,
  orderSize: 0, // computed at runtime
  refreshIntervalMs: 10_000,

  // Danger zone — core v5: cancel before fill
  // P29→P51: increased from 0.20 to 0.35 — bigger buffer between trigger and order.
  // At spreadRatio=0.65, dangerRatio=0.35:
  //   buffer(trigger→order) = 0.35 × maxSpread (was 0.20 × maxSpread)
  //   buffer(mid→trigger)   = (0.65-0.35) × maxSpread = 0.30 × maxSpread
  // For maxSpread=4.5¢: trigger→order=1.575¢ (was 0.9¢), mid→trigger=1.35¢
  dangerSpreadRatio: 0.35,
  cooldownMs: 120_000, // 2 minutes cooldown after danger zone cancel
  // P29: disabled cushion check (was 1.5). Unreliable on thin books — REST API
  // doesn't give full depth, causing false triggers. Rely on mid-distance check
  // + instant exit as safety net instead.
  minCushionRatio: 0,

  // Market selection
  maxConcurrentMarkets: 1,
  minDailyVolume: 100,
  minRewardRate: 50,
  // P51: increased from 200 to 500 — thicker books are harder to sweep through
  minBidDepthUsd: 500,

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
