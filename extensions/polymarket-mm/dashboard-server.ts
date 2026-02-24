// ---------------------------------------------------------------------------
// Lightweight HTTP dashboard server for MM status visualization
// Serves static dashboard page + JSON API for real-time data
// ---------------------------------------------------------------------------

import { readFile } from "fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { PluginLogger } from "../../src/plugins/types.js";
import type { MmEngine } from "./engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class DashboardServer {
  private server: ReturnType<typeof createServer> | null = null;
  private engine: MmEngine | null = null;
  private cachedHtml: string | null = null; // cleared on restart; edit dashboard/index.html and restart to update

  constructor(
    private port: number,
    private password: string,
    private logger: PluginLogger,
  ) {}

  setEngine(engine: MmEngine): void {
    this.engine = engine;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.listen(this.port, "127.0.0.1", () => {
      this.logger.info(`Dashboard server listening on 127.0.0.1:${this.port}`);
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://localhost:${this.port}`);
    const path = url.pathname;

    // CORS headers for same-origin
    res.setHeader("X-Content-Type-Options", "nosniff");

    // Auth check for API endpoints
    if (path.startsWith("/api/")) {
      const key = url.searchParams.get("key") || (req.headers["x-api-key"] as string);
      if (key !== this.password) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

    try {
      if (path === "/" || path === "/index.html") {
        await this.serveDashboard(res);
      } else if (path === "/api/status") {
        this.serveStatus(res);
      } else if (path === "/api/orders") {
        this.serveOrders(res);
      } else if (path === "/api/markets") {
        this.serveMarkets(res);
      } else if (path === "/api/rewards") {
        this.serveRewards(res);
      } else if (path === "/api/auth") {
        this.serveAuth(url, res);
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    } catch (err: any) {
      this.logger.warn(`Dashboard request error: ${err.message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  }

  private serveAuth(url: URL, res: ServerResponse): void {
    const key = url.searchParams.get("key");
    const ok = key === this.password;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok }));
  }

  private async serveDashboard(res: ServerResponse): Promise<void> {
    if (!this.cachedHtml) {
      this.cachedHtml = await readFile(join(__dirname, "dashboard", "index.html"), "utf-8");
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(this.cachedHtml);
  }

  private serveStatus(res: ServerResponse): void {
    if (!this.engine) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ running: false, message: "Engine not initialized" }));
      return;
    }

    const status = this.engine.getStatus();
    const st = status.state;

    const data = {
      running: status.running,
      balance: status.balance,
      positionValue: status.positionValue,
      portfolio: status.balance + status.positionValue,
      unrealizedPnl: status.unrealizedPnl,
      dailyPnl: st.dailyPnl,
      totalPnl: st.totalPnl,
      liveOrders: status.liveOrders,
      scoringOrders: status.scoringOrders,
      activeMarkets: st.activeMarkets.length,
      maxMarkets: status.config.maxConcurrentMarkets,
      capital: st.capital,
      totalRewards: (st.rewardHistory || []).reduce(
        (sum: number, h: { actual?: number }) => sum + (h.actual || 0),
        0,
      ),
      killSwitch: st.killSwitchTriggered,
      dayPaused: st.dayPaused,
      startedAt: st.startedAt,
      lastRefresh: st.lastRefreshAt,
      errorCount: st.errorCount,
      timestamp: Date.now(),
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private serveOrders(res: ServerResponse): void {
    if (!this.engine) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ orders: [] }));
      return;
    }

    const status = this.engine.getStatus();
    const orders = Object.values(status.state.trackedOrders)
      .filter((o) => o.status === "live")
      .map((o) => ({
        side: o.side,
        price: o.price,
        size: o.originalSize,
        filled: o.filledSize,
        scoring: o.scoring,
        token: o.tokenId.slice(0, 8),
        conditionId: o.conditionId.slice(0, 12),
        level: o.level,
      }))
      .sort((a, b) => b.price - a.price);

    const recentFills = this.engine.getRecentFills(10).map((o) => ({
      side: o.side,
      price: o.price,
      size: o.filledSize,
      token: o.tokenId.slice(0, 8),
      time: o.placedAt,
    }));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ orders, recentFills }));
  }

  private serveRewards(res: ServerResponse): void {
    if (!this.engine) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ scoring: { scoring: 0, total: 0 }, markets: [], totalEstDaily: 0 }));
      return;
    }

    const data = this.engine.getRewardData();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private serveMarkets(res: ServerResponse): void {
    if (!this.engine) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ markets: [] }));
      return;
    }

    const markets = this.engine.getActiveMarkets().map((m) => ({
      question: m.question,
      conditionId: m.conditionId.slice(0, 12),
      rewardRate: m.rewardsDailyRate,
      score: m.score,
      tokens: m.tokens.map((t) => ({
        outcome: t.outcome,
        price: t.price,
        tokenId: t.tokenId.slice(0, 8),
      })),
    }));

    const positions = Object.entries(this.engine.getStatus().state.positions).map(
      ([tokenId, pos]) => ({
        outcome: pos.outcome,
        shares: pos.netShares,
        avgEntry: pos.avgEntry,
        realizedPnl: pos.realizedPnl,
        tokenId: tokenId.slice(0, 8),
      }),
    );

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ markets, positions }));
  }
}
