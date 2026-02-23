// ---------------------------------------------------------------------------
// Polymarket Market-Maker Plugin
//
// Registers:
//   - Service: background MM engine with start/stop lifecycle
//   - Command: /mm for Telegram control
//   - Tool: polymarket_mm for AI agent queries
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
  AnyAgentTool,
} from "../../src/plugins/types.js";
import { formatConfig, resolveConfig } from "./config.js";
import { MmEngine } from "./engine.js";
import { createMmCommandHandler } from "./telegram-commands.js";
import type { MmConfig } from "./types.js";

let engine: MmEngine | null = null;

export default function register(api: OpenClawPluginApi) {
  // ---------- Service: background MM engine --------------------------------
  api.registerService({
    id: "polymarket-mm",
    start: async (ctx) => {
      const cfg = api.pluginConfig as Partial<MmConfig> | undefined;

      // Resolve env credentials
      const privateKey =
        process.env.POLYMARKET_Wallet_Private_Key || process.env.POLYMARKET_PRIVATE_KEY;
      const apiKey = process.env.POLYMARKET_API_KEY;
      const apiSecret = process.env.POLYMARKET_API_SECRET;
      const passphrase = process.env.POLYMARKET_PASSPHRASE;
      const funder = process.env.POLYMARKET_FUNDER;

      if (!privateKey || !apiKey || !apiSecret || !passphrase || !funder) {
        api.logger.info(
          "Polymarket MM: missing env credentials, service registered but not auto-started. " +
            "Set POLYMARKET_Wallet_Private_Key, POLYMARKET_API_KEY, POLYMARKET_API_SECRET, " +
            "POLYMARKET_PASSPHRASE, POLYMARKET_FUNDER to enable.",
        );
        // Still create engine so /mm commands can show helpful errors
        return;
      }

      engine = new MmEngine(
        {
          privateKey,
          apiKey,
          apiSecret,
          passphrase,
          funder,
          logger: ctx.logger,
        },
        ctx.stateDir,
        cfg,
        ctx.logger,
      );

      // Start dashboard (always on, even before MM trading starts)
      engine.startDashboard();

      // Auto-start if configured
      const autoStart = (cfg as any)?.autoStart === true || process.env.MM_AUTO_START === "true";
      if (autoStart) {
        ctx.logger.info("Polymarket MM auto-starting...");
        await engine.start();
      } else {
        ctx.logger.info("Polymarket MM engine initialized (use /mm start to begin)");
      }
    },
    stop: async () => {
      if (engine?.isRunning()) {
        await engine.stop("Service shutdown");
      }
      engine?.stopDashboard();
      engine = null;
    },
  });

  // ---------- Command: /mm -------------------------------------------------
  api.registerCommand({
    name: "mm",
    description: "Polymarket 做市机器人控制",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      if (!engine) {
        // Lazy init if env vars are available
        const privateKey =
          process.env.POLYMARKET_Wallet_Private_Key || process.env.POLYMARKET_PRIVATE_KEY;
        const apiKey = process.env.POLYMARKET_API_KEY;
        const apiSecret = process.env.POLYMARKET_API_SECRET;
        const passphrase = process.env.POLYMARKET_PASSPHRASE;
        const funder = process.env.POLYMARKET_FUNDER;

        if (!privateKey || !apiKey || !apiSecret || !passphrase || !funder) {
          return {
            text:
              "❌ Polymarket 环境变量未配置\n" +
              "需要: POLYMARKET_Wallet_Private_Key, POLYMARKET_API_KEY, " +
              "POLYMARKET_API_SECRET, POLYMARKET_PASSPHRASE, POLYMARKET_FUNDER",
          };
        }

        engine = new MmEngine(
          {
            privateKey,
            apiKey,
            apiSecret,
            passphrase,
            funder,
            logger: api.logger,
          },
          process.env.OPENCLAW_STATE_DIR || "~/.openclaw",
          api.pluginConfig as Partial<MmConfig> | undefined,
          api.logger,
        );
      }

      const handler = createMmCommandHandler(engine);
      return handler(ctx);
    },
  });

  // ---------- Command: /mail — on-demand email digest -----------------------
  api.registerCommand({
    name: "mail",
    description: "读取所有未读邮件并生成 AI 摘要",
    acceptsArgs: false,
    requireAuth: true,
    handler: async (ctx) => {
      const scriptPath = "/opt/clawdbot/gmail-digest-all.py";
      const chatId = ctx.senderId || "6309937609";

      // Spawn script in background — it sends results to TG directly
      const proc = spawn("python3", [scriptPath], {
        stdio: "ignore",
        detached: true,
        env: { ...process.env, CHAT_ID: chatId },
      });
      proc.unref();

      api.logger.info(`/mail triggered by ${ctx.senderId}, spawned gmail-digest-all.py`);
      return { text: "📬 正在读取未读邮件并生成摘要，请稍候..." };
    },
  });

  // ---------- Tool: polymarket_mm (for AI agent) ----------------------------
  api.registerTool(
    ((ctx) => {
      if (ctx.sandboxed) return null;
      return {
        name: "polymarket_mm",
        description:
          "Query the Polymarket market-making bot status, positions, rewards, and configuration. " +
          "Can also start/stop the bot or adjust parameters.",
        parameters: {
          type: "object" as const,
          properties: {
            action: {
              type: "string" as const,
              enum: ["status", "markets", "rewards", "config", "start", "stop", "trades"],
              description: "Action to perform",
            },
            params: {
              type: "object" as const,
              description: "Optional parameters (e.g., config key/value)",
              additionalProperties: true,
            },
          },
          required: ["action"],
        },
        execute: async (input: { action: string; params?: Record<string, any> }) => {
          if (!engine) {
            return "MM engine not initialized. Configure POLYMARKET env variables first.";
          }
          switch (input.action) {
            case "status":
              return JSON.stringify(engine.getStatus(), null, 2);
            case "markets":
              return JSON.stringify(
                engine.getActiveMarkets().map((m) => ({
                  question: m.question,
                  conditionId: m.conditionId,
                  rewardRate: m.rewardsDailyRate,
                  score: m.score,
                })),
                null,
                2,
              );
            case "rewards":
              return await engine.getRewardStatus();
            case "config":
              return JSON.stringify(engine.getConfig(), null, 2);
            case "start":
              await engine.start();
              return "MM engine started";
            case "stop":
              await engine.stop("Agent requested stop");
              return "MM engine stopped";
            case "trades":
              return JSON.stringify(engine.getRecentFills(10), null, 2);
            default:
              return `Unknown action: ${input.action}`;
          }
        },
      } as unknown as AnyAgentTool;
    }) as OpenClawPluginToolFactory,
    { name: "polymarket_mm", optional: true },
  );
}
