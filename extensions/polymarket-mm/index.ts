// ---------------------------------------------------------------------------
// Polymarket Market-Maker Plugin — v5 Cancel-Before-Fill
//
// Registers:
//   - Service: background MM engine with start/stop lifecycle
//   - Command: /mm for Telegram control
//   - Tool: polymarket_mm for AI agent queries
// ---------------------------------------------------------------------------

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

      const privateKey =
        process.env.POLYMARKET_Wallet_Private_Key || process.env.POLYMARKET_PRIVATE_KEY;
      const apiKey = process.env.POLYMARKET_API_KEY;
      const apiSecret = process.env.POLYMARKET_API_SECRET;
      const passphrase = process.env.POLYMARKET_PASSPHRASE;
      const funder = process.env.POLYMARKET_FUNDER;

      if (!privateKey || !apiKey || !apiSecret || !passphrase || !funder) {
        api.logger.info(
          "Polymarket MM: missing env credentials, service registered but not auto-started.",
        );
        return;
      }

      engine = new MmEngine(
        { privateKey, apiKey, apiSecret, passphrase, funder, logger: ctx.logger },
        ctx.stateDir,
        cfg,
        ctx.logger,
      );

      engine.startDashboard();

      const autoStart = (cfg as any)?.autoStart === true || process.env.MM_AUTO_START === "true";
      if (autoStart) {
        ctx.logger.info("Polymarket MM v5 auto-starting...");
        await engine.start();
      } else {
        ctx.logger.info("Polymarket MM v5 engine initialized (use /mm start)");
      }
    },
    stop: async () => {
      if (engine?.isRunning()) await engine.stop("Service shutdown");
      engine?.stopDashboard();
      engine = null;
    },
  });

  // ---------- Command: /mm -------------------------------------------------
  api.registerCommand({
    name: "mm",
    description: "Polymarket MM v5 控制",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      if (engine?.isKilled()) {
        engine.stopDashboard();
        engine = null;
      }

      if (!engine) {
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
          { privateKey, apiKey, apiSecret, passphrase, funder, logger: api.logger },
          process.env.OPENCLAW_STATE_DIR || "~/.openclaw",
          api.pluginConfig as Partial<MmConfig> | undefined,
          api.logger,
        );
      }

      const handler = createMmCommandHandler(engine);
      return handler(ctx);
    },
  });

  // ---------- Tool: polymarket_mm ------------------------------------------
  api.registerTool(
    ((ctx) => {
      if (ctx.sandboxed) return null;
      return {
        name: "polymarket_mm",
        description:
          "Query the Polymarket market-making bot (v5 cancel-before-fill). " +
          "Status, positions, rewards, configuration. Start/stop control.",
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
              description: "Optional parameters",
              additionalProperties: true,
            },
          },
          required: ["action"],
        },
        execute: async (input: { action: string; params?: Record<string, any> }) => {
          if (!engine) return "MM engine not initialized.";
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
              return "MM v5 started";
            case "stop":
              await engine.stop("Agent stop");
              return "MM stopped";
            case "trades":
              return JSON.stringify(engine.getRecentFills(10), null, 2);
            default:
              return `Unknown: ${input.action}`;
          }
        },
      } as unknown as AnyAgentTool;
    }) as OpenClawPluginToolFactory,
    { name: "polymarket_mm", optional: true },
  );
}
