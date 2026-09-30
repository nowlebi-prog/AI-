import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, startTestServer, type TestServer } from './helpers.ts';
import { pendingCount } from '../src/domain/proposals.ts';
import { listDecisions } from '../src/domain/decisions.ts';
import { getTask } from '../src/domain/tasks.ts';

let srv: TestServer;
let b: Browser;

before(async () => {
  srv = await startTestServer();
  b = new Browser(srv.base);
});
after(async () => {
  await srv.close();
});

test('로그인 전에는 로그인 화면으로 보낸다', async () => {
  const res = await b.get('/projects');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/login?next=%2Fprojects');
  assert.equal((await b.get('/healthz')).status, 200);
});

test('비밀번호가 틀리면 401, 맞으면 세션 쿠키', async () => {
  assert.equal((await b.login('wrong')).status, 401);
  const res = await b.login();
  assert.equal(res.status, 303);
  const cookie = res.headers.getSetCookie().join(';');
  assert.match(cookie, /hub_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const home = await b.get('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.match(await home.text(), /시작하기/);
});

test('CSRF 토큰 없이 보낸 폼은 거절한다', async () => {
  const res = await b.post('/projects', { name: '몰래 만든 프로젝트' });
  assert.equal(res.status, 403);
});

test('프로젝트 만들기 → 상세 화면에 브리핑과 메모 안내가 보인다 (이스케이프 포함)', async () => {
  const csrf = await b.csrf('/projects');
  const res = await b.post('/projects', { _csrf: csrf, name: '브랜드X <b>', summary: '비건 스킨케어' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/projects/1');
  const html = await (await b.get('/projects/1')).text();
  assert.ok(html.includes('브랜드X &lt;b&gt;'));
  assert.ok(!html.includes('브랜드X <b>'));
  assert.ok(html.includes('[Hub 메모]'));
  assert.ok(html.includes('data-copy-target="brief-text-M"'));
});

test('빠른 추가는 프로젝트·역할·마감을 읽는다', async () => {
  const csrf = await b.csrf('/');
  const res = await b.post('/quick-add', { _csrf: csrf, text: '브랜드X <b> 로고 시안 내일까지 #디자인' });
  assert.equal(res.status, 303);
  const t = getTask(srv.app.db, 1);
  assert.equal(t?.title, '로고 시안');
  assert.equal(t?.project_id, 1);
  assert.equal(t?.role, 'design');
  assert.ok(t?.due_date);
  assert.match(await (await b.get('/')).text(), /추가했어요: 로고 시안/);
});

test('할 일 상태 바꾸기', async () => {
  const csrf = await b.csrf('/');
  await b.post('/tasks/1/status', { _csrf: csrf, status: 'done', _back: '/projects/1' });
  assert.equal(getTask(srv.app.db, 1)?.status, 'done');
  await b.post('/tasks/1/status', { _csrf: csrf, status: 'todo', _back: '//evil.example' });
  assert.equal(getTask(srv.app.db, 1)?.status, 'todo');
});

test('붙여넣기 → 인박스 → 승인', async () => {
  const csrf = await b.csrf('/capture');
  const memo = `[Hub 메모]\n프로젝트: 브랜드X\n요약: 컬러 확정\n결정: 메인 컬러는 네이비 | 이유: 신뢰감\n할 일: 팔레트 정리 | 디자인\n위치: 팔레트 작업 전\n[/Hub 메모]`;
  const res = await b.post('/capture', { _csrf: csrf, text: memo, source: 'ChatGPT', project: '' });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('세션 요약 저장'));
  assert.ok(html.includes('인박스: 결정: 메인 컬러는 네이비'));
  assert.equal(pendingCount(srv.app.db), 2);

  const bad = await b.post('/capture', { _csrf: csrf, text: '그냥 대화', source: 'ChatGPT', project: '' });
  assert.equal(bad.status, 422);

  const inbox = await (await b.get('/inbox')).text();
  const ids = [...inbox.matchAll(/action="\/inbox\/(\d+)\/approve"/g)].map((m) => Number(m[1]));
  assert.ok(ids.length >= 2);
  await b.post(`/inbox/${ids[0]}/approve`, { _csrf: csrf, edit: '1', content: '메인 컬러는 딥 네이비', reason: '신뢰감' });
  const decisions = listDecisions(srv.app.db, 1);
  assert.equal(decisions[0]?.content, '메인 컬러는 딥 네이비');
  assert.equal(decisions[0]?.source, 'ChatGPT');
  await b.post('/inbox/approve-all', { _csrf: csrf });
  assert.equal(pendingCount(srv.app.db), 0);
});

test('개인 토큰은 만들 때 한 번만 보여준다', async () => {
  const csrf = await b.csrf('/settings');
  const res = await b.post('/settings/tokens', { _csrf: csrf, name: 'Muse', write: '1' });
  const html = await res.text();
  assert.match(html, /hub_pat_[A-Za-z0-9_-]{20,}/);
  const again = await (await b.get('/settings')).text();
  assert.doesNotMatch(again, /hub_pat_[A-Za-z0-9_-]{20,}/);
  assert.ok(again.includes('Muse'));
});

test('백업 다운로드는 SQLite 파일', async () => {
  const res = await b.get('/settings/backup');
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString('utf8'), 'SQLite format 3');
});

test('모든 기기 로그아웃은 기존 세션을 무효화한다', async () => {
  const csrf = await b.csrf('/settings');
  await b.post('/settings/logout-all', { _csrf: csrf });
  assert.equal((await b.get('/')).status, 303);
  await b.login();
  assert.equal((await b.get('/')).status, 200);
});
