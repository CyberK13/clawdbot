// ---------------------------------------------------------------------------
// Gmail Assistant Types
// ---------------------------------------------------------------------------

/** OAuth token record (encrypted at rest, stored in JSON file) */
export interface GmailTokenRecord {
  tg_user_id: string;
  gmail_email: string;
  encrypted_token: string;
  is_active: boolean;
  updated_at: string; // ISO string
}

/** Decrypted OAuth credentials */
export interface GmailOAuthCredentials {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  token_type: string;
  scope: string;
}

/** Processed email ready for summarization */
export interface ParsedEmail {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  body: string;
  snippet: string;
  articles: ArticleContent[];
}

/** Fetched article content from email links */
export interface ArticleContent {
  url: string;
  content: string;
}

/** Plugin configuration from openclaw.json */
export interface GmailAssistantConfig {
  /** Enable/disable the plugin (default: true if env vars present) */
  enabled?: boolean;
  /** Cron schedule for auto-digest (default: every 2h) */
  schedule?: string;
  /** Max emails to process per digest (default: 50) */
  maxEmails?: number;
  /** Mark emails as read after digest (default: true) */
  markAsRead?: boolean;
}
