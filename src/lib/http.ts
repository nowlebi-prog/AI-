import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SafeHtml } from './html.ts';

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface SessionInfo {
  nonce: string;
  csrf: string;
  /** 만료 시각 (초) */
  exp: number;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: URL;
  path: string;
  params: Record<string, string>;
  cookies: Record<string, string>;
  baseUrl: string;
  session: SessionInfo | null;
  form?: URLSearchParams;
  rawBody?: Buffer;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

export type RouteMatch =
  | { kind: 'found'; handler: Handler; params: Record<string, string> }
  | { kind: 'method-not-allowed'; allow: string[] }
  | { kind: 'not-found' };

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    const keys: string[] = [];
    const escaped = pattern.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
    const source = escaped.replace(/\/:([a-zA-Z_]+)/g, (_m, key: string) => {
      keys.push(key);
      return '/([^/]+)';
    });
    this.routes.push({ method, re: new RegExp(`^${source}/?$`), keys, handler });
  }

  get(pattern: string, handler: Handler): void {
    this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): void {
    this.add('POST', pattern, handler);
  }

  match(method: string, path: string): RouteMatch {
    const allow: string[] = [];
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) {
        allow.push(r.method);
        continue;
      }
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => {
        const v = m[i + 1] ?? '';
        try {
          params[k] = decodeURIComponent(v);
        } catch {
          params[k] = v;
        }
      });
      return { kind: 'found', handler: r.handler, params };
    }
    return allow.length ? { kind: 'method-not-allowed', allow } : { kind: 'not-found' };
  }
}

export async function readBody(ctx: Ctx, limit = 2_000_000): Promise<Buffer> {
  if (ctx.rawBody) return ctx.rawBody;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of ctx.req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new HttpError(413, '요청 본문이 너무 커요');
    chunks.push(buf);
  }
  ctx.rawBody = Buffer.concat(chunks);
  return ctx.rawBody;
}

/** urlencoded 또는 JSON 본문을 URLSearchParams로 읽는다 */
export async function readForm(ctx: Ctx): Promise<URLSearchParams> {
  if (ctx.form) return ctx.form;
  const body = (await readBody(ctx)).toString('utf8');
  const type = String(ctx.req.headers['content-type'] ?? '');
  if (type.includes('application/json')) {
    const params = new URLSearchParams();
    try {
      const data = JSON.parse(body || '{}') as Record<string, unknown>;
      for (const [k, v] of Object.entries(data)) {
        if (v !== null && v !== undefined) params.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
    } catch {
      throw new HttpError(400, 'JSON 형식이 올바르지 않아요');
    }
    ctx.form = params;
  } else {
    ctx.form = new URLSearchParams(body);
  }
  return ctx.form;
}

export async function readJson(ctx: Ctx): Promise<unknown> {
  const body = (await readBody(ctx)).toString('utf8');
  return JSON.parse(body);
}

/** 폼 값(앞뒤 공백 제거) */
export function field(form: URLSearchParams, name: string): string {
  return (form.get(name) ?? '').trim();
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export interface CookieOptions {
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
}

export function setCookie(ctx: Ctx, name: string, value: string, opts: CookieOptions = {}): void {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`];
  if (opts.maxAge !== undefined) bits.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly !== false) bits.push('HttpOnly');
  if (opts.secure) bits.push('Secure');
  bits.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  const prev = ctx.res.getHeader('Set-Cookie');
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  ctx.res.setHeader('Set-Cookie', [...list, bits.join('; ')]);
}

const PAGE_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
};

export function sendHtml(ctx: Ctx, body: SafeHtml, status = 200): void {
  ctx.res.writeHead(status, {
    ...PAGE_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  ctx.res.end(ctx.method === 'HEAD' ? undefined : body.value);
}

export function sendJson(ctx: Ctx, data: unknown, status = 200, headers: Record<string, string> = {}): void {
  ctx.res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  ctx.res.end(JSON.stringify(data));
}

export function sendText(ctx: Ctx, text: string, status = 200, headers: Record<string, string> = {}): void {
  ctx.res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  ctx.res.end(text);
}

export function redirect(ctx: Ctx, location: string, status = 303): void {
  ctx.res.writeHead(status, { Location: location, 'Cache-Control': 'no-store' });
  ctx.res.end();
}

/** 외부로 튀지 않는 상대 경로만 허용 */
export function safeLocalPath(value: string | null | undefined, fallback = '/'): string {
  if (!value) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  return value;
}

export function baseUrlOf(req: IncomingMessage, publicUrl: string): string {
  if (publicUrl) return publicUrl;
  const fwdProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim();
  const fwdHost = String(req.headers['x-forwarded-host'] ?? '').split(',')[0]?.trim();
  const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
  const proto = fwdProto || (encrypted ? 'https' : 'http');
  const host = fwdHost || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

/** 응답에 CORS 헤더를 붙인다 (토큰 기반 엔드포인트용) */
export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
    'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
    'Access-Control-Max-Age': '86400',
  };
}
