// ---------------------------------------------------------------------------
// Configuration with sensible conservative defaults — v2 Reward Harvester
// ---------------------------------------------------------------------------

import type { MmConfig } from "./types.js";

export const DEFAULT_CONFIG: MmConfig = {
  // Capital — aggressive single-market strategy, full capital deployment
  // $238 balance → deploy nearly all into highest-reward market
  totalCapital: 238,
  maxCapitalPerMarket: 235, // near-full deployment
  reserveRatio: 0.02, // minimal 2% reserve ($~5 buffer)

  // Quoting — dynamic spread ratios (fraction of market's maxSpread)
  defaultSpreadRatio: 0.35, // default 35% of maxSpread → highest S(v,s) score
  minSpreadRatio: 0.15, // floor 15% — allow tighter spreads for better scoring
  maxSpreadRatio: 0.85, // ceiling 85% — allow wider spread when needed
  // Legacy fixed spread fields (fallback when market maxSpread unavailable)
  defaultSpread: 0.01,
  minSpread: 0.01,
  maxSpread: 0.05,
  orderSize: 115, // ~half of capital: YES + NO each get ~$115 ≈ $230 total
  numLevels: 1, // single level concentrate capital for max score
  refreshIntervalMs: 10_000, // 10s faster refresh

  // Inventory management
  maxInventoryPerMarket: 300, // allow larger positions
  skewFactor: 0.5,

  // Risk — relaxed for full-capital deployment
  maxTotalExposure: 230, // ~97% of capital
  maxDrawdownPercent: 30, // generous room for MM variance
  maxDailyLoss: 30, // aligned with drawdown

  // Opportunistic trading
  deviationThreshold: 0.15,
  opportunisticSize: 20,

  // Markets
  maxConcurrentMarkets: 1, // concentrate capital in 1 market for max score
  minDailyVolume: 100, // lower threshold to not miss markets
  minRewardRate: 50, // target $50+/day markets (worth the capital)

  // Fill recovery
  fillRecoveryTimeoutMs: 300_000, // 5 minutes before force sell
  maxExposureForSoftSell: 0.4, // <40% capital → soft recovery (limit sell)
  maxExposureForHardSell: 0.7, // >70% capital → force liquidate
  // More tolerant: let positions ride longer before panic-selling

  // Reconciliation
  reconcileIntervalMs: 300_000, // every 5 minutes

  // Exit / liquidation safety
  minSellPriceRatio: 0.5, // won't force sell below 50% of entry price
  forceSellMaxRetries: 5, // retries per split level
  forceSellRetryDelayMs: 30_000, // 30s between retries
  liquidateOnStop: false, // don't liquidate on graceful stop by default
  liquidateOnKill: true, // attempt liquidation on kill
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
  cfg.minSellPriceRatio = clamp(cfg.minSellPriceRatio, 0.1, 0.95);
  cfg.forceSellMaxRetries = clamp(cfg.forceSellMaxRetries, 1, 20);
  cfg.forceSellRetryDelayMs = Math.max(5_000, cfg.forceSellRetryDelayMs);

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
