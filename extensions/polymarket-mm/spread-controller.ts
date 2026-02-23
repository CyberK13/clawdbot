// ---------------------------------------------------------------------------
// Dynamic Spread Controller
//
// Adjusts spread based on recent fill rate to balance score vs safety:
//   - Low fills → tighter spread (more score)
//   - High fills → wider spread (less adverse selection)
//
// Spread is expressed as a ratio of the market's rewardsMaxSpread.
// The scoring function S(v,s) = ((v-s)/v)² × b means:
//   30% of maxSpread → 0.49 score per share
//   50% of maxSpread → 0.25 score per share
//   70% of maxSpread → 0.09 score per share
// ---------------------------------------------------------------------------

import type { PluginLogger } from "../../src/plugins/types.js";
import type { StateManager } from "./state.js";
import type { MmConfig } from "./types.js";

export class SpreadController {
  private logger: PluginLogger;

  constructor(
    private state: StateManager,
    private config: MmConfig,
    logger: PluginLogger,
  ) {
    this.logger = logger;
  }

  /**
   * Calculate optimal spread for a market based on recent fill rate.
   *
   * @param maxSpread - Market's rewardsMaxSpread (in price units, e.g. 0.035)
   * @param conditionId - Market condition ID (for fill rate lookup)
   * @param tick - Tick size (e.g. 0.01)
   * @param negRisk - Whether this is a negRisk market (needs wider minimum)
   * @returns Spread in price units
   */
  calculateSpread(maxSpread: number, conditionId: string, tick: number, negRisk: boolean): number {
    const fillsPerHour = this.state.getFillsPerHour(conditionId);
    let spreadRatio: number;

    if (fillsPerHour === 0)
      spreadRatio = 0.3; // aggressive
    else if (fillsPerHour < 1)
      spreadRatio = 0.4; // moderately aggressive
    else if (fillsPerHour < 2)
      spreadRatio = 0.5; // baseline
    else if (fillsPerHour < 4)
      spreadRatio = 0.6; // conservative
    else spreadRatio = 0.7; // defensive

    // Check for widen_spread override from risk controller
    const spreadState = this.state.get().spreadState;
    if (spreadState?.currentRatio > spreadRatio) {
      spreadRatio = spreadState.currentRatio;
    }

    const spread = maxSpread * spreadRatio;

    // Floor: 2 ticks (or 3 for negRisk) or minSpreadRatio
    const minTicks = negRisk ? 3 * tick : 2 * tick;
    const floor = Math.max(minTicks, maxSpread * this.config.minSpreadRatio);
    // Ceiling: maxSpreadRatio
    const ceiling = maxSpread * this.config.maxSpreadRatio;

    const result = clamp(spread, floor, ceiling);

    this.logger.info(
      `Spread: ${conditionId.slice(0, 10)} fills/hr=${fillsPerHour} ratio=${spreadRatio.toFixed(2)} ` +
        `spread=${result.toFixed(4)} (${((result / maxSpread) * 100).toFixed(0)}% of max ${maxSpread.toFixed(4)})`,
    );

    return result;
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
