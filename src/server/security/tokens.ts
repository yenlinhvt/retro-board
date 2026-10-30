import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomId(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time string compare: hash both sides to equal length first. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Compares against every entry (no early exit). */
export function matchesAny(candidate: string, allowed: string[]): boolean {
  let found = false;
  for (const a of allowed) {
    if (safeEqual(candidate, a)) found = true;
  }
  return found;
}
