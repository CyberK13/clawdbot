// ---------------------------------------------------------------------------
// Inventory Manager: Position tracking, skew calculation, exposure limits
// ---------------------------------------------------------------------------

import type { PluginLogger } from "../../src/plugins/types.js";
import type { PolymarketClient } from "./client.js";
import type { StateManager } from "./state.js";
import type { MmConfig, MmMarket, Position, BookSnapshot } from "./types.js";

export class InventoryManager {
  private logger: PluginLogger;

  constructor(
    private client: PolymarketClient,
    private state: StateManager,
    private config: MmConfig,
    logger: PluginLogger,
  ) {
    this.logger = logger;
  }

  /**
   * Calculate inventory skew for quote adjustment.
   *
   * skew = skewFactor × (net_position_value / maxInventoryPerMarket)
   *
   * Positive skew when long → widen bid, tighten ask (encourage selling)
   * Negative skew when short → tighten bid, widen ask (encourage buying)
   *
   * @returns skew in price units (e.g. 0.01 = 1 cent)
   */
  calculateSkew(market: MmMarket, midpoint: number): number {
    // Sum position value across both tokens in this market
    let netValue = 0;
    for (const token of market.tokens) {
      const pos = this.state.getPosition(token.tokenId);
      if (pos && pos.netShares !== 0) {
        netValue += pos.netShares * midpoint;
      }
    }

    // Normalize by max inventory and apply skew factor
    const ratio = netValue / this.config.maxInventoryPerMarket;
    const clampedRatio = Math.max(-1, Math.min(1, ratio));
    return this.config.skewFactor * clampedRatio * this.config.defaultSpread;
  }

  /**
   * Check if we should reduce quoting on a specific side due to inventory limits.
   * Returns the side to CANCEL orders on, or null if within limits.
   */
  checkInventoryLimit(market: MmMarket, priceMap: Map<string, number>): "BUY" | "SELL" | null {
    const exposure = this.state.getMarketExposure(market.conditionId, priceMap);
    if (exposure > this.config.maxInventoryPerMarket) {
      // Determine which side is over-extended
      const netPosition = this.getNetMarketPosition(market);
      if (netPosition > 0) return "BUY"; // too long, cancel bids
      if (netPosition < 0) return "SELL"; // too short, cancel asks
    }
    return null;
  }

  /** Get net position in shares for a market (positive = net long). */
  getNetMarketPosition(market: MmMarket): number {
    let net = 0;
    for (const token of market.tokens) {
      const pos = this.state.getPosition(token.tokenId);
      if (pos) net += pos.netShares;
    }
    return net;
  }

  /** Get position info for display. */
  getPositionSummary(
    market: MmMarket,
    priceMap: Map<string, number>,
  ): { netValue: number; unrealizedPnl: number; realizedPnl: number } {
    let netValue = 0;
    let unrealizedPnl = 0;
    let realizedPnl = 0;

    for (const token of market.tokens) {
      const pos = this.state.getPosition(token.tokenId);
      if (!pos) continue;
      const price = priceMap.get(token.tokenId) ?? pos.avgEntry;
      netValue += pos.netShares * price;
      if (pos.netShares !== 0) {
        unrealizedPnl += pos.netShares * (price - pos.avgEntry);
      }
      realizedPnl += pos.realizedPnl;
    }

    return { netValue, unrealizedPnl, realizedPnl };
  }

  /** Check if total exposure across all markets exceeds limit. */
  isTotalExposureExceeded(priceMap: Map<string, number>): boolean {
    return this.state.getTotalExposure(priceMap) > this.config.maxTotalExposure;
  }

  /**
   * Calculate order size reduction factor when approaching exposure limits.
   * Returns 1.0 = full size, 0.5 = half size, 0 = no orders.
   */
  getExposureReductionFactor(priceMap: Map<string, number>): number {
    const exposure = this.state.getTotalExposure(priceMap);
    const limit = this.config.maxTotalExposure;
    if (exposure <= limit * 0.8) return 1.0; // < 80% of limit → full size
    if (exposure >= limit) return 0.5; // at limit → half size (floor to avoid deadlock)
    // Linear reduction between 80% and 100%, minimum 0.5
    return Math.max(0.5, (limit - exposure) / (limit * 0.2));
  }

  /** Reconcile tracked orders with exchange state on startup/recovery. */
  async reconcile(): Promise<void> {
    this.logger.info("Reconciling positions with exchange...");
    try {
      const openOrders = await this.client.getOpenOrders();
      const trackedOrders = this.state.getTrackedOrders();

      // Remove tracked orders that are no longer on exchange
      for (const tracked of trackedOrders) {
        const onExchange = openOrders.find((o) => o.id === tracked.orderId);
        if (!onExchange) {
          // Order was filled or cancelled externally
          this.state.removeOrder(tracked.orderId);
        }
      }

      const openCount = openOrders.length;
      const trackedCount = this.state.getTrackedOrders().length;
      this.logger.info(
        `Reconciliation done: ${openCount} orders on exchange, ${trackedCount} tracked`,
      );
    } catch (err: any) {
      this.logger.warn(`Reconciliation failed: ${err.message}`);
    }
  }

  /**
   * Reconcile tracked positions against on-chain balances.
   * Corrects significant discrepancies (>1% or >0.5 shares),
   * trusting on-chain as source of truth while preserving cost basis.
   */
  async reconcilePositions(activeMarkets: MmMarket[]): Promise<void> {
    const st = this.state.get();
    let corrected = 0;

    for (const market of activeMarkets) {
      for (const token of market.tokens) {
        const pos = st.positions[token.tokenId];
        if (!pos) continue;

        // Skip zero positions
        if (pos.netShares === 0) continue;

        // Get on-chain balance via CLOB API (NegRisk compatible)
        const onChainBalance = await this.client.getConditionalBalance(token.tokenId);
        if (onChainBalance < 0) continue; // API failure, skip

        // Account for shares locked in open sell orders
        const openSellShares = this.state
          .getMarketOrders(market.conditionId)
          .filter((o) => o.tokenId === token.tokenId && o.side === "SELL" && o.status === "live")
          .reduce((sum, o) => sum + (o.originalSize - o.filledSize), 0);

        const expectedOnChain = Math.max(0, pos.netShares - openSellShares);
        const discrepancy = Math.abs(onChainBalance - expectedOnChain);

        // Only correct significant discrepancies (>1% or >0.5 shares)
        const pctDiscrepancy = expectedOnChain > 0 ? discrepancy / expectedOnChain : 0;
        if (discrepancy <= 0.5 && pctDiscrepancy <= 0.01) continue;

        const actualShares = onChainBalance + openSellShares;
        this.logger.warn(
          `Position reconciliation: ${token.outcome} tracked=${pos.netShares.toFixed(1)} ` +
            `on-chain=${onChainBalance.toFixed(1)} openSells=${openSellShares.toFixed(1)} → ` +
            `corrected to ${actualShares.toFixed(1)}`,
        );

        // Trust on-chain, preserve avgEntry cost basis
        pos.netShares = actualShares;
        corrected++;
      }
    }

    if (corrected > 0) {
      this.state.update({}); // mark dirty
      this.logger.info(`Position reconciliation: corrected ${corrected} positions`);
    }
  }
}
