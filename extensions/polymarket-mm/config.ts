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
  // P54: increased from 0.85 to 0.90 — orders at 90% of maxSpread from mid.
  // Scoring at 0.90: (0.10)² = 1% of max. Very low rewards but maximum safety.
  // Combined with singleSided=true → half exposure, further from mid.
  // For 8¢ maxSpread: order 7.2¢ from mid. Buffer = 2.0¢ (was 1.1¢ at P53).
  spreadRatio: 0.9,
  orderSize: 0, // computed at runtime
  refreshIntervalMs: 10_000,

  // Danger zone — core v5: cancel before fill
  // P54: increased from 0.55 to 0.65 — trigger even earlier.
  // At spreadRatio=0.90, dangerRatio=0.65:
  //   buffer(trigger→order) = (0.90-0.65) × maxSpread = 0.25 × maxSpread
  //   buffer(mid→trigger)   = 0.65 × maxSpread
  // For 8¢ maxSpread: order=7.2¢, trigger=5.2¢, buffer=2.0¢ (was 1.1¢)
  dangerSpreadRatio: 0.65,
  cooldownMs: 120_000, // 2 minutes cooldown after danger zone cancel
  // P29: disabled cushion check (was 1.5). Unreliable on thin books — REST API
  // doesn't give full depth, causing false triggers. Rely on mid-distance check
  // + instant exit as safety net instead.
  minCushionRatio: 0,

  // Market selection
  maxConcurrentMarkets: 1,
  minDailyVolume: 100,
  minRewardRate: 30,
  // P54: require maxSpread ≥ 6¢ — 5¢ only gave 1.1¢ buffer (still got filled).
  // 8¢ was too strict (0 markets). 6¢ gives 1.5¢ buffer + singleSided halves risk.
  // Net safety: ~equivalent to 3¢ buffer two-sided (better than P53's 1.1¢ two-sided).
  minMaxSpread: 0.06,
  // P51: increased from 200 to 500 — thicker books are harder to sweep through
  minBidDepthUsd: 500,

  // Accidental fill exit (4 stages, minutes)
  accidentalFillTimeouts: [5, 15, 30, 60],
  minSellPriceRatio: 0.5,

  // Risk
  maxDrawdownPercent: 30,
  maxDailyLoss: 30,

  // Exit behavior
  // P54: single-sided — only BUY the cheaper token.
  // Half the exposure, half the fill risk. 1/3 rewards (no Q_min two-sided bonus).
  // At extreme prices (<0.10 or >0.90), auto-reverts to two-sided.
  singleSided: true,
  liquidateOnStop: false,
  liquidateOnKill: true,
};

/** Merge user overrides onto defaults, validating ranges. */
export function resolveConfig(overrides?: Partial<MmConfig>): MmConfig {
  const cfg = { ...DEFAULT_CONFIG, ...overrides };

  cfg.deployRatio = clamp(cfg.deployRatio, 0.5, 1.0);
  cfg.orderSizeRatio = clamp(cfg.orderSizeRatio, 0.1, 0.5);
  cfg.reserveRatio = clamp(cfg.reserveRatio, 0, 0.5);
  cfg.spreadRatio = clamp(cfg.spreadRatio, 0.1, 0.95);
  cfg.orderSize = Math.max(0, cfg.orderSize);
  cfg.refreshIntervalMs = Math.max(5_000, cfg.refreshIntervalMs);
  cfg.dangerSpreadRatio = clamp(cfg.dangerSpreadRatio, 0.05, 0.8);
  cfg.minCushionRatio = clamp(cfg.minCushionRatio ?? 1.5, 0, 5);
  cfg.cooldownMs = clamp(cfg.cooldownMs, 30_000, 600_000);
  cfg.maxConcurrentMarkets = clamp(cfg.maxConcurrentMarkets, 1, 50);
  cfg.minMaxSpread = clamp(cfg.minMaxSpread ?? 0.05, 0, 0.2);
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
    `🏪 市场: max=${cfg.maxConcurrentMarkets}, minReward=$${cfg.minRewardRate}, minSpread=${(cfg.minMaxSpread * 100).toFixed(1)}¢`,
    `🛡️ 风控: drawdown=${cfg.maxDrawdownPercent}%, dailyLoss=$${cfg.maxDailyLoss}`,
    `🚪 意外成交: 阶段=[${cfg.accidentalFillTimeouts.join(",")}]min, 地板=${(cfg.minSellPriceRatio * 100).toFixed(0)}%`,
    `📋 单边=${cfg.singleSided}, 停止清仓=${cfg.liquidateOnStop}, kill清仓=${cfg.liquidateOnKill}`,
  ];
  return lines.join("\n");
}
