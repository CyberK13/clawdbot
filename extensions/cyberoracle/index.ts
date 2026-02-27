// ---------------------------------------------------------------------------
// CyberOracle V3 Plugin
//
// Registers:
//   - Tool: cyberoracle — agent can call any of 90 API actions via natural language
//   - Command: /cy — fast natural language passthrough to CyberOracle AI Chat
// ---------------------------------------------------------------------------

import type {
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
  AnyAgentTool,
} from "../../src/plugins/types.js";
import { CyberOracleClient } from "./client.js";
import type { CyberOracleAction } from "./types.js";

const BASE_URL = "https://tradfinance.cyberoracle.net/api/v2";

const ALL_ACTIONS: CyberOracleAction[] = [
  // System
  "health",
  "scheduler_status",
  "trigger_job",
  // A-Share
  "ashare_signals",
  "ashare_hotspots",
  "ashare_events",
  "ashare_champions",
  "ashare_dragon_tiger",
  "ashare_hotmoney",
  "ashare_northbound",
  "ashare_ths_hot",
  "ashare_industry_heatmap",
  "ashare_hsgt_flow",
  // US Market
  "us_signals",
  "us_smartmoney",
  "us_etf_flows",
  "us_hot_tickers",
  "us_small_caps",
  "us_munger_champions",
  "us_sky_high_fools",
  "us_analyze_sky_high",
  // Global & News
  "indices",
  "breaking_news",
  "polymarket_hot",
  "global_events",
  "global_calendar",
  "global_leaders",
  "global_upcoming",
  "global_disasters",
  // AI Analysis
  "berkshire_analyze",
  "berkshire_reports",
  "hotspot_analyze",
  "quick_analyze",
  "analyze_event",
  "batch_analyze",
  // Trading
  "trading_status",
  "trading_accounts",
  "trading_balance",
  "trading_positions",
  "trading_orders",
  "place_order",
  "modify_order",
  "cancel_order",
  "cancel_all_orders",
  "trading_deals",
  "trading_history",
  "quotes",
  "kline",
  "trading_environment",
  "switch_environment",
  "unlock_trading",
  // Search & DB
  "search_stocks",
  "db_tables",
  "db_query",
  // Knowledge Graph
  "kg_sectors",
  "kg_sector_detail",
  "kg_sector_nodes",
  // Opportunities
  "opportunities_analyze",
  "opportunities_quick",
  "opportunities_single",
  "opportunity_categories",
  "opportunities_by_category",
  "opportunity_stats",
  "opportunity_config",
  // Analysis Pipeline
  "analysis_opportunities",
  "analysis_stats",
  // Stock Data
  "stock_lookup",
  "stock_fundamentals",
  "stock_daily",
  "stock_batch",
  "us_fundamentals",
  "us_daily",
  // Hotlist
  "hotlist_realtime",
  "hotlist_processed",
  // Backtesting
  "backtest_snapshots",
  "backtest_results",
  "backtest_accuracy",
  "backtest_overview",
  // Incidents
  "incidents",
  "incident_detail",
  "active_incidents",
  // AI Results
  "ai_results",
  "ai_event_analysis",
  // Social
  "social_tweets",
  "social_summary",
  // Hot Money Extended
  "hotmoney_traders",
  "hotmoney_by_trader",
  "hotmoney_by_stock",
  // Daily Recap
  "daily_recap_latest",
  "daily_recap",
  "daily_recap_generate",
  // Misc
  "data_coverage",
  "chat",
];

// ---------------------------------------------------------------------------
// Dispatch: action name → client method
// ---------------------------------------------------------------------------

async function dispatch(
  client: CyberOracleClient,
  action: CyberOracleAction,
  params: Record<string, any> = {},
): Promise<unknown> {
  switch (action) {
    // --- System ---
    case "health":
      return client.getHealth();
    case "scheduler_status":
      return client.getSchedulerStatus();
    case "trigger_job":
      return client.triggerJob(params.job_id);

    // --- A-Share ---
    case "ashare_signals":
      return client.getAShareSignals();
    case "ashare_hotspots":
      return client.getAShareHotspots(params);
    case "ashare_events":
      return client.getAShareEvents(params);
    case "ashare_champions":
      return client.getAShareChampions(params);
    case "ashare_dragon_tiger":
      return client.getAShareDragonTiger(params);
    case "ashare_hotmoney":
      return client.getAShareHotMoney(params);
    case "ashare_northbound":
      return client.getAShareNorthbound(params);
    case "ashare_ths_hot":
      return client.getAShareThsHot(params);
    case "ashare_industry_heatmap":
      return client.getAShareIndustryHeatmap();
    case "ashare_hsgt_flow":
      return client.getAShareHsgtFlow();

    // --- US Market ---
    case "us_signals":
      return client.getUSSignals();
    case "us_smartmoney":
      return client.getUSSmartMoney();
    case "us_etf_flows":
      return client.getUSEtfFlows();
    case "us_hot_tickers":
      return client.getUSHotTickers();
    case "us_small_caps":
      return client.getUSSmallCaps(params);
    case "us_munger_champions":
      return client.getUSMungerChampions(params);
    case "us_sky_high_fools":
      return client.getUSSkyHighFools(params);
    case "us_analyze_sky_high":
      return client.analyzeSkyHighFool(params.symbol);

    // --- Global & News ---
    case "indices":
      return client.getMarketIndices();
    case "breaking_news":
      return client.getBreakingNews(params);
    case "polymarket_hot":
      return client.getPolymarketHot(params);
    case "global_events":
      return client.getGlobalEvents(params);
    case "global_calendar":
      return client.getGlobalCalendar(params);
    case "global_leaders":
      return client.getGlobalLeaders(params);
    case "global_upcoming":
      return client.getGlobalUpcoming(params);
    case "global_disasters":
      return client.getGlobalDisasters(params);

    // --- AI Analysis ---
    case "berkshire_analyze":
      return client.analyzeBerkshire(params.stock_code, params.market);
    case "berkshire_reports":
      return client.getBerkshireReports(params);
    case "hotspot_analyze":
      return client.analyzeHotspot(params.title, params.category, params.keywords);
    case "quick_analyze":
      return client.quickAnalyze(params);
    case "analyze_event":
      return client.analyzeEvent(params.event ?? params);
    case "batch_analyze":
      return client.batchAnalyze(params.events);

    // --- Trading ---
    case "trading_status":
      return client.getTradingStatus();
    case "trading_accounts":
      return client.getTradingAccounts();
    case "trading_balance":
      return client.getTradingBalance();
    case "trading_positions":
      return client.getTradingPositions();
    case "trading_orders":
      return client.getTradingOrders();
    case "place_order":
      return client.placeOrder(params);
    case "modify_order":
      return client.modifyOrder(params.order_id, params);
    case "cancel_order":
      return client.cancelOrder(params.order_id);
    case "cancel_all_orders":
      return client.cancelAllOrders();
    case "trading_deals":
      return client.getTradingDeals();
    case "trading_history":
      return client.getTradingHistory(params.type ?? "orders");
    case "quotes":
      return client.getQuotes(
        Array.isArray(params.codes) ? params.codes : (params.codes ?? "").split(","),
      );
    case "kline":
      return client.getKline(params.code, params);
    case "trading_environment":
      return client.getTradingEnvironment();
    case "switch_environment":
      return client.switchEnvironment(params.environment);
    case "unlock_trading":
      return client.unlockTrading();

    // --- Search & DB ---
    case "search_stocks":
      return client.searchStocks(params.q, params);
    case "db_tables":
      return client.getDbTables();
    case "db_query":
      return client.dbQuery(params.sql);

    // --- Knowledge Graph ---
    case "kg_sectors":
      return client.getKGSectors();
    case "kg_sector_detail":
      return client.getKGSector(params.sector_id, params);
    case "kg_sector_nodes":
      return client.getKGNodes(params.sector_id, params);

    // --- Opportunities ---
    case "opportunities_analyze":
      return client.analyzeOpportunities(params);
    case "opportunities_quick":
      return client.quickOpportunities(params);
    case "opportunities_single":
      return client.analyzeSingleOpportunity(params.title, params.platform);
    case "opportunity_categories":
      return client.getOpportunityCategories();
    case "opportunities_by_category":
      return client.getOpportunitiesByCategory(params.code, params);
    case "opportunity_stats":
      return client.getOpportunityStats();
    case "opportunity_config":
      return client.getOpportunityConfig();

    // --- Analysis Pipeline ---
    case "analysis_opportunities":
      return client.getAnalysisOpportunities(params);
    case "analysis_stats":
      return client.getAnalysisStats();

    // --- Stock Data ---
    case "stock_lookup":
      return client.lookupStock(params.symbol, params);
    case "stock_fundamentals":
      return client.getStockFundamentals(params.ts_code);
    case "stock_daily":
      return client.getStockDaily(params.ts_code, params);
    case "stock_batch":
      return client.batchStockData(params.ts_codes);
    case "us_fundamentals":
      return client.getUSFundamentals(params.symbol);
    case "us_daily":
      return client.getUSDaily(params.symbol, params);

    // --- Hotlist ---
    case "hotlist_realtime":
      return client.getHotlistRealtime(params);
    case "hotlist_processed":
      return client.getHotlistProcessed(params);

    // --- Backtesting ---
    case "backtest_snapshots":
      return client.getBacktestSnapshots(params);
    case "backtest_results":
      return client.getBacktestResults(params.snapshot_id);
    case "backtest_accuracy":
      return client.getBacktestAccuracy(params);
    case "backtest_overview":
      return client.getBacktestOverview();

    // --- Incidents ---
    case "incidents":
      return client.getIncidents(params);
    case "incident_detail":
      return client.getIncident(params.id);
    case "active_incidents":
      return client.getActiveIncidents();

    // --- AI Results ---
    case "ai_results":
      return client.getAiResults(params);
    case "ai_event_analysis":
      return client.getAiEventAnalysis(params.event_id);

    // --- Social ---
    case "social_tweets":
      return client.getSocialTweets(params);
    case "social_summary":
      return client.getSocialSummary();

    // --- Hot Money Extended ---
    case "hotmoney_traders":
      return client.getHotMoneyTraders();
    case "hotmoney_by_trader":
      return client.getHotMoneyByTrader(params.name, params);
    case "hotmoney_by_stock":
      return client.getHotMoneyByStock(params.ts_code, params);

    // --- Daily Recap ---
    case "daily_recap_latest":
      return client.getDailyRecapLatest();
    case "daily_recap":
      return client.getDailyRecap(params);
    case "daily_recap_generate":
      return client.generateDailyRecap();

    // --- Misc ---
    case "data_coverage":
      return client.getDataCoverage();
    case "chat":
      return client.chat(params.message, params);

    default:
      throw new Error(`Unknown CyberOracle action: ${action}`);
  }
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export default function register(api: OpenClawPluginApi) {
  const apiKey = process.env.CYBERORACLE_API_KEY;
  if (!apiKey) {
    api.logger.info(
      "CyberOracle: CYBERORACLE_API_KEY not set — plugin registered but non-functional. " +
        "Set the env var to enable.",
    );
  }

  const client = new CyberOracleClient(BASE_URL, apiKey ?? "");

  // ---------- Tool: cyberoracle (agent natural-language calls) ---------------

  const toolFactory: OpenClawPluginToolFactory = (_ctx) => {
    if (!apiKey) return null;
    return {
      name: "cyberoracle",
      description:
        `CyberOracle V3 — 全球市场情报和交易系统。可查询:\n` +
        `- A股: 智能信号(ashare_signals)、热点事件(ashare_hotspots)、龙虎榜(ashare_dragon_tiger)、` +
        `游资(ashare_hotmoney)、北向资金(ashare_northbound)、同花顺热股(ashare_ths_hot)、` +
        `行业热力图(ashare_industry_heatmap)、陆股通资金流(ashare_hsgt_flow)、` +
        `芒格选股(ashare_champions)、热点事件列表(ashare_events)\n` +
        `- 美股: 智能信号(us_signals)、聪明钱(us_smartmoney)、ETF流向(us_etf_flows)、` +
        `热门标的(us_hot_tickers)、小盘股(us_small_caps)、芒格选股(us_munger_champions)、` +
        `高估值预警(us_sky_high_fools)、个股高估分析(us_analyze_sky_high)\n` +
        `- 全球: 实时指数(indices)、突发新闻(breaking_news)、Polymarket热门(polymarket_hot)、` +
        `事件日历(global_events/global_calendar)、领导人(global_leaders)、` +
        `即将发生事件(global_upcoming)、灾害预警(global_disasters)\n` +
        `- AI分析: 伯克希尔5部门深度分析(berkshire_analyze)、热点分析(hotspot_analyze)、` +
        `快速分析(quick_analyze)、事件深度分析(analyze_event)、批量分析(batch_analyze)\n` +
        `- 产业链知识图谱: 11个行业/地缘板块(kg_sectors/kg_sector_detail/kg_sector_nodes)\n` +
        `- 交易: 账户状态/持仓/余额/下单/撤单/行情/K线(trading_*,place_order,quotes,kline)\n` +
        `- 投资机会: 分析/快速/单事件/分类(opportunities_*)\n` +
        `- 股票数据: 查找/基本面/日线/批量/美股基本面/美股日线(stock_*,us_fundamentals,us_daily)\n` +
        `- 热榜: 12平台实时(hotlist_realtime)、标准化(hotlist_processed)\n` +
        `- 回测: 快照/结果/准确率/概览(backtest_*)\n` +
        `- 事件: 列表/详情/活跃(incidents/incident_detail/active_incidents)\n` +
        `- 社交: KOL推文/摘要(social_tweets/social_summary)\n` +
        `- 游资扩展: 游资列表/按游资/按股票(hotmoney_traders/hotmoney_by_trader/hotmoney_by_stock)\n` +
        `- 搜索/数据库: search_stocks, db_tables, db_query\n` +
        `- AI Chat: 自然语言问答(chat)\n` +
        `- 每日复盘: 最新(daily_recap_latest)、历史(daily_recap)、生成(daily_recap_generate)\n` +
        `- 数据覆盖: data_coverage`,
      parameters: {
        type: "object" as const,
        properties: {
          action: {
            type: "string" as const,
            enum: ALL_ACTIONS,
            description:
              "要执行的API操作。例: ashare_hotspots(A股热点)、indices(全球指数)、" +
              "us_fundamentals(美股基本面)、berkshire_analyze(深度分析)、place_order(下单)、" +
              "kg_sector_detail(产业链详情)、db_query(SQL查询)、chat(AI问答)",
          },
          params: {
            type: "object" as const,
            description:
              "操作参数。常用参数:\n" +
              "- symbol/stock_code/ts_code: 股票代码 (如 AAPL, 002259.SZ)\n" +
              "- market: 市场 (CN/US)\n" +
              "- limit: 返回数量\n" +
              "- days: 天数\n" +
              "- sector_id: 产业链ID (ai_industry, aerospace, storage_chips 等)\n" +
              "- code: 交易代码 (如 US.AAPL)\n" +
              "- qty/side/price/order_type: 下单参数\n" +
              "- sql: SQL查询语句 (仅SELECT)\n" +
              "- message: AI Chat消息\n" +
              "- codes: 报价代码列表 (逗号分隔或数组)\n" +
              "- job_id: 调度任务ID\n" +
              "- order_id: 订单ID\n" +
              "- snapshot_id: 回测快照ID\n" +
              "- event_id: 事件ID\n" +
              "- name: 游资名称\n" +
              "- q: 搜索关键字\n" +
              "- type: trading_history的类型 (orders/deals)\n" +
              "- environment: 交易环境 (SIMULATE/REAL)",
            additionalProperties: true,
          },
        },
        required: ["action"] as const,
      },
      execute: async (input: { action: CyberOracleAction; params?: Record<string, any> }) => {
        try {
          const result = await dispatch(client, input.action, input.params ?? {});
          return JSON.stringify(result, null, 2);
        } catch (err: any) {
          return JSON.stringify({ error: err.message ?? String(err) });
        }
      },
    } as unknown as AnyAgentTool;
  };

  api.registerTool(toolFactory, { name: "cyberoracle", optional: true });

  // ---------- Command: /cy (fast AI Chat passthrough) -----------------------

  api.registerCommand({
    name: "cy",
    description: "CyberOracle AI 快速查询 (自然语言直通)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      if (!apiKey) {
        return { text: "CyberOracle 未配置。请设置 CYBERORACLE_API_KEY 环境变量。" };
      }

      const query = ctx.args?.trim();
      if (!query) {
        return {
          text:
            "用法: /cy <你的问题>\n\n" +
            "例:\n" +
            "  /cy 分析一下AAPL最近走势\n" +
            "  /cy 今天A股有什么热点\n" +
            "  /cy 宁德时代基本面怎么样\n" +
            "  /cy 帮我查看当前持仓\n" +
            "  /cy AI产业链有哪些被低估的标的",
        };
      }

      try {
        const result = await client.chat(query);
        return { text: result.response };
      } catch (err: any) {
        return { text: `CyberOracle 查询失败: ${err.message ?? err}` };
      }
    },
  });

  // ---------- Command: /fb (A股每日复盘) ------------------------------------

  api.registerCommand({
    name: "fb",
    description: "A股每日复盘报告 (CyberOracle)",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      if (!apiKey) {
        return { text: "CyberOracle 未配置。请设置 CYBERORACLE_API_KEY 环境变量。" };
      }

      const arg = ctx.args?.trim() ?? "";

      // --- 无参数 / latest → 最新复盘 ---
      if (!arg || arg === "latest" || arg === "最新") {
        try {
          const res = await client.getDailyRecapLatest();
          return { text: formatRecap(res.data) };
        } catch (err: any) {
          return { text: `获取最新复盘失败: ${err.message ?? err}` };
        }
      }

      // --- 生成 / generate → 手动触发 ---
      if (arg === "生成" || arg === "generate") {
        try {
          const res = await client.generateDailyRecap();
          return { text: `复盘报告生成已触发。\n${JSON.stringify(res.data, null, 2)}` };
        } catch (err: any) {
          return { text: `触发复盘生成失败: ${err.message ?? err}` };
        }
      }

      // --- 历史 [N|日期] ---
      if (arg.startsWith("历史") || arg.startsWith("history")) {
        const rest = arg.replace(/^(历史|history)\s*/, "").trim();
        const params: Record<string, string | number> = {};
        if (/^\d{4}-\d{2}-\d{2}$/.test(rest)) {
          params.date = rest;
        } else if (/^\d+$/.test(rest)) {
          params.days = Number(rest);
        } else if (rest) {
          params.date = rest;
        }
        try {
          const res = await client.getDailyRecap(params as any);
          return { text: formatRecap(res.data) };
        } catch (err: any) {
          return { text: `获取历史复盘失败: ${err.message ?? err}` };
        }
      }

      // --- 其他自然语言 → /chat 直通 ---
      try {
        const result = await client.chat(`A股复盘相关: ${arg}`);
        return { text: result.response };
      } catch (err: any) {
        return { text: `CyberOracle 查询失败: ${err.message ?? err}` };
      }
    },
  });

  api.logger.info("CyberOracle V3 plugin registered (tool: cyberoracle, commands: /cy, /fb)");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRecap(data: any): string {
  if (!data) return "暂无复盘数据。";

  // If it's an array (history), format each entry
  if (Array.isArray(data)) {
    if (data.length === 0) return "暂无复盘数据。";
    return data.map((item: any) => formatSingleRecap(item)).join("\n\n---\n\n");
  }

  return formatSingleRecap(data);
}

function formatSingleRecap(item: any): string {
  if (typeof item === "string") return item;
  // If the API returns a structured object with a content/report field, use it
  const text = item.content ?? item.report ?? item.summary ?? item.text ?? item.response;
  if (typeof text === "string") {
    const header = item.date ? `📊 ${item.date} A股复盘\n\n` : "";
    return header + text;
  }
  // Fallback: pretty-print JSON
  return JSON.stringify(item, null, 2);
}
