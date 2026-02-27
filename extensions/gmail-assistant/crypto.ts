// ---------------------------------------------------------------------------
// AES-256-GCM encryption for OAuth tokens
// ---------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

/** Parse key from hex (64 chars) or base64 (44 chars) format. */
function parseKey(keyStr: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(keyStr)) return Buffer.from(keyStr, "hex");
  return Buffer.from(keyStr, "base64");
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Output format: base64(iv + tag + ciphertext)
 */
export function encrypt(plaintext: string, keyStr: string): string {
  const key = parseKey(keyStr);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * Decrypt AES-256-GCM ciphertext.
 * Input format: base64(iv + tag + ciphertext)
 */
export function decrypt(encoded: string, keyStr: string): string {
  const key = parseKey(keyStr);
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}
