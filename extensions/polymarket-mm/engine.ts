// ---------------------------------------------------------------------------
// MM Engine v5: Cancel-Before-Fill Reward Harvester
//
// Core loop:
//   WS real-time: market feed → danger zone detection (sub-second)
//   REST backup (5s): refresh midpoints → danger zone fallback
//   Shared logic: quoting / cooldown / exiting phases per market
//
// Philosophy: earn rewards from active orders on the book.
//   Fill = accident, not goal. Cancel before fill.
// ---------------------------------------------------------------------------

import { OrderType, Side } from "@polymarket/clob-client";
import type { PluginLogger } from "../../src/plugins/types.js";
import { AccidentalFillHandler } from "./accidental-fill-handler.js";
import { PolymarketClient, type ClientOptions } from "./client.js";
import { resolveConfig } from "./config.js";
import { DashboardServer } from "./dashboard-server.js";
import { MarketScanner } from "./market-scanner.js";
import { OrderManager } from "./order-manager.js";
import { QuoteEngine } from "./quote-engine.js";
import { RewardTracker } from "./reward-tracker.js";
import { StateManager } from "./state.js";
import type {
  MmConfig,
  MmMarket,
  BookSnapshot,
  TargetQuote,
  TrackedOrder,
  MarketState,
} from "./types.js";
import { fmtUsd } from "./utils.js";
import { WsFeed } from "./ws-feed.js";

export class MmEngine {
  private client: PolymarketClient;
  private stateMgr: StateManager;
  private scanner: MarketScanner;
  private quoteEngine: QuoteEngine;
  private orderMgr: OrderManager;
  private rewards: RewardTracker;
  private fillHandler: AccidentalFillHandler;
  private wsFeed: WsFeed | null = null;

  private config: MmConfig;
  private logger: PluginLogger;
  private running = false;
  private loopHandle: ReturnType<typeof setTimeout> | null = null;
  private tickCount = 0;
  private dashboard: DashboardServer | null = null;

  private books: Map<string, BookSnapshot> = new Map();
  private priceMap: Map<string, number> = new Map();
  private currentQuotes: Map<string, TargetQuote[]> = new Map();
  private activeMarkets: MmMarket[] = [];
  private cachedBalance = 0;
  private lastMidCorrection: Map<string, number> = new Map();
  /** P28 #3: Dedup fill processing — prevents WS+REST double-counting */
  private processedFillKeys = new Set<string>();

  private clientOpts: ClientOptions;

  constructor(
    clientOpts: ClientOptions,
    stateDir: string,
    configOverrides: Partial<MmConfig> | undefined,
    logger: PluginLogger,
  ) {
    this.logger = logger;
    this.clientOpts = clientOpts;
    this.config = resolveConfig(configOverrides);
    this.client = new PolymarketClient(clientOpts);
    this.stateMgr = new StateManager(stateDir, logger);

    this.scanner = new MarketScanner(this.client, this.config, logger);
    this.quoteEngine = new QuoteEngine(this.stateMgr, this.config, logger);
    this.orderMgr = new OrderManager(this.client, this.stateMgr, this.config, logger);
    this.rewards = new RewardTracker(this.client, this.stateMgr, this.quoteEngine, logger);
    this.fillHandler = new AccidentalFillHandler(this.client, this.stateMgr, this.config, logger);
    this.fillHandler.setRedeemCallback(async (conditionId: string) => {
      await this.redeemPosition(conditionId);
    });
  }

  // ---- Capital sizing ------------------------------------------------------

  private adjustSizingToBalance(balance: number): void {
    this.config.orderSize = Math.max(1, balance * this.config.orderSizeRatio);
    this.config.maxCapitalPerMarket = Math.max(1, balance * this.config.deployRatio);

    const st = this.stateMgr.get();
    if (balance > (st.peakBalance || 0)) {
      this.stateMgr.update({ peakBalance: balance });
    }
    this.stateMgr.update({ capital: balance });
  }

  // ---- Lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.logger.info("Starting MM v5 engine...");

    await this.client.init();
    this.stateMgr.startAutoSave();

    // Get balance and compute sizing
    this.cachedBalance = await this.client.getBalance();
    this.adjustSizingToBalance(this.cachedBalance);
    this.logger.info(
      `Balance: $${this.cachedBalance.toFixed(2)} → orderSize=$${this.config.orderSize.toFixed(0)}, ` +
        `maxPerMarket=$${this.config.maxCapitalPerMarket.toFixed(0)}`,
    );

    // P18 fix: Cancel any lingering exchange orders and clear stale tracked orders on startup
    // Old orders from previous session may have expired (GTD) or been orphaned.
    try {
      await this.client.cancelAll();
      this.logger.info("Startup: cancelled all lingering exchange orders");
    } catch (err: any) {
      this.logger.warn(`Startup cancel-all failed (non-fatal): ${err.message}`);
    }
    this.stateMgr.clearAllTrackedOrders();

    // Market scan
    await this.scanner.scan();
    const pausedList = this.stateMgr.get().pausedMarkets;
    this.activeMarkets = this.scanner.selectActiveMarkets(pausedList);
    if (pausedList.length > 0) {
      this.logger.info(`Filtering ${pausedList.length} paused markets`);
    }
    for (const mkt of this.activeMarkets) {
      this.logger.info(`✅ Active: ${mkt.question.slice(0, 50)}… ($${mkt.rewardsDailyRate}/d)`);
    }
    const activeIds = this.activeMarkets.map((m) => m.conditionId);

    // Sell orphan positions from non-active markets BEFORE pruning
    // (prune deletes state records — must sell first while we still know about them)
    await this.sellOrphanPositions(activeIds);

    // Prune stale positions (only zero-share leftovers after sell attempts)
    const pruned = this.stateMgr.pruneStalePositions(activeIds);
    if (pruned > 0) this.logger.info(`Pruned ${pruned} stale positions`);

    // P21 fix: Remove stale market states for non-active markets
    this.stateMgr.cleanupStaleMarketStates(activeIds);

    // Initialize market states
    for (const mkt of this.activeMarkets) {
      const existing = this.stateMgr.getMarketState(mkt.conditionId);
      if (!existing || existing.phase !== "exiting") {
        this.stateMgr.setMarketState(mkt.conditionId, {
          conditionId: mkt.conditionId,
          phase: "quoting",
          cooldownUntil: 0,
          activeOrderIds: [],
          ordersExpireAt: 0,
          consecutiveCooldowns: 0,
        });
      }
    }

    this.stateMgr.update({
      running: true,
      startedAt: Date.now(),
      activeMarkets: activeIds,
      killSwitchTriggered: false,
    });

    this.running = true;
    this.logger.info(
      `MM v5 started: ${this.activeMarkets.length} markets, $${this.cachedBalance.toFixed(2)} balance`,
    );

    if (!this.dashboard) this.startDashboard();

    // Start WebSocket feeds
    const allTokenIds = this.activeMarkets.flatMap((m) => m.tokens.map((t) => t.tokenId));
    this.wsFeed = new WsFeed(
      {
        apiKey: this.clientOpts.apiKey,
        apiSecret: this.clientOpts.apiSecret,
        passphrase: this.clientOpts.passphrase,
      },
      this.stateMgr,
      (order, fillSize) => this.handleFill(order, fillSize),
      this.logger,
    );

    // Wire market channel → danger zone detection
    this.wsFeed.onMidUpdate = (tokenId, newMid) => {
      this.priceMap.set(tokenId, newMid);
      this.checkDangerZoneForToken(tokenId);
    };

    this.wsFeed.start(activeIds, allTokenIds);

    // Place initial quotes
    await this.refreshBooks();
    for (const mkt of this.activeMarkets) {
      const ms = this.stateMgr.getMarketState(mkt.conditionId);
      if (ms && ms.phase === "quoting") {
        await this.placeQuotes(mkt, ms);
      }
    }

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

    if (this.wsFeed) {
      this.wsFeed.stop();
      this.wsFeed = null;
    }

    await this.orderMgr.cancelAllOrders();

    const shouldLiquidate = liquidate ?? this.config.liquidateOnStop;
    if (shouldLiquidate) {
      this.logger.info("Liquidating positions on stop...");
      await this.liquidateAllPositions();
    }

    this.stateMgr.update({ running: false });
    this.stateMgr.stopAutoSave();
    this.logger.info("MM stopped.");
  }

  async emergencyKill(reason: string): Promise<{ liquidated: boolean }> {
    this.running = false;
    if (this.loopHandle) {
      clearTimeout(this.loopHandle);
      this.loopHandle = null;
    }

    this.logger.error(`🚨 KILL SWITCH: ${reason}`);

    if (this.wsFeed) {
      this.wsFeed.stop();
      this.wsFeed = null;
    }

    try {
      await this.client.cancelAll();
    } catch (err: any) {
      this.logger.error(`P32: cancelAll in emergencyKill failed: ${err?.message}`);
    }

    let liquidated = false;
    if (this.config.liquidateOnKill) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const result = await this.liquidateAllPositions();
          if (result.failed === 0) {
            liquidated = true;
            break;
          }
        } catch (err: any) {
          this.logger.error(`Liquidation attempt ${attempt} failed: ${err.message}`);
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 5_000));
      }
    }

    this.stateMgr.update({ running: false, killSwitchTriggered: true, trackedOrders: {} });
    this.stateMgr.forceSave();
    this.stateMgr.stopAutoSave();
    return { liquidated };
  }

  isRunning(): boolean {
    return this.running;
  }

  isKilled(): boolean {
    return this.stateMgr.get().killSwitchTriggered === true;
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
    this.loopHandle = setTimeout(() => this.tick(), 5_000);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    this.tickCount++;

    try {
      this.stateMgr.checkDayRoll();
      const st = this.stateMgr.get();
      if (st.killSwitchTriggered || st.dayPaused) {
        this.scheduleLoop();
        return;
      }

      // 1. REST refresh midpoints (fallback, WS is primary)
      await this.refreshBooks();

      // 2. REST fill detection (fallback)
      const fills = await this.orderMgr.detectFills();
      for (const { order, fillSize } of fills) {
        await this.handleFill(order, fillSize);
      }

      // 3. Per-market phase logic
      // P28 #5 fix: snapshot activeMarkets to prevent rescan from replacing mid-loop
      const marketsSnapshot = [...this.activeMarkets];
      for (const mkt of marketsSnapshot) {
        const ms = this.stateMgr.getMarketState(mkt.conditionId);
        if (!ms) continue;

        switch (ms.phase) {
          case "quoting":
            // REST fallback danger zone check (WS is primary path)
            if (this.isInDangerZone(mkt, ms)) {
              await this.enterCooldown(mkt, ms, "REST fallback");
            }
            // GTD refresh: re-place orders 30s before expiry
            else if (this.needsRefresh(ms)) {
              // P29: Orders survived a full GTD cycle without danger zone — market is stable.
              // Reset consecutiveCooldowns so the 3-strike counter starts fresh.
              if (ms.consecutiveCooldowns > 0) {
                this.logger.info(
                  `${mkt.question.slice(0, 30)}… 单子存活至GTD刷新, 重置冷却计数 (was ${ms.consecutiveCooldowns})`,
                );
                ms.consecutiveCooldowns = 0;
                this.stateMgr.setMarketState(mkt.conditionId, ms);
              }
              await this.refreshQuotes(mkt, ms);
            }
            break;

          case "cooldown":
            if (Date.now() > ms.cooldownUntil) {
              if ((ms.consecutiveCooldowns || 0) >= 3) {
                // Too volatile — pause market and rescan for a better one
                this.logger.warn(
                  `🔄 ${mkt.question.slice(0, 30)}… 连续${ms.consecutiveCooldowns}次冷却, 暂停并切换`,
                );
                await this.orderMgr.cancelMarketOrders(mkt.conditionId);
                const paused = [
                  ...new Set([...this.stateMgr.get().pausedMarkets, mkt.conditionId]),
                ];
                this.stateMgr.update({ pausedMarkets: paused });
                this.stateMgr.removeMarketState(mkt.conditionId);
                await this.rescanMarketsInternal();
              } else {
                // P29: Resume quoting after cooldown. DON'T reset consecutiveCooldowns
                // here — it resets only when orders survive a full GTD cycle (see
                // needsRefresh path). This lets the counter accumulate if we keep
                // bouncing between quoting and cooldown.
                ms.phase = "quoting";
                ms.lastCooldownMids = undefined;
                this.stateMgr.setMarketState(mkt.conditionId, ms);
                await this.placeQuotes(mkt, ms);
                this.logger.info(
                  `✅ ${mkt.question.slice(0, 30)}… 冷却结束, 重新报价 (累计冷却${ms.consecutiveCooldowns}次)`,
                );
              }
            }
            break;

          case "exiting":
            // Exiting is now a brief marker during immediateSell().
            // If we're still here after 60s, something went wrong — force to cooldown.
            if (ms.accidentalFill && Date.now() - ms.accidentalFill.filledAt > 60_000) {
              this.logger.warn(`Exiting stuck for >60s, forcing cooldown`);
              ms.accidentalFill = undefined;
              ms.phase = "cooldown";
              ms.cooldownUntil = Date.now() + this.config.cooldownMs;
              this.stateMgr.setMarketState(mkt.conditionId, ms);
            } else if (!ms.accidentalFill) {
              // T1: exiting phase but no accidentalFill — should never happen, recover
              this.logger.warn(`T1: Exiting phase but no accidentalFill, forcing cooldown`);
              ms.phase = "cooldown";
              ms.cooldownUntil = Date.now() + this.config.cooldownMs;
              this.stateMgr.setMarketState(mkt.conditionId, ms);
            }
            break;
        }
      }

      // 4. Simple risk: drawdown check
      this.checkSimpleRisk();

      // 5. Periodic tasks
      // Every 12 ticks (60s): reward scoring
      if (this.tickCount % 12 === 0) {
        await this.rewards.checkScoring();
      }
      // Every 60 ticks (5min): balance refresh
      if (this.tickCount % 60 === 0) {
        try {
          this.cachedBalance = await this.client.getBalance();
          this.adjustSizingToBalance(this.cachedBalance);
        } catch (err: any) {
          this.logger.warn(`P32: Balance refresh failed: ${err?.message}`);
        }
      }
      // Every 360 ticks (30min): market rescan
      if (this.tickCount % 360 === 0 || this.scanner.shouldRescan()) {
        await this.rescanMarketsInternal();
      }
      // Every 720 ticks (1hr): fetch actual earnings
      if (this.tickCount % 720 === 0) {
        await this.rewards.fetchDailyEarnings();
      }

      this.stateMgr.update({ lastRefreshAt: Date.now(), errorCount: 0 });
    } catch (err: any) {
      this.logger.error(`Tick error: ${err.message}`);
      this.stateMgr.update({ errorCount: (this.stateMgr.get().errorCount || 0) + 1 });

      if (this.stateMgr.get().errorCount > 5) {
        this.logger.error("Too many errors, cancelling all orders as safety measure");
        await this.orderMgr.cancelAllOrders();
      }
    }

    this.scheduleLoop();
  }

  // ---- Danger zone detection (core v5) ------------------------------------

  /** WS-triggered real-time danger zone check for a specific token. */
  private checkDangerZoneForToken(tokenId: string): void {
    const mkt = this.activeMarkets.find((m) => m.tokens.some((t) => t.tokenId === tokenId));
    if (!mkt) return;

    const ms = this.stateMgr.getMarketState(mkt.conditionId);
    if (!ms || ms.phase !== "quoting") return;

    if (this.isInDangerZone(mkt, ms)) {
      // Fire-and-forget async cancel (WS path must be fast)
      this.enterCooldown(mkt, ms, "WS real-time").catch((err) => {
        this.logger.error(`WS danger zone cancel failed: ${err.message}`);
      });
    }
  }

  private isInDangerZone(mkt: MmMarket, ms: MarketState): boolean {
    for (const orderId of ms.activeOrderIds) {
      const order = this.stateMgr.get().trackedOrders[orderId];
      if (!order || order.status !== "live") continue;

      const mid = this.priceMap.get(order.tokenId);
      if (!mid) {
        // P35: No price data for this token — treat as dangerous (conservative).
        // Better to cancel than to leave an unprotected order on the book.
        return true;
      }

      // 1. Classic mid-distance check
      const distance = Math.abs(mid - order.price);
      const dangerSpread = mkt.rewardsMaxSpread * this.config.dangerSpreadRatio;
      if (distance < dangerSpread) return true;

      // 2. P27: Book-depth cushion check — protects against aggressive taker sweeps.
      // If there isn't enough bid liquidity between our order and mid, a taker can
      // sweep straight through to us regardless of mid position.
      if (this.config.minCushionRatio > 0) {
        const book = this.books.get(order.tokenId);
        if (book) {
          const cushion = this.measureCushion(book, order.price, mid);
          const minCushion = this.config.orderSize * this.config.minCushionRatio;
          if (cushion < minCushion) return true;
        }
      }
    }
    return false;
  }

  /**
   * P27: Measure the USD value of bids sitting between our order price and mid.
   * These bids act as a cushion — a taker must fill them before reaching us.
   * Excludes orders at our exact price level (likely our own order).
   */
  private measureCushion(book: BookSnapshot, orderPrice: number, mid: number): number {
    let cushionUsd = 0;
    for (const bid of book.bids) {
      // Only count bids strictly above our price and below mid
      if (bid.price > orderPrice + 0.001 && bid.price < mid) {
        cushionUsd += bid.size * bid.price;
      }
    }
    return cushionUsd;
  }

  private async enterCooldown(mkt: MmMarket, ms: MarketState, source: string): Promise<void> {
    // P9 fix: set phase SYNCHRONOUSLY before await to prevent WS race
    // (two WS events could enter enterCooldown in parallel otherwise)
    ms.phase = "cooldown";
    ms.cooldownUntil = Date.now() + this.config.cooldownMs;
    ms.activeOrderIds = [];
    ms.consecutiveCooldowns = (ms.consecutiveCooldowns || 0) + 1;

    // Record mids at cooldown entry for stability check
    ms.lastCooldownMids = {};
    for (const token of mkt.tokens) {
      const mid = this.priceMap.get(token.tokenId);
      if (mid) ms.lastCooldownMids[token.tokenId] = mid;
    }

    this.stateMgr.setMarketState(mkt.conditionId, ms);
    this.logger.warn(
      `⚠️ 危险区 (${source}): ${mkt.question.slice(0, 30)}… → 冷却${this.config.cooldownMs / 1000}s` +
        ` (连续第${ms.consecutiveCooldowns}次)`,
    );

    // Async cancel AFTER state is set — safe because phase is already "cooldown"
    await this.orderMgr.cancelMarketOrders(mkt.conditionId);
  }

  private isSafeToQuote(_mkt: MmMarket, _ms: MarketState): boolean {
    // P29: Always return true after cooldown expires.
    // Old logic checked if mid was "stable" during cooldown, but this was
    // self-defeating — the very markets that trigger danger zone ALWAYS have
    // moving mids, so isSafeToQuote almost always returned false, leading to
    // inevitable 3-consecutive-cooldown market pauses.
    //
    // New approach: let placeQuotes + isInDangerZone handle safety. New orders
    // are placed at targetSpread from CURRENT mid, which is inherently safe.
    // If market is still volatile, danger zone triggers again quickly and
    // consecutiveCooldowns increments organically.
    return true;
  }

  private needsRefresh(ms: MarketState): boolean {
    if (ms.activeOrderIds.length === 0) return true;
    // Refresh 30s before GTD expiry
    if (ms.ordersExpireAt > 0 && Date.now() > ms.ordersExpireAt - 30_000) return true;
    return false;
  }

  // ---- Quoting -------------------------------------------------------------

  private async placeQuotes(mkt: MmMarket, ms: MarketState): Promise<void> {
    const quotes = this.quoteEngine.generateQuotes(mkt, this.books);
    if (quotes.length === 0) {
      // P31: Track consecutive empty-quote ticks to detect unquotable markets
      ms.emptyQuoteTicks = (ms.emptyQuoteTicks || 0) + 1;
      if (ms.emptyQuoteTicks >= 6) {
        // 6 ticks × 5s = 30s of empty quotes → market is unquotable, pause and rescan
        this.logger.warn(
          `🔄 P31: ${mkt.question.slice(0, 30)}… 连续${ms.emptyQuoteTicks}次空报价, 暂停并切换市场`,
        );
        const paused = [...new Set([...this.stateMgr.get().pausedMarkets, mkt.conditionId])];
        this.stateMgr.update({ pausedMarkets: paused });
        this.stateMgr.removeMarketState(mkt.conditionId);
        await this.rescanMarketsInternal();
      }
      this.stateMgr.setMarketState(mkt.conditionId, ms);
      return;
    }

    // Reset empty quote counter on success
    if (ms.emptyQuoteTicks) {
      ms.emptyQuoteTicks = 0;
    }

    this.currentQuotes.set(mkt.conditionId, quotes);
    const placedIds = await this.orderMgr.refreshMarketOrders(mkt, quotes);

    // Race guard: WS danger zone may have fired during the await above,
    // changing ms.phase to "cooldown". If so, cancel the orphan orders.
    if (ms.phase !== "quoting") {
      if (placedIds.length > 0) {
        this.logger.info(
          `Race detected: phase=${ms.phase} after placeQuotes, cancelling ${placedIds.length} orphans`,
        );
        try {
          await this.client.cancelOrders(placedIds);
        } catch (err: any) {
          this.logger.warn(`P32: Race cancel failed: ${err?.message}`);
        }
        for (const id of placedIds) this.stateMgr.removeOrder(id);
      }
      return;
    }

    ms.activeOrderIds = placedIds;
    // GTD 5min = 300s effective after 60s buffer
    ms.ordersExpireAt = Date.now() + 300_000;
    this.stateMgr.setMarketState(mkt.conditionId, ms);
  }

  private async refreshQuotes(mkt: MmMarket, ms: MarketState): Promise<void> {
    // Cancel old orders, place fresh ones
    await this.placeQuotes(mkt, ms);
  }

  // ---- Fill handling -------------------------------------------------------

  private async handleFill(order: TrackedOrder, fillSize: number): Promise<void> {
    // P28 #3: Deduplicate — both WS and REST can detect the same fill.
    const fillKey = `${order.orderId}:${order.filledSize}`;
    if (this.processedFillKeys.has(fillKey)) return;
    this.processedFillKeys.add(fillKey);
    if (this.processedFillKeys.size > 100) {
      const entries = [...this.processedFillKeys];
      this.processedFillKeys = new Set(entries.slice(-50));
    }

    const market = this.activeMarkets.find((m) => m.conditionId === order.conditionId);
    if (!market) {
      this.logger.warn(
        `P42: handleFill — market ${order.conditionId.slice(0, 16)}… not in activeMarkets, ignoring fill`,
      );
      return;
    }

    const ms = this.stateMgr.getMarketState(order.conditionId);
    if (!ms) {
      this.logger.warn(
        `P42: handleFill — no market state for ${order.conditionId.slice(0, 16)}…, ignoring fill`,
      );
      return;
    }

    // If already selling from a previous fill on this market, just accumulate
    if (ms.phase === "exiting" && ms.accidentalFill) {
      const outcome = market.tokens.find((t) => t.tokenId === order.tokenId)?.outcome ?? "?";
      this.stateMgr.updatePosition(
        order.tokenId,
        order.conditionId,
        outcome,
        fillSize,
        order.price,
        order.side,
      );
      if (order.tokenId === ms.accidentalFill.tokenId) {
        ms.accidentalFill.shares += fillSize;
      }
      this.stateMgr.setMarketState(ms.conditionId, ms);
      return;
    }

    this.logger.warn(
      `🚨 Fill: ${order.side} ${fillSize.toFixed(1)} @ ${order.price.toFixed(3)} ` +
        `(${market.question.slice(0, 30)}…) — 立即清仓`,
    );

    // 1. Cancel ALL orders for this market
    await this.orderMgr.cancelMarketOrders(market.conditionId);
    ms.activeOrderIds = [];

    // 2. Record position
    const outcome = market.tokens.find((t) => t.tokenId === order.tokenId)?.outcome ?? "?";
    this.stateMgr.updatePosition(
      order.tokenId,
      order.conditionId,
      outcome,
      fillSize,
      order.price,
      order.side,
    );

    // Record fill event
    this.stateMgr.recordFill({
      orderId: order.orderId,
      tokenId: order.tokenId,
      conditionId: order.conditionId,
      side: order.side,
      price: order.price,
      size: fillSize,
      timestamp: Date.now(),
    });

    // 3. Mark exiting (prevents re-quoting during sell)
    ms.phase = "exiting";
    ms.accidentalFill = {
      tokenId: order.tokenId,
      shares: fillSize,
      entryPrice: order.price,
      filledAt: Date.now(),
      stage: 3, // skip to FAK stage
    };
    this.stateMgr.setMarketState(ms.conditionId, ms);

    // 4. IMMEDIATE FAK sell — wait settlement then dump
    const sold = await this.immediateSell(order.tokenId, market, fillSize);

    // 5. Back to quoting regardless of sell result
    ms.accidentalFill = undefined;
    ms.phase = "cooldown";
    ms.cooldownUntil = Date.now() + this.config.cooldownMs;
    this.stateMgr.setMarketState(ms.conditionId, ms);

    if (sold) {
      this.logger.info(`✅ 清仓成功, 进入冷却`);
    } else {
      this.logger.error(`❌ 清仓失败, 需要 /mm sell 手动清理`);
    }
  }

  /**
   * Immediate FAK sell — wait for settlement (max 15s) then market-dump.
   * No price floor, no staging, no waiting. Just sell.
   */
  private async immediateSell(
    tokenId: string,
    market: MmMarket,
    expectedShares: number,
  ): Promise<boolean> {
    // Wait for tokens to settle to proxy wallet (max 15s)
    let shares = 0;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 2_000 : 3_000));
      shares = await this.client.getConditionalBalance(tokenId);
      if (shares >= expectedShares * 0.9) break;
    }

    if (shares <= 0) {
      this.logger.error(
        `Settlement failed: 0 shares after 15s (expected ${expectedShares.toFixed(1)})`,
      );
      return false;
    }

    // FAK sell at bestBid with 3 retries
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const book = await this.client.getOrderBook(tokenId);
        const bids = book.bids || [];
        const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;
        if (bestBid <= 0) {
          this.logger.warn(`No bids for ${tokenId.slice(0, 10)}…, retry ${attempt + 1}/3`);
          await new Promise((r) => setTimeout(r, 3_000));
          continue;
        }

        const sellResult = await this.client.createAndPostOrder(
          {
            tokenID: tokenId,
            price: Math.max(0.01, bestBid),
            size: shares,
            side: Side.SELL,
            feeRateBps: 0,
          },
          {
            tickSize: (book.tick_size || market.tickSize) as any,
            negRisk: book.neg_risk ?? market.negRisk,
          },
          OrderType.FAK,
          false,
        );

        if (sellResult?.success === false) {
          throw new Error(sellResult.errorMsg || "order rejected");
        }

        this.logger.info(
          `🔥 FAK SELL: ${shares.toFixed(1)} @ ${bestBid.toFixed(3)} (${tokenId.slice(0, 10)}…)`,
        );

        // Update position
        const pos = this.stateMgr.getPosition(tokenId);
        if (pos) {
          this.stateMgr.updatePosition(
            tokenId,
            market.conditionId,
            pos.outcome,
            shares,
            bestBid,
            "SELL",
          );
        }
        return true;
      } catch (err: any) {
        if (
          attempt < 2 &&
          (err.message?.includes("balance") || err.message?.includes("allowance"))
        ) {
          await new Promise((r) => setTimeout(r, 5_000));
          continue;
        }
        this.logger.error(`FAK sell failed: ${err.message}`);
        return false;
      }
    }
    return false;
  }

  // ---- Book refresh --------------------------------------------------------

  private async refreshBooks(): Promise<void> {
    const allTokens: { tokenId: string; market: MmMarket }[] = [];
    for (const market of this.activeMarkets) {
      for (const token of market.tokens) {
        allTokens.push({ tokenId: token.tokenId, market });
      }
    }
    if (allTokens.length === 0) return;

    // Batch fetch books
    const bookParams = allTokens.map((t) => ({ token_id: t.tokenId, side: Side.BUY }));
    let rawBooks: import("@polymarket/clob-client").OrderBookSummary[];
    try {
      rawBooks = await this.client.getOrderBooks(bookParams);
    } catch (err: any) {
      this.logger.warn(`Batch book fetch failed: ${err.message}`);
      return;
    }

    // Batch fetch midpoints
    let midpoints: any = {};
    try {
      midpoints = await this.client.getMidpoints(bookParams);
    } catch {}

    for (let i = 0; i < allTokens.length; i++) {
      const { tokenId, market } = allTokens[i];
      const rawBook = rawBooks[i];
      if (!rawBook) continue;

      const snapshot = this.quoteEngine.parseBook(rawBook);

      // Apply true midpoint
      let trueMid = 0;
      if (Array.isArray(midpoints)) {
        const entry = midpoints[i];
        trueMid = parseFloat(entry?.mid ?? entry ?? "0");
      } else if (midpoints[tokenId]) {
        trueMid = parseFloat(midpoints[tokenId]?.mid ?? midpoints[tokenId] ?? "0");
      }

      if (trueMid > 0 && trueMid < 1) {
        // Neg_risk book correction
        if (Math.abs(snapshot.midpoint - trueMid) > 0.3) {
          const oldBestBid = snapshot.bestBid;
          const oldBestAsk = snapshot.bestAsk;
          snapshot.bestBid = oldBestAsk > 0 ? 1 - oldBestAsk : 0;
          snapshot.bestAsk = oldBestBid > 0 ? 1 - oldBestBid : 1;
          snapshot.spread = snapshot.bestAsk - snapshot.bestBid;
        }
        snapshot.midpoint = trueMid;
      }

      this.books.set(tokenId, snapshot);
      this.priceMap.set(tokenId, snapshot.midpoint);
    }
  }

  // ---- Risk ----------------------------------------------------------------

  private checkSimpleRisk(): void {
    const st = this.stateMgr.get();
    const peak = st.peakBalance || this.cachedBalance;
    if (peak <= 0) return;

    const currentValue = this.cachedBalance + this.stateMgr.getPositionValue(this.priceMap);
    const drawdownPct = ((peak - currentValue) / peak) * 100;

    if (drawdownPct > this.config.maxDrawdownPercent) {
      // P39: Set running=false synchronously before async emergencyKill
      // to prevent tick loop from continuing during shutdown
      this.running = false;
      this.emergencyKill(
        `Drawdown ${drawdownPct.toFixed(1)}% > ${this.config.maxDrawdownPercent}%`,
      );
      return;
    }

    if (st.dailyPnl < -this.config.maxDailyLoss) {
      this.orderMgr.cancelAllOrders();
      this.stateMgr.update({ dayPaused: true });
      this.logger.warn(`日亏损 ${fmtUsd(st.dailyPnl)} > 限额 $${this.config.maxDailyLoss}, 暂停`);
    }
  }

  // ---- Market management ---------------------------------------------------

  private async rescanMarketsInternal(): Promise<number> {
    await this.scanner.scan();
    const pausedList = this.stateMgr.get().pausedMarkets;
    const newMarkets = this.scanner.selectActiveMarkets(pausedList);
    if (newMarkets.length > 0) {
      this.logger.info(
        `Selected after filter: ${newMarkets.map((m) => m.question.slice(0, 30)).join(", ")}`,
      );
    }

    // Cancel orders on removed markets
    const removedIds = this.activeMarkets
      .filter((m) => !newMarkets.find((n) => n.conditionId === m.conditionId))
      .map((m) => m.conditionId);

    for (const id of removedIds) {
      await this.orderMgr.cancelMarketOrders(id);
      this.stateMgr.removeMarketState(id);
    }

    this.activeMarkets = newMarkets;
    const newIds = newMarkets.map((m) => m.conditionId);
    const allTokenIds = newMarkets.flatMap((m) => m.tokens.map((t) => t.tokenId));

    // Initialize market states for new markets
    for (const mkt of newMarkets) {
      if (!this.stateMgr.getMarketState(mkt.conditionId)) {
        this.stateMgr.setMarketState(mkt.conditionId, {
          conditionId: mkt.conditionId,
          phase: "quoting",
          cooldownUntil: 0,
          activeOrderIds: [],
          ordersExpireAt: 0,
          consecutiveCooldowns: 0,
        });
      }
    }

    this.wsFeed?.updateMarkets(newIds, allTokenIds);
    this.stateMgr.update({ activeMarkets: newIds, lastScanAt: Date.now() });

    return this.scanner.getMarkets().length;
  }

  // ---- Liquidation ---------------------------------------------------------

  async liquidateAllPositions(): Promise<{ success: number; failed: number }> {
    const st = this.stateMgr.get();
    let success = 0;
    let failed = 0;

    for (const pos of Object.values(st.positions)) {
      if (pos.netShares <= 0) continue;
      const ok = await this.fillHandler.forceSell(pos.tokenId, pos.conditionId, pos.netShares);
      if (ok) success++;
      else failed++;
    }

    this.logger.info(`Liquidation: ${success} sold, ${failed} failed`);
    return { success, failed };
  }

  /**
   * /mm sell — unconditional market-price liquidation.
   * 1. Stop engine if running (cancel all orders)
   * 2. Collect ALL token IDs from state + active markets
   * 3. Check on-chain balance for each (catches orphan positions)
   * 4. FAK sell everything with balance > 0
   * Returns detailed results for TG display.
   */
  async sellAll(): Promise<{
    stopped: boolean;
    sold: Array<{ tokenId: string; shares: number; price: number; ok: boolean }>;
    errors: string[];
  }> {
    const result: Awaited<ReturnType<MmEngine["sellAll"]>> = {
      stopped: false,
      sold: [],
      errors: [],
    };

    // 1. Initialize client if needed
    if (!this.client.initialized) {
      try {
        await this.client.init();
      } catch (err: any) {
        result.errors.push(`Client init failed: ${err.message}`);
        return result;
      }
    }

    // 2. Stop engine if running
    if (this.running) {
      await this.stop("sellAll — unconditional liquidation");
      result.stopped = true;
    }

    // 3. Cancel ALL open orders (belt & suspenders)
    try {
      await this.client.cancelAll();
    } catch (err: any) {
      result.errors.push(`Cancel-all failed (non-fatal): ${err.message}`);
    }

    // 4. Collect all known token IDs
    const tokenSet = new Map<string, string>(); // tokenId → conditionId
    const st = this.stateMgr.get();

    // From state positions
    for (const pos of Object.values(st.positions)) {
      tokenSet.set(pos.tokenId, pos.conditionId);
    }
    // From active markets
    for (const mkt of this.activeMarkets) {
      for (const t of mkt.tokens) {
        tokenSet.set(t.tokenId, mkt.conditionId);
      }
    }
    // From scanner cached markets (broader coverage)
    for (const mkt of this.scanner.getMarkets()) {
      for (const t of mkt.tokens) {
        if (!tokenSet.has(t.tokenId)) {
          tokenSet.set(t.tokenId, mkt.conditionId);
        }
      }
    }

    if (tokenSet.size === 0) {
      this.logger.info("sellAll: no tokens to check");
      return result;
    }

    this.logger.info(`sellAll: checking ${tokenSet.size} tokens for on-chain balances...`);

    // 5. Check on-chain balance for each token, sell if > 0
    for (const [tokenId, conditionId] of tokenSet) {
      try {
        const shares = await this.client.getConditionalBalance(tokenId);
        if (shares <= 0.01) continue; // skip dust

        this.logger.info(`sellAll: found ${shares.toFixed(2)} shares on ${tokenId.slice(0, 12)}…`);

        // Get orderbook for best bid
        const book = await this.client.getOrderBook(tokenId);
        const bids = book.bids || [];
        const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;

        if (bestBid <= 0) {
          result.sold.push({ tokenId, shares, price: 0, ok: false });
          result.errors.push(`No bids for ${tokenId.slice(0, 12)}…`);
          continue;
        }

        const sellPrice = Math.max(0.01, bestBid);
        const tickSize = (book.tick_size || "0.01") as import("@polymarket/clob-client").TickSize;
        const negRisk = book.neg_risk || false;

        // FAK sell with 3 retries (settlement delay)
        let sold = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const sellResult = await this.client.createAndPostOrder(
              {
                tokenID: tokenId,
                price: sellPrice,
                size: shares,
                side: Side.SELL,
                feeRateBps: 0,
              },
              { tickSize, negRisk },
              OrderType.FAK,
              false,
            );
            if (sellResult?.success === false) {
              throw new Error(sellResult.errorMsg || "order rejected");
            }
            sold = true;
            break;
          } catch (sellErr: any) {
            if (
              attempt < 2 &&
              (sellErr.message?.includes("balance") || sellErr.message?.includes("allowance"))
            ) {
              await new Promise((r) => setTimeout(r, 5_000));
              continue;
            }
            result.errors.push(`Sell ${tokenId.slice(0, 12)}…: ${sellErr.message}`);
            break;
          }
        }

        result.sold.push({ tokenId, shares, price: sellPrice, ok: sold });

        // Update state if sold
        if (sold) {
          const pos = this.stateMgr.getPosition(tokenId);
          if (pos) {
            this.stateMgr.updatePosition(
              tokenId,
              conditionId,
              pos.outcome,
              shares,
              sellPrice,
              "SELL",
            );
          }
        }
      } catch (err: any) {
        result.errors.push(`Check ${tokenId.slice(0, 12)}…: ${err.message}`);
      }
    }

    // 6. Refresh balance
    try {
      this.cachedBalance = await this.client.getBalance();
      this.adjustSizingToBalance(this.cachedBalance);
    } catch {}

    this.stateMgr.forceSave();
    const soldCount = result.sold.filter((s) => s.ok).length;
    const failedCount = result.sold.filter((s) => !s.ok).length;
    this.logger.info(
      `sellAll complete: ${soldCount} sold, ${failedCount} failed, ` +
        `${result.errors.length} errors, balance=$${this.cachedBalance.toFixed(2)}`,
    );

    return result;
  }

  private async sellOrphanPositions(activeConditionIds: string[]): Promise<void> {
    const activeSet = new Set(activeConditionIds);
    const st = this.stateMgr.get();

    for (const pos of Object.values(st.positions)) {
      if (pos.netShares <= 0 || activeSet.has(pos.conditionId)) continue;

      this.logger.warn(
        `Orphan: ${pos.outcome} ${pos.netShares.toFixed(1)} shares (${pos.conditionId.slice(0, 10)}), selling`,
      );
      await this.fillHandler.forceSell(pos.tokenId, pos.conditionId, pos.netShares);
    }
  }

  // ---- Redeem ---------------------------------------------------------------

  async redeemPosition(conditionId: string): Promise<string> {
    if (!this.client.initialized) await this.client.init();

    const positions = Object.values(this.stateMgr.get().positions).filter(
      (p) => p.conditionId === conditionId && p.netShares > 0,
    );
    if (positions.length === 0) {
      throw new Error(`No positions for ${conditionId.slice(0, 16)}...`);
    }

    const totalShares = positions.reduce((s, p) => s + p.netShares, 0);
    this.logger.info(
      `Redeeming ${totalShares.toFixed(2)} shares for ${conditionId.slice(0, 16)}...`,
    );

    const balanceBefore = await this.client.getBalance();
    const txHash = await this.client.redeemPositions(conditionId, [1, 2]);

    this.cachedBalance = await this.client.getBalance();
    const actualProceeds = Math.max(0, this.cachedBalance - balanceBefore);
    const effectivePrice = totalShares > 0 ? actualProceeds / totalShares : 0;

    this.logger.info(
      `Redemption: $${actualProceeds.toFixed(2)} (price=${effectivePrice.toFixed(4)})`,
    );

    for (const pos of positions) {
      this.stateMgr.updatePosition(
        pos.tokenId,
        pos.conditionId,
        pos.outcome,
        pos.netShares,
        effectivePrice,
        "SELL",
      );
    }

    this.adjustSizingToBalance(this.cachedBalance);
    this.stateMgr.forceSave();
    return txHash;
  }

  // ---- Public API ----------------------------------------------------------

  getStatus(): {
    running: boolean;
    balance: number;
    positionValue: number;
    unrealizedPnl: number;
    liveOrders: number;
    scoringOrders: number;
    config: MmConfig;
    state: import("./types.js").MmState;
    marketPhases: Record<string, string>;
  } {
    const st = this.stateMgr.get();
    const scoring = this.rewards.getCurrentScoringStats();

    const marketPhases: Record<string, string> = {};
    for (const mkt of this.activeMarkets) {
      const ms = this.stateMgr.getMarketState(mkt.conditionId);
      marketPhases[mkt.conditionId] = ms?.phase ?? "unknown";
    }

    return {
      running: this.running,
      balance: this.cachedBalance,
      positionValue: this.stateMgr.getPositionValue(this.priceMap),
      unrealizedPnl: this.stateMgr.getUnrealizedPnl(this.priceMap),
      liveOrders: this.orderMgr.getLiveOrderCount(),
      scoringOrders: scoring.scoring,
      config: this.config,
      state: st,
      marketPhases,
    };
  }

  getActiveMarkets(): MmMarket[] {
    return this.activeMarkets;
  }

  getConfig(): MmConfig {
    return { ...this.config };
  }

  updateConfig(key: string, value: string): void {
    if (!(key in this.config)) throw new Error(`Unknown config key: ${key}`);
    const num = parseFloat(value);
    if (isNaN(num)) throw new Error(`Invalid value: ${value}`);
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
      let netValue = 0;
      let unrealizedPnl = 0;
      let realizedPnl = 0;
      for (const token of market.tokens) {
        const pos = this.stateMgr.getPosition(token.tokenId);
        if (!pos) continue;
        const price = this.priceMap.get(token.tokenId) ?? pos.avgEntry;
        netValue += pos.netShares * price;
        unrealizedPnl += pos.netShares * (price - pos.avgEntry);
        realizedPnl += pos.realizedPnl;
      }
      result.set(market.conditionId, { netValue, unrealizedPnl, realizedPnl });
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
    if (!this.client.initialized) throw new Error("Client not initialized");
    return this.rescanMarketsInternal();
  }

  async getOnChainBalance(tokenId: string): Promise<number> {
    if (!this.client.initialized) await this.client.init();
    return this.client.getOnChainBalance(tokenId);
  }
}
