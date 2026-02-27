// ---------------------------------------------------------------------------
// JSON file storage for gmail tokens (replaces PostgreSQL)
// Stored at: {stateDir}/gmail-assistant/tokens.json
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { GmailTokenRecord } from "./types.js";

interface TokenStore {
  tokens: Record<string, GmailTokenRecord>; // keyed by tgUserId
}

let storePath = "";
let store: TokenStore = { tokens: {} };

/** Initialize: set storage path and load existing data. */
export async function init(stateDir: string): Promise<void> {
  const dir = path.join(stateDir, "gmail-assistant");
  await mkdir(dir, { recursive: true });
  storePath = path.join(dir, "tokens.json");
  try {
    const raw = await readFile(storePath, "utf-8");
    store = JSON.parse(raw);
  } catch {
    store = { tokens: {} };
  }
}

/** Flush is a no-op cleanup (no connection pool to close). */
export async function close(): Promise<void> {
  // nothing to close — file-based
}

async function save(): Promise<void> {
  await writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
}

/** Upsert a user's encrypted token. */
export async function upsertToken(
  tgUserId: string,
  gmailEmail: string,
  encryptedToken: string,
): Promise<void> {
  store.tokens[tgUserId] = {
    tg_user_id: tgUserId,
    gmail_email: gmailEmail,
    encrypted_token: encryptedToken,
    is_active: true,
    updated_at: new Date().toISOString(),
  };
  await save();
}

/** Get a user's active token record. */
export async function getToken(tgUserId: string): Promise<GmailTokenRecord | null> {
  const rec = store.tokens[tgUserId];
  return rec?.is_active ? rec : null;
}

/** Get all active token records (for scheduled digest). */
export async function getAllActiveTokens(): Promise<GmailTokenRecord[]> {
  return Object.values(store.tokens).filter((r) => r.is_active);
}

/** Soft-delete a user's token. */
export async function deactivateToken(tgUserId: string): Promise<boolean> {
  const rec = store.tokens[tgUserId];
  if (!rec?.is_active) return false;
  rec.is_active = false;
  rec.updated_at = new Date().toISOString();
  await save();
  return true;
}

/** Update the encrypted token (e.g., after refresh). */
export async function updateEncryptedToken(
  tgUserId: string,
  encryptedToken: string,
): Promise<void> {
  const rec = store.tokens[tgUserId];
  if (!rec) return;
  rec.encrypted_token = encryptedToken;
  rec.updated_at = new Date().toISOString();
  await save();
}
