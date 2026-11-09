export type RateLimiter = { take(): boolean };

/** Token bucket: starts full, refills continuously at `refillPerSec`, never above `capacity`. */
export function createRateLimiter(opts: { capacity: number; refillPerSec: number; now?: () => number }): RateLimiter {
  const now = opts.now ?? Date.now;
  let tokens = opts.capacity;
  let last = now();
  return {
    take() {
      const t = now();
      tokens = Math.min(opts.capacity, tokens + (Math.max(0, t - last) / 1000) * opts.refillPerSec);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
