import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.ts';
import { createProject, getProject, resolveProject, setResumeNote } from '../src/domain/projects.ts';
import { createTask, getTask, todayBoard, updateTask } from '../src/domain/tasks.ts';
import { createDecision, getDecision, listDecisions } from '../src/domain/decisions.ts';
import { approveProposal, listProposals, pendingCount, propose, rejectProposal } from '../src/domain/proposals.ts';
import { setAutoApprove, saveProfile, setSetting } from '../src/domain/profile.ts';
import { overviewBrief, projectBrief } from '../src/domain/brief.ts';
import { fetchDoc, search } from '../src/domain/search.ts';
import { applyMemo, parseMemos, recordSession } from '../src/domain/capture.ts';
import { activityReport, listActivity, undoActivity } from '../src/domain/activity.ts';
import { createReference, listReferences, refCategories } from '../src/domain/references.ts';
import { dueHistogram, projectStats, roleStats } from '../src/domain/dashboard.ts';
import { currentDay } from '../src/domain/clock.ts';
import { buildIcs } from '../src/domain/calendar.ts';
import { UserError } from '../src/domain/types.ts';
import { addDays, todayIn } from '../src/lib/time.ts';

const TZ = 'Asia/Seoul';

function fresh(): Db {
  return new Db(':memory:');
}

test('프로젝트 참조 해석: 번호·이름·부분 일치', () => {
  const db = fresh();
  const a = createProject(db, { name: '브랜드X 리뉴얼' });
  const b = createProject(db, { name: '앱 MVP' });
  createProject(db, { name: '앱 마케팅' });
  assert.equal(resolveProject(db, `P${a.id}`).id, a.id);
  assert.equal(resolveProject(db, String(b.id)).id, b.id);
  assert.equal(resolveProject(db, '브랜드x 리뉴얼').id, a.id);
  assert.equal(resolveProject(db, '브랜드').id, a.id);
  assert.throws(() => resolveProject(db, '앱'), /여러 개/);
  assert.throws(() => resolveProject(db, '없는거'), /찾을 수 없어요/);
  assert.throws(() => createProject(db, { name: '앱 mvp' }), /이미 있어요/);
  assert.throws(() => createProject(db, { name: 'Z', kind: '요리' }), /분야/);
  assert.equal(createProject(db, { name: 'IR 자료', kind: 'PPT' }).kind, 'docs');
});

test('결정 대체(supersede)', () => {
  const db = fresh();
  const p = createProject(db, { name: 'P' });
  const d1 = createDecision(db, { project_id: p.id, content: '컬러는 블루' }, '나');
  const d2 = createDecision(db, { project_id: p.id, content: '컬러는 네이비', supersedes: d1.id }, 'Claude');
  assert.equal(getDecision(db, d1.id)?.superseded_by, d2.id);
  assert.deepEqual(listDecisions(db, p.id).map((d) => d.id), [d2.id]);
  assert.throws(() => createDecision(db, { project_id: p.id, content: 'x', supersedes: d1.id }, '나'), /이미 D/);
  const other = createProject(db, { name: 'Q' });
  assert.throws(() => createDecision(db, { project_id: other.id, content: 'x', supersedes: d2.id }, '나'), /이 프로젝트의 결정이 아니에요/);
});

test('제안 → 승인/거절, 자동 승인, 중복 방지', () => {
  const db = fresh();
  const p = createProject(db, { name: '브랜드X' });
  const r1 = propose(db, { kind: 'decision', projectId: p.id, payload: { content: '로고는 B안', reason: '선호도', supersedes: null } }, 'Claude');
  assert.equal(r1.applied, false);
  assert.equal(pendingCount(db), 1);
  const decisionId = approveProposal(db, r1.id);
  assert.equal(getDecision(db, decisionId)?.source, 'Claude');
  assert.equal(pendingCount(db), 0);
  assert.throws(() => approveProposal(db, r1.id), UserError);

  const task = { title: '시안', role: 'design' as const, priority: 2 as const, due_date: null, note: '' };
  const r2 = propose(db, { kind: 'task', projectId: p.id, payload: task }, 'ChatGPT');
  rejectProposal(db, r2.id);
  assert.equal(listProposals(db, 'resolved')[0]?.status, 'rejected');

  const r3 = propose(db, { kind: 'task', projectId: p.id, payload: task }, 'ChatGPT');
  // 같은 제목이 인박스에 있으면 다시 올리지 않는다
  const dupPending = propose(db, { kind: 'task', projectId: p.id, payload: { ...task, title: '시안 ' } }, 'Grok');
  assert.deepEqual(dupPending.duplicate, { type: 'proposal', id: r3.id, title: '시안 ' });
  const taskId = approveProposal(db, r3.id, { overrides: { title: '시안 3종', due_date: '2026-10-03' } });
  assert.equal(getTask(db, taskId)?.title, '시안 3종');
  assert.equal(getTask(db, taskId)?.due_date, '2026-10-03');
  assert.equal(propose(db, { kind: 'task', projectId: p.id, payload: { ...task, title: '시안3종' } }, 'Grok').duplicate?.type, 'task');
  assert.equal(propose(db, { kind: 'decision', projectId: p.id, payload: { content: '로고는 B안!', reason: '', supersedes: null } }, 'Grok').duplicate?.type, 'decision');

  const r4 = propose(db, { kind: 'task_update', projectId: p.id, payload: { task_id: taskId, changes: { status: 'done' } } }, 'Grok');
  approveProposal(db, r4.id);
  assert.equal(getTask(db, taskId)?.status, 'done');
  assert.ok(getTask(db, taskId)?.done_at);

  setAutoApprove(db, ['task']);
  const r5 = propose(db, { kind: 'task', projectId: null, payload: { title: '메일 회신', role: 'ops', priority: 1, due_date: null, note: '' } }, 'Muse');
  assert.equal(r5.applied, true);
  assert.equal(r5.via, 'auto');
  assert.equal(getTask(db, r5.resultId ?? 0)?.source, 'Muse');

  assert.throws(() => propose(db, { kind: 'project', projectId: null, payload: { name: '브랜드x', fields: {} } }, 'Claude'), /이미 있어요/);
});

test('직접 요청(direct)은 바로 반영되고, 변경 기록으로 되돌릴 수 있다', () => {
  const db = fresh();
  const p = createProject(db, { name: '브랜드X', stage: '시안' });
  const old = createDecision(db, { project_id: p.id, content: '컬러는 블루' }, '나');

  const t = propose(db, { kind: 'task', projectId: p.id, payload: { title: '목업', role: 'design', priority: 2, due_date: null, note: '' } }, 'Claude', { direct: true });
  assert.equal(t.applied, true);
  assert.equal(t.via, 'direct');
  const d = propose(db, { kind: 'decision', projectId: p.id, payload: { content: '컬러는 네이비', reason: '', supersedes: old.id } }, 'Claude', { direct: true });
  const u = propose(db, { kind: 'project_update', projectId: p.id, payload: { changes: { stage: 'QA' } } }, 'Claude', { direct: true });
  assert.equal(getProject(db, p.id)?.stage, 'QA');
  assert.equal(listDecisions(db, p.id).length, 1);

  const acts = listActivity(db);
  assert.deepEqual(acts.map((a) => a.action), ['project.update', 'decision.create', 'task.create']);
  undoActivity(db, acts[0]?.id ?? 0);
  assert.equal(getProject(db, p.id)?.stage, '시안');
  undoActivity(db, acts[1]?.id ?? 0);
  assert.equal(getDecision(db, d.resultId ?? 0), undefined);
  assert.equal(getDecision(db, old.id)?.superseded_by, null); // 대체됐던 결정이 다시 유효
  undoActivity(db, acts[2]?.id ?? 0);
  assert.equal(getTask(db, t.resultId ?? 0), undefined);
  assert.throws(() => undoActivity(db, acts[2]?.id ?? 0), /이미 되돌렸어요/);

  // 설정에서 끄면 직접 요청도 인박스로
  setSetting(db, 'direct_apply', '0');
  const later = propose(db, { kind: 'task', projectId: p.id, payload: { title: '다른 일', role: 'etc', priority: 2, due_date: null, note: '' } }, 'Claude', { direct: true });
  assert.equal(later.applied, false);
  assert.ok(u.applied);
});

test('반복 할 일: 완료하면 다음 차례가 생기고, 완료 취소하면 사라진다', () => {
  const db = fresh();
  const today = currentDay(db);
  const t = createTask(db, { project_id: null, title: '주간 리포트', repeat: 'daily', due_date: today }, '나');
  const r = updateTask(db, t.id, { status: 'done' });
  assert.ok(r.spawned);
  assert.equal(r.spawned?.due_date, addDays(today, 1));
  assert.equal(r.spawned?.repeat, 'daily');
  assert.equal(getTask(db, t.id)?.next_task_id, r.spawned?.id);
  // 다시 완료→취소→완료해도 두 번 만들지 않는다
  const back = updateTask(db, t.id, { status: 'todo' });
  assert.equal(back.removedSpawn, r.spawned?.id);
  assert.equal(getTask(db, r.spawned?.id ?? 0), undefined);
  const again = updateTask(db, t.id, { status: 'done' });
  assert.ok(again.spawned);

  // 반복 완료를 AI가 했으면 되돌리기로 다음 차례까지 지운다
  const w = createTask(db, { project_id: null, title: '세금계산서 확인', repeat: 'monthly:10', due_date: today }, '나');
  const pr = propose(db, { kind: 'task_update', projectId: null, payload: { task_id: w.id, changes: { status: 'done' } } }, 'Claude', { direct: true });
  const spawnedId = getTask(db, w.id)?.next_task_id ?? 0;
  assert.ok(getTask(db, spawnedId));
  undoActivity(db, listActivity(db)[0]?.id ?? 0);
  assert.equal(getTask(db, w.id)?.status, 'todo');
  assert.equal(getTask(db, spawnedId), undefined);
  assert.ok(pr.applied);
});

test('대기 중인 할 일은 따로 모인다', () => {
  const db = fresh();
  const today = currentDay(db);
  createTask(db, { project_id: null, title: '지난 일', due_date: addDays(today, -2) }, '나');
  const w = createTask(db, { project_id: null, title: '피드백 대기', due_date: addDays(today, -1), waiting: '클라이언트 피드백' }, '나');
  const b = todayBoard(db, today);
  assert.deepEqual(b.overdue.map((t) => t.title), ['지난 일']);
  assert.deepEqual(b.waiting.map((t) => t.id), [w.id]);
  updateTask(db, w.id, { status: 'done' });
  assert.equal(getTask(db, w.id)?.waiting, ''); // 완료하면 대기 해제
});

test('하루 시작 시각: 새벽 작업은 전날로 친다', () => {
  const db = fresh();
  const at2am = new Date('2026-09-30T17:30:00Z'); // 한국 10/1 02:30
  assert.equal(currentDay(db, at2am), '2026-10-01');
  setSetting(db, 'day_start_hour', '4');
  assert.equal(currentDay(db, at2am), '2026-09-30');
});

test('새 프로젝트 제안에 결정·할 일을 함께 넣으면 한 번에 승인된다', () => {
  const db = fresh();
  const r = propose(
    db,
    {
      kind: 'project',
      projectId: null,
      payload: {
        name: '뉴스레터',
        kind: 'marketing',
        fields: { summary: '월간 작업 기록' },
        decisions: [{ content: '매월 첫째 주 발송' }],
        tasks: [{ title: '구독 폼 만들기', role: 'dev', priority: 2, due_date: null, note: '' }],
      },
    },
    'Claude',
  );
  const pid = approveProposal(db, r.id);
  const p = getProject(db, pid);
  assert.equal(p?.kind, 'marketing');
  assert.equal(listDecisions(db, pid)[0]?.content, '매월 첫째 주 발송');
  assert.match(projectBrief(db, pid, { size: 'M', mode: 'mcp', today: currentDay(db), tz: TZ }), /구독 폼 만들기/);
});

test('브리핑: 크기별 구성과 붙여넣기 모드', () => {
  const db = fresh();
  const today = todayIn(TZ);
  saveProfile(db, { name: '민지', about: '1인 스튜디오 운영', preferences: '한국어로 짧게' });
  const p = createProject(db, { name: '브랜드X', summary: '비건 스킨케어 리뉴얼', stage: '시안', goal: '10월 런칭', kind: 'design' });
  createDecision(db, { project_id: p.id, content: '로고는 B안', reason: '선호도' }, 'Claude');
  createTask(db, { project_id: p.id, title: '상세페이지 시안', role: 'design', due_date: today, repeat: 'weekly:0' }, '나');
  setResumeNote(db, p.id, '시안 2까지 완료', 'Claude');
  recordSession(db, { projectId: p.id, summary: '로고 방향 논의', resume: '', decisions: [], tasks: [], doneTaskIds: [] }, 'ChatGPT');
  createReference(db, { url: 'https://dribbble.com/shots/1', title: '비건 패키지', project_id: p.id }, '나');

  const m = projectBrief(db, p.id, { size: 'M', mode: 'mcp', today, tz: TZ });
  for (const s of ['# 브리핑: 브랜드X (P1) · M', '## 나', '민지 — 1인 스튜디오 운영', '분야: 디자인', '목표: 10월 런칭', '## 마지막 위치', '시안 2까지 완료', '[D1] 로고는 B안 — 이유: 선호도', '[T1] 상세페이지 시안 · 디자인 · 마감 오늘 · 반복 매주 월', '## 최근 세션', 'ChatGPT: 로고 방향 논의', '## Hub 사용 규칙', 'direct=true']) {
    assert.ok(m.includes(s), `M 브리핑에 '${s}'가 있어야 해요\n${m}`);
  }
  assert.ok(!m.includes('## 레퍼런스'));
  assert.match(projectBrief(db, p.id, { size: 'L', mode: 'mcp', today, tz: TZ }), /## 레퍼런스\n- \[R1\] 비건 패키지 \(디자인\)/);
  const s = projectBrief(db, p.id, { size: 'S', mode: 'mcp', today, tz: TZ });
  assert.ok(s.length < m.length);
  assert.ok(!s.includes('## Hub 사용 규칙'));
  const paste = projectBrief(db, p.id, { size: 'S', mode: 'paste', today, tz: TZ });
  assert.ok(paste.includes('[Hub 메모]') && paste.includes('프로젝트: 브랜드X'));
  const all = overviewBrief(db, { size: 'M', mode: 'mcp', today, tz: TZ });
  assert.ok(all.includes('[P1] 브랜드X'));
  assert.ok(all.includes('[T1] 상세페이지 시안'));
});

test('검색과 항목 가져오기 (레퍼런스 포함)', () => {
  const db = fresh();
  const ctx = { baseUrl: 'https://hub.test', today: todayIn(TZ), tz: TZ };
  const p = createProject(db, { name: '브랜드X' });
  createDecision(db, { project_id: p.id, content: '메인 컬러는 네이비', reason: '신뢰감' }, '나');
  createTask(db, { project_id: p.id, title: '네이비 팔레트 정리' }, '나');
  createReference(db, { url: 'https://coolors.co/palette/navy', title: 'Navy palette', note: '네이비 톤 참고' }, '나');
  const hits = search(db, '네이비', ctx.baseUrl);
  assert.deepEqual(hits.map((h) => h.id).sort(), ['decision:1', 'ref:1', 'task:1']);
  assert.equal(search(db, '네이비 신뢰감', ctx.baseUrl).length, 1);
  assert.equal(search(db, '100%', ctx.baseUrl).length, 0);
  assert.ok(fetchDoc(db, 'D1', ctx).text.includes('이유: 신뢰감'));
  assert.ok(fetchDoc(db, 'R1', ctx).text.includes('https://coolors.co/palette/navy'));
  assert.ok(fetchDoc(db, 'project:1', ctx).text.includes('# 브리핑: 브랜드X'));
  assert.throws(() => fetchDoc(db, 'x:1', ctx), /형식/);
  assert.throws(() => fetchDoc(db, 'task:99', ctx), /없어요/);
});

test('레퍼런스: 같은 링크는 합치고, 카테고리·태그·검색으로 찾는다', () => {
  const db = fresh();
  const p = createProject(db, { name: '브랜드X' });
  const a = createReference(db, { url: 'https://www.dribbble.com/shots/9?utm_source=x', title: '패키지 레퍼런스', tags: '패키지 #비건' }, '나');
  assert.equal(a.created, true);
  assert.equal(a.ref.category, '디자인');
  const again = createReference(db, { url: 'dribbble.com/shots/9', note: '색 조합 좋음', project_id: p.id }, 'Claude');
  assert.equal(again.created, false);
  assert.equal(again.ref.note, '색 조합 좋음');
  assert.equal(again.ref.project_id, p.id);
  createReference(db, { url: 'https://github.com/x/y', title: '예약 라이브러리' }, 'Claude');
  assert.equal(listReferences(db, { q: '색 조합' }).length, 1);
  assert.equal(listReferences(db, { category: '개발' })[0]?.title, '예약 라이브러리');
  assert.equal(listReferences(db, { tag: '비건' }).length, 1);
  assert.equal(listReferences(db, { projectId: p.id }).length, 1);
  assert.equal(refCategories(db).find((c) => c.category === '디자인')?.n, 1);
  // AI가 저장한 건 되돌릴 수 있다
  const act = listActivity(db).find((x) => x.action === 'reference.create');
  assert.ok(act);
  undoActivity(db, act.id);
  assert.equal(listReferences(db, { category: '개발' }).length, 0);
});

test('대시보드 집계: 분야별·프로젝트별·날짜별', () => {
  const db = fresh();
  const today = currentDay(db);
  const p = createProject(db, { name: '앱', kind: 'dev' });
  createTask(db, { project_id: p.id, title: 'API', role: 'dev', due_date: addDays(today, -1) }, '나');
  createTask(db, { project_id: p.id, title: '와이어프레임', role: 'plan', due_date: addDays(today, 2) }, '나');
  const done = createTask(db, { project_id: p.id, title: '기획서', role: 'docs' }, '나');
  updateTask(db, done.id, { status: 'done' });
  const stats = roleStats(db, today);
  assert.deepEqual(stats.find((s) => s.role === 'dev'), { role: 'dev', open: 1, overdue: 1, week: 0, doing: 0, waiting: 0, doneWeek: 0 });
  assert.equal(stats.find((s) => s.role === 'docs')?.doneWeek, 1);
  const ps = projectStats(db, today)[0];
  assert.deepEqual([ps?.overdue, ps?.done30, ps?.byRole.dev, ps?.byRole.plan, ps?.nextTask?.title], [1, 1, 1, 1, 'API']);
  const hist = dueHistogram(db, today, 7);
  assert.deepEqual(hist[0], { date: 'overdue', count: 1, overdue: true });
  assert.equal(hist.find((h) => h.date === addDays(today, 2))?.count, 1);
});

test('세션 기록·메모 반영·최근 활동 요약·캘린더', () => {
  const db = fresh();
  const p = createProject(db, { name: '브랜드X' });
  const t = createTask(db, { project_id: p.id, title: '로고 시안', due_date: currentDay(db), repeat: 'weekly:0' }, '나');
  const memo = parseMemos(
    `[Hub 메모]\n프로젝트: 브랜드\n요약: 로고 확정\n결정: 로고는 B안\n할 일: 목업 제작 | 디자인\n할 일: 로고 시안\n완료: T${t.id}\n위치: 목업 착수 전\n[/Hub 메모]`,
    todayIn(TZ),
  )[0];
  assert.ok(memo);
  const res = applyMemo(db, memo, 'ChatGPT', null);
  assert.equal(res.projectName, '브랜드X');
  assert.ok(res.logId);
  assert.equal(res.resumeSaved, true);
  assert.equal(res.proposals.filter((x) => !x.result.duplicate).length, 3);
  assert.equal(res.proposals.filter((x) => x.result.duplicate).length, 1); // '로고 시안'은 이미 있음
  assert.equal(pendingCount(db), 3);

  const report = activityReport(db, { days: 7 });
  assert.match(report, /## AI 세션 \(1\)/);
  assert.match(report, /ChatGPT \[브랜드X\]: 로고 확정/);

  const ics = buildIcs(db, 'https://hub.test');
  assert.match(ics, /BEGIN:VEVENT\r\nUID:task-1@hub/);
  assert.match(ics, /SUMMARY:\[브랜드X\] 로고 시안/);
  assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=MO/);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));

  // 세션 기록과 마지막 위치도 되돌릴 수 있다
  const resumeAct = listActivity(db).find((a) => a.action === 'resume.update');
  assert.ok(resumeAct);
  undoActivity(db, resumeAct.id);
  assert.equal(getProject(db, p.id)?.resume_note, '');
});
