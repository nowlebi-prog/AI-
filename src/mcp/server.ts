import type { Db } from '../db.ts';
import { verifyBearer, type AuthInfo } from '../auth/tokens.ts';
import { currentDay, getTimezone } from '../domain/clock.ts';
import { UserError } from '../domain/types.ts';
import { corsHeaders, readBody, sendJson, type Ctx } from '../lib/http.ts';
import { nowIso } from '../lib/time.ts';
import { runTool, toolListing } from './tools.ts';

/** 지원하는 MCP 프로토콜 버전 (최신순) */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const SERVER_INSTRUCTIONS = [
  'Hub는 사용자의 개인 작업 허브예요. 프로젝트, 결정, 할 일, AI 대화 기록, 레퍼런스 링크가 모여 있어요.',
  '- 대화가 특정 프로젝트에 관한 것이면 먼저 get_brief(project)로 최신 맥락을 확인하세요. 어떤 프로젝트인지 모르면 list_projects를 호출하세요.',
  '- 중요한 결정은 propose_decision, 새 할 일이나 할 일 변경은 propose_task로 제안하세요.',
  '- 사용자가 "추가해 줘", "완료 처리해 줘"처럼 직접 시킨 변경은 direct=true로 보내면 바로 반영돼요. 스스로 정리한 내용은 direct 없이 제안만 하세요.',
  '- 대화를 마칠 때 log_session으로 요약과 마지막 위치(다음에 이어서 할 지점)를 남겨 주세요.',
  '- 링크를 저장해 달라고 하면 save_reference, 예전에 본 사이트를 찾으면 find_references를 쓰세요.',
  '- 하루 마감 파일 정리: 파일 목록은 submit_files로 보내고, 지울 목록은 get_file_cleanup으로 받아서 사용자 확인 뒤 휴지통으로만 옮기세요.',
  '- 제안은 사용자가 Hub 인박스에서 승인해야 반영돼요. 승인 전에는 반영됐다고 말하지 마세요.',
  '- 번호 규칙: P=프로젝트, D=결정, T=할 일, L=세션 기록, R=레퍼런스, I=가져온 문서.',
].join('\n');

export interface McpDeps {
  db: Db;
  version: string;
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type RpcId = string | number;

interface RpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcError(id: RpcId | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function logCall(db: Db, entry: { client: string; method: string; tool: string | null; ok: boolean; error: string | null; ms: number }): void {
  const r = db.run(
    'INSERT INTO mcp_calls (at, client, method, tool, ok, error, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
    nowIso(),
    entry.client,
    entry.method,
    entry.tool,
    entry.ok,
    entry.error ? entry.error.slice(0, 500) : null,
    entry.ms,
  );
  if (r.lastInsertRowid % 100 === 0) db.run('DELETE FROM mcp_calls WHERE id <= ?', r.lastInsertRowid - 2000);
}

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  auth: AuthInfo,
  ctx: Ctx,
  deps: McpDeps,
  note: { tool: string | null; error: string | null },
): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'hub', title: 'Hub', version: deps.version },
        instructions: SERVER_INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: toolListing(auth.scopes) };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      note.tool = name || null;
      if (!toolListing(auth.scopes).some((t) => t.name === name)) {
        throw new RpcError(-32602, `알 수 없는 도구예요: ${name}`);
      }
      try {
        const text = await runTool(name, params.arguments ?? {}, {
          db: deps.db,
          auth,
          baseUrl: ctx.baseUrl,
          today: currentDay(deps.db),
          tz: getTimezone(deps.db),
        });
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        if (err instanceof UserError) {
          note.error = err.message;
          return { content: [{ type: 'text', text: err.message }], isError: true };
        }
        throw err;
      }
    }
    case 'resources/list':
      return { resources: [] };
    case 'resources/templates/list':
      return { resourceTemplates: [] };
    case 'prompts/list':
      return { prompts: [] };
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

async function handleMessage(m: unknown, auth: AuthInfo, ctx: Ctx, deps: McpDeps): Promise<Record<string, unknown> | null> {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return rpcError(null, -32600, 'Invalid Request');
  const msg = m as RpcMessage;
  const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null;
  if (msg.jsonrpc !== '2.0') return rpcError(id, -32600, 'Invalid Request');
  if (typeof msg.method !== 'string') return null; // 클라이언트가 보낸 응답은 무시
  if (msg.id === undefined) return null; // 알림(notification)
  if (id === null) return rpcError(null, -32600, 'Invalid Request: id가 필요해요');

  const started = Date.now();
  const note: { tool: string | null; error: string | null } = { tool: null, error: null };
  const params = msg.params && typeof msg.params === 'object' ? (msg.params as Record<string, unknown>) : {};
  try {
    const result = await dispatch(msg.method, params, auth, ctx, deps, note);
    logCall(deps.db, { client: auth.source, method: msg.method, tool: note.tool, ok: note.error === null, error: note.error, ms: Date.now() - started });
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    const rpc = err instanceof RpcError ? err : null;
    const message = rpc ? rpc.message : 'Internal error';
    if (!rpc) console.error('[mcp]', err);
    logCall(deps.db, { client: auth.source, method: msg.method, tool: note.tool, ok: false, error: rpc ? message : String(err), ms: Date.now() - started });
    return rpcError(id, rpc ? rpc.code : -32603, message);
  }
}

/** Streamable HTTP 엔드포인트 (무상태, JSON 응답) */
export async function handleMcp(ctx: Ctx, deps: McpDeps): Promise<void> {
  const cors = corsHeaders();
  if (ctx.method === 'OPTIONS') {
    ctx.res.writeHead(204, cors);
    ctx.res.end();
    return;
  }

  const authz = String(ctx.req.headers.authorization ?? '');
  const token = /^Bearer\s+(.+)$/i.exec(authz)?.[1]?.trim() ?? '';
  const auth = token ? verifyBearer(deps.db, token) : null;
  if (!auth) {
    const meta = `${ctx.baseUrl}/.well-known/oauth-protected-resource/mcp`;
    const extra = token ? ', error="invalid_token", error_description="token expired or invalid"' : '';
    sendJson(ctx, { error: token ? 'invalid_token' : 'unauthorized', error_description: 'Hub 토큰이 필요해요' }, 401, {
      ...cors,
      'WWW-Authenticate': `Bearer resource_metadata="${meta}", scope="hub:read hub:write"${extra}`,
    });
    return;
  }

  if (ctx.method !== 'POST') {
    sendJson(ctx, rpcError(null, -32000, 'Method not allowed: POST만 지원해요'), 405, { ...cors, Allow: 'POST, OPTIONS' });
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse((await readBody(ctx, 4_000_000)).toString('utf8'));
  } catch {
    sendJson(ctx, rpcError(null, -32700, 'Parse error'), 400, cors);
    return;
  }

  if (Array.isArray(body)) {
    if (!body.length) {
      sendJson(ctx, rpcError(null, -32600, 'Invalid Request'), 400, cors);
      return;
    }
    const out: Array<Record<string, unknown>> = [];
    for (const m of body) {
      const r = await handleMessage(m, auth, ctx, deps);
      if (r) out.push(r);
    }
    if (!out.length) {
      ctx.res.writeHead(202, cors);
      ctx.res.end();
      return;
    }
    sendJson(ctx, out, 200, cors);
    return;
  }

  const res = await handleMessage(body, auth, ctx, deps);
  if (!res) {
    ctx.res.writeHead(202, cors);
    ctx.res.end();
    return;
  }
  sendJson(ctx, res, 200, cors);
}
