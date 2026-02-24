// ---------------------------------------------------------------------------
// Configuration with sensible conservative defaults — v2 Reward Harvester
// ---------------------------------------------------------------------------

import type { MmConfig } from "./types.js";

export const DEFAULT_CONFIG: MmConfig = {
  // Capital — dynamic from balance, no hardcoded amounts
  deployRatio: 0.95, // 95% of balance for per-market deployment
  orderSizeRatio: 0.475, // 47.5% of balance per-token (~half: YES + NO each)
  maxCapitalPerMarket: 0, // computed at runtime: balance × deployRatio
  reserveRatio: 0.02, // minimal 2% reserve

  // Quoting — dynamic spread ratios (fraction of market's maxSpread)
  defaultSpreadRatio: 0.35, // default 35% of maxSpread → highest S(v,s) score
  minSpreadRatio: 0.15, // floor 15% — allow tighter spreads for better scoring
  maxSpreadRatio: 0.85, // ceiling 85% — allow wider spread when needed
  // Legacy fixed spread fields (fallback when market maxSpread unavailable)
  defaultSpread: 0.01,
  minSpread: 0.01,
  maxSpread: 0.05,
  orderSize: 0, // computed at runtime: balance × orderSizeRatio
  numLevels: 1, // single level concentrate capital for max score
  refreshIntervalMs: 10_000, // 10s faster refresh

  // Inventory management
  maxInventoryPerMarket: 300, // allow larger positions
  skewFactor: 0.5,

  // Risk — relaxed for full-capital deployment
  maxTotalExposure: 0, // computed at runtime: balance × deployRatio
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
  forceSellMaxRetries: 5, // retries per split level (legacy, used as fallback)
  forceSellRetryDelayMs: 30_000, // 30s between retries (low urgency)
  liquidateOnStop: false, // don't liquidate on graceful stop by default
  liquidateOnKill: true, // attempt liquidation on kill
  maxPendingSellAgeMs: 600_000, // 10 min → disable min price protection (emergency mode)

  // Multi-level quoting
  levelSizeWeights: [0.55, 0.3, 0.15], // inner level gets most capital
  levelSpreadMultiplier: 1.4, // each level 40% wider

  // Continuous spread model
  volatilityWeight: 3.0, // realized vol × weight → spread adjustment
  inventorySpreadPenalty: 0.5, // exposure ratio × penalty → spread widening

  // Fast split progression
  forceSellMaxRetriesPerSplit: 3, // 3 retries per split level (faster than 5)
  forceSellMinSplitFactor: 0.1, // minimum 10% split (was implicit 25%)
  forceSellUrgentRetryDelayMs: 10_000, // 10s for critical urgency

  // Protective sell
  protectiveSellSpread: 0.005, // max -0.5% from entry for protective SELL

  // Trailing stop (Livermore) — simple exit system
  trailingStopLoss: 0.02, // -2% from entry → hard stop, immediate market sell
  trailingActivation: 0.01, // +1% from entry → activate trailing stop
  trailingDistance: 0.01, // -1% from peak → trailing stop sell

  // Two-sided quoting with cancel-on-fill: earn 3× reward, cancel other side on fill
  singleSided: false, // false = two-sided (cancel other side on fill)
};

/** Merge user overrides onto defaults, validating ranges. */
export function resolveConfig(overrides?: Partial<MmConfig>): MmConfig {
  const cfg = { ...DEFAULT_CONFIG, ...overrides };

  // Clamp / sanity checks
  cfg.deployRatio = clamp(cfg.deployRatio, 0.5, 1.0);
  cfg.orderSizeRatio = clamp(cfg.orderSizeRatio, 0.1, 0.5);
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
  cfg.maxPendingSellAgeMs = Math.max(120_000, cfg.maxPendingSellAgeMs);

  // Multi-level quoting
  if (!Array.isArray(cfg.levelSizeWeights) || cfg.levelSizeWeights.length === 0) {
    cfg.levelSizeWeights = [1.0];
  }
  // Normalize weights to sum to 1.0
  const weightSum = cfg.levelSizeWeights.reduce((s, w) => s + w, 0);
  if (weightSum > 0 && Math.abs(weightSum - 1.0) > 0.01) {
    cfg.levelSizeWeights = cfg.levelSizeWeights.map((w) => w / weightSum);
  }
  cfg.levelSpreadMultiplier = clamp(cfg.levelSpreadMultiplier, 1.0, 3.0);

  // Continuous spread model
  cfg.volatilityWeight = clamp(cfg.volatilityWeight, 0, 10);
  cfg.inventorySpreadPenalty = clamp(cfg.inventorySpreadPenalty, 0, 2);

  // Fast split progression
  cfg.forceSellMaxRetriesPerSplit = clamp(cfg.forceSellMaxRetriesPerSplit, 1, 10);
  cfg.forceSellMinSplitFactor = clamp(cfg.forceSellMinSplitFactor, 0.05, 0.5);
  cfg.forceSellUrgentRetryDelayMs = Math.max(5_000, cfg.forceSellUrgentRetryDelayMs);

  // Protective sell
  cfg.protectiveSellSpread = clamp(cfg.protectiveSellSpread, 0.001, 0.05);

  // Trailing stop
  cfg.trailingStopLoss = clamp(cfg.trailingStopLoss, 0.005, 0.1);
  cfg.trailingActivation = clamp(cfg.trailingActivation, 0.005, 0.1);
  cfg.trailingDistance = clamp(cfg.trailingDistance, 0.005, 0.1);

  return cfg;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Format config for Telegram display */
export function formatConfig(cfg: MmConfig): string {
  const lines = [
    `💰 资金: 动态(余额×${(cfg.deployRatio * 100).toFixed(0)}%), 单笔=${(cfg.orderSizeRatio * 100).toFixed(1)}%余额, 预留=${(cfg.reserveRatio * 100).toFixed(0)}%`,
    `📊 报价: spreadRatio=${cfg.defaultSpreadRatio} [${cfg.minSpreadRatio}-${cfg.maxSpreadRatio}], size=$${cfg.orderSize}, levels=${cfg.numLevels}, volW=${cfg.volatilityWeight}, invP=${cfg.inventorySpreadPenalty}`,
    `🔄 刷新: ${cfg.refreshIntervalMs / 1000}s`,
    `📦 库存: max=$${cfg.maxInventoryPerMarket}, skew=${cfg.skewFactor}`,
    `🛡️ 风控: exposure=$${cfg.maxTotalExposure}, drawdown=${cfg.maxDrawdownPercent}%, dailyLoss=$${cfg.maxDailyLoss}`,
    `📉 止损: 硬止损=${(cfg.trailingStopLoss * 100).toFixed(1)}%, 激活=${(cfg.trailingActivation * 100).toFixed(1)}%, 追踪=${(cfg.trailingDistance * 100).toFixed(1)}%, 单边=${cfg.singleSided}`,
    `🏪 市场: max=${cfg.maxConcurrentMarkets}, minReward=$${cfg.minRewardRate}`,
  ];
  return lines.join("\n");
}
