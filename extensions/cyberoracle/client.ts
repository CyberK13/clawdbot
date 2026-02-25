// ---------------------------------------------------------------------------
// CyberOracle V3 HTTP Client — typed methods for all 90 endpoints
// ---------------------------------------------------------------------------

import type { ApiResponse, ChatResponse } from "./types.js";

type Params = Record<string, string | number | boolean | undefined>;

export class CyberOracleClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  // ---- internal helpers ---------------------------------------------------

  private async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts?: { params?: Params; body?: unknown },
  ): Promise<ApiResponse<T>> {
    const url = new URL(path, this.baseUrl);
    if (opts?.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (opts?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url.toString(), init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`CyberOracle ${method} ${path} → ${res.status}: ${text}`);
    }
    return (await res.json()) as ApiResponse<T>;
  }

  private get<T = unknown>(path: string, params?: Params) {
    return this.request<T>("GET", path, { params });
  }

  private post<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("POST", path, { body });
  }

  private put<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("PUT", path, { body });
  }

  private del<T = unknown>(path: string) {
    return this.request<T>("DELETE", path);
  }

  // =========================================================================
  // System (3)
  // =========================================================================

  getHealth() {
    return this.get("/health");
  }

  getSchedulerStatus() {
    return this.get("/scheduler/status");
  }

  triggerJob(jobId: string) {
    return this.post(`/scheduler/trigger/${encodeURIComponent(jobId)}`);
  }

  // =========================================================================
  // A-Share (10)
  // =========================================================================

  getAShareSignals() {
    return this.get("/market/a-share/signals");
  }

  getAShareHotspots(p?: {
    limit?: number;
    platform?: string;
    category?: string;
    min_relevance?: number;
  }) {
    return this.get("/market/a-share/hotspots", p as Params);
  }

  getAShareEvents(p?: {
    platform?: string;
    category?: string;
    min_heat?: number;
    limit?: number;
    offset?: number;
  }) {
    return this.get("/market/a-share/events", p as Params);
  }

  getAShareChampions(p?: {
    min_score?: number;
    risk_rating?: string;
    limit?: number;
    sort_by?: string;
  }) {
    return this.get("/market/a-share/champions", p as Params);
  }

  getAShareDragonTiger(p?: {
    trade_date?: string;
    ts_code?: string;
    days?: number;
    limit?: number;
  }) {
    return this.get("/market/a-share/dragon-tiger", p as Params);
  }

  getAShareHotMoney(p?: { hm_name?: string; ts_code?: string; days?: number; limit?: number }) {
    return this.get("/market/a-share/hotmoney", p as Params);
  }

  getAShareNorthbound(p?: { limit?: number }) {
    return this.get("/market/a-share/northbound", p as Params);
  }

  getAShareThsHot(p?: { limit?: number }) {
    return this.get("/market/a-share/ths-hot", p as Params);
  }

  getAShareIndustryHeatmap() {
    return this.get("/market/a-share/industry-heatmap");
  }

  getAShareHsgtFlow() {
    return this.get("/market/a-share/hsgt-flow");
  }

  // =========================================================================
  // US Market (8)
  // =========================================================================

  getUSSignals() {
    return this.get("/market/us/signals");
  }

  getUSSmartMoney() {
    return this.get("/market/us/smartmoney");
  }

  getUSEtfFlows() {
    return this.get("/market/us/etf-flows");
  }

  getUSHotTickers() {
    return this.get("/market/us/hot-tickers");
  }

  getUSSmallCaps(p?: { min_cap?: number; max_cap?: number; min_volume_ratio?: number }) {
    return this.get("/market/us/small-caps", p as Params);
  }

  getUSMungerChampions(p?: { min_score?: number; limit?: number }) {
    return this.get("/market/us/munger-champions", p as Params);
  }

  getUSSkyHighFools(p?: { limit?: number; sort?: string; date?: string }) {
    return this.get("/market/us/sky-high-fools", p as Params);
  }

  analyzeSkyHighFool(symbol: string) {
    return this.post("/market/us/sky-high-fools/analyze", { symbol });
  }

  // =========================================================================
  // Global & News (8)
  // =========================================================================

  getMarketIndices() {
    return this.get("/market/indices");
  }

  getBreakingNews(p?: { refresh?: boolean }) {
    return this.get("/news/breaking", p as Params);
  }

  getPolymarketHot(p?: { limit?: number }) {
    return this.get("/polymarket/hot", p as Params);
  }

  getGlobalEvents(p?: {
    start_date?: string;
    end_date?: string;
    event_type?: string;
    importance?: number;
    limit?: number;
  }) {
    return this.get("/global/events", p as Params);
  }

  getGlobalCalendar(p?: {
    year?: number;
    month?: number;
    event_type?: string;
    leader_id?: number;
  }) {
    return this.get("/global/calendar", p as Params);
  }

  getGlobalLeaders(p?: { category?: string; country?: string; active_only?: boolean }) {
    return this.get("/global/leaders", p as Params);
  }

  getGlobalUpcoming(p?: {
    days?: number;
    event_type?: string;
    importance?: number;
    limit?: number;
  }) {
    return this.get("/global/upcoming", p as Params);
  }

  getGlobalDisasters(p?: { days?: number; min_severity?: string }) {
    return this.get("/global/disasters", p as Params);
  }

  // =========================================================================
  // AI Analysis (6)
  // =========================================================================

  analyzeBerkshire(stockCode: string, market: "CN" | "US") {
    return this.post("/analysis/berkshire", { stock_code: stockCode, market });
  }

  getBerkshireReports(p?: { limit?: number }) {
    return this.get("/analysis/berkshire/reports", p as Params);
  }

  analyzeHotspot(title: string, category: string, keywords?: string[]) {
    return this.post("/analysis/hotspot", { title, category, keywords });
  }

  quickAnalyze(event: Record<string, unknown>) {
    return this.post("/analysis/quick-analyze", event);
  }

  analyzeEvent(event: Record<string, unknown>) {
    return this.post("/analysis/analyze-event", { event });
  }

  batchAnalyze(events: Record<string, unknown>[]) {
    return this.post("/analysis/batch", { events });
  }

  // =========================================================================
  // Trading (16)
  // =========================================================================

  getTradingStatus() {
    return this.get("/trading/status");
  }

  getTradingAccounts() {
    return this.get("/trading/accounts");
  }

  getTradingBalance() {
    return this.get("/trading/balance");
  }

  getTradingPositions() {
    return this.get("/trading/positions");
  }

  getTradingOrders() {
    return this.get("/trading/orders");
  }

  placeOrder(order: Record<string, unknown>) {
    return this.post("/trading/orders", order);
  }

  modifyOrder(orderId: string, changes: Record<string, unknown>) {
    return this.put(`/trading/orders/${encodeURIComponent(orderId)}`, changes);
  }

  cancelOrder(orderId: string) {
    return this.del(`/trading/orders/${encodeURIComponent(orderId)}`);
  }

  cancelAllOrders() {
    return this.post("/trading/orders/cancel-all");
  }

  getTradingDeals() {
    return this.get("/trading/deals");
  }

  getTradingHistory(type: "orders" | "deals") {
    return this.get(`/trading/history/${type}`);
  }

  getQuotes(codes: string[]) {
    return this.get("/trading/quotes", { codes: codes.join(",") });
  }

  getKline(code: string, p?: { ktype?: string; count?: number }) {
    return this.get("/trading/kline", { code, ...p });
  }

  getTradingEnvironment() {
    return this.get("/trading/environment");
  }

  switchEnvironment(env: "SIMULATE" | "REAL") {
    return this.post("/trading/environment", { environment: env });
  }

  unlockTrading() {
    return this.post("/trading/unlock");
  }

  // =========================================================================
  // Search & DB (3)
  // =========================================================================

  searchStocks(q: string, p?: { market?: string; limit?: number }) {
    return this.get("/search/stocks", { q, ...p });
  }

  getDbTables() {
    return this.get("/db/tables");
  }

  dbQuery(sql: string) {
    return this.post("/db/query", { sql });
  }

  // =========================================================================
  // Knowledge Graph (3)
  // =========================================================================

  getKGSectors() {
    return this.get("/knowledge-graph/sectors");
  }

  getKGSector(sectorId: string, p?: { format?: string }) {
    return this.get(`/knowledge-graph/sectors/${encodeURIComponent(sectorId)}`, p as Params);
  }

  getKGNodes(sectorId: string, p?: { market?: string; layer?: number; cat?: string }) {
    return this.get(`/knowledge-graph/sectors/${encodeURIComponent(sectorId)}/nodes`, p as Params);
  }

  // =========================================================================
  // Opportunities (7)
  // =========================================================================

  analyzeOpportunities(body?: Record<string, unknown>) {
    return this.post("/opportunities/analyze", body);
  }

  quickOpportunities(p?: { category?: string; top_n?: number }) {
    return this.get("/opportunities/analyze/quick", p as Params);
  }

  analyzeSingleOpportunity(title: string, platform?: string) {
    return this.post("/opportunities/analyze/single", { title, platform });
  }

  getOpportunityCategories() {
    return this.get("/opportunities/categories");
  }

  getOpportunitiesByCategory(code: string, p?: { top_n?: number; min_confidence?: number }) {
    return this.get(`/opportunities/by-category/${encodeURIComponent(code)}`, p as Params);
  }

  getOpportunityStats() {
    return this.get("/opportunities/statistics");
  }

  getOpportunityConfig() {
    return this.get("/opportunities/config");
  }

  // =========================================================================
  // Analysis Pipeline (2)
  // =========================================================================

  getAnalysisOpportunities(p?: {
    min_score?: number;
    max_risk?: string;
    recommendation?: string;
    limit?: number;
    sort?: string;
  }) {
    return this.get("/analysis/opportunities", p as Params);
  }

  getAnalysisStats() {
    return this.get("/analysis/stats");
  }

  // =========================================================================
  // Stock Data (6)
  // =========================================================================

  lookupStock(symbol: string, p?: { market?: string }) {
    return this.get(`/stock/lookup/${encodeURIComponent(symbol)}`, p as Params);
  }

  getStockFundamentals(tsCode: string) {
    return this.get(`/stock/${encodeURIComponent(tsCode)}/fundamentals`);
  }

  getStockDaily(tsCode: string, p?: { days?: number; start_date?: string; end_date?: string }) {
    return this.get(`/stock/${encodeURIComponent(tsCode)}/daily`, p as Params);
  }

  batchStockData(tsCodes: string[]) {
    return this.post("/stock/batch", { ts_codes: tsCodes });
  }

  getUSFundamentals(symbol: string) {
    return this.get(`/stock/us/${encodeURIComponent(symbol)}/fundamentals`);
  }

  getUSDaily(symbol: string, p?: { period?: string; interval?: string }) {
    return this.get(`/stock/us/${encodeURIComponent(symbol)}/daily`, p as Params);
  }

  // =========================================================================
  // Hotlist (2)
  // =========================================================================

  getHotlistRealtime(p?: { platforms?: string; category?: string; limit?: number }) {
    return this.get("/hotlist/realtime", p as Params);
  }

  getHotlistProcessed(p?: {
    platforms?: string;
    category?: string;
    min_priority?: number;
    limit?: number;
  }) {
    return this.get("/hotlist/processed", p as Params);
  }

  // =========================================================================
  // Backtesting (4)
  // =========================================================================

  getBacktestSnapshots(p?: {
    stock_code?: string;
    min_score?: number;
    limit?: number;
    offset?: number;
  }) {
    return this.get("/backtesting/snapshots", p as Params);
  }

  getBacktestResults(snapshotId: number) {
    return this.get(`/backtesting/results/${snapshotId}`);
  }

  getBacktestAccuracy(p?: { period_type?: string }) {
    return this.get("/backtesting/accuracy", p as Params);
  }

  getBacktestOverview() {
    return this.get("/backtesting/overview");
  }

  // =========================================================================
  // Incidents (3)
  // =========================================================================

  getIncidents(p?: { category?: string; status?: string; search?: string; limit?: number }) {
    return this.get("/incidents", p as Params);
  }

  getIncident(id: number) {
    return this.get(`/incidents/${id}`);
  }

  getActiveIncidents() {
    return this.get("/incidents/active");
  }

  // =========================================================================
  // AI Results (2)
  // =========================================================================

  getAiResults(p?: { limit?: number; min_confidence?: number; category?: string }) {
    return this.get("/ai-analysis/results", p as Params);
  }

  getAiEventAnalysis(eventId: string) {
    return this.get(`/ai-analysis/event/${encodeURIComponent(eventId)}`);
  }

  // =========================================================================
  // Social (2)
  // =========================================================================

  getSocialTweets(p?: { limit?: number; category?: string; username?: string }) {
    return this.get("/social/tweets", p as Params);
  }

  getSocialSummary() {
    return this.get("/social/summary");
  }

  // =========================================================================
  // Hot Money Extended (3)
  // =========================================================================

  getHotMoneyTraders() {
    return this.get("/market/a-share/hotmoney/traders");
  }

  getHotMoneyByTrader(name: string, p?: { days?: number; limit?: number }) {
    return this.get(`/market/a-share/hotmoney/by-trader/${encodeURIComponent(name)}`, p as Params);
  }

  getHotMoneyByStock(tsCode: string, p?: { days?: number; limit?: number }) {
    return this.get(`/market/a-share/hotmoney/by-stock/${encodeURIComponent(tsCode)}`, p as Params);
  }

  // =========================================================================
  // Data Coverage (1)
  // =========================================================================

  getDataCoverage() {
    return this.get("/data/coverage");
  }

  // =========================================================================
  // AI Chat (1)
  // =========================================================================

  async chat(
    message: string,
    opts?: { model?: string; context?: unknown[] },
  ): Promise<ChatResponse> {
    const res = await this.post<ChatResponse>("/chat", {
      message,
      model: opts?.model,
      context: opts?.context,
    });
    return res.data;
  }
}
