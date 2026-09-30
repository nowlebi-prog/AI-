import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.ts';
import { createProject, resolveProject, setResumeNote } from '../src/domain/projects.ts';
import { createTask, getTask, todayBoard } from '../src/domain/tasks.ts';
import { createDecision, getDecision, listDecisions } from '../src/domain/decisions.ts';
import { approveProposal, listProposals, pendingCount, propose, rejectProposal } from '../src/domain/proposals.ts';
import { setAutoApprove, saveProfile } from '../src/domain/profile.ts';
import { overviewBrief, projectBrief } from '../src/domain/brief.ts';
import { fetchDoc, search } from '../src/domain/search.ts';
import { applyMemo, parseMemos, recordSession } from '../src/domain/capture.ts';
import { UserError } from '../src/domain/types.ts';
import { todayIn } from '../src/lib/time.ts';

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

test('제안 → 승인/거절, 자동 승인', () => {
  const db = fresh();
  const p = createProject(db, { name: '브랜드X' });
  const r1 = propose(db, { kind: 'decision', projectId: p.id, payload: { content: '로고는 B안', reason: '선호도', supersedes: null } }, 'Claude');
  assert.equal(r1.applied, false);
  assert.equal(pendingCount(db), 1);
  const decisionId = approveProposal(db, r1.id);
  assert.equal(getDecision(db, decisionId)?.source, 'Claude');
  assert.equal(pendingCount(db), 0);
  assert.throws(() => approveProposal(db, r1.id), UserError);

  const r2 = propose(db, { kind: 'task', projectId: p.id, payload: { title: '시안', role: 'design', priority: 2, due_date: null, note: '' } }, 'ChatGPT');
  rejectProposal(db, r2.id);
  assert.equal(listProposals(db, 'resolved')[0]?.status, 'rejected');

  // 고쳐서 승인
  const r3 = propose(db, { kind: 'task', projectId: p.id, payload: { title: '시안', role: 'design', priority: 2, due_date: null, note: '' } }, 'ChatGPT');
  const taskId = approveProposal(db, r3.id, { title: '시안 3종', due_date: '2026-10-03' });
  assert.equal(getTask(db, taskId)?.title, '시안 3종');
  assert.equal(getTask(db, taskId)?.due_date, '2026-10-03');

  // 완료 제안
  const r4 = propose(db, { kind: 'task_update', projectId: p.id, payload: { task_id: taskId, changes: { status: 'done' } } }, 'Grok');
  approveProposal(db, r4.id);
  assert.equal(getTask(db, taskId)?.status, 'done');
  assert.ok(getTask(db, taskId)?.done_at);

  // 자동 승인
  setAutoApprove(db, ['task']);
  const r5 = propose(db, { kind: 'task', projectId: null, payload: { title: '메일 회신', role: 'ops', priority: 1, due_date: null, note: '' } }, 'Muse');
  assert.equal(r5.applied, true);
  assert.equal(getTask(db, r5.resultId ?? 0)?.source, 'Muse');

  // 검증 실패는 제안 자체가 안 된다
  assert.throws(() => propose(db, { kind: 'project', projectId: null, payload: { name: '브랜드x', fields: {} } }, 'Claude'), /이미 있어요/);
});

test('브리핑: 크기별 구성과 붙여넣기 모드', () => {
  const db = fresh();
  const today = todayIn(TZ);
  saveProfile(db, { name: '민지', about: '1인 스튜디오 운영', preferences: '한국어로 짧게' });
  const p = createProject(db, { name: '브랜드X', summary: '비건 스킨케어 리뉴얼', stage: '시안', goal: '10월 런칭' });
  createDecision(db, { project_id: p.id, content: '로고는 B안', reason: '선호도' }, 'Claude');
  createTask(db, { project_id: p.id, title: '상세페이지 시안', role: 'design', due_date: today }, '나');
  setResumeNote(db, p.id, '시안 2까지 완료', 'Claude');
  recordSession(db, { projectId: p.id, summary: '로고 방향 논의', resume: '', decisions: [], tasks: [], doneTaskIds: [] }, 'ChatGPT');

  const m = projectBrief(db, p.id, { size: 'M', mode: 'mcp', today, tz: TZ });
  for (const s of ['# 브리핑: 브랜드X (P1) · M', '## 나', '민지 — 1인 스튜디오 운영', '목표: 10월 런칭', '## 마지막 위치', '시안 2까지 완료', '[D1] 로고는 B안 — 이유: 선호도', '[T1] 상세페이지 시안 · 디자인 · 마감 오늘', '## 최근 세션', 'ChatGPT: 로고 방향 논의', '## Hub 사용 규칙']) {
    assert.ok(m.includes(s), `M 브리핑에 '${s}'가 있어야 해요\n${m}`);
  }
  const s = projectBrief(db, p.id, { size: 'S', mode: 'mcp', today, tz: TZ });
  assert.ok(s.length < m.length);
  assert.ok(!s.includes('## Hub 사용 규칙'));
  assert.ok(!s.includes('[D1]'));

  const paste = projectBrief(db, p.id, { size: 'S', mode: 'paste', today, tz: TZ });
  assert.ok(paste.includes('[Hub 메모]') && paste.includes('프로젝트: 브랜드X'));

  const all = overviewBrief(db, { size: 'M', mode: 'mcp', today, tz: TZ });
  assert.ok(all.includes('[P1] 브랜드X'));
  assert.ok(all.includes('## 오늘 챙길 것'));
  assert.ok(all.includes('[T1] 상세페이지 시안'));
});

test('검색과 항목 가져오기', () => {
  const db = fresh();
  const ctx = { baseUrl: 'https://hub.test', today: todayIn(TZ), tz: TZ };
  const p = createProject(db, { name: '브랜드X' });
  createDecision(db, { project_id: p.id, content: '메인 컬러는 네이비', reason: '신뢰감' }, '나');
  createTask(db, { project_id: p.id, title: '네이비 팔레트 정리' }, '나');
  const hits = search(db, '네이비', ctx.baseUrl);
  assert.deepEqual(hits.map((h) => h.id).sort(), ['decision:1', 'task:1']);
  assert.equal(search(db, '네이비 신뢰감', ctx.baseUrl).length, 1);
  assert.equal(search(db, '100%', ctx.baseUrl).length, 0);
  const doc = fetchDoc(db, 'D1', ctx);
  assert.equal(doc.url, 'https://hub.test/projects/1#decision-1');
  assert.ok(doc.text.includes('이유: 신뢰감'));
  assert.ok(fetchDoc(db, 'project:1', ctx).text.includes('# 브리핑: 브랜드X'));
  assert.throws(() => fetchDoc(db, 'x:1', ctx), /형식/);
  assert.throws(() => fetchDoc(db, 'task:99', ctx), /없어요/);
});

test('세션 기록과 메모 반영', () => {
  const db = fresh();
  const p = createProject(db, { name: '브랜드X' });
  const t = createTask(db, { project_id: p.id, title: '로고 시안' }, '나');
  const memo = parseMemos(
    `[Hub 메모]\n프로젝트: 브랜드\n요약: 로고 확정\n결정: 로고는 B안\n할 일: 목업 제작 | 디자인\n완료: T${t.id}\n위치: 목업 착수 전\n[/Hub 메모]`,
    todayIn(TZ),
  )[0];
  assert.ok(memo);
  const res = applyMemo(db, memo, 'ChatGPT', null);
  assert.equal(res.projectName, '브랜드X');
  assert.ok(res.logId);
  assert.equal(res.resumeSaved, true);
  assert.equal(res.proposals.length, 3);
  assert.deepEqual(res.errors, []);
  assert.equal(pendingCount(db), 3);
  const board = todayBoard(db, todayIn(TZ));
  assert.equal(board.backlog.length, 1); // 완료는 아직 승인 전
});
