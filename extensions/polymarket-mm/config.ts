// ---------------------------------------------------------------------------
// Configuration with sensible conservative defaults
// ---------------------------------------------------------------------------

import type { MmConfig } from "./types.js";

export const DEFAULT_CONFIG: MmConfig = {
  // Capital ($136 small capital optimization)
  totalCapital: 136,
  maxCapitalPerMarket: 60, // allow single market 44% — concentrate capital

  // Quoting — tight spread for max reward score ((v-s)/v)²
  defaultSpread: 0.01, // 1 tick — tightest possible for 3.2x score boost
  minSpread: 0.01, // 1 cent floor
  maxSpread: 0.05, // 5 cents ceiling
  orderSize: 25, // $25 base, auto-adapted up to meet minSize
  numLevels: 1, // concentrate capital on best price level
  refreshIntervalMs: 15_000, // refresh quotes every 15s

  // Inventory management
  maxInventoryPerMarket: 60, // match maxCapitalPerMarket
  skewFactor: 0.5, // moderate inventory skew aggressiveness

  // Risk
  maxTotalExposure: 120, // 88% of capital
  maxDrawdownPercent: 15, // slightly relaxed for small capital
  maxDailyLoss: 15, // $15/day cap

  // Opportunistic trading
  deviationThreshold: 0.15, // 15% price deviation trigger
  opportunisticSize: 15, // $15 per opportunistic trade

  // Markets
  maxConcurrentMarkets: 3, // 2-3 low-barrier markets
  minDailyVolume: 500, // lowered for more market access
  minRewardRate: 0, // accept any reward rate
};

/** Merge user overrides onto defaults, validating ranges. */
export function resolveConfig(overrides?: Partial<MmConfig>): MmConfig {
  const cfg = { ...DEFAULT_CONFIG, ...overrides };

  // Clamp / sanity checks
  cfg.totalCapital = Math.max(0, cfg.totalCapital);
  cfg.maxCapitalPerMarket = Math.min(cfg.maxCapitalPerMarket, cfg.totalCapital);
  cfg.minSpread = Math.max(0.001, cfg.minSpread);
  cfg.defaultSpread = clamp(cfg.defaultSpread, cfg.minSpread, cfg.maxSpread);
  cfg.orderSize = Math.max(1, cfg.orderSize);
  cfg.numLevels = clamp(cfg.numLevels, 1, 10);
  cfg.refreshIntervalMs = Math.max(5_000, cfg.refreshIntervalMs);
  cfg.maxInventoryPerMarket = Math.max(1, cfg.maxInventoryPerMarket);
  cfg.skewFactor = clamp(cfg.skewFactor, 0, 2);
  cfg.maxTotalExposure = Math.max(0, cfg.maxTotalExposure); // allow > totalCapital
  cfg.maxDrawdownPercent = clamp(cfg.maxDrawdownPercent, 1, 100);
  cfg.maxDailyLoss = Math.max(1, cfg.maxDailyLoss);
  cfg.deviationThreshold = clamp(cfg.deviationThreshold, 0.01, 1);
  cfg.opportunisticSize = Math.max(1, cfg.opportunisticSize);
  cfg.maxConcurrentMarkets = clamp(cfg.maxConcurrentMarkets, 1, 50);

  return cfg;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Format config for Telegram display */
export function formatConfig(cfg: MmConfig): string {
  const lines = [
    `💰 资金: $${cfg.totalCapital} (单市场上限 $${cfg.maxCapitalPerMarket})`,
    `📊 报价: spread=${cfg.defaultSpread} [${cfg.minSpread}-${cfg.maxSpread}], size=$${cfg.orderSize}, levels=${cfg.numLevels}`,
    `🔄 刷新: ${cfg.refreshIntervalMs / 1000}s`,
    `📦 库存: max=$${cfg.maxInventoryPerMarket}, skew=${cfg.skewFactor}`,
    `🛡️ 风控: exposure=$${cfg.maxTotalExposure}, drawdown=${cfg.maxDrawdownPercent}%, dailyLoss=$${cfg.maxDailyLoss}`,
    `🎯 机会: deviation=${(cfg.deviationThreshold * 100).toFixed(0)}%, size=$${cfg.opportunisticSize}`,
    `🏪 市场: max=${cfg.maxConcurrentMarkets}, minVol=$${cfg.minDailyVolume}`,
  ];
  return lines.join("\n");
}
