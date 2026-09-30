import type { AppCtx } from '../app-context.ts';
import { html } from '../lib/html.ts';
import { corsHeaders, field, readForm, readJson, redirect, sendHtml, sendJson, type Ctx } from '../lib/http.ts';
import { barePage, csrfInput } from '../web/layout.ts';
import { safeEqual, sha256Base64Url, sha256Hex } from './crypto.ts';
import {
  ACCESS_TTL_SEC,
  SCOPE_LABEL,
  clientRedirectUris,
  consumeCode,
  createCode,
  getClient,
  issueTokens,
  oauthScopeString,
  parseScopes,
  refreshTokens,
  registerClient,
  renameClient,
  revokeByToken,
  type OAuthClient,
  type Scope,
} from './tokens.ts';

const SCOPES_SUPPORTED = ['hub:read', 'hub:write'];

// ─── 메타데이터 ─────────────────────────────────────────────────

export function protectedResourceMetadata(ctx: Ctx): void {
  sendJson(
    ctx,
    {
      resource: `${ctx.baseUrl}/mcp`,
      authorization_servers: [ctx.baseUrl],
      scopes_supported: SCOPES_SUPPORTED,
      bearer_methods_supported: ['header'],
      resource_name: 'Hub',
    },
    200,
    corsHeaders(),
  );
}

export function authorizationServerMetadata(ctx: Ctx): void {
  const b = ctx.baseUrl;
  sendJson(
    ctx,
    {
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      registration_endpoint: `${b}/oauth/register`,
      revocation_endpoint: `${b}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: SCOPES_SUPPORTED,
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${b}/settings#connect`,
    },
    200,
    corsHeaders(),
  );
}

// ─── 동적 클라이언트 등록 (RFC 7591) ──────────────────────────────

/** https, 루프백 http, 앱 전용 스킴만 허용 */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (scheme === 'https') return true;
  if (scheme === 'http') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (['javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'ftp', 'ws', 'wss'].includes(scheme)) return false;
  return /^[a-z][a-z0-9+.-]*$/.test(scheme);
}

function oauthError(ctx: Ctx, status: number, error: string, description: string): void {
  sendJson(ctx, { error, error_description: description }, status, { ...corsHeaders(), Pragma: 'no-cache' });
}

export function registerHandler(app: AppCtx) {
  return async (ctx: Ctx): Promise<void> => {
    let body: Record<string, unknown>;
    try {
      const parsed = await readJson(ctx);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed as Record<string, unknown>;
    } catch {
      return oauthError(ctx, 400, 'invalid_client_metadata', 'JSON 본문이 필요해요');
    }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (!uris.length || uris.length > 10) return oauthError(ctx, 400, 'invalid_redirect_uri', 'redirect_uris가 필요해요');
    const bad = uris.find((u) => !isAllowedRedirectUri(u));
    if (bad) return oauthError(ctx, 400, 'invalid_redirect_uri', `허용되지 않는 redirect_uri: ${bad}`);
    const method = String(body.token_endpoint_auth_method ?? 'client_secret_basic');
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
      return oauthError(ctx, 400, 'invalid_client_metadata', `지원하지 않는 인증 방식: ${method}`);
    }
    const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim() : 'MCP 클라이언트';
    const { client, secret } = registerClient(app.db, {
      client_name: name,
      redirect_uris: uris,
      auth_method: method as 'none' | 'client_secret_post' | 'client_secret_basic',
    });
    sendJson(
      ctx,
      {
        client_id: client.client_id,
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000),
        client_name: client.client_name,
        redirect_uris: uris,
        token_endpoint_auth_method: method,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: SCOPES_SUPPORTED.join(' '),
      },
      201,
      corsHeaders(),
    );
  };
}

// ─── 인가 (동의 화면) ───────────────────────────────────────────

interface AuthzRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  requested: Set<Scope>;
}

type AuthzParse = { ok: true; req: AuthzRequest } | { ok: false; fatal: string } | { ok: false; redirectTo: string };

function withParams(uri: string, params: Record<string, string>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.toString();
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function parseAuthz(app: AppCtx, p: URLSearchParams, baseUrl: string): AuthzParse {
  const clientId = (p.get('client_id') ?? '').trim();
  const client = clientId ? getClient(app.db, clientId) : undefined;
  if (!client) return { ok: false, fatal: '등록되지 않은 앱이에요. AI 쪽에서 연결을 처음부터 다시 시도해 주세요.' };
  const registered = clientRedirectUris(client);
  let redirectUri = (p.get('redirect_uri') ?? '').trim();
  if (!redirectUri && registered.length === 1) redirectUri = registered[0] ?? '';
  if (!redirectUri || !registered.includes(redirectUri)) {
    return { ok: false, fatal: '돌아갈 주소(redirect_uri)가 등록된 값과 달라요.' };
  }
  const state = p.get('state') ?? '';
  const fail = (error: string, description: string): AuthzParse => ({
    ok: false,
    redirectTo: withParams(redirectUri, { error, error_description: description, state, iss: baseUrl }),
  });
  if (p.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type=code만 지원해요');
  const challenge = (p.get('code_challenge') ?? '').trim();
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return fail('invalid_request', 'PKCE code_challenge가 필요해요');
  if ((p.get('code_challenge_method') ?? 'S256') !== 'S256') return fail('invalid_request', 'code_challenge_method=S256만 지원해요');
  const resource = (p.get('resource') ?? '').trim();
  if (resource && !sameOrigin(resource, baseUrl)) return fail('invalid_target', '이 서버의 리소스가 아니에요');
  const requested = parseScopes(p.get('scope') ?? '');
  if (!requested.size) {
    requested.add('read');
    requested.add('write');
  }
  requested.add('read');
  return { ok: true, req: { client, redirectUri, state, codeChallenge: challenge, requested } };
}

function errorPage(ctx: Ctx, message: string, status = 400): void {
  sendHtml(ctx, barePage('연결 오류', html`<h1>연결할 수 없어요</h1><p>${message}</p><p><a href="/">Hub로 가기</a></p>`), status);
}

function hostOf(uri: string): string {
  try {
    const u = new URL(uri);
    return u.host || u.protocol;
  } catch {
    return uri;
  }
}

export function authorizeGet(app: AppCtx) {
  return (ctx: Ctx): void => {
    const parsed = parseAuthz(app, ctx.url.searchParams, ctx.baseUrl);
    if (!parsed.ok) return 'fatal' in parsed ? errorPage(ctx, parsed.fatal) : redirect(ctx, parsed.redirectTo, 302);
    if (!ctx.session) return redirect(ctx, `/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`);
    const { client, redirectUri, requested } = parsed.req;
    const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource', 'response_type'];
    const body = html`
      <h1>Hub 연결 요청</h1>
      <p><strong>${client.client_name}</strong>이(가) Hub에 연결하려고 해요.</p>
      <p class="small muted">허용하면 ${hostOf(redirectUri)}(으)로 돌아가요.</p>
      <form method="post" action="/oauth/authorize" class="stack">
        ${csrfInput(ctx)}
        ${hidden.map((k) => html`<input type="hidden" name="${k}" value="${ctx.url.searchParams.get(k) ?? ''}">`)}
        <label>이 연결의 이름 (출처로 표시돼요)<input type="text" name="label" value="${client.label ?? client.client_name}" maxlength="60"></label>
        <fieldset class="scopes">
          <legend>권한</legend>
          <label class="inline-label"><input type="checkbox" checked disabled> ${SCOPE_LABEL.read}</label>
          ${requested.has('write')
            ? html`<label class="inline-label"><input type="checkbox" name="write" value="1" checked> ${SCOPE_LABEL.write}</label>`
            : ''}
        </fieldset>
        <p class="small muted">제안은 인박스에서 승인해야 반영돼요. 연결은 설정 → 연결된 앱에서 언제든 끊을 수 있어요.</p>
        <div class="form-inline">
          <button class="btn btn-primary" name="decision" value="allow">허용</button>
          <button class="btn btn-ghost" name="decision" value="deny">거부</button>
        </div>
      </form>`;
    sendHtml(ctx, barePage('연결 허용', body));
  };
}

export function authorizePost(app: AppCtx) {
  return async (ctx: Ctx): Promise<void> => {
    const form = await readForm(ctx);
    if (!ctx.session) return errorPage(ctx, '로그인이 필요해요. 처음부터 다시 시도해 주세요.', 401);
    if (!safeEqual(field(form, '_csrf'), ctx.session.csrf)) return errorPage(ctx, '요청이 만료됐어요. 처음부터 다시 시도해 주세요.', 403);
    const parsed = parseAuthz(app, form, ctx.baseUrl);
    if (!parsed.ok) return 'fatal' in parsed ? errorPage(ctx, parsed.fatal) : redirect(ctx, parsed.redirectTo, 302);
    const { client, redirectUri, state, codeChallenge, requested } = parsed.req;
    if (field(form, 'decision') !== 'allow') {
      return redirect(ctx, withParams(redirectUri, { error: 'access_denied', error_description: '사용자가 거부했어요', state, iss: ctx.baseUrl }), 302);
    }
    const scopes = new Set<Scope>(['read']);
    if (requested.has('write') && field(form, 'write') === '1') scopes.add('write');
    const label = field(form, 'label');
    if (label && label !== client.client_name) renameClient(app.db, client.client_id, label);
    const code = createCode(app.db, { clientId: client.client_id, redirectUri, codeChallenge, scopes });
    redirect(ctx, withParams(redirectUri, { code, state, iss: ctx.baseUrl }), 302);
  };
}

// ─── 토큰 ─────────────────────────────────────────────────────

function clientCredentials(ctx: Ctx, form: URLSearchParams): { id: string; secret: string } {
  const basic = /^Basic\s+(.+)$/i.exec(String(ctx.req.headers.authorization ?? ''));
  if (basic) {
    const decoded = Buffer.from(basic[1] ?? '', 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i > 0) {
      const dec = (s: string) => {
        try {
          return decodeURIComponent(s.replace(/\+/g, ' '));
        } catch {
          return s;
        }
      };
      return { id: dec(decoded.slice(0, i)), secret: dec(decoded.slice(i + 1)) };
    }
  }
  return { id: field(form, 'client_id'), secret: field(form, 'client_secret') };
}

function authenticateClient(app: AppCtx, ctx: Ctx, form: URLSearchParams): OAuthClient | null {
  const cred = clientCredentials(ctx, form);
  const client = cred.id ? getClient(app.db, cred.id) : undefined;
  if (!client) return null;
  if (client.auth_method === 'none') return client;
  if (!cred.secret || !client.client_secret_hash || !safeEqual(sha256Hex(cred.secret), client.client_secret_hash)) return null;
  return client;
}

export function tokenHandler(app: AppCtx) {
  return async (ctx: Ctx): Promise<void> => {
    const form = await readForm(ctx);
    const client = authenticateClient(app, ctx, form);
    if (!client) return oauthError(ctx, 401, 'invalid_client', '클라이언트 인증에 실패했어요');
    const grant = field(form, 'grant_type');
    const resource = field(form, 'resource');
    if (resource && !sameOrigin(resource, ctx.baseUrl)) return oauthError(ctx, 400, 'invalid_target', '이 서버의 리소스가 아니에요');

    let issued;
    if (grant === 'authorization_code') {
      const row = consumeCode(app.db, field(form, 'code'));
      if (!row || row.client_id !== client.client_id) return oauthError(ctx, 400, 'invalid_grant', '인가 코드가 올바르지 않거나 만료됐어요');
      const redirectUri = field(form, 'redirect_uri');
      if (redirectUri && redirectUri !== row.redirect_uri) return oauthError(ctx, 400, 'invalid_grant', 'redirect_uri가 달라요');
      const verifier = field(form, 'code_verifier');
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(sha256Base64Url(verifier), row.code_challenge)) {
        return oauthError(ctx, 400, 'invalid_grant', 'PKCE 검증에 실패했어요');
      }
      issued = issueTokens(app.db, client.client_id, parseScopes(row.scopes));
    } else if (grant === 'refresh_token') {
      issued = refreshTokens(app.db, field(form, 'refresh_token'), client.client_id);
      if (!issued) return oauthError(ctx, 400, 'invalid_grant', '리프레시 토큰이 올바르지 않거나 만료됐어요');
    } else {
      return oauthError(ctx, 400, 'unsupported_grant_type', 'authorization_code, refresh_token만 지원해요');
    }
    sendJson(
      ctx,
      {
        access_token: issued.access_token,
        token_type: 'Bearer',
        expires_in: ACCESS_TTL_SEC,
        refresh_token: issued.refresh_token,
        scope: oauthScopeString(issued.scopes),
      },
      200,
      { ...corsHeaders(), Pragma: 'no-cache' },
    );
  };
}

export function revokeHandler(app: AppCtx) {
  return async (ctx: Ctx): Promise<void> => {
    const form = await readForm(ctx);
    const client = authenticateClient(app, ctx, form);
    if (!client) return oauthError(ctx, 401, 'invalid_client', '클라이언트 인증에 실패했어요');
    const token = field(form, 'token');
    if (token) revokeByToken(app.db, token, client.client_id);
    sendJson(ctx, {}, 200, corsHeaders());
  };
}
