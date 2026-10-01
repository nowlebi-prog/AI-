import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, startTestServer, type TestServer } from './helpers.ts';
import { pendingCount, propose } from '../src/domain/proposals.ts';
import { listDecisions, listLogs } from '../src/domain/decisions.ts';
import { getTask, listTasks } from '../src/domain/tasks.ts';
import { getSetting } from '../src/domain/profile.ts';
import { listActivity } from '../src/domain/activity.ts';
import { getRun } from '../src/domain/runs.ts';
import { SESSION_COOKIE, SESSION_MAX_AGE, signSession } from '../src/auth/session.ts';
import { createProject } from '../src/domain/projects.ts';
import { createTask, updateTask } from '../src/domain/tasks.ts';
import { currentDay } from '../src/domain/clock.ts';
import { addDays } from '../src/lib/time.ts';

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
  const res = await b.post('/projects', { _csrf: csrf, name: '브랜드X <b>', summary: '비건 스킨케어', kind: 'design' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/projects/1');
  const html = await (await b.get('/projects/1')).text();
  assert.ok(html.includes('브랜드X &lt;b&gt;'));
  assert.ok(!html.includes('브랜드X <b>'));
  assert.ok(html.includes('[Hub 메모]'));
  assert.ok(html.includes('data-copy-target="brief-text-M"'));
  assert.ok(html.includes('href="/run?project=1"'));
});

test('빠른 추가는 프로젝트·분야·마감을 읽는다', async () => {
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
  assert.match(await bad.text(), /메모 없이 세션 기록으로 저장/);

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

test('붙여넣기: 메모가 없으면 세션 기록으로만 저장할 수 있다', async () => {
  const csrf = await b.csrf('/capture');
  const res = await b.post('/capture', { _csrf: csrf, text: '긴 대화 내용…', source: 'Muse', project: '1', mode: 'log' });
  assert.equal(res.status, 303);
  assert.equal(listLogs(srv.app.db, { projectId: 1 })[0]?.source, 'Muse');
});

test('할 일 편집·미루기·대기·반복', async () => {
  const csrf = await b.csrf('/');
  await b.post('/tasks/1/edit', { _csrf: csrf, title: '로고 시안 2종', role: 'design', priority: '1', due_date: '2026-10-09', repeat: '매주 월', note: '컬러 2안', project_id: '1' });
  let t = getTask(srv.app.db, 1);
  assert.deepEqual([t?.title, t?.priority, t?.due_date, t?.repeat, t?.note], ['로고 시안 2종', 1, '2026-10-09', 'weekly:0', '컬러 2안']);
  await b.post('/tasks/1/snooze', { _csrf: csrf, to: 'none' });
  assert.equal(getTask(srv.app.db, 1)?.due_date, null);
  await b.post('/tasks/1/waiting', { _csrf: csrf, mode: 'set', waiting: '클라이언트 피드백' });
  assert.equal(getTask(srv.app.db, 1)?.waiting, '클라이언트 피드백');
  assert.match(await (await b.get('/')).text(), /대기 중/);
  await b.post('/tasks/1/waiting', { _csrf: csrf, mode: 'clear' });
  assert.equal(getTask(srv.app.db, 1)?.waiting, '');
  await b.post('/tasks/1/status', { _csrf: csrf, status: 'done' });
  t = getTask(srv.app.db, 1);
  assert.ok(t?.next_task_id, '반복 할 일은 다음 차례가 생겨야 해요');
  assert.match(await (await b.get('/')).text(), /다음 차례를 만들었어요/);
});

test('빠른 추가 미리보기와 여러 줄 추가', async () => {
  const pre = await (await b.get(`/quick-add/preview?text=${encodeURIComponent('매주 월요일 주간 리포트 #마케팅 !')}`)).json();
  assert.equal(pre.title, '주간 리포트');
  assert.equal(pre.role, '마케팅');
  assert.equal(pre.repeat, '매주 월');
  assert.equal(pre.priority, '긴급');
  const csrf = await b.csrf('/');
  const before = listTasks(srv.app.db, { projectId: 1, status: 'open', today: '2026-01-01' }).length;
  await b.post('/quick-add', { _csrf: csrf, lines: '- 패키지 목업\n- 인쇄 견적 받기 #운영\n\n', project: '1' });
  assert.equal(listTasks(srv.app.db, { projectId: 1, status: 'open', today: '2026-01-01' }).length, before + 2);
});

test('대시보드·검색·레퍼런스 화면', async () => {
  const dash = await b.get('/dashboard');
  assert.equal(dash.status, 200);
  const dh = await dash.text();
  assert.match(dh, /대시보드/);
  assert.match(dh, /프로젝트 × 분야/);
  assert.doesNotMatch(dh, /style="/); // CSP 때문에 인라인 스타일을 쓰지 않는다

  const csrf = await b.csrf('/refs');
  // 내부 주소라 미리보기를 가져오지 않는다 (테스트가 인터넷에 나가지 않게)
  const saved = await b.post('/refs', { _csrf: csrf, url: 'http://127.0.0.1:9/landing?utm_source=x', category: '', note: '히어로 섹션 레이아웃 좋음', tags: '랜딩 히어로', project: '1' });
  assert.equal(saved.status, 303);
  const list = await (await b.get('/refs?q=히어로')).text();
  assert.match(list, /히어로 섹션 레이아웃 좋음/);
  assert.match(list, /#랜딩/);
  const again = await b.post('/refs', { _csrf: csrf, url: 'http://127.0.0.1:9/landing', note: '다른 메모' });
  assert.equal(again.status, 303);
  assert.match(await (await b.get('/refs')).text(), /이미 저장된 링크예요/);

  const found = await (await b.get(`/search?q=${encodeURIComponent('히어로')}`)).text();
  assert.match(found, /레퍼런스/);
  assert.match(found, /\[R1\]/);
});

test('브리핑·활동 텍스트 (복사 버튼용)', async () => {
  const p = await b.get('/projects/1/brief.txt?size=S');
  assert.match(p.headers.get('content-type') ?? '', /text\/plain/);
  assert.match(await p.text(), /# 브리핑: 브랜드X <b> \(P1\) · S/);
  assert.match(await (await b.get('/brief.txt?size=M')).text(), /# 전체 브리핑 · M/);
  assert.match(await (await b.get('/activity.txt?days=7')).text(), /# 최근 7일 활동/);
});

test('캘린더 구독: 비밀 주소로만 열린다', async () => {
  const csrf = await b.csrf('/settings');
  await b.post('/settings/calendar', { _csrf: csrf, action: 'create' });
  const token = getSetting(srv.app.db, 'calendar_token') ?? '';
  assert.ok(token.length > 20);
  const ics = await fetch(`${srv.base}/calendar/${token}.ics`);
  assert.match(ics.headers.get('content-type') ?? '', /text\/calendar/);
  const body = await ics.text();
  assert.match(body, /BEGIN:VCALENDAR/);
  assert.equal((await fetch(`${srv.base}/calendar/wrong.ics`)).status, 404);
  await b.post('/settings/calendar', { _csrf: csrf, action: 'off' });
  assert.equal((await fetch(`${srv.base}/calendar/${token}.ics`)).status, 404);
});

test('앱으로 설치(매니페스트·아이콘)', async () => {
  const m = await (await fetch(`${srv.base}/manifest.webmanifest`)).json();
  assert.equal(m.name, 'Hub');
  assert.equal(m.display, 'standalone');
  const icon = await fetch(`${srv.base}/static/icon-512.png`);
  assert.equal(icon.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await icon.arrayBuffer()).readUInt32BE(16), 512);
});

test('인박스 변경 기록에서 되돌리기', async () => {
  const r = propose(srv.app.db, { kind: 'task', projectId: 1, payload: { title: 'AI가 바로 만든 할 일', role: 'etc', priority: 2, due_date: null, note: '' } }, 'Claude', { direct: true });
  assert.ok(r.applied);
  const html = await (await b.get('/inbox')).text();
  assert.match(html, /할 일 추가 \[T\d+\] AI가 바로 만든 할 일/);
  const act = listActivity(srv.app.db)[0];
  const csrf = await b.csrf('/inbox');
  await b.post(`/activity/${act?.id}/undo`, { _csrf: csrf });
  assert.equal(getTask(srv.app.db, r.resultId ?? 0), undefined);
});

test('자동화 설정 저장', async () => {
  const csrf = await b.csrf('/settings');
  await b.post('/settings/automation', { _csrf: csrf, day_start_hour: '4', kinds: ['task'] });
  assert.equal(getSetting(srv.app.db, 'direct_apply'), '0');
  assert.equal(getSetting(srv.app.db, 'day_start_hour'), '4');
  assert.equal(getSetting(srv.app.db, 'auto_approve'), '["task"]');
  await b.post('/settings/automation', { _csrf: csrf, day_start_hour: '0', direct_apply: '1' });
  assert.equal(getSetting(srv.app.db, 'direct_apply'), '1');
});

test('월간 달력: 분야 필터와 진행도', async () => {
  const day = currentDay(srv.app.db);
  const p = createProject(srv.app.db, { name: 'IR 자료', kind: 'docs' });
  const t1 = createTask(srv.app.db, { project_id: p.id, title: '표지 장표', role: 'docs', due_date: day }, '나');
  createTask(srv.app.db, { project_id: p.id, title: '재무 장표', role: 'docs', due_date: day }, '나');
  updateTask(srv.app.db, t1.id, { status: 'done' });
  const html = await (await b.get(`/calendar?month=${day.slice(0, 7)}&role=docs`)).text();
  assert.match(html, /월간 달력/);
  assert.match(html, /표지 장표/);
  assert.match(html, /이번 달 진행도/);
  assert.match(html, /50%/); // 2개 중 1개 완료
  assert.doesNotMatch(html, /style="/);
  const next = await b.get(`/calendar?month=2027-01`);
  assert.match(await next.text(), /2027년 1월/);
  assert.match(await (await b.get('/projects')).text(), /class="pct">50%/);
});

test('하루 마감: 넘기기·Hub 정리·파일 정리·마감', async () => {
  const day = currentDay(srv.app.db);
  const left = createTask(srv.app.db, { project_id: null, title: '오늘 못 끝낸 일', due_date: day }, '나');
  const csrf = await b.csrf('/wrapup');
  let html = await (await b.get('/wrapup')).text();
  assert.match(html, /오늘 못 끝낸 일/);
  await b.post('/wrapup/snooze', { _csrf: csrf, ids: [String(left.id)], to: 'tomorrow' });
  assert.equal(getTask(srv.app.db, left.id)?.due_date, addDays(day, 1));

  await b.post('/wrapup/files', { _csrf: csrf, text: '/Users/me/Downloads/시안_최종.png\n/Users/me/Downloads/임시 캡처.png\n~/Desktop/it\'s.pdf\n그냥 텍스트' });
  html = await (await b.get('/wrapup')).text();
  const ids = [...html.matchAll(/name="keep" value="(\d+)"/g)].map((m) => m[1] ?? '');
  assert.equal(ids.length, 3);
  await b.post('/wrapup/files/decide', { _csrf: csrf, keep: [ids[1] ?? ''] }); // 경로 순 정렬: 두 번째(시안_최종) 남김
  html = await (await b.get('/wrapup')).text();
  assert.match(html, /삭제 2개 · 남김 1개/);
  assert.match(html, /\[삭제할 파일 2개\]/);
  assert.match(html, /hub_trash ~\/&#39;Desktop\/it&#39;\\&#39;&#39;s\.pdf&#39;/); // 작은따옴표가 든 이름도 안전하게
  assert.match(html, /SendToRecycleBin/);

  await b.post('/wrapup/done', { _csrf: csrf, note: '시안 확정, 내일은 목업부터' });
  assert.equal(getSetting(srv.app.db, 'wrapup_done'), day);
  assert.match(listLogs(srv.app.db, { limit: 1 })[0]?.summary ?? '', /하루 마감.*시안 확정/);
});

test('AI 실행: 추천 → 앱에서 열기', async () => {
  createProject(srv.app.db, { name: '뉴스레터' });
  const csrf = await b.csrf('/run');
  const res = await b.post('/run', { _csrf: csrf, request: '뉴스레터 구독 유도 인스타 카피 5개 써줘', project: '' });
  assert.equal(res.status, 303);
  const loc = res.headers.get('location') ?? '';
  assert.match(loc, /^\/run\/\d+$/);
  const html = await (await b.get(loc)).text();
  assert.match(html, /글·카피/);
  assert.match(html, /https:\/\/chatgpt\.com\/\?q=/);
  assert.match(html, /OPENAI_API_KEY를 설정하면/); // 키가 없으면 API 실행 버튼은 비활성
  const id = Number(loc.split('/').pop());
  assert.equal(getRun(srv.app.db, id)?.project_name, '뉴스레터'); // 요청 속 프로젝트 이름을 찾았다
  const mark = await b.post(`/run/${id}/handoff`, { _csrf: csrf, ai: 'chatgpt', model: 'gpt-6-sol' }, { 'X-Requested-With': 'fetch' });
  assert.equal(mark.status, 204);
  assert.equal(getRun(srv.app.db, id)?.status, 'handed_off');
  assert.match(await (await b.get(loc)).text(), /ChatGPT에서 열었어요/);
});

test('쓰는 동안에는 로그인이 자동으로 연장된다', async () => {
  const old = signSession(srv.app.ctx.secret, '0', SESSION_MAX_AGE - 3 * 86_400);
  const res = await fetch(`${srv.base}/`, { headers: { Cookie: `${SESSION_COOKIE}=${old}` }, redirect: 'manual' });
  assert.equal(res.status, 200);
  const renewed = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(renewed, '연장된 쿠키가 와야 해요');
  const nonceOf = (v: string) => decodeURIComponent(v).split('.')[1];
  assert.equal(nonceOf(renewed.split(';')[0]?.split('=')[1] ?? ''), nonceOf(old)); // CSRF 토큰 유지
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

test('백업: 다운로드와 매일 자동 백업', async () => {
  const res = await b.get('/settings/backup');
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString('utf8'), 'SQLite format 3');
  const settings = await (await b.get('/settings')).text();
  const name = /\/settings\/backups\/(hub-\d{4}-\d{2}-\d{2}\.db)/.exec(settings)?.[1];
  assert.ok(name, '시작할 때 자동 백업이 하나 있어야 해요');
  assert.equal((await b.get(`/settings/backups/${name}`)).status, 200);
  assert.equal((await b.get('/settings/backups/..%2Fhub.db')).status, 400);
});

test('모든 기기 로그아웃은 기존 세션을 무효화한다', async () => {
  const csrf = await b.csrf('/settings');
  await b.post('/settings/logout-all', { _csrf: csrf });
  assert.equal((await b.get('/')).status, 303);
  await b.login();
  assert.equal((await b.get('/')).status, 200);
});
