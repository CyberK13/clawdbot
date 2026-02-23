// ---------------------------------------------------------------------------
// Configuration with sensible conservative defaults — v2 Reward Harvester
// ---------------------------------------------------------------------------

import type { MmConfig } from "./types.js";

export const DEFAULT_CONFIG: MmConfig = {
  // Capital — single-market strategy with $237 balance
  // Most high-reward markets need minSize=200 (≈$200 capital).
  // We concentrate capital in 1 market for maximum scoring.
  totalCapital: 237,
  maxCapitalPerMarket: 220, // must cover minSize=200 × ~$1 (yes+no prices)
  reserveRatio: 0.08, // keep 8% capital unused ($19 buffer)

  // Quoting — dynamic spread ratios (fraction of market's maxSpread)
  defaultSpreadRatio: 0.35, // default 35% of maxSpread → highest S(v,s) score
  minSpreadRatio: 0.2, // floor 20%
  maxSpreadRatio: 0.8, // ceiling 80%
  // Legacy fixed spread fields (fallback when market maxSpread unavailable)
  defaultSpread: 0.01,
  minSpread: 0.01,
  maxSpread: 0.05,
  orderSize: 100, // $100 base — adaptive sizing bumps to meet minSize
  numLevels: 1, // single level concentrate capital for max score
  refreshIntervalMs: 10_000, // 10s faster refresh

  // Inventory management
  maxInventoryPerMarket: 200, // allow up to 200 shares (match minSize=200 markets)
  skewFactor: 0.5,

  // Risk
  maxTotalExposure: 200, // ~85% of capital (one market can use most of it)
  maxDrawdownPercent: 15, // allow more room for market-making variance
  maxDailyLoss: 15, // aligned with drawdown limit

  // Opportunistic trading
  deviationThreshold: 0.15,
  opportunisticSize: 15,

  // Markets
  maxConcurrentMarkets: 1, // concentrate capital in 1 market for max score
  minDailyVolume: 200, // lowered
  minRewardRate: 10, // at least $10/day (skip dust markets)

  // Fill recovery
  fillRecoveryTimeoutMs: 300_000, // 5 minutes before force sell
  maxExposureForSoftSell: 0.3, // <30% capital → soft recovery
  maxExposureForHardSell: 0.5, // >50% capital → force liquidate

  // Reconciliation
  reconcileIntervalMs: 300_000, // every 5 minutes
};

/** Merge user overrides onto defaults, validating ranges. */
export function resolveConfig(overrides?: Partial<MmConfig>): MmConfig {
  const cfg = { ...DEFAULT_CONFIG, ...overrides };

  // Clamp / sanity checks
  cfg.totalCapital = Math.max(0, cfg.totalCapital);
  cfg.maxCapitalPerMarket = Math.min(cfg.maxCapitalPerMarket, cfg.totalCapital);
  cfg.reserveRatio = clamp(cfg.reserveRatio, 0, 0.5);
  cfg.defaultSpreadRatio = clamp(cfg.defaultSpreadRatio, 0.1, 0.9);
  cfg.minSpreadRatio = clamp(cfg.minSpreadRatio, 0.1, cfg.defaultSpreadRatio);
  cfg.maxSpreadRatio = clamp(cfg.maxSpreadRatio, cfg.defaultSpreadRatio, 0.95);
  cfg.minSpread = Math.max(0.001, cfg.minSpread);
  cfg.defaultSpread = clamp(cfg.defaultSpread, cfg.minSpread, cfg.maxSpread);
  cfg.orderSize = Math.max(1, cfg.orderSize);
  cfg.numLevels = clamp(cfg.numLevels, 1, 10);
  cfg.refreshIntervalMs = Math.max(5_000, cfg.refreshIntervalMs);
  cfg.maxInventoryPerMarket = Math.max(1, cfg.maxInventoryPerMarket);
  cfg.skewFactor = clamp(cfg.skewFactor, 0, 2);
  cfg.maxTotalExposure = Math.max(0, cfg.maxTotalExposure);
  cfg.maxDrawdownPercent = clamp(cfg.maxDrawdownPercent, 1, 100);
  cfg.maxDailyLoss = Math.max(1, cfg.maxDailyLoss);
  cfg.deviationThreshold = clamp(cfg.deviationThreshold, 0.01, 1);
  cfg.opportunisticSize = Math.max(1, cfg.opportunisticSize);
  cfg.maxConcurrentMarkets = clamp(cfg.maxConcurrentMarkets, 1, 50);
  cfg.fillRecoveryTimeoutMs = Math.max(60_000, cfg.fillRecoveryTimeoutMs);
  cfg.maxExposureForSoftSell = clamp(cfg.maxExposureForSoftSell, 0.1, 0.5);
  cfg.maxExposureForHardSell = clamp(cfg.maxExposureForHardSell, cfg.maxExposureForSoftSell, 0.9);
  cfg.reconcileIntervalMs = Math.max(60_000, cfg.reconcileIntervalMs);

  return cfg;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Format config for Telegram display */
export function formatConfig(cfg: MmConfig): string {
  const lines = [
    `💰 资金: $${cfg.totalCapital} (单市场 $${cfg.maxCapitalPerMarket}, 预留 ${(cfg.reserveRatio * 100).toFixed(0)}%)`,
    `📊 报价: spreadRatio=${cfg.defaultSpreadRatio} [${cfg.minSpreadRatio}-${cfg.maxSpreadRatio}], size=$${cfg.orderSize}, levels=${cfg.numLevels}`,
    `🔄 刷新: ${cfg.refreshIntervalMs / 1000}s`,
    `📦 库存: max=$${cfg.maxInventoryPerMarket}, skew=${cfg.skewFactor}`,
    `🛡️ 风控: exposure=$${cfg.maxTotalExposure}, drawdown=${cfg.maxDrawdownPercent}%, dailyLoss=$${cfg.maxDailyLoss}`,
    `🔧 恢复: timeout=${cfg.fillRecoveryTimeoutMs / 1000}s, softSell=${(cfg.maxExposureForSoftSell * 100).toFixed(0)}%, hardSell=${(cfg.maxExposureForHardSell * 100).toFixed(0)}%`,
    `🏪 市场: max=${cfg.maxConcurrentMarkets}, minReward=$${cfg.minRewardRate}`,
  ];
  return lines.join("\n");
}
