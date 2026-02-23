// ---------------------------------------------------------------------------
// Dynamic Spread Controller — v3 Continuous Model
//
// Replaces discrete step function with four-factor continuous model:
//   optimalRatio = clamp(
//     baseRatio(fillRate)          // sigmoid: 0→0.25, 5/hr→0.70
//     + volatilityAdjust(vol)      // 0 ~ +0.15 based on 5min realized vol
//     + inventoryPenalty(exposure)  // 0 ~ +0.10 based on position/cap ratio
//     + extremeAdjust(midpoint)    // -0.05 for extreme prices
//   , minSpreadRatio, maxSpreadRatio)
//
// The scoring function S(v,s) = ((v-s)/v)² × b means:
//   25% of maxSpread → 0.5625 score per share
//   35% of maxSpread → 0.4225 score per share
//   50% of maxSpread → 0.25 score per share
//   70% of maxSpread → 0.09 score per share
// ---------------------------------------------------------------------------

import type { PluginLogger } from "../../src/plugins/types.js";
import type { StateManager } from "./state.js";
import type { MmConfig } from "./types.js";

export class SpreadController {
  private logger: PluginLogger;
  /** Per-market volatility (5-min realized), updated by engine. */
  private volatilities: Map<string, number> = new Map();
  /** Per-market exposure ratio (0-1), updated by engine. */
  private exposureRatios: Map<string, number> = new Map();

  constructor(
    private state: StateManager,
    private config: MmConfig,
    logger: PluginLogger,
  ) {
    this.logger = logger;
  }

  /**
   * Calculate optimal spread for a market using the continuous model.
   *
   * @param maxSpread - Market's rewardsMaxSpread (in price units, e.g. 0.035)
   * @param conditionId - Market condition ID (for fill rate lookup)
   * @param tick - Tick size (e.g. 0.01)
   * @param negRisk - Whether this is a negRisk market (needs wider minimum)
   * @param midpoint - Current midpoint (optional, for extreme price adjustment)
   * @returns Spread in price units
   */
  calculateSpread(
    maxSpread: number,
    conditionId: string,
    tick: number,
    negRisk: boolean,
    midpoint?: number,
  ): number {
    const fillsPerHour = this.state.getFillsPerHour(conditionId);

    // Factor 1: Base ratio from fill rate (sigmoid curve)
    // f(x) = 0.25 + 0.45 × (1 - e^(-x × 0.4))
    // 0 fills/hr → 0.25 (aggressive), 5 fills/hr → ~0.70 (defensive)
    const baseRatio = 0.25 + 0.45 * (1 - Math.exp(-fillsPerHour * 0.4));

    // Factor 2: Volatility adjustment (0 ~ +0.15)
    const vol = this.volatilities.get(conditionId) ?? 0;
    const volAdjust = Math.min(0.15, vol * this.config.volatilityWeight);

    // Factor 3: Inventory penalty (0 ~ +0.10)
    const expRatio = this.exposureRatios.get(conditionId) ?? 0;
    const invPenalty = Math.min(0.1, expRatio * this.config.inventorySpreadPenalty);

    // Factor 4: Extreme price adjustment (-0.05 when mid < 0.10 or > 0.90)
    // Tighter spread at extremes ensures we stay within scoring range on both sides
    let extremeAdjust = 0;
    if (midpoint !== undefined && (midpoint < 0.1 || midpoint > 0.9)) {
      extremeAdjust = -0.05;
    }

    // Combine factors
    let spreadRatio = baseRatio + volAdjust + invPenalty + extremeAdjust;

    // Check for widen_spread override from risk controller
    const spreadState = this.state.get().spreadState;
    if (spreadState?.currentRatio > spreadRatio) {
      spreadRatio = spreadState.currentRatio;
    }

    // Clamp to configured bounds
    spreadRatio = clamp(spreadRatio, this.config.minSpreadRatio, this.config.maxSpreadRatio);

    const spread = maxSpread * spreadRatio;

    // Floor: 2 ticks (or 3 for negRisk) or minSpreadRatio
    const minTicks = negRisk ? 3 * tick : 2 * tick;
    const floor = Math.max(minTicks, maxSpread * this.config.minSpreadRatio);
    // Ceiling: maxSpreadRatio
    const ceiling = maxSpread * this.config.maxSpreadRatio;

    const result = clamp(spread, floor, ceiling);

    this.logger.info(
      `Spread: ${conditionId.slice(0, 10)} fills/hr=${fillsPerHour.toFixed(1)} ` +
        `base=${baseRatio.toFixed(2)} vol=${volAdjust.toFixed(3)} inv=${invPenalty.toFixed(3)} ` +
        `ext=${extremeAdjust.toFixed(2)} ratio=${spreadRatio.toFixed(3)} ` +
        `spread=${result.toFixed(4)} (${((result / maxSpread) * 100).toFixed(0)}% of max ${maxSpread.toFixed(4)})`,
    );

    return result;
  }

  /**
   * Update realized volatility for a market.
   * Called by engine during refreshBooks().
   *
   * @param conditionId - Market condition ID
   * @param volatility - 5-minute realized volatility (as fraction, e.g. 0.02 = 2%)
   */
  updateVolatility(conditionId: string, volatility: number): void {
    this.volatilities.set(conditionId, Math.max(0, volatility));
    // Persist to state for monitoring
    const st = this.state.get();
    const volRecord = { ...(st.spreadState?.volatility ?? {}), [conditionId]: volatility };
    this.state.update({
      spreadState: {
        ...st.spreadState,
        currentRatio: st.spreadState?.currentRatio ?? this.config.defaultSpreadRatio,
        fillsPerHour: st.spreadState?.fillsPerHour ?? {},
        lastAdjustedAt: st.spreadState?.lastAdjustedAt ?? Date.now(),
        volatility: volRecord,
      },
    });
  }

  /**
   * Update exposure ratio for a market (for inventory penalty factor).
   * Called by engine with current position / maxCapital ratio.
   */
  updateExposureRatio(conditionId: string, ratio: number): void {
    this.exposureRatios.set(conditionId, clamp(ratio, 0, 1));
  }

  /**
   * Widen spread temporarily (called by risk controller on adverse selection).
   */
  widenSpread(conditionId: string, factor: number): void {
    const st = this.state.get();
    const current = st.spreadState?.currentRatio || this.config.defaultSpreadRatio;
    const widened = Math.min(current * factor, this.config.maxSpreadRatio);
    this.state.update({
      spreadState: {
        ...st.spreadState,
        currentRatio: widened,
        lastAdjustedAt: Date.now(),
      },
    });
    this.logger.info(
      `Spread widened: ${conditionId.slice(0, 10)} ratio ${current.toFixed(2)} → ${widened.toFixed(2)}`,
    );
  }

  /**
   * Reset spread to default (called periodically to decay widen overrides).
   */
  decayOverride(): void {
    const st = this.state.get();
    if (!st.spreadState || st.spreadState.currentRatio <= this.config.defaultSpreadRatio) return;

    // Decay back toward default over 10 minutes
    const elapsed = Date.now() - st.spreadState.lastAdjustedAt;
    if (elapsed > 10 * 60_000) {
      this.state.update({
        spreadState: {
          ...st.spreadState,
          currentRatio: this.config.defaultSpreadRatio,
          lastAdjustedAt: Date.now(),
        },
      });
      this.logger.info("Spread override decayed back to default");
    }
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
