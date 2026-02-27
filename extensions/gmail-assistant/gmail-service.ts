// ---------------------------------------------------------------------------
// Gmail Service — OAuth flow, digest execution, scheduled delivery
// ---------------------------------------------------------------------------

import type { PluginLogger } from "../../src/plugins/types.js";
import { summarizeEmails } from "./ai-summarizer.js";
import { encrypt, decrypt } from "./crypto.js";
import * as db from "./db.js";
import {
  generateAuthUrl,
  exchangeCode,
  getEmailAddress,
  ensureFreshCredentials,
  fetchUnreadEmails,
  markAsRead,
} from "./gmail-api.js";
import type { GmailOAuthCredentials } from "./types.js";

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let logger: PluginLogger = { info: console.log, warn: console.warn, error: console.error };

const BOT_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || "";
const ENCRYPTION_KEY = () => process.env.GMAIL_ENCRYPTION_KEY || "";

export function setLogger(l: PluginLogger) {
  logger = l;
}

// ---- OAuth flow -----------------------------------------------------------

/** Generate an OAuth URL with the TG user ID encoded in the state parameter. */
export function getOAuthUrl(tgUserId: string): string {
  const state = Buffer.from(JSON.stringify({ tgUserId, ts: Date.now() })).toString("base64url");
  return generateAuthUrl(state);
}

/** Handle the OAuth callback: exchange code, store encrypted token. */
export async function handleOAuthCallbackFlow(
  code: string,
  stateRaw: string,
): Promise<{ tgUserId: string; email: string }> {
  // Decode state
  const stateJson = Buffer.from(stateRaw, "base64url").toString("utf-8");
  const { tgUserId } = JSON.parse(stateJson) as { tgUserId: string };
  if (!tgUserId) throw new Error("Invalid state: missing tgUserId");

  // Exchange code for tokens
  const creds = await exchangeCode(code);
  if (!creds.refresh_token)
    throw new Error("No refresh_token received — re-authorize with consent");

  // Get email address
  const email = await getEmailAddress(creds);

  // Encrypt and store
  const encryptedToken = encrypt(JSON.stringify(creds), ENCRYPTION_KEY());
  await db.upsertToken(tgUserId, email, encryptedToken);

  logger.info(`Gmail bound: ${email} → TG ${tgUserId}`);
  return { tgUserId, email };
}

// ---- Digest execution -----------------------------------------------------

/** Run a mail digest for a specific TG user. Returns the summary text or null. */
export async function runDigestForUser(tgUserId: string, markRead = true): Promise<string> {
  const row = await db.getToken(tgUserId);
  if (!row) return "❌ 未绑定 Gmail。请先使用 /bindmail 绑定。";

  let creds: GmailOAuthCredentials;
  try {
    creds = JSON.parse(decrypt(row.encrypted_token, ENCRYPTION_KEY()));
  } catch {
    return "❌ Token 解密失败，请重新 /bindmail 绑定。";
  }

  // Refresh if needed
  try {
    const fresh = await ensureFreshCredentials(creds);
    if (fresh !== creds) {
      // Token was refreshed — persist updated credentials
      const encrypted = encrypt(JSON.stringify(fresh), ENCRYPTION_KEY());
      await db.updateEncryptedToken(tgUserId, encrypted);
      creds = fresh;
    }
  } catch (err: any) {
    if (err?.message?.includes("invalid_grant") || err?.code === 401) {
      await db.deactivateToken(tgUserId);
      return "❌ Gmail 授权已过期，请重新 /bindmail 绑定。";
    }
    return `❌ Token 刷新失败: ${err?.message ?? err}`;
  }

  // Fetch emails
  const emails = await fetchUnreadEmails(creds);
  if (emails.length === 0) return "📭 没有未读邮件";

  logger.info(`Fetched ${emails.length} unread emails for TG ${tgUserId}`);

  // AI summarize
  const summary = await summarizeEmails(emails);
  if (!summary) return "❌ AI 摘要生成失败，请稍后重试";

  // Mark as read
  if (markRead) {
    try {
      await markAsRead(
        creds,
        emails.map((e) => e.id),
      );
      logger.info(`Marked ${emails.length} emails as read for TG ${tgUserId}`);
    } catch (err: any) {
      logger.warn(`Failed to mark as read: ${err?.message}`);
    }
  }

  return `📬 未读邮件汇总 (${emails.length} 封)\n${"─".repeat(30)}\n\n${summary}`;
}

// ---- Unbind ---------------------------------------------------------------

export async function unbindUser(tgUserId: string): Promise<string> {
  const removed = await db.deactivateToken(tgUserId);
  return removed ? "✅ Gmail 绑定已解除" : "⚠️ 未找到绑定记录";
}

// ---- Scheduled digest -----------------------------------------------------

export function startScheduler(intervalMs = 2 * 60 * 60_000) {
  stopScheduler();
  schedulerTimer = setInterval(() => void runScheduledDigest(), intervalMs);
  logger.info(`Gmail digest scheduler started (every ${intervalMs / 60_000}min)`);
}

export function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

async function runScheduledDigest() {
  const rows = await db.getAllActiveTokens();
  if (rows.length === 0) return;

  logger.info(`Scheduled digest: processing ${rows.length} users`);
  for (const row of rows) {
    try {
      const text = await runDigestForUser(row.tg_user_id);
      if (text && !text.startsWith("📭")) {
        await sendTelegram(row.tg_user_id, text);
      }
    } catch (err: any) {
      logger.error(`Scheduled digest failed for TG ${row.tg_user_id}: ${err?.message}`);
    }
  }
}

// ---- Telegram push --------------------------------------------------------

async function sendTelegram(chatId: string, text: string): Promise<void> {
  const token = BOT_TOKEN();
  if (!token) return;

  // Split long messages (TG limit: 4096)
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= 4000) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n", 4000);
    if (cut < 2000) cut = 4000;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }

  for (const chunk of chunks) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      }),
    }).catch(() => {});
  }
}

/** Public helper for OAuth callback to notify user via TG. */
export async function notifyUser(chatId: string, text: string): Promise<void> {
  await sendTelegram(chatId, text);
}
