// ---------------------------------------------------------------------------
// Persistent state management
// - Auto-saves every 30 seconds and on significant events
// - Crash recovery: reload + reconcile with exchange
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { PluginLogger } from "../../src/plugins/types.js";
import type {
  MmState,
  TrackedOrder,
  Position,
  FillEvent,
  SpreadState,
  PendingSell,
} from "./types.js";
import { todayUTC } from "./utils.js";

const STATE_FILE = "polymarket-mm.json";

function defaultState(): MmState {
  return {
    running: false,
    startedAt: null,
    capital: 0,
    dailyPnl: 0,
    dailyDate: todayUTC(),
    totalPnl: 0,
    totalRewardsEstimate: 0,
    positions: {},
    trackedOrders: {},
    pendingSells: {},
    activeMarkets: [],
    pausedMarkets: [],
    errorCount: 0,
    lastRefreshAt: 0,
    lastScanAt: 0,
    killSwitchTriggered: false,
    dayPaused: false,
    rewardHistory: [],
    fillHistory: [],
    spreadState: { currentRatio: 0.35, fillsPerHour: {}, lastAdjustedAt: 0, volatility: {} },
  };
}

export class StateManager {
  private state: MmState;
  private filePath: string;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;
  private logger: PluginLogger;

  constructor(stateDir: string, logger: PluginLogger) {
    this.logger = logger;
    this.filePath = join(stateDir, STATE_FILE);
    this.state = this.load();
  }

  /** Start auto-save timer (every 30s). */
  startAutoSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setInterval(() => {
      if (this.dirty) this.save();
    }, 30_000);
  }

  /** Stop auto-save timer and do a final save. */
  stopAutoSave(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) this.save();
  }

  /** Get current state (readonly reference). */
  get(): Readonly<MmState> {
    return this.state;
  }

  /** Update state with partial patch. */
  update(patch: Partial<MmState>): void {
    Object.assign(this.state, patch);
    this.dirty = true;
  }

  /** Check if day rolled over and reset daily counters. */
  checkDayRoll(): boolean {
    const today = todayUTC();
    if (this.state.dailyDate !== today) {
      // Archive yesterday's reward estimate
      if (this.state.dailyDate) {
        this.state.rewardHistory.push({
          date: this.state.dailyDate,
          estimated: this.state.totalRewardsEstimate,
        });
        // Keep last 90 days
        if (this.state.rewardHistory.length > 90) {
          this.state.rewardHistory = this.state.rewardHistory.slice(-90);
        }
      }
      this.state.dailyPnl = 0;
      this.state.dailyDate = today;
      this.state.dayPaused = false;
      this.dirty = true;
      return true;
    }
    return false;
  }

  // ---- Position helpers ----------------------------------------------------

  getPosition(tokenId: string): Position | undefined {
    return this.state.positions[tokenId];
  }

  updatePosition(
    tokenId: string,
    conditionId: string,
    outcome: string,
    fillShares: number,
    fillPrice: number,
    side: "BUY" | "SELL",
  ): void {
    let pos = this.state.positions[tokenId];
    if (!pos) {
      pos = {
        conditionId,
        tokenId,
        outcome,
        netShares: 0,
        avgEntry: 0,
        realizedPnl: 0,
      };
      this.state.positions[tokenId] = pos;
    }

    const direction = side === "BUY" ? 1 : -1;
    const newShares = fillShares * direction;

    if ((pos.netShares >= 0 && direction > 0) || (pos.netShares <= 0 && direction < 0)) {
      // Adding to position → update average entry
      const totalCost = pos.avgEntry * Math.abs(pos.netShares) + fillPrice * fillShares;
      pos.netShares += newShares;
      pos.avgEntry = Math.abs(pos.netShares) > 0 ? totalCost / Math.abs(pos.netShares) : 0;
    } else {
      // Reducing/flipping position → realize P&L
      const closingShares = Math.min(fillShares, Math.abs(pos.netShares));
      const pnl = closingShares * (fillPrice - pos.avgEntry) * (pos.netShares > 0 ? 1 : -1);
      pos.realizedPnl += pnl;
      this.state.dailyPnl += pnl;
      this.state.totalPnl += pnl;

      pos.netShares += newShares;
      // If position flipped, set new avg entry
      if (Math.abs(pos.netShares) > closingShares) {
        // Only the excess shares have the new price
        pos.avgEntry = fillPrice;
      } else if (pos.netShares === 0) {
        pos.avgEntry = 0;
      }
    }

    this.dirty = true;
  }

  /** Get total unrealized P&L across all positions. */
  getUnrealizedPnl(priceMap: Map<string, number>): number {
    let total = 0;
    for (const pos of Object.values(this.state.positions)) {
      if (pos.netShares === 0) continue;
      const currentPrice = priceMap.get(pos.tokenId) ?? pos.avgEntry;
      total += pos.netShares * (currentPrice - pos.avgEntry);
    }
    return total;
  }

  /** Get total value of all long positions (netShares × price). */
  getPositionValue(priceMap: Map<string, number>): number {
    let total = 0;
    for (const pos of Object.values(this.state.positions)) {
      if (pos.netShares <= 0) continue;
      const price = priceMap.get(pos.tokenId) ?? pos.avgEntry;
      total += pos.netShares * price;
    }
    return total;
  }

  /** Get total exposure across all positions (absolute value). */
  getTotalExposure(priceMap: Map<string, number>): number {
    let total = 0;
    for (const pos of Object.values(this.state.positions)) {
      if (pos.netShares === 0) continue;
      const price = priceMap.get(pos.tokenId) ?? pos.avgEntry;
      total += Math.abs(pos.netShares) * price;
    }
    return total;
  }

  /**
   * Remove positions that don't belong to any active market.
   * Stale positions from resolved/expired markets pollute exposure calculations.
   * Returns the number of positions pruned.
   */
  pruneStalePositions(activeConditionIds: string[]): number {
    const activeSet = new Set(activeConditionIds);
    let pruned = 0;
    for (const [tokenId, pos] of Object.entries(this.state.positions)) {
      if (!activeSet.has(pos.conditionId)) {
        this.logger.info(
          `Pruning stale position: ${pos.outcome} ${pos.netShares.toFixed(1)} shares ` +
            `(condition ${pos.conditionId.slice(0, 12)}…)`,
        );
        delete this.state.positions[tokenId];
        pruned++;
      }
    }
    if (pruned > 0) this.dirty = true;
    return pruned;
  }

  /** Get net exposure for a specific market (across both tokens). */
  getMarketExposure(conditionId: string, priceMap: Map<string, number>): number {
    let total = 0;
    for (const pos of Object.values(this.state.positions)) {
      if (pos.conditionId !== conditionId || pos.netShares === 0) continue;
      const price = priceMap.get(pos.tokenId) ?? pos.avgEntry;
      total += Math.abs(pos.netShares) * price;
    }
    return total;
  }

  // ---- Pending sells (persisted for crash recovery) -----------------------

  setPendingSell(tokenId: string, pending: PendingSell): void {
    if (!this.state.pendingSells) this.state.pendingSells = {};
    this.state.pendingSells[tokenId] = pending;
    this.dirty = true;
  }

  removePendingSell(tokenId: string): void {
    if (!this.state.pendingSells) return;
    delete this.state.pendingSells[tokenId];
    this.dirty = true;
  }

  getPendingSells(): Record<string, PendingSell> {
    return this.state.pendingSells || {};
  }

  // ---- Order tracking ------------------------------------------------------

  trackOrder(order: TrackedOrder): void {
    this.state.trackedOrders[order.orderId] = order;
    this.dirty = true;
  }

  removeOrder(orderId: string): void {
    delete this.state.trackedOrders[orderId];
    this.dirty = true;
  }

  getTrackedOrders(): TrackedOrder[] {
    return Object.values(this.state.trackedOrders);
  }

  getMarketOrders(conditionId: string): TrackedOrder[] {
    return Object.values(this.state.trackedOrders).filter(
      (o) => o.conditionId === conditionId && o.status === "live",
    );
  }

  // ---- Fill history --------------------------------------------------------

  /** Record a fill event and trim old entries. */
  recordFill(fill: FillEvent): void {
    if (!this.state.fillHistory) this.state.fillHistory = [];
    this.state.fillHistory.push(fill);
    // Keep last 2 hours of fills
    const cutoff = Date.now() - 2 * 3600_000;
    this.state.fillHistory = this.state.fillHistory.filter((f) => f.timestamp >= cutoff);
    this.dirty = true;
  }

  /** Count fills in the last hour for a specific market. */
  getFillsPerHour(conditionId: string): number {
    const cutoff = Date.now() - 3600_000;
    return (this.state.fillHistory || []).filter(
      (f) => f.conditionId === conditionId && f.timestamp >= cutoff,
    ).length;
  }

  /** Get all fills in the last hour (all markets). */
  getRecentFillsAll(): FillEvent[] {
    const cutoff = Date.now() - 3600_000;
    return (this.state.fillHistory || []).filter((f) => f.timestamp >= cutoff);
  }

  // ---- Persistence ---------------------------------------------------------

  save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
      this.dirty = false;
    } catch (err: any) {
      this.logger.error(`Failed to save state: ${err.message}`);
    }
  }

  /** Force an immediate save (for significant events). */
  forceSave(): void {
    this.dirty = true;
    this.save();
  }

  private load(): MmState {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw) as MmState;
        this.logger.info(`Loaded state from ${this.filePath}`);
        // Merge with defaults to handle schema evolution
        return { ...defaultState(), ...parsed };
      }
    } catch (err: any) {
      this.logger.warn(`Failed to load state, using defaults: ${err.message}`);
    }
    return defaultState();
  }
}
