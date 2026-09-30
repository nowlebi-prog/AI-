import { randomBytes } from 'node:crypto';
import type { SessionInfo } from '../lib/http.ts';
import { hmac, safeEqual } from './crypto.ts';

export const SESSION_COOKIE = 'hub_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30일
/** 발급 후 이만큼 지나면 쓰는 동안 자동으로 연장한다 */
export const SESSION_RENEW_AFTER = 60 * 60 * 24; // 1일

function sign(secret: string, epoch: string, exp: number, nonce: string): string {
  const payload = `${exp}.${nonce}`;
  return `${payload}.${hmac(secret, `${epoch}.${payload}`)}`;
}

export function signSession(secret: string, epoch: string, maxAge = SESSION_MAX_AGE): string {
  return sign(secret, epoch, Math.floor(Date.now() / 1000) + maxAge, randomBytes(16).toString('base64url'));
}

/** 같은 nonce(= 같은 CSRF 토큰)로 만료만 늘린다. 열려 있는 다른 탭도 계속 쓸 수 있다 */
export function renewSession(secret: string, epoch: string, nonce: string, maxAge = SESSION_MAX_AGE): string {
  return sign(secret, epoch, Math.floor(Date.now() / 1000) + maxAge, nonce);
}

export function needsRenewal(s: SessionInfo, maxAge = SESSION_MAX_AGE): boolean {
  return s.exp - Date.now() / 1000 < maxAge - SESSION_RENEW_AFTER;
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
  return { nonce, csrf: csrfFor(secret, nonce), exp: Number(exp) };
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
