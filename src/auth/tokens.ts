import type { Db } from '../db.ts';
import { nowIso } from '../lib/time.ts';
import { UserError } from '../domain/types.ts';
import { randomToken, sha256Hex } from './crypto.ts';

export type Scope = 'read' | 'write';
export const ALL_SCOPES: Scope[] = ['read', 'write'];
export const SCOPE_LABEL: Record<Scope, string> = { read: '읽기 (브리핑·검색)', write: '제안 (결정·할 일·세션 기록)' };

export const ACCESS_TTL_SEC = 60 * 60; // 1시간
export const REFRESH_TTL_SEC = 60 * 60 * 24 * 90; // 90일
export const CODE_TTL_SEC = 10 * 60;

export function scopesToString(scopes: Iterable<Scope>): string {
  return [...new Set(scopes)].sort().join(' ');
}

export function parseScopes(s: string): Set<Scope> {
  const out = new Set<Scope>();
  for (const part of s.split(/[\s,]+/)) {
    const p = part.trim().toLowerCase().replace(/^hub:/, '');
    if (p === 'read' || p === 'write') out.add(p);
  }
  return out;
}

/** OAuth 응답용 'hub:read hub:write' */
export function oauthScopeString(scopes: Iterable<Scope>): string {
  return [...new Set(scopes)].sort().map((s) => `hub:${s}`).join(' ');
}

export interface AuthInfo {
  kind: 'pat' | 'oauth';
  id: string;
  source: string;
  scopes: Set<Scope>;
}

function addSeconds(sec: number): string {
  return new Date(Date.now() + sec * 1000).toISOString();
}

// ─── 개인 토큰 (PAT) ──────────────────────────────────────────────

export interface PatRow {
  id: number;
  name: string;
  prefix: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function createPat(db: Db, name: string, scopes: Set<Scope>): { id: number; token: string } {
  const n = name.trim();
  if (!n) throw new UserError('토큰 이름을 입력해 주세요 (예: Muse)');
  if (!scopes.has('read')) scopes.add('read');
  const token = randomToken('hub_pat_');
  const r = db.run(
    'INSERT INTO api_tokens (name, token_hash, prefix, scopes, created_at) VALUES (?, ?, ?, ?, ?)',
    n.slice(0, 60),
    sha256Hex(token),
    token.slice(0, 12),
    scopesToString(scopes),
    nowIso(),
  );
  return { id: r.lastInsertRowid, token };
}

export function listPats(db: Db): PatRow[] {
  return db.all<PatRow>(
    'SELECT id, name, prefix, scopes, created_at, last_used_at, revoked_at FROM api_tokens ORDER BY revoked_at IS NOT NULL, created_at DESC',
  );
}

export function revokePat(db: Db, id: number): void {
  db.run('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', nowIso(), id);
}

// ─── OAuth 클라이언트 ─────────────────────────────────────────────

export interface OAuthClient {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string;
  label: string | null;
  redirect_uris: string;
  auth_method: string;
  created_at: string;
}

export interface OAuthClientView extends OAuthClient {
  active_tokens: number;
  last_used_at: string | null;
}

export function clientLabel(c: Pick<OAuthClient, 'label' | 'client_name'>): string {
  return (c.label ?? '').trim() || c.client_name;
}

export function registerClient(
  db: Db,
  meta: { client_name: string; redirect_uris: string[]; auth_method: 'none' | 'client_secret_post' | 'client_secret_basic' },
): { client: OAuthClient; secret: string | null } {
  pruneClients(db);
  const clientId = randomToken('hubc_', 18);
  const secret = meta.auth_method === 'none' ? null : randomToken('hubcs_');
  db.run(
    `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, auth_method, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    clientId,
    secret ? sha256Hex(secret) : null,
    meta.client_name.slice(0, 100),
    JSON.stringify(meta.redirect_uris),
    meta.auth_method,
    nowIso(),
  );
  return { client: getClient(db, clientId) as OAuthClient, secret };
}

/** 등록만 되고 한 번도 연결되지 않은 오래된 클라이언트 정리 */
function pruneClients(db: Db): void {
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
  db.run(
    `DELETE FROM oauth_clients WHERE created_at < ?
       AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = oauth_clients.client_id)`,
    cutoff,
  );
}

export function getClient(db: Db, clientId: string): OAuthClient | undefined {
  return db.get<OAuthClient>('SELECT * FROM oauth_clients WHERE client_id = ?', clientId);
}

export function clientRedirectUris(c: OAuthClient): string[] {
  try {
    const v = JSON.parse(c.redirect_uris) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function listConnectedClients(db: Db): OAuthClientView[] {
  return db.all<OAuthClientView>(
    `SELECT c.*,
       (SELECT count(*) FROM oauth_tokens t WHERE t.client_id = c.client_id AND t.revoked_at IS NULL
          AND (t.refresh_expires_at > ? OR t.access_expires_at > ?)) AS active_tokens,
       (SELECT max(t.last_used_at) FROM oauth_tokens t WHERE t.client_id = c.client_id) AS last_used_at
     FROM oauth_clients c
     WHERE EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = c.client_id)
     ORDER BY c.created_at DESC`,
    nowIso(),
    nowIso(),
  );
}

export function renameClient(db: Db, clientId: string, label: string): void {
  db.run('UPDATE oauth_clients SET label = ? WHERE client_id = ?', label.trim().slice(0, 60) || null, clientId);
}

export function deleteClient(db: Db, clientId: string): void {
  db.run('DELETE FROM oauth_clients WHERE client_id = ?', clientId);
}

// ─── 인가 코드 ───────────────────────────────────────────────────

export function createCode(
  db: Db,
  input: { clientId: string; redirectUri: string; codeChallenge: string; scopes: Set<Scope> },
): string {
  db.run("DELETE FROM oauth_codes WHERE expires_at < ? OR used_at IS NOT NULL", nowIso());
  const code = randomToken('hubac_');
  db.run(
    'INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    sha256Hex(code),
    input.clientId,
    input.redirectUri,
    input.codeChallenge,
    scopesToString(input.scopes),
    addSeconds(CODE_TTL_SEC),
  );
  return code;
}

export interface CodeRow {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  expires_at: string;
  used_at: string | null;
}

/** 코드는 한 번만 쓸 수 있다 */
export function consumeCode(db: Db, code: string): CodeRow | null {
  return db.tx(() => {
    const row = db.get<CodeRow>('SELECT * FROM oauth_codes WHERE code_hash = ?', sha256Hex(code));
    if (!row || row.used_at || row.expires_at < nowIso()) return null;
    db.run('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?', nowIso(), row.code_hash);
    return row;
  });
}

// ─── 액세스/리프레시 토큰 ─────────────────────────────────────────

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scopes: Set<Scope>;
}

export function issueTokens(db: Db, clientId: string, scopes: Set<Scope>): IssuedTokens {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  db.run(
    'DELETE FROM oauth_tokens WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR refresh_expires_at < ?',
    weekAgo,
    nowIso(),
  );
  const access = randomToken('hub_at_');
  const refresh = randomToken('hub_rt_');
  db.run(
    `INSERT INTO oauth_tokens (client_id, access_hash, refresh_hash, scopes, access_expires_at, refresh_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    clientId,
    sha256Hex(access),
    sha256Hex(refresh),
    scopesToString(scopes),
    addSeconds(ACCESS_TTL_SEC),
    addSeconds(REFRESH_TTL_SEC),
    nowIso(),
  );
  return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL_SEC, scopes };
}

/** 리프레시 토큰 회전: 쓰인 토큰은 폐기하고 새로 발급 */
export function refreshTokens(db: Db, refreshToken: string, clientId: string): IssuedTokens | null {
  return db.tx(() => {
    const row = db.get<{ id: number; client_id: string; scopes: string; refresh_expires_at: string | null; revoked_at: string | null }>(
      'SELECT id, client_id, scopes, refresh_expires_at, revoked_at FROM oauth_tokens WHERE refresh_hash = ?',
      sha256Hex(refreshToken),
    );
    if (!row || row.client_id !== clientId || row.revoked_at) return null;
    if (!row.refresh_expires_at || row.refresh_expires_at < nowIso()) return null;
    db.run('UPDATE oauth_tokens SET revoked_at = ? WHERE id = ?', nowIso(), row.id);
    return issueTokens(db, clientId, parseScopes(row.scopes));
  });
}

export function revokeByToken(db: Db, token: string, clientId: string): void {
  const h = sha256Hex(token);
  db.run(
    'UPDATE oauth_tokens SET revoked_at = ? WHERE (access_hash = ? OR refresh_hash = ?) AND client_id = ? AND revoked_at IS NULL',
    nowIso(),
    h,
    h,
    clientId,
  );
}

const TOUCH_INTERVAL_MS = 5 * 60_000;

function shouldTouch(last: string | null): boolean {
  return !last || Date.now() - Date.parse(last) > TOUCH_INTERVAL_MS;
}

/** Authorization: Bearer 값 검증 (OAuth 액세스 토큰 또는 개인 토큰) */
export function verifyBearer(db: Db, token: string): AuthInfo | null {
  if (!token) return null;
  const h = sha256Hex(token);
  if (token.startsWith('hub_pat_')) {
    const pat = db.get<{ id: number; name: string; scopes: string; last_used_at: string | null }>(
      'SELECT id, name, scopes, last_used_at FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL',
      h,
    );
    if (!pat) return null;
    if (shouldTouch(pat.last_used_at)) db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', nowIso(), pat.id);
    return { kind: 'pat', id: String(pat.id), source: pat.name, scopes: parseScopes(pat.scopes) };
  }
  const row = db.get<{ id: number; scopes: string; last_used_at: string | null; client_name: string; label: string | null }>(
    `SELECT t.id, t.scopes, t.last_used_at, c.client_name, c.label FROM oauth_tokens t
     JOIN oauth_clients c ON c.client_id = t.client_id
     WHERE t.access_hash = ? AND t.revoked_at IS NULL AND t.access_expires_at > ?`,
    h,
    nowIso(),
  );
  if (!row) return null;
  if (shouldTouch(row.last_used_at)) db.run('UPDATE oauth_tokens SET last_used_at = ? WHERE id = ?', nowIso(), row.id);
  return { kind: 'oauth', id: String(row.id), source: clientLabel(row), scopes: parseScopes(row.scopes) };
}
