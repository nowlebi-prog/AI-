import { randomBytes } from 'node:crypto';
import type { SessionInfo } from '../lib/http.ts';
import { hmac, safeEqual } from './crypto.ts';

export const SESSION_COOKIE = 'hub_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30일

export function signSession(secret: string, epoch: string, maxAge = SESSION_MAX_AGE): string {
  const exp = Math.floor(Date.now() / 1000) + maxAge;
  const nonce = randomBytes(16).toString('base64url');
  const payload = `${exp}.${nonce}`;
  return `${payload}.${hmac(secret, `${epoch}.${payload}`)}`;
}

export function csrfFor(secret: string, nonce: string): string {
  return hmac(secret, `csrf.${nonce}`).slice(0, 32);
}

export function verifySession(value: string | undefined, secret: string, epoch: string): SessionInfo | null {
  if (!value) return null;
  const [exp, nonce, sig] = value.split('.');
  if (!exp || !nonce || !sig) return null;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return null;
  if (!safeEqual(sig, hmac(secret, `${epoch}.${exp}.${nonce}`))) return null;
  return { nonce, csrf: csrfFor(secret, nonce) };
}

export function checkPassword(input: string, expected: string): boolean {
  if (!expected) return false;
  return safeEqual(input, expected);
}

/** 로그인 실패가 몰리면 잠시 막는다 (1인용이라 전체 기준) */
export class LoginLimiter {
  private failures: number[] = [];
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max = 10, windowMs = 15 * 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.failures = this.failures.filter((t) => t > cutoff);
  }

  blocked(): boolean {
    this.prune();
    return this.failures.length >= this.max;
  }

  fail(): void {
    this.failures.push(Date.now());
  }

  reset(): void {
    this.failures = [];
  }
}
