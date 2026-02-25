// ---------------------------------------------------------------------------
// CyberOracle V3 API — Core response types
// ---------------------------------------------------------------------------

/** Standard API envelope */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T;
  timestamp?: string;
  message?: string;
}

/** /chat response */
export interface ChatResponse {
  response: string;
  model_used: string;
  timestamp: string;
}

/** Action names recognised by the dispatch layer */
export type CyberOracleAction =
  // System (3)
  | "health"
  | "scheduler_status"
  | "trigger_job"
  // A-Share (10)
  | "ashare_signals"
  | "ashare_hotspots"
  | "ashare_events"
  | "ashare_champions"
  | "ashare_dragon_tiger"
  | "ashare_hotmoney"
  | "ashare_northbound"
  | "ashare_ths_hot"
  | "ashare_industry_heatmap"
  | "ashare_hsgt_flow"
  // US Market (8)
  | "us_signals"
  | "us_smartmoney"
  | "us_etf_flows"
  | "us_hot_tickers"
  | "us_small_caps"
  | "us_munger_champions"
  | "us_sky_high_fools"
  | "us_analyze_sky_high"
  // Global & News (8)
  | "indices"
  | "breaking_news"
  | "polymarket_hot"
  | "global_events"
  | "global_calendar"
  | "global_leaders"
  | "global_upcoming"
  | "global_disasters"
  // AI Analysis (6)
  | "berkshire_analyze"
  | "berkshire_reports"
  | "hotspot_analyze"
  | "quick_analyze"
  | "analyze_event"
  | "batch_analyze"
  // Trading (16)
  | "trading_status"
  | "trading_accounts"
  | "trading_balance"
  | "trading_positions"
  | "trading_orders"
  | "place_order"
  | "modify_order"
  | "cancel_order"
  | "cancel_all_orders"
  | "trading_deals"
  | "trading_history"
  | "quotes"
  | "kline"
  | "trading_environment"
  | "switch_environment"
  | "unlock_trading"
  // Search & DB (3)
  | "search_stocks"
  | "db_tables"
  | "db_query"
  // Knowledge Graph (3)
  | "kg_sectors"
  | "kg_sector_detail"
  | "kg_sector_nodes"
  // Opportunities (7)
  | "opportunities_analyze"
  | "opportunities_quick"
  | "opportunities_single"
  | "opportunity_categories"
  | "opportunities_by_category"
  | "opportunity_stats"
  | "opportunity_config"
  // Analysis Pipeline (2)
  | "analysis_opportunities"
  | "analysis_stats"
  // Stock Data (6)
  | "stock_lookup"
  | "stock_fundamentals"
  | "stock_daily"
  | "stock_batch"
  | "us_fundamentals"
  | "us_daily"
  // Hotlist (2)
  | "hotlist_realtime"
  | "hotlist_processed"
  // Backtesting (4)
  | "backtest_snapshots"
  | "backtest_results"
  | "backtest_accuracy"
  | "backtest_overview"
  // Incidents (3)
  | "incidents"
  | "incident_detail"
  | "active_incidents"
  // AI Results (2)
  | "ai_results"
  | "ai_event_analysis"
  // Social (2)
  | "social_tweets"
  | "social_summary"
  // Hot Money Extended (3)
  | "hotmoney_traders"
  | "hotmoney_by_trader"
  | "hotmoney_by_stock"
  // Data Coverage (1)
  | "data_coverage"
  // AI Chat (1)
  | "chat";
