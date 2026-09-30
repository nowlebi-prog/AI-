import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Browser, callTool, mcp, startTestServer, type TestServer } from './helpers.ts';
import { createPat } from '../src/auth/tokens.ts';
import { createProject } from '../src/domain/projects.ts';
import { listProposals, pendingCount, approveProposal } from '../src/domain/proposals.ts';
import { createTask, getTask } from '../src/domain/tasks.ts';
import { decideDayFiles, listDayFiles } from '../src/domain/wrapup.ts';
import { currentDay } from '../src/domain/clock.ts';

let srv: TestServer;
let pat: string;
let readOnly: string;

before(async () => {
  srv = await startTestServer();
  const db = srv.app.db;
  createProject(db, { name: '브랜드X', summary: '비건 스킨케어 리뉴얼', stage: '시안' });
  createTask(db, { project_id: 1, title: '로고 시안', role: 'design' }, '나');
  pat = createPat(db, 'Muse', new Set(['read', 'write'])).token;
  readOnly = createPat(db, '읽기전용', new Set(['read'])).token;
});
after(async () => {
  await srv.close();
});

test('토큰 없이 부르면 401과 리소스 메타데이터 위치를 알려준다', async () => {
  const res = await fetch(`${srv.base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  const h = res.headers.get('www-authenticate') ?? '';
  assert.match(h, /^Bearer resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  const bad = await mcp(srv.base, 'hub_pat_nope', { jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get('www-authenticate') ?? '', /invalid_token/);
});

test('initialize: 버전 협상과 서버 안내문', async () => {
  const r = await mcp(srv.base, pat, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.result.protocolVersion, '2025-06-18');
  assert.deepEqual(r.json.result.capabilities, { tools: { listChanged: false } });
  assert.match(r.json.result.instructions, /get_brief/);
  assert.equal(r.headers.get('mcp-session-id'), null);

  const future = await mcp(srv.base, pat, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
  assert.equal(future.json.result.protocolVersion, '2025-11-25');

  const note = await fetch(`${srv.base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(note.status, 202);

  const get = await fetch(`${srv.base}/mcp`, { headers: { Authorization: `Bearer ${pat}`, Accept: 'text/event-stream' } });
  assert.equal(get.status, 405);
});

test('tools/list: 권한에 따라 도구가 달라진다', async () => {
  const full = await mcp(srv.base, pat, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const names = full.json.result.tools.map((t: { name: string }) => t.name);
  assert.deepEqual(names, [
    'list_projects',
    'get_brief',
    'list_tasks',
    'recent_activity',
    'search',
    'fetch',
    'find_references',
    'save_reference',
    'get_file_cleanup',
    'submit_files',
    'propose_decision',
    'propose_task',
    'propose_project',
    'log_session',
  ]);
  const brief = full.json.result.tools.find((t: { name: string }) => t.name === 'get_brief');
  assert.equal(brief.annotations.readOnlyHint, true);
  assert.equal(brief.inputSchema.type, 'object');
  const ro = await mcp(srv.base, readOnly, { jsonrpc: '2.0', id: 4, method: 'tools/list' });
  assert.equal(ro.json.result.tools.length, 8);
  const denied = await mcp(srv.base, readOnly, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'propose_task', arguments: { title: 'x' } } });
  assert.equal(denied.json.error.code, -32602);
});

test('브리핑·목록·검색·가져오기', async () => {
  const list = await callTool(srv.base, pat, 'list_projects');
  assert.match(list.text, /\[P1\] 브랜드X · 비건 스킨케어 리뉴얼 · 단계: 시안 · 열린 할 일 1/);
  const overview = await callTool(srv.base, pat, 'get_brief');
  assert.match(overview.text, /# 전체 브리핑 · M/);
  const brief = await callTool(srv.base, pat, 'get_brief', { project: '브랜드', size: 's' });
  assert.match(brief.text, /# 브리핑: 브랜드X \(P1\) · S/);
  const missing = await callTool(srv.base, pat, 'get_brief', { project: '없는 프로젝트' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /찾을 수 없어요/);
  const tasks = await callTool(srv.base, pat, 'list_tasks', { role: 'design' });
  assert.match(tasks.text, /\[T1\] 로고 시안/);
  const found = JSON.parse((await callTool(srv.base, pat, 'search', { query: '로고' })).text);
  assert.equal(found.results[0].id, 'task:1');
  const doc = JSON.parse((await callTool(srv.base, pat, 'fetch', { id: found.results[0].id })).text);
  assert.match(doc.text, /할 일: 로고 시안/);
});

test('제안 도구는 인박스로, log_session은 바로 기록', async () => {
  const d = await callTool(srv.base, pat, 'propose_decision', { project: 'P1', content: '로고는 B안', reason: '선호도' });
  assert.match(d.text, /인박스에 올렸어요 \(제안 #\d+\)/);
  const t = await callTool(srv.base, pat, 'propose_task', { project: '브랜드X', title: '목업 제작', role: 'design', due: '다음 주 금요일' });
  assert.match(t.text, /인박스에 올렸어요/);
  const done = await callTool(srv.base, pat, 'propose_task', { task_id: 'T1', status: 'done' });
  assert.match(done.text, /\[T1\] "로고 시안" 변경/);
  const proj = await callTool(srv.base, pat, 'propose_project', { name: '앱 MVP', summary: '예약 앱' });
  assert.match(proj.text, /새 프로젝트 "앱 MVP"/);
  const bad = await callTool(srv.base, pat, 'propose_task', { title: '마감 이상', due: '언젠가' });
  assert.equal(bad.isError, true);
  const noArgs = await callTool(srv.base, pat, 'propose_decision', { project: 'P1' });
  assert.equal(noArgs.isError, true);
  assert.match(noArgs.text, /content: 필수/);

  assert.equal(pendingCount(srv.app.db), 4);
  const sources = new Set(listProposals(srv.app.db, 'pending').map((p) => p.source));
  assert.deepEqual([...sources], ['Muse']);

  const log = await callTool(srv.base, pat, 'log_session', {
    project: '브랜드X',
    summary: '로고와 목업 일정을 정리했다.',
    resume_note: '목업 착수 전',
    decisions: [{ content: '목업은 3종' }],
    tasks: [{ title: '패키지 목업', role: 'design', due: '2026-10-10' }],
    done_task_ids: [1],
  });
  assert.match(log.text, /세션을 기록했어요 \(L1\)/);
  assert.match(log.text, /마지막 위치를 저장했어요/);
  assert.match(log.text, /제안 3건/);

  const after = await callTool(srv.base, pat, 'get_brief', { project: 'P1' });
  assert.match(after.text, /## 마지막 위치\n목업 착수 전 \(Muse/);
  assert.match(after.text, /Muse: 로고와 목업 일정을 정리했다\./);

  // 승인하면 브리핑에 결정이 들어간다
  const decisionProposal = listProposals(srv.app.db, 'pending').find((p) => p.kind === 'decision');
  assert.ok(decisionProposal);
  approveProposal(srv.app.db, decisionProposal.id);
  assert.match((await callTool(srv.base, pat, 'get_brief', { project: 'P1' })).text, /\[D1\] 로고는 B안 — 이유: 선호도/);
});

test('배치 요청과 알 수 없는 메서드', async () => {
  const r = await mcp(srv.base, pat, [
    { jsonrpc: '2.0', id: 'a', method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'b', method: 'nope/nope' },
  ]);
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 2);
  assert.deepEqual(r.json[0], { jsonrpc: '2.0', id: 'a', result: {} });
  assert.equal(r.json[1].error.code, -32601);
  const parse = await fetch(`${srv.base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${pat}` }, body: '{oops' });
  assert.equal(parse.status, 400);
});

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function tokenRequest(params: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

test('OAuth: 메타데이터 → 등록 → 동의 → 토큰 → MCP → 갱신', async () => {
  const prm = await (await fetch(`${srv.base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${srv.base}/mcp`);
  assert.deepEqual(prm.authorization_servers, [srv.base]);
  const asm = await (await fetch(`${srv.base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(asm.code_challenge_methods_supported, ['S256']);

  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await fetch(asm.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] }),
  });
  assert.equal(reg.status, 201);
  const client = await reg.json();
  assert.ok(client.client_id);
  assert.equal(client.client_secret, undefined);

  const badReg = await fetch(asm.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
  assert.equal(badReg.status, 400);

  const { verifier, challenge } = pkce();
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    scope: 'hub:read hub:write',
    resource: `${srv.base}/mcp`,
  });

  const browser = new Browser(srv.base);
  const anon = await browser.get(`/oauth/authorize?${q}`);
  assert.equal(anon.status, 303);
  assert.match(anon.headers.get('location') ?? '', /^\/login\?next=%2Foauth%2Fauthorize/);

  await browser.login();
  const consent = await browser.get(`/oauth/authorize?${q}`);
  assert.equal(consent.status, 200);
  const html = await consent.text();
  assert.ok(html.includes('Claude'));
  const csrf = /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';

  const mismatch = await browser.get(`/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: 'https://evil.example/cb' })}`);
  assert.equal(mismatch.status, 400);

  const allow = await browser.post('/oauth/authorize', { ...Object.fromEntries(q), _csrf: csrf, decision: 'allow', write: '1', label: 'Claude 데스크톱' });
  assert.equal(allow.status, 302);
  const loc = new URL(allow.headers.get('location') ?? '');
  assert.equal(`${loc.origin}${loc.pathname}`, redirectUri);
  assert.equal(loc.searchParams.get('state'), 'xyz');
  assert.equal(loc.searchParams.get('iss'), srv.base);
  const code = loc.searchParams.get('code') ?? '';

  const wrong = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: pkce().verifier });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error, 'invalid_grant');

  // 코드는 한 번 쓰면 끝 (위에서 틀린 verifier로 소모됨) → 새로 받기
  const allow2 = await browser.post('/oauth/authorize', { ...Object.fromEntries(q), _csrf: csrf, decision: 'allow', write: '1' });
  const code2 = new URL(allow2.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const tok = await tokenRequest({ grant_type: 'authorization_code', code: code2, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource: `${srv.base}/mcp` });
  assert.equal(tok.status, 200);
  assert.equal(tok.json.token_type, 'Bearer');
  assert.equal(tok.json.scope, 'hub:read hub:write');
  assert.ok(tok.json.refresh_token);
  const reuse = await tokenRequest({ grant_type: 'authorization_code', code: code2, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier });
  assert.equal(reuse.status, 400);

  const call = await callTool(srv.base, tok.json.access_token, 'propose_task', { title: 'OAuth로 올린 할 일' });
  assert.match(call.text, /인박스에 올렸어요/);
  assert.equal(listProposals(srv.app.db, 'pending').at(-1)?.source, 'Claude 데스크톱');

  const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.json.refresh_token, client_id: client.client_id });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.json.access_token, tok.json.access_token);
  const replay = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.json.refresh_token, client_id: client.client_id });
  assert.equal(replay.status, 400);
  assert.equal((await mcp(srv.base, tok.json.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
  assert.equal((await mcp(srv.base, refreshed.json.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200);

  // 거부하면 access_denied로 돌려보낸다
  const deny = await browser.post('/oauth/authorize', { ...Object.fromEntries(q), _csrf: csrf, decision: 'deny' });
  assert.equal(new URL(deny.headers.get('location') ?? '').searchParams.get('error'), 'access_denied');

  // 연결 끊기(revoke)
  const rev = await fetch(`${srv.base}/oauth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshed.json.access_token, client_id: client.client_id }) });
  assert.equal(rev.status, 200);
  assert.equal((await mcp(srv.base, refreshed.json.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
});

test('OAuth: 비밀 키가 있는 클라이언트와 읽기 전용 동의', async () => {
  const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const reg = await (
    await fetch(`${srv.base}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [redirectUri], token_endpoint_auth_method: 'client_secret_basic' }),
    })
  ).json();
  assert.ok(reg.client_secret);
  const { verifier, challenge } = pkce();
  const q = { response_type: 'code', client_id: reg.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state: 's' };
  const browser = new Browser(srv.base);
  await browser.login();
  const csrf = await browser.csrf(`/oauth/authorize?${new URLSearchParams(q)}`);
  const allow = await browser.post('/oauth/authorize', { ...q, _csrf: csrf, decision: 'allow' }); // write 체크 해제
  const code = new URL(allow.headers.get('location') ?? '').searchParams.get('code') ?? '';

  const noSecret = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: verifier });
  assert.equal(noSecret.status, 401);
  assert.equal(noSecret.json.error, 'invalid_client');

  const allow2 = await browser.post('/oauth/authorize', { ...q, _csrf: csrf, decision: 'allow' });
  const code2 = new URL(allow2.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const basic = Buffer.from(`${encodeURIComponent(reg.client_id)}:${encodeURIComponent(reg.client_secret)}`).toString('base64');
  const tok = await tokenRequest({ grant_type: 'authorization_code', code: code2, redirect_uri: redirectUri, code_verifier: verifier }, { Authorization: `Basic ${basic}` });
  assert.equal(tok.status, 200);
  assert.equal(tok.json.scope, 'hub:read');
  const tools = await mcp(srv.base, tok.json.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(tools.json.result.tools.length, 8);
});

test('직접 요청·중복 방지·반복·대기·최근 활동', async () => {
  const add = await callTool(srv.base, pat, 'propose_task', { project: 'P1', title: '세금계산서 발행', repeat: '매월 10일', role: 'ops', direct: true });
  assert.match(add.text, /요청대로 바로 반영했어요/);
  const id = Number(/→ T(\d+)/.exec(add.text)?.[1]);
  const t = getTask(srv.app.db, id);
  assert.equal(t?.repeat, 'monthly:10');
  assert.equal(t?.source, 'Muse');
  const dup = await callTool(srv.base, pat, 'propose_task', { project: 'P1', title: '세금계산서 발행', direct: true });
  assert.match(dup.text, /이미 같은 할 일이 있어요 \(T\d+\)/);
  const wait = await callTool(srv.base, pat, 'propose_task', { task_id: id, waiting: '거래처 사업자번호 확인', direct: true });
  assert.match(wait.text, /바로 반영/);
  assert.match((await callTool(srv.base, pat, 'list_tasks', { status: 'waiting' })).text, /대기: 거래처 사업자번호 확인/);
  assert.match((await callTool(srv.base, pat, 'recent_activity', { days: 7 })).text, /# 최근 7일 활동/);
  assert.equal((await callTool(srv.base, pat, 'propose_task', { title: 'x', repeat: '가끔' })).isError, true);
});

test('레퍼런스 저장·찾기와 새 프로젝트 한 번에 제안', async () => {
  // 내부 주소라 미리보기를 가져오지 않는다 (인터넷에 나가지 않음)
  const saved = await callTool(srv.base, pat, 'save_reference', { url: 'http://127.0.0.1:1/pricing', title: '가격표 레이아웃', category: '디자인', note: '3단 요금제 표 참고', project: 'P1' });
  assert.match(saved.text, /레퍼런스에 저장했어요: \[R1\] 가격표 레이아웃 \(디자인\)/);
  assert.match((await callTool(srv.base, pat, 'save_reference', { url: 'http://127.0.0.1:1/pricing' })).text, /이미 저장된 링크예요/);
  assert.match((await callTool(srv.base, pat, 'find_references', { query: '요금제' })).text, /\[R1\] 가격표 레이아웃/);
  assert.match((await callTool(srv.base, pat, 'fetch', { id: 'R1' })).text, /3단 요금제 표 참고/);

  const proj = await callTool(srv.base, pat, 'propose_project', {
    name: '포트폴리오 사이트',
    kind: 'design',
    summary: '작업물 모음',
    decisions: [{ content: '노션 대신 자체 사이트' }],
    tasks: [{ title: '케이스 스터디 3개 정리', role: 'docs', due: '다음 주 금요일' }],
  });
  assert.match(proj.text, /새 프로젝트 "포트폴리오 사이트" \(결정 1, 할 일 1\)/);
  const p = listProposals(srv.app.db, 'pending').find((x) => x.kind === 'project' && x.payload.includes('포트폴리오 사이트'));
  assert.ok(p);
  approveProposal(srv.app.db, p.id);
  assert.match((await callTool(srv.base, pat, 'get_brief', { project: '포트폴리오' })).text, /케이스 스터디 3개 정리 · 문서·PPT/);
});

test('하루 마감 파일 정리: AI가 목록을 올리고, 사용자가 고르면 받아 간다', async () => {
  const none = await callTool(srv.base, pat, 'get_file_cleanup');
  assert.match(none.text, /정리할 파일 목록이 없어요/);
  const sent = await callTool(srv.base, pat, 'submit_files', { files: ['/Users/me/Downloads/a.png', '/Users/me/Downloads/b.zip', '메모'] });
  assert.match(sent.text, /파일 2개를 올렸어요/);
  assert.match((await callTool(srv.base, pat, 'get_file_cleanup')).text, /아직 남길 파일을 다 고르지 않았어요/);
  const files = listDayFiles(srv.app.db, currentDay(srv.app.db));
  decideDayFiles(srv.app.db, [files[0]?.id ?? 0], currentDay(srv.app.db));
  const plan = (await callTool(srv.base, pat, 'get_file_cleanup')).text;
  assert.match(plan, /\[삭제할 파일 1개\]\n- \/Users\/me\/Downloads\/b\.zip/);
  assert.match(plan, /\[남길 파일 1개\]\n- \/Users\/me\/Downloads\/a\.png/);
});
