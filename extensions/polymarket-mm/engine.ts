// ---------------------------------------------------------------------------
// MM Engine: Main service loop tying all components together
//
// Single-process architecture:
//   1. Market scan loop (every 30 min)
//   2. Quote refresh loop (every 15s)
//   3. Fill detection loop (every 5s)
//   4. Risk check loop (every 5s)
//   5. Reward scoring check (every 60s)
//   6. Opportunistic trade check (every 30s)
// ---------------------------------------------------------------------------

import { Side } from "@polymarket/clob-client";
import type { PluginLogger } from "../../src/plugins/types.js";
import { PolymarketClient, type ClientOptions } from "./client.js";
import { resolveConfig } from "./config.js";
import { DashboardServer } from "./dashboard-server.js";
import { FillHandler } from "./fill-handler.js";
import { InventoryManager } from "./inventory-manager.js";
import { MarketScanner } from "./market-scanner.js";
import { OpportunisticTrader } from "./opportunistic-trader.js";
import { OrderManager } from "./order-manager.js";
import { QuoteEngine } from "./quote-engine.js";
import { RewardTracker } from "./reward-tracker.js";
import { RiskController } from "./risk-controller.js";
import { SpreadController } from "./spread-controller.js";
import { StateManager } from "./state.js";
import type {
  MmConfig,
  MmMarket,
  BookSnapshot,
  TargetQuote,
  TrackedOrder,
  PendingSell,
} from "./types.js";
import { sleep, todayUTC, fmtUsd } from "./utils.js";

export class MmEngine {
  private client: PolymarketClient;
  private stateMgr: StateManager;
  private scanner: MarketScanner;
  private quoteEngine: QuoteEngine;
  private inventory: InventoryManager;
  private orderMgr: OrderManager;
  private risk: RiskController;
  private rewards: RewardTracker;
  private opportunistic: OpportunisticTrader;
  private spreadController: SpreadController;
  private fillHandler: FillHandler;

  private config: MmConfig;
  private logger: PluginLogger;
  private running = false;
  private loopHandle: ReturnType<typeof setTimeout> | null = null;
  private tickCount = 0;
  private dashboard: DashboardServer | null = null;

  /** Cached book snapshots per token. */
  private books: Map<string, BookSnapshot> = new Map();
  /** Cached price map (tokenId → midpoint). */
  private priceMap: Map<string, number> = new Map();
  /** Current quotes per market. */
  private currentQuotes: Map<string, TargetQuote[]> = new Map();
  /** Active MmMarket objects. */
  private activeMarkets: MmMarket[] = [];
  /** Cached balance. */
  private cachedBalance = 0;
  /** Track last midpoint correction per token to reduce log spam. */
  private lastMidCorrection: Map<string, number> = new Map();

  constructor(
    clientOpts: ClientOptions,
    stateDir: string,
    configOverrides: Partial<MmConfig> | undefined,
    logger: PluginLogger,
  ) {
    this.logger = logger;
    this.config = resolveConfig(configOverrides);
    this.client = new PolymarketClient(clientOpts);
    this.stateMgr = new StateManager(stateDir, logger);

    this.scanner = new MarketScanner(this.client, this.config, logger);
    this.inventory = new InventoryManager(this.client, this.stateMgr, this.config, logger);
    this.spreadController = new SpreadController(this.stateMgr, this.config, logger);
    this.quoteEngine = new QuoteEngine(
      this.inventory,
      this.stateMgr,
      this.config,
      this.spreadController,
      logger,
    );
    this.orderMgr = new OrderManager(this.client, this.stateMgr, this.config, logger);
    this.risk = new RiskController(this.client, this.stateMgr, this.inventory, this.config, logger);
    this.rewards = new RewardTracker(this.client, this.stateMgr, this.quoteEngine, logger);
    this.opportunistic = new OpportunisticTrader(this.client, this.stateMgr, this.config, logger);
    this.fillHandler = new FillHandler(
      this.client,
      this.stateMgr,
      this.spreadController,
      this.config,
      logger,
    );
    // Wire risk controller → fill handler for toxicity analysis
    this.fillHandler.setRiskController(this.risk);
  }

  // ---- Lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.logger.info("Starting MM engine...");

    // Initialize CLOB client
    await this.client.init();

    // Load state, reconcile
    this.stateMgr.startAutoSave();
    await this.inventory.reconcile();

    // Get initial balance and adjust capital config to match actual funds
    this.cachedBalance = await this.client.getBalance();
    this.stateMgr.update({ capital: this.cachedBalance });
    this.logger.info(`Balance: $${this.cachedBalance.toFixed(2)}`);

    if (this.cachedBalance < this.config.totalCapital) {
      this.config.totalCapital = this.cachedBalance;
      this.config.maxCapitalPerMarket = Math.min(
        this.config.maxCapitalPerMarket,
        this.cachedBalance * 0.95,
      );
      this.config.orderSize = Math.min(
        this.config.orderSize,
        this.cachedBalance * 0.45, // ~half per token (YES+NO)
      );
      this.config.maxTotalExposure = Math.min(
        this.config.maxTotalExposure,
        this.cachedBalance * 0.95,
      );
      this.logger.info(
        `Capital adjusted to balance: orderSize=$${this.config.orderSize.toFixed(0)}, ` +
          `maxPerMarket=$${this.config.maxCapitalPerMarket.toFixed(0)}`,
      );
    }

    // Initial market scan
    await this.scanner.scan();
    this.activeMarkets = this.scanner.selectActiveMarkets(this.stateMgr.get().pausedMarkets);
    const activeIds = this.activeMarkets.map((m) => m.conditionId);

    // Prune stale positions from resolved/expired markets
    const pruned = this.stateMgr.pruneStalePositions(activeIds);
    if (pruned > 0) {
      this.logger.info(`Pruned ${pruned} stale positions from resolved markets`);
    }
    this.fillHandler.setActiveMarkets(activeIds);

    // Restore pending sells from persisted state (crash recovery)
    await this.fillHandler.restorePendingSells();

    // Detect orphan positions (in non-active markets) and queue for sell
    await this.sellOrphanPositions(activeIds);

    this.stateMgr.update({
      running: true,
      startedAt: Date.now(),
      activeMarkets: activeIds,
      killSwitchTriggered: false,
    });

    this.running = true;
    this.logger.info(
      `MM started with ${this.activeMarkets.length} markets, $${this.cachedBalance.toFixed(2)} balance`,
    );

    // Start dashboard if configured
    if (!this.dashboard) {
      this.startDashboard();
    }

    // Start main loop
    this.scheduleLoop();
  }

  async stop(reason: string, liquidate?: boolean): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.loopHandle) {
      clearTimeout(this.loopHandle);
      this.loopHandle = null;
    }

    this.logger.info(`Stopping MM: ${reason}`);

    // Cancel all orders
    await this.orderMgr.cancelAllOrders();

    // Optionally liquidate positions
    const shouldLiquidate = liquidate ?? this.config.liquidateOnStop;
    if (shouldLiquidate) {
      this.logger.info("Liquidating positions on stop...");
      await this.liquidateAllPositions();
    }

    this.stateMgr.update({ running: false });
    this.stateMgr.stopAutoSave();
    this.logger.info("MM stopped. All orders cancelled. State saved.");
    // Note: dashboard keeps running so user can still see status after stop
  }

  async emergencyKill(reason: string): Promise<{ liquidated: boolean }> {
    this.running = false;
    if (this.loopHandle) {
      clearTimeout(this.loopHandle);
      this.loopHandle = null;
    }

    this.logger.error(`🚨 KILL SWITCH: ${reason}`);

    // Cancel all orders immediately
    try {
      await this.client.cancelAll();
    } catch {
      // Best effort
    }

    // Attempt to liquidate positions if configured
    let liquidated = false;
    if (this.config.liquidateOnKill) {
      this.logger.info("Attempting liquidation on kill...");
      try {
        await this.liquidateAllPositions();
        liquidated = true;
      } catch (err: any) {
        this.logger.error(`Liquidation on kill failed: ${err.message}`);
      }
    }

    this.stateMgr.update({
      running: false,
      killSwitchTriggered: true,
      trackedOrders: {},
    });
    this.stateMgr.forceSave();
    this.stateMgr.stopAutoSave();
    return { liquidated };
  }

  isRunning(): boolean {
    return this.running;
  }

  startDashboard(port = 3800, password = ""): void {
    const pw = password || process.env.MM_DASHBOARD_PASSWORD || "159";
    const p = parseInt(process.env.MM_DASHBOARD_PORT || "", 10) || port;
    this.dashboard = new DashboardServer(p, pw, this.logger);
    this.dashboard.setEngine(this);
    this.dashboard.start();
  }

  stopDashboard(): void {
    this.dashboard?.stop();
    this.dashboard = null;
  }

  // ---- Main loop -----------------------------------------------------------

  private scheduleLoop(): void {
    if (!this.running) return;
    // Main tick every 5 seconds
    this.loopHandle = setTimeout(() => this.tick(), 5_000);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    this.tickCount++;

    try {
      // Day rollover check
      this.stateMgr.checkDayRoll();

      // Skip if day-paused or kill-switch
      const st = this.stateMgr.get();
      if (st.killSwitchTriggered || st.dayPaused) {
        this.scheduleLoop();
        return;
      }

      // --- Every tick (5s): fill detection + risk check ---
      const fills = await this.orderMgr.detectFills();
      for (const { order, fillSize } of fills) {
        await this.handleFill(order, fillSize);
      }

      // Update books for active markets
      await this.refreshBooks();

      // Risk check
      const riskAction = this.risk.check(this.activeMarkets, this.books, this.priceMap);
      if (riskAction.type !== "ok") {
        await this.handleRiskAction(riskAction);
        if (riskAction.type === "kill") {
          this.scheduleLoop();
          return;
        }
      }

      // --- Every 3 ticks (15s): refresh quotes ---
      if (this.tickCount % 3 === 0) {
        this.logger.info(
          `[tick ${this.tickCount}] Refreshing quotes for ${this.activeMarkets.length} markets (books: ${this.books.size})`,
        );
        await this.refreshAllQuotes();
        const totalOrders = Object.keys(this.stateMgr.get().trackedOrders || {}).length;
        this.logger.info(`[tick ${this.tickCount}] After refresh: ${totalOrders} tracked orders`);
      }

      // --- Every 6 ticks (30s): opportunistic trades ---
      if (this.tickCount % 6 === 0) {
        await this.opportunistic.checkOpportunities(this.activeMarkets, this.books);
      }

      // --- Every 4 ticks (20s): pending sell timeout check ---
      if (this.tickCount % 4 === 0) {
        await this.fillHandler.checkTimeouts();
      }

      // --- Every 12 ticks (60s): reward scoring + spread decay + circuit breaker recovery ---
      if (this.tickCount % 12 === 0) {
        await this.rewards.checkScoring();
        this.spreadController.decayOverride();

        // Auto-resume paused markets when circuit breaker cooldown expires
        const paused = this.stateMgr.get().pausedMarkets;
        if (paused.length > 0) {
          const toResume = this.risk.getMarketsToResume(paused);
          if (toResume.length > 0) {
            const remaining = paused.filter((id) => !toResume.includes(id));
            this.stateMgr.update({ pausedMarkets: remaining });
            this.logger.info(
              `Auto-resumed ${toResume.length} market(s): ${toResume.map((id) => id.slice(0, 10)).join(", ")}`,
            );
          }
        }
      }

      // --- Every 60 ticks (5 min): balance refresh ---
      if (this.tickCount % 60 === 0) {
        try {
          this.cachedBalance = await this.client.getBalance();
        } catch {
          // non-critical
        }
      }

      // --- Every 360 ticks (30 min): market rescan ---
      if (this.tickCount % 360 === 0 || this.scanner.shouldRescan()) {
        await this.rescanMarketsInternal();
      }

      // --- Every 60 ticks (5 min): position reconciliation ---
      if (this.tickCount % 60 === 0) {
        try {
          await this.inventory.reconcilePositions(this.activeMarkets);
        } catch (err: any) {
          this.logger.warn(`Position reconciliation failed: ${err.message}`);
        }
      }

      // --- Once per hour: fetch actual earnings ---
      if (this.tickCount % 720 === 0) {
        await this.rewards.fetchDailyEarnings();
      }

      this.stateMgr.update({ lastRefreshAt: Date.now(), errorCount: 0 });
    } catch (err: any) {
      this.logger.error(`Tick error: ${err.message}`);
      this.stateMgr.update({
        errorCount: (this.stateMgr.get().errorCount || 0) + 1,
      });

      // If too many consecutive errors, cancel all as safety measure
      if (this.stateMgr.get().errorCount > 5) {
        this.logger.error("Too many consecutive errors, cancelling all orders");
        await this.orderMgr.cancelAllOrders();
      }
    }

    this.scheduleLoop();
  }

  // ---- Core operations ----------------------------------------------------

  private async refreshBooks(): Promise<void> {
    // 1. Collect all tokens and update exposure ratios
    const allTokens: { tokenId: string; market: MmMarket }[] = [];
    for (const market of this.activeMarkets) {
      let marketExposure = 0;
      for (const token of market.tokens) {
        const pos = this.stateMgr.getPosition(token.tokenId);
        if (pos && pos.netShares > 0) {
          marketExposure += pos.netShares * pos.avgEntry;
        }
        allTokens.push({ tokenId: token.tokenId, market });
      }
      const exposureRatio = marketExposure / this.config.maxCapitalPerMarket;
      this.spreadController.updateExposureRatio(market.conditionId, exposureRatio);
    }

    if (allTokens.length === 0) return;

    // 2. Batch fetch all orderbooks (1 API call instead of N)
    const bookParams = allTokens.map((t) => ({ token_id: t.tokenId, side: Side.BUY }));
    let rawBooks: import("@polymarket/clob-client").OrderBookSummary[];
    try {
      rawBooks = await this.client.getOrderBooks(bookParams);
    } catch (err: any) {
      this.logger.warn(`Batch book fetch failed, falling back to individual: ${err.message}`);
      await this.refreshBooksIndividual();
      return;
    }

    // 3. Batch fetch all midpoints (1 API call instead of N)
    let midpoints: any = {};
    try {
      midpoints = await this.client.getMidpoints(bookParams);
    } catch {
      // Will use local book midpoints as fallback
    }

    // 4. Process results
    for (let i = 0; i < allTokens.length; i++) {
      const { tokenId, market } = allTokens[i];
      const rawBook = rawBooks[i];
      if (!rawBook) continue;

      const snapshot = this.quoteEngine.parseBook(rawBook);

      // Apply true midpoint from batch result
      // getMidpoints may return array of {mid: string} or Record<token_id, string>
      let trueMid = 0;
      if (Array.isArray(midpoints)) {
        const entry = midpoints[i];
        trueMid = parseFloat(entry?.mid ?? entry ?? "0");
      } else if (midpoints[tokenId]) {
        trueMid = parseFloat(midpoints[tokenId]?.mid ?? midpoints[tokenId] ?? "0");
      }

      if (trueMid > 0 && trueMid < 1) {
        // Only log midpoint correction when it's new or significantly changed
        const lastCorr = this.lastMidCorrection.get(tokenId);
        if (
          Math.abs(snapshot.midpoint - trueMid) > 0.05 &&
          (lastCorr === undefined || Math.abs(lastCorr - trueMid) > 0.01)
        ) {
          this.logger.info(
            `Midpoint correction ${tokenId.slice(0, 10)}: ` +
              `local=${snapshot.midpoint.toFixed(3)} → true=${trueMid.toFixed(3)}`,
          );
          this.lastMidCorrection.set(tokenId, trueMid);
        }
        snapshot.midpoint = trueMid;
      }

      this.books.set(tokenId, snapshot);
      this.priceMap.set(tokenId, snapshot.midpoint);
      this.risk.recordPrice(tokenId, snapshot.midpoint);

      const vol = this.risk.getRealizedVolatility(tokenId);
      this.spreadController.updateVolatility(market.conditionId, vol);
    }
  }

  /** Fallback: fetch books individually (used when batch endpoint fails). */
  private async refreshBooksIndividual(): Promise<void> {
    for (const market of this.activeMarkets) {
      for (const token of market.tokens) {
        try {
          const rawBook = await this.client.getOrderBook(token.tokenId);
          const snapshot = this.quoteEngine.parseBook(rawBook);

          try {
            const trueMid = await this.client.getMidpoint(token.tokenId);
            if (trueMid > 0 && trueMid < 1) {
              const lastCorr = this.lastMidCorrection.get(token.tokenId);
              if (
                Math.abs(snapshot.midpoint - trueMid) > 0.05 &&
                (lastCorr === undefined || Math.abs(lastCorr - trueMid) > 0.01)
              ) {
                this.logger.info(
                  `Midpoint correction ${token.tokenId.slice(0, 10)}: ` +
                    `local=${snapshot.midpoint.toFixed(3)} → true=${trueMid.toFixed(3)}`,
                );
                this.lastMidCorrection.set(token.tokenId, trueMid);
              }
              snapshot.midpoint = trueMid;
            }
          } catch {
            // Fall back to local book midpoint
          }

          this.books.set(token.tokenId, snapshot);
          this.priceMap.set(token.tokenId, snapshot.midpoint);
          this.risk.recordPrice(token.tokenId, snapshot.midpoint);

          const vol = this.risk.getRealizedVolatility(token.tokenId);
          this.spreadController.updateVolatility(market.conditionId, vol);
        } catch (err: any) {
          this.logger.warn(
            `Failed to fetch book for ${token.tokenId.slice(0, 10)}: ${err.message}`,
          );
        }
      }
    }
  }

  private async refreshAllQuotes(): Promise<void> {
    const sizeFactor = this.inventory.getExposureReductionFactor(this.priceMap);

    for (const market of this.activeMarkets) {
      if (this.stateMgr.get().pausedMarkets.includes(market.conditionId)) {
        continue;
      }

      const quotes = this.quoteEngine.generateQuotes(market, this.books, sizeFactor);
      this.currentQuotes.set(market.conditionId, quotes);
      await this.orderMgr.refreshMarketOrders(market, quotes);
    }
  }

  private async handleFill(order: TrackedOrder, fillSize: number): Promise<void> {
    const market = this.activeMarkets.find((m) => m.conditionId === order.conditionId);

    // Update position
    this.stateMgr.updatePosition(
      order.tokenId,
      order.conditionId,
      market?.tokens.find((t) => t.tokenId === order.tokenId)?.outcome ?? "?",
      fillSize,
      order.price,
      order.side,
    );

    // Record fill for adverse selection + toxic flow detection (v3: with direction data)
    this.risk.recordFill(order.conditionId, order.tokenId, order.side, fillSize);

    const fillValue = (fillSize * order.price).toFixed(2);
    const emoji = order.side === "BUY" ? "🟢" : "🔴";
    this.logger.info(
      `${emoji} Fill: ${order.side} ${fillSize.toFixed(1)} @ ${order.price.toFixed(3)} ($${fillValue}) ` +
        `(${market?.question.slice(0, 30) ?? "?"}…)`,
    );

    // Delegate to FillHandler for capital recovery (BUY fills only)
    await this.fillHandler.handleFill(order, fillSize, market);
  }

  private async handleRiskAction(action: import("./types.js").RiskAction): Promise<void> {
    this.logger.warn(`风控: ${action.type} - ${"reason" in action ? action.reason : ""}`);

    switch (action.type) {
      case "kill":
        await this.emergencyKill(action.reason);
        break;

      case "pause_day":
        await this.orderMgr.cancelAllOrders();
        this.stateMgr.update({ dayPaused: true });
        break;

      case "reduce_market":
        await this.orderMgr.cancelSideOrders(action.conditionId, action.side);
        break;

      case "reduce_all":
        // Will take effect on next quote refresh via sizeFactor
        this.logger.warn(`Reducing all order sizes by factor ${action.factor}`);
        break;

      case "pause_market":
        await this.orderMgr.cancelMarketOrders(action.conditionId);
        const paused = [...new Set([...this.stateMgr.get().pausedMarkets, action.conditionId])];
        this.stateMgr.update({ pausedMarkets: paused });
        break;

      case "widen_spread":
        this.spreadController.widenSpread(action.conditionId, action.factor);
        break;
    }
  }

  private async rescanMarketsInternal(): Promise<number> {
    await this.scanner.scan();
    const newMarkets = this.scanner.selectActiveMarkets(this.stateMgr.get().pausedMarkets);

    // Cancel orders on removed markets
    const removedIds = this.activeMarkets
      .filter((m) => !newMarkets.find((n) => n.conditionId === m.conditionId))
      .map((m) => m.conditionId);

    for (const id of removedIds) {
      await this.orderMgr.cancelMarketOrders(id);

      // Sell positions in removed markets to prevent orphan accumulation
      const st = this.stateMgr.get();
      for (const pos of Object.values(st.positions)) {
        if (pos.conditionId !== id || pos.netShares <= 0) continue;
        this.logger.warn(
          `Market removed: selling ${pos.outcome} ${pos.netShares.toFixed(1)} shares ` +
            `(${id.slice(0, 10)})`,
        );
        const ok = await this.fillHandler.forceSellPublic(pos.tokenId, id, pos.netShares);
        if (!ok) {
          // Track as pending sell for retry
          this.stateMgr.setPendingSell(pos.tokenId, {
            tokenId: pos.tokenId,
            conditionId: id,
            shares: pos.netShares,
            placedAt: Date.now(),
            retryCount: 0,
            lastAttemptAt: Date.now(),
            splitFactor: 1.0,
          });
          this.logger.warn(
            `Failed to sell removed-market position ${pos.tokenId.slice(0, 10)}, tracked as pending sell`,
          );
        }
      }
    }

    this.activeMarkets = newMarkets;
    const newIds = newMarkets.map((m) => m.conditionId);
    this.fillHandler.setActiveMarkets(newIds);
    this.stateMgr.update({
      activeMarkets: newIds,
      lastScanAt: Date.now(),
    });

    return this.scanner.getMarkets().length;
  }

  // ---- Liquidation / orphan handling ----------------------------------------

  /**
   * Liquidate all positions with netShares > 0.
   * Returns summary of results.
   */
  async liquidateAllPositions(): Promise<{ success: number; failed: number }> {
    const st = this.stateMgr.get();
    let success = 0;
    let failed = 0;

    for (const pos of Object.values(st.positions)) {
      if (pos.netShares <= 0) continue;

      this.logger.info(
        `Liquidating: ${pos.outcome} ${pos.netShares.toFixed(1)} shares (${pos.conditionId.slice(0, 10)})`,
      );

      const ok = await this.fillHandler.forceSellPublic(
        pos.tokenId,
        pos.conditionId,
        pos.netShares,
      );
      if (ok) {
        success++;
      } else {
        failed++;
      }
    }

    this.logger.info(`Liquidation complete: ${success} sold, ${failed} failed`);
    return { success, failed };
  }

  /**
   * Detect positions in non-active markets and sell them as orphans.
   */
  private async sellOrphanPositions(activeConditionIds: string[]): Promise<void> {
    const activeSet = new Set(activeConditionIds);
    const st = this.stateMgr.get();
    let orphanCount = 0;

    for (const pos of Object.values(st.positions)) {
      if (pos.netShares <= 0) continue;
      if (activeSet.has(pos.conditionId)) continue;

      orphanCount++;
      this.logger.warn(
        `Orphan position detected: ${pos.outcome} ${pos.netShares.toFixed(1)} shares ` +
          `(${pos.conditionId.slice(0, 10)}), attempting sell`,
      );

      const ok = await this.fillHandler.forceSellPublic(
        pos.tokenId,
        pos.conditionId,
        pos.netShares,
      );
      if (!ok) {
        // Track as pending sell for retry (prevents orphan from being forgotten)
        this.stateMgr.setPendingSell(pos.tokenId, {
          tokenId: pos.tokenId,
          conditionId: pos.conditionId,
          shares: pos.netShares,
          placedAt: Date.now(),
          retryCount: 0,
          lastAttemptAt: Date.now(),
          splitFactor: 1.0,
        });
        this.logger.warn(
          `Failed to sell orphan ${pos.tokenId.slice(0, 10)}, tracked as pending sell for retry`,
        );
      }
    }

    if (orphanCount > 0) {
      this.logger.info(`Found ${orphanCount} orphan positions`);
    }
  }

  // ---- Public API for Telegram commands ------------------------------------

  getStatus(): {
    running: boolean;
    balance: number;
    positionValue: number;
    unrealizedPnl: number;
    liveOrders: number;
    scoringOrders: number;
    config: MmConfig;
    state: import("./types.js").MmState;
  } {
    const st = this.stateMgr.get();
    const scoring = this.rewards.getCurrentScoringStats();
    return {
      running: this.running,
      balance: this.cachedBalance,
      positionValue: this.stateMgr.getPositionValue(this.priceMap),
      unrealizedPnl: this.stateMgr.getUnrealizedPnl(this.priceMap),
      liveOrders: this.orderMgr.getLiveOrderCount(),
      scoringOrders: scoring.scoring,
      config: this.config,
      state: st,
    };
  }

  getActiveMarkets(): MmMarket[] {
    return this.activeMarkets;
  }

  getConfig(): MmConfig {
    return { ...this.config };
  }

  updateConfig(key: string, value: string): void {
    if (!(key in this.config)) {
      throw new Error(`Unknown config key: ${key}`);
    }
    const num = parseFloat(value);
    if (isNaN(num)) {
      throw new Error(`Invalid value: ${value}`);
    }
    (this.config as any)[key] = num;
    this.config = resolveConfig(this.config);
    this.logger.info(`Config updated: ${key} = ${num}`);
  }

  getPositionSummaries(): Map<
    string,
    { netValue: number; unrealizedPnl: number; realizedPnl: number }
  > {
    const result = new Map();
    for (const market of this.activeMarkets) {
      result.set(market.conditionId, this.inventory.getPositionSummary(market, this.priceMap));
    }
    return result;
  }

  async getRewardStatus(): Promise<string> {
    const scores = this.rewards.estimateRewards(this.activeMarkets, this.books, this.currentQuotes);
    return this.rewards.formatRewardStatus(scores, this.activeMarkets);
  }

  getRewardData() {
    const scores = this.rewards.estimateRewards(this.activeMarkets, this.books, this.currentQuotes);
    return this.rewards.getRewardData(scores, this.activeMarkets);
  }

  getRecentFills(count: number): TrackedOrder[] {
    return this.stateMgr
      .getTrackedOrders()
      .filter((o) => o.status === "filled" && o.filledSize > 0)
      .sort((a, b) => b.placedAt - a.placedAt)
      .slice(0, count);
  }

  getRecentFillEvents(count: number): import("./types.js").FillEvent[] {
    return this.stateMgr
      .getRecentFillsAll()
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, count);
  }

  async pauseMarket(conditionIdOrIndex: string): Promise<void> {
    // Support numeric index from /mm markets list
    const idx = parseInt(conditionIdOrIndex, 10);
    let conditionId = conditionIdOrIndex;
    if (!isNaN(idx) && idx >= 1 && idx <= this.activeMarkets.length) {
      conditionId = this.activeMarkets[idx - 1].conditionId;
    }

    await this.orderMgr.cancelMarketOrders(conditionId);
    const paused = [...new Set([...this.stateMgr.get().pausedMarkets, conditionId])];
    this.stateMgr.update({ pausedMarkets: paused });
  }

  resumeMarket(conditionIdOrIndex: string): void {
    const idx = parseInt(conditionIdOrIndex, 10);
    let conditionId = conditionIdOrIndex;
    if (!isNaN(idx) && idx >= 1 && idx <= this.activeMarkets.length) {
      conditionId = this.activeMarkets[idx - 1].conditionId;
    }

    const paused = this.stateMgr.get().pausedMarkets.filter((id) => id !== conditionId);
    this.stateMgr.update({ pausedMarkets: paused });
  }

  async rescanMarkets(): Promise<number> {
    if (!this.client.initialized) {
      throw new Error("Client not initialized. Start engine first.");
    }
    return this.rescanMarketsInternal();
  }

  /**
   * Redeem resolved position tokens from CTF contract.
   * Burns winning conditional tokens and returns USDC.
   */
  async redeemPosition(conditionId: string): Promise<string> {
    if (!this.client.initialized) {
      await this.client.init();
    }

    // Find all positions for this conditionId
    const positions = Object.values(this.stateMgr.get().positions).filter(
      (p) => p.conditionId === conditionId && p.netShares > 0,
    );

    if (positions.length === 0) {
      throw new Error(`No positions found for condition ${conditionId.slice(0, 16)}...`);
    }

    const totalShares = positions.reduce((s, p) => s + p.netShares, 0);
    this.logger.info(
      `Redeeming ${totalShares.toFixed(2)} shares for condition ${conditionId.slice(0, 16)}...`,
    );

    // Call CTF redeemPositions (both YES and NO index sets)
    const txHash = await this.client.redeemPositions(conditionId, [1, 2]);

    // Update state: zero out the positions after redemption
    for (const pos of positions) {
      const price = 1.0; // resolved winning token redeems at $1
      const pnl = pos.netShares * (price - pos.avgEntry);
      this.stateMgr.updatePosition(
        pos.tokenId,
        pos.conditionId,
        pos.outcome,
        pos.netShares,
        price,
        "SELL",
      );
    }

    // Refresh balance
    this.cachedBalance = await this.client.getBalance();
    this.stateMgr.update({ capital: this.cachedBalance });
    this.stateMgr.forceSave();

    return txHash;
  }

  /**
   * Get on-chain token balance for a specific token.
   */
  async getOnChainBalance(tokenId: string): Promise<number> {
    if (!this.client.initialized) {
      await this.client.init();
    }
    return this.client.getOnChainBalance(tokenId);
  }
}
