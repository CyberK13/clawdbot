// ---------------------------------------------------------------------------
// Gmail AI Assistant Plugin — OpenClaw Extension
//
// Registers:
//   - Service: token store init + scheduled digest
//   - Commands: /bindmail, /unbindmail, /mail
//   - Tool: gmail_assistant for LLM natural language invocation
//   - HTTP route: OAuth callback
// ---------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
  AnyAgentTool,
} from "../../src/plugins/types.js";
import * as db from "./db.js";
import {
  setLogger,
  getOAuthUrl,
  handleOAuthCallbackFlow,
  runDigestForUser,
  unbindUser,
  startScheduler,
  stopScheduler,
  notifyUser,
} from "./gmail-service.js";

function isConfigured(): boolean {
  return !!(
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET &&
    process.env.GMAIL_REDIRECT_URI &&
    process.env.GMAIL_ENCRYPTION_KEY
  );
}

export default function register(api: OpenClawPluginApi) {
  // ---------- Service: background lifecycle --------------------------------
  api.registerService({
    id: "gmail-assistant",
    start: async (ctx) => {
      setLogger(ctx.logger);

      if (!isConfigured()) {
        ctx.logger.info("Gmail Assistant: missing env vars, skipping initialization.");
        return;
      }

      try {
        await db.init(ctx.stateDir);
        ctx.logger.info("Gmail Assistant: token store initialized");
      } catch (err: any) {
        ctx.logger.error(`Gmail Assistant init failed: ${err?.message}`);
        return;
      }

      // Start scheduled digest (every 2h)
      const enabled = process.env.GMAIL_ENABLED !== "false";
      if (enabled) {
        startScheduler();
      }
    },
    stop: async () => {
      stopScheduler();
      await db.close();
    },
  });

  // ---------- Command: /bindmail -------------------------------------------
  api.registerCommand({
    name: "bindmail",
    description: "绑定 Gmail 账号（OAuth 授权）",
    acceptsArgs: false,
    requireAuth: true,
    handler: async (ctx) => {
      if (!isConfigured()) {
        return { text: "❌ Gmail Assistant 未配置。需要设置环境变量。" };
      }
      const tgUserId = ctx.senderId;
      if (!tgUserId) return { text: "❌ 无法获取用户 ID" };

      const url = getOAuthUrl(tgUserId);
      return {
        text: `🔗 请点击以下链接授权 Gmail 访问：\n\n${url}\n\n授权完成后会收到确认通知。`,
      };
    },
  });

  // ---------- Command: /unbindmail -----------------------------------------
  api.registerCommand({
    name: "unbindmail",
    description: "解除 Gmail 绑定",
    acceptsArgs: false,
    requireAuth: true,
    handler: async (ctx) => {
      if (!isConfigured()) return { text: "❌ Gmail Assistant 未配置" };
      const tgUserId = ctx.senderId;
      if (!tgUserId) return { text: "❌ 无法获取用户 ID" };
      const result = await unbindUser(tgUserId);
      return { text: result };
    },
  });

  // ---------- Command: /mail -----------------------------------------------
  api.registerCommand({
    name: "mail",
    description: "读取未读邮件并生成 AI 摘要",
    acceptsArgs: false,
    requireAuth: true,
    handler: async (ctx) => {
      if (!isConfigured()) {
        return { text: "❌ Gmail Assistant 未配置" };
      }
      const tgUserId = ctx.senderId;
      if (!tgUserId) return { text: "❌ 无法获取用户 ID" };

      // Check if user has a binding
      const row = await db.getToken(tgUserId);
      if (!row) {
        return { text: "❌ 未绑定 Gmail。请先使用 /bindmail 绑定。" };
      }

      // Run async — send immediate ack, then push result via TG
      void (async () => {
        try {
          const summary = await runDigestForUser(tgUserId);
          await notifyUser(tgUserId, summary);
        } catch (err: any) {
          api.logger.error(`/mail failed for ${tgUserId}: ${err?.message}`);
          await notifyUser(tgUserId, `❌ 邮件摘要失败: ${err?.message}`);
        }
      })();

      return { text: "📬 正在读取邮件..." };
    },
  });

  // ---------- Tool: gmail_assistant (LLM natural language) ------------------
  api.registerTool(
    ((ctx) => {
      if (ctx.sandboxed) return null;
      return {
        name: "gmail_assistant",
        description:
          "Read and summarize the user's unread Gmail emails. " +
          "Use this when the user asks about their email, inbox, unread messages, " +
          "or wants an email digest/summary. " +
          "Supports: reading unread emails with AI summary, checking binding status. " +
          "The user must have linked their Gmail via /bindmail first.",
        parameters: {
          type: "object" as const,
          properties: {
            action: {
              type: "string" as const,
              enum: ["digest", "status"],
              description:
                "digest: fetch unread emails and return AI summary. " +
                "status: check if the user has bound their Gmail account.",
            },
          },
          required: ["action"],
        },
        execute: async (input: { action: string }) => {
          if (!isConfigured()) return "Gmail Assistant is not configured on this server.";

          // Resolve the sender — tool context carries agentAccountId or sessionKey
          const senderId = ctx.agentAccountId?.replace(/^telegram:/, "") ?? ctx.sessionKey;
          if (!senderId) return "Cannot identify the requesting user.";

          // Extract TG user ID from various formats
          const tgUserId = senderId.replace(/\D/g, "") || senderId;

          switch (input.action) {
            case "status": {
              const token = await db.getToken(tgUserId);
              if (token) {
                return `Gmail is bound to ${token.gmail_email}. Use /mail or ask me to read your emails.`;
              }
              return "Gmail is not bound. The user needs to run /bindmail to link their Gmail account first.";
            }
            case "digest": {
              const token = await db.getToken(tgUserId);
              if (!token) {
                return "Gmail is not bound. Tell the user to run /bindmail to link their Gmail account first.";
              }
              const result = await runDigestForUser(tgUserId);
              return result;
            }
            default:
              return `Unknown action: ${input.action}. Use "digest" or "status".`;
          }
        },
      } as unknown as AnyAgentTool;
    }) as OpenClawPluginToolFactory,
    { name: "gmail_assistant", optional: true },
  );

  // ---------- HTTP Route: OAuth callback -----------------------------------
  api.registerHttpRoute({
    path: "/api/oauth/gmail/callback",
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<h2>❌ 授权失败</h2><p>${error}</p>`);
          return;
        }

        if (!code || !state) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h2>❌ 缺少授权参数</h2>");
          return;
        }

        const { tgUserId, email } = await handleOAuthCallbackFlow(code, state);

        // Notify user via Telegram
        await notifyUser(
          tgUserId,
          `✅ Gmail 绑定成功: ${email}\n\n现在可以使用 /mail 获取邮件摘要了。`,
        );

        // Show success page
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Gmail 绑定成功</title></head>` +
            `<body style="font-family:sans-serif;text-align:center;padding:50px">` +
            `<h2>✅ Gmail 绑定成功</h2>` +
            `<p>账号: <strong>${email}</strong></p>` +
            `<p>你可以关闭此页面，回到 Telegram 使用 /mail 命令。</p>` +
            `</body></html>`,
        );
      } catch (err: any) {
        api.logger.error(`OAuth callback error: ${err?.message}`);
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h2>❌ 绑定失败</h2><p>${err?.message ?? "Unknown error"}</p>`);
      }
    },
  });
}
