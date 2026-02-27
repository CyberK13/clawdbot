// ---------------------------------------------------------------------------
// Gmail API wrapper via googleapis
// ---------------------------------------------------------------------------

import { google } from "googleapis";
import type { GmailOAuthCredentials, ParsedEmail, ArticleContent } from "./types.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
];

// ---- OAuth helpers --------------------------------------------------------

export function createOAuth2Client(): InstanceType<typeof google.auth.OAuth2> {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI,
  );
}

export function generateAuthUrl(state: string): string {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });
}

export async function exchangeCode(code: string): Promise<GmailOAuthCredentials> {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  return {
    access_token: tokens.access_token ?? "",
    refresh_token: tokens.refresh_token ?? "",
    expiry_date: tokens.expiry_date ?? 0,
    token_type: tokens.token_type ?? "Bearer",
    scope: tokens.scope ?? SCOPES.join(" "),
  };
}

/** Get user's email address from the Gmail profile. */
export async function getEmailAddress(creds: GmailOAuthCredentials): Promise<string> {
  const client = createOAuth2Client();
  client.setCredentials(creds);
  const gmail = google.gmail({ version: "v1", auth: client });
  const profile = await gmail.users.getProfile({ userId: "me" });
  return profile.data.emailAddress ?? "unknown";
}

// ---- Email fetching -------------------------------------------------------

/** Refresh token if expired, returns updated credentials (or same if still valid). */
export async function ensureFreshCredentials(
  creds: GmailOAuthCredentials,
): Promise<GmailOAuthCredentials> {
  if (creds.expiry_date > Date.now() + 60_000) return creds;
  const client = createOAuth2Client();
  client.setCredentials(creds);
  const { credentials } = await client.refreshAccessToken();
  return {
    access_token: credentials.access_token ?? creds.access_token,
    refresh_token: credentials.refresh_token ?? creds.refresh_token,
    expiry_date: credentials.expiry_date ?? 0,
    token_type: credentials.token_type ?? "Bearer",
    scope: credentials.scope ?? creds.scope,
  };
}

/** Fetch unread emails from the last 24 hours. */
export async function fetchUnreadEmails(
  creds: GmailOAuthCredentials,
  maxResults = 50,
): Promise<ParsedEmail[]> {
  const client = createOAuth2Client();
  client.setCredentials(creds);
  const gmail = google.gmail({ version: "v1", auth: client });

  const listRes = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread",
    maxResults,
  });

  const messageIds = listRes.data.messages ?? [];
  if (messageIds.length === 0) return [];

  const emails: ParsedEmail[] = [];
  for (const { id, threadId } of messageIds) {
    if (!id) continue;
    try {
      const msg = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      const parsed = parseMessage(msg.data, threadId ?? id);
      if (parsed) emails.push(parsed);
    } catch {
      // skip unreadable messages
    }
  }
  return emails;
}

/** Mark messages as read. */
export async function markAsRead(
  creds: GmailOAuthCredentials,
  messageIds: string[],
): Promise<void> {
  if (messageIds.length === 0) return;
  const client = createOAuth2Client();
  client.setCredentials(creds);
  const gmail = google.gmail({ version: "v1", auth: client });

  // Batch modify (up to 1000 per call)
  await gmail.users.messages.batchModify({
    userId: "me",
    requestBody: {
      ids: messageIds,
      removeLabelIds: ["UNREAD"],
    },
  });
}

// ---- Message parsing ------------------------------------------------------

function parseMessage(msg: any, threadId: string): ParsedEmail | null {
  const payload = msg.payload;
  if (!payload) return null;

  const headers: Record<string, string> = {};
  for (const h of payload.headers ?? []) {
    const name = (h.name ?? "").toLowerCase();
    if (["from", "to", "subject", "date"].includes(name)) {
      headers[name] = h.value ?? "";
    }
  }

  let bodyText = "";
  let bodyHtml = "";

  function extractParts(parts: any[]) {
    for (const part of parts) {
      const mime = part.mimeType ?? "";
      const data = part.body?.data;
      if (data) {
        const decoded = Buffer.from(data, "base64url").toString("utf-8");
        if (mime === "text/plain" && !bodyText) bodyText = decoded;
        else if (mime === "text/html" && !bodyHtml) bodyHtml = decoded;
      }
      if (part.parts) extractParts(part.parts);
    }
  }

  if (payload.parts) {
    extractParts(payload.parts);
  } else {
    const data = payload.body?.data;
    if (data) {
      const decoded = Buffer.from(data, "base64url").toString("utf-8");
      const mime = payload.mimeType ?? "";
      if (mime === "text/plain") bodyText = decoded;
      else if (mime === "text/html") bodyHtml = decoded;
    }
  }

  // Convert HTML to plain text (simple strip)
  if (!bodyText && bodyHtml) {
    bodyText = htmlToText(bodyHtml);
  }

  const articles = extractArticleUrls(bodyText);

  return {
    id: msg.id ?? "",
    threadId,
    from: headers.from ?? "",
    subject: headers.subject ?? "(no subject)",
    date: headers.date ?? "",
    body: bodyText.slice(0, 4000),
    snippet: msg.snippet ?? "",
    articles,
  };
}

// ---- URL extraction (ported from Python) ----------------------------------

const SKIP_DOMAINS = new Set([
  "list-manage.com",
  "mailchimp.com",
  "sendgrid.net",
  "manage.kmail-lists.com",
  "google.com",
  "play.google.com",
  "itunes.apple.com",
  "facebook.com",
  "twitter.com",
  "instagram.com",
  "linkedin.com",
  "youtube.com",
  "doubleclick.net",
  "googlesyndication.com",
]);

const SKIP_URL_PATTERNS = [
  "unsubscribe",
  "optout",
  "opt-out",
  "preference",
  "click.",
  "tracking.",
  "trk.",
  "opens.",
  "beacon",
  "pixel",
  "1x1",
];

const STATIC_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".css", ".js", ".woff"];

function isTrackingUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (SKIP_URL_PATTERNS.some((p) => lower.includes(p))) return true;
  try {
    const hostname = new URL(lower).hostname;
    for (const domain of SKIP_DOMAINS) {
      if (hostname.includes(domain)) return true;
    }
  } catch {
    /* ignore invalid URLs */
  }
  return false;
}

function extractArticleUrls(body: string): ArticleContent[] {
  const urlRegex = /https?:\/\/[^\s<>"')\]]+/g;
  const matches = body.match(urlRegex) ?? [];
  const seen = new Set<string>();
  const result: ArticleContent[] = [];

  for (let url of matches) {
    url = url.replace(/[.,;:!?)>\]]+$/, "");
    if (url.length < 20 || isTrackingUrl(url)) continue;
    try {
      const parsed = new URL(url);
      if (STATIC_EXTS.some((ext) => parsed.pathname.toLowerCase().endsWith(ext))) continue;
      const key = parsed.hostname + parsed.pathname;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ url, content: "" }); // content filled later by ai-summarizer
    } catch {
      /* skip invalid */
    }
    if (result.length >= 2) break;
  }
  return result;
}

// ---- Simple HTML → text ---------------------------------------------------

function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
