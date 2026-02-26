// ---------------------------------------------------------------------------
// Persistent state management — v5 simplified
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { PluginLogger } from "../../src/plugins/types.js";
import type { MmState, TrackedOrder, Position, FillEvent, MarketState } from "./types.js";
import { todayUTC } from "./utils.js";

const STATE_FILE = "polymarket-mm.json";

function defaultState(): MmState {
  return {
    running: false,
    startedAt: null,
    capital: 0,
    peakBalance: 0,
    dailyPnl: 0,
    dailyDate: todayUTC(),
    totalPnl: 0,
    totalRewardsEstimate: 0,
    positions: {},
    trackedOrders: {},
    activeMarkets: [],
    pausedMarkets: [],
    errorCount: 0,
    lastRefreshAt: 0,
    lastScanAt: 0,
    killSwitchTriggered: false,
    dayPaused: false,
    rewardHistory: [],
    fillHistory: [],
    marketStates: {},
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

  startAutoSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setInterval(() => {
      if (this.dirty) this.save();
    }, 30_000);
  }

  stopAutoSave(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) this.save();
  }

  get(): Readonly<MmState> {
    return this.state;
  }

  update(patch: Partial<MmState>): void {
    Object.assign(this.state, patch);
    this.dirty = true;
  }

  markDirty(): void {
    this.dirty = true;
  }

  checkDayRoll(): boolean {
    const today = todayUTC();
    if (this.state.dailyDate !== today) {
      if (this.state.dailyDate) {
        this.state.rewardHistory.push({
          date: this.state.dailyDate,
          estimated: this.state.totalRewardsEstimate,
        });
        if (this.state.rewardHistory.length > 90) {
          this.state.rewardHistory = this.state.rewardHistory.slice(-90);
        }
      }
      this.state.dailyPnl = 0;
      this.state.dailyDate = today;
      this.state.dayPaused = false;

      // Clean closed positions
      let cleaned = 0;
      for (const [tokenId, pos] of Object.entries(this.state.positions)) {
        if (pos.netShares === 0) {
          delete this.state.positions[tokenId];
          cleaned++;
        }
      }
      if (cleaned > 0) {
        this.logger.info(`Day roll: cleaned ${cleaned} closed positions`);
      }

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
      pos = { conditionId, tokenId, outcome, netShares: 0, avgEntry: 0, realizedPnl: 0 };
      this.state.positions[tokenId] = pos;
    }

    const direction = side === "BUY" ? 1 : -1;
    const newShares = fillShares * direction;

    if ((pos.netShares >= 0 && direction > 0) || (pos.netShares <= 0 && direction < 0)) {
      const totalCost = pos.avgEntry * Math.abs(pos.netShares) + fillPrice * fillShares;
      pos.netShares += newShares;
      pos.avgEntry = Math.abs(pos.netShares) > 0 ? totalCost / Math.abs(pos.netShares) : 0;
    } else {
      const closingShares = Math.min(fillShares, Math.abs(pos.netShares));
      const pnl = closingShares * (fillPrice - pos.avgEntry) * (pos.netShares > 0 ? 1 : -1);
      pos.realizedPnl += pnl;
      this.state.dailyPnl += pnl;
      this.state.totalPnl += pnl;

      pos.netShares += newShares;
      if (Math.abs(pos.netShares) > closingShares) {
        pos.avgEntry = fillPrice;
      } else if (pos.netShares === 0) {
        pos.avgEntry = 0;
      }
    }

    this.dirty = true;
  }

  getUnrealizedPnl(priceMap: Map<string, number>): number {
    let total = 0;
    for (const pos of Object.values(this.state.positions)) {
      if (pos.netShares === 0) continue;
      const currentPrice = priceMap.get(pos.tokenId) ?? pos.avgEntry;
      total += pos.netShares * (currentPrice - pos.avgEntry);
    }
    return total;
  }

  getPositionValue(priceMap: Map<string, number>): number {
    let total = 0;
    for (const pos of Object.values(this.state.positions)) {
      if (pos.netShares <= 0) continue;
      const price = priceMap.get(pos.tokenId) ?? pos.avgEntry;
      total += pos.netShares * price;
    }
    return total;
  }

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

  // ---- Market state (v5) ---------------------------------------------------

  getMarketState(conditionId: string): MarketState | undefined {
    return this.state.marketStates[conditionId];
  }

  setMarketState(conditionId: string, ms: MarketState): void {
    this.state.marketStates[conditionId] = ms;
    this.dirty = true;
  }

  removeMarketState(conditionId: string): void {
    delete this.state.marketStates[conditionId];
    this.dirty = true;
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

  recordFill(fill: FillEvent): void {
    if (!this.state.fillHistory) this.state.fillHistory = [];
    this.state.fillHistory.push(fill);
    const cutoff = Date.now() - 2 * 3600_000;
    this.state.fillHistory = this.state.fillHistory.filter((f) => f.timestamp >= cutoff);
    this.dirty = true;
  }

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

  forceSave(): void {
    this.dirty = true;
    this.save();
  }

  private load(): MmState {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw);
        this.logger.info(`Loaded state from ${this.filePath}`);
        // Merge with defaults for schema evolution (v4→v5 compat)
        const state = { ...defaultState(), ...parsed };
        // Ensure marketStates exists (new in v5)
        if (!state.marketStates) state.marketStates = {};
        // Drop deprecated fields from v4
        delete (state as any).pendingSells;
        delete (state as any).spreadState;
        return state;
      }
    } catch (err: any) {
      this.logger.warn(`Failed to load state, using defaults: ${err.message}`);
    }
    return defaultState();
  }
}
