// ---------------------------------------------------------------------------
// Helpers: rounding, tick sizes, formatting
// ---------------------------------------------------------------------------

import type { TickSize } from "@polymarket/clob-client";

/** Number of decimal places for each tick size */
const TICK_DECIMALS: Record<string, number> = {
  "0.1": 1,
  "0.01": 2,
  "0.001": 3,
  "0.0001": 4,
};

/** Round price DOWN for bids, UP for asks to stay on tick grid. */
export function roundPrice(price: number, tickSize: TickSize, side: "BUY" | "SELL"): number {
  const tick = parseFloat(tickSize);
  const decimals = TICK_DECIMALS[tickSize] ?? 2;
  if (side === "BUY") {
    // Round down for bids
    return parseFloat((Math.floor(price / tick) * tick).toFixed(decimals));
  }
  // Round up for asks
  return parseFloat((Math.ceil(price / tick) * tick).toFixed(decimals));
}

/** Clamp price to [tick, 1-tick] range (valid Polymarket prices). */
export function clampPrice(price: number, tickSize: TickSize): number {
  const tick = parseFloat(tickSize);
  return Math.max(tick, Math.min(1 - tick, price));
}

/** Round size to appropriate decimal places. */
export function roundSize(size: number, tickSize: TickSize): number {
  // Size is in shares; use size precision from OrderBookSummary
  // Polymarket sizes typically have the same precision as the tick
  const decimals = TICK_DECIMALS[tickSize] ?? 2;
  return parseFloat(Math.floor(size * 10 ** decimals) / 10 ** decimals + "");
}

/** Convert USDC amount to shares at a given price. */
export function usdcToShares(usdc: number, price: number): number {
  if (price <= 0 || price >= 1) return 0;
  return usdc / price;
}

/** Convert shares to USDC value at a given price. */
export function sharesToUsdc(shares: number, price: number): number {
  return shares * price;
}

/**
 * Polymarket reward scoring function.
 *   S(v, s) = ((v - s) / v)² × b
 *
 * @param v - max_incentive_spread (e.g. 0.03 = 3 cents)
 * @param s - actual spread from adjusted midpoint
 * @param b - order size in shares
 * @returns score contribution
 */
export function scoringFunction(v: number, s: number, b: number): number {
  if (v <= 0 || s >= v || s < 0 || b <= 0) return 0;
  const ratio = (v - s) / v;
  return ratio * ratio * b;
}

/** Get today's date as YYYY-MM-DD in UTC. */
export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Sleep for ms milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Format USDC amount for display. */
export function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : n > 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

/** Format percentage for display. */
export function fmtPct(n: number): string {
  const sign = n < 0 ? "-" : n > 0 ? "+" : "";
  return `${sign}${Math.abs(n).toFixed(2)}%`;
}

/** Format a duration in ms to human-readable. */
export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** Truncate question string for display. */
export function truncQ(q: string, max = 40): string {
  return q.length > max ? q.slice(0, max - 1) + "…" : q;
}

/**
 * Simple rate limiter: returns a wrapped function that waits if called too fast.
 * @param maxPerSec Maximum calls per second
 */
export function createRateLimiter(maxPerSec: number) {
  const minInterval = 1000 / maxPerSec;
  let lastCall = 0;
  return async function rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - lastCall;
    if (elapsed < minInterval) {
      await sleep(minInterval - elapsed);
    }
    lastCall = Date.now();
  };
}

/** Simple exponential backoff. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseMs = 1000,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < maxRetries) {
        await sleep(baseMs * 2 ** i);
      }
    }
  }
  throw lastErr;
}
