import type { AppCtx } from '../../app-context.ts';
import { listActivity } from '../../domain/activity.ts';
import { clip } from '../../domain/brief.ts';
import { currentDay } from '../../domain/clock.ts';
import { listLogs } from '../../domain/decisions.ts';
import { getProfile } from '../../domain/profile.ts';
import { listProjects } from '../../domain/projects.ts';
import { describeProposal, listProposals, pendingCount } from '../../domain/proposals.ts';
import { parseQuickAdd } from '../../domain/quickadd.ts';
import { describeRepeat, normalizeRepeat } from '../../domain/repeat.ts';
import { createTask, deleteTask, doneOn, snoozeDate, todayBoard, updateTask, type SnoozeTarget } from '../../domain/tasks.ts';
import { PROPOSAL_KIND_LABEL, ROLE_LABEL, ROLES, UserError, toPriority, toRole, toTaskStatus, type TaskWithProject } from '../../domain/types.ts';
import { wrapupDue } from '../../domain/wrapup.ts';
import { html, raw, type SafeHtml } from '../../lib/html.ts';
import { field, sendHtml, sendJson, type Ctx } from '../../lib/http.ts';
import { formatAgo, formatDate, formatDue } from '../../lib/time.ts';
import { formAction, idParam } from '../actions.ts';
import { copyUrlButton, csrfInput, flash, page, projectOptions, taskItem } from '../layout.ts';

type ProjectRef = { id: number; name: string };

function section(ctx: Ctx, title: string, tasks: TaskWithProject[], today: string, projects: ProjectRef[], cls = ''): SafeHtml {
  if (!tasks.length) return html``;
  return html`<section class="board-section ${cls}">
    <h3>${title} <span class="count">${tasks.length}</span></h3>
    <ul class="tasks">${tasks.map((t) => taskItem(ctx, t, today, { showProject: true, projects }))}</ul>
  </section>`;
}

export function todayPage(app: AppCtx) {
  return (ctx: Ctx): void => {
    const today = currentDay(app.db);
    const role = toRole(ctx.url.searchParams.get('role') ?? '') ?? undefined;
    const board = todayBoard(app.db, today, role);
    const done = doneOn(app.db, today, role);
    const projects = listProjects(app.db, 'active');
    const refs = projects.map((p) => ({ id: p.id, name: p.name }));
    const logs = listLogs(app.db, { limit: 5 });
    const pending = listProposals(app.db, 'pending', 50);
    const profile = getProfile(app.db);
    const aiChanges = listActivity(app.db, { sinceIso: new Date(Date.now() - 86_400_000).toISOString(), vias: ['direct', 'auto', 'session'], limit: 100 }).filter(
      (a) => !a.undone_at,
    );
    const empty =
      !board.overdue.length && !board.today.length && !board.doing.length && !board.week.length && !board.later.length && !board.backlog.length && !board.waiting.length;
    const onboarding = !projects.length || !profile.about;
    const focusAdd = ctx.url.searchParams.get('focus') === 'add';
    const prefill = (ctx.url.searchParams.get('prefill') ?? '').slice(0, 200);

    const body = html`
      <div class="page-head">
        <h1>오늘 <span class="muted small">${formatDate(today)}</span></h1>
        <div class="filters">
          <a href="/" class="pill ${!role ? 'active' : ''}">전체</a>
          ${ROLES.filter((r) => r !== 'etc').map(
            (r) => html`<a href="/?role=${r}" class="pill ${role === r ? 'active' : ''}">${ROLE_LABEL[r]}</a>`,
          )}
          <a href="/wrapup" class="btn btn-small">🌙 하루 마감</a>
        </div>
      </div>

      ${wrapupDue(app.db)
        ? html`<a class="card note-card wrap-banner" href="/wrapup"><strong>🌙 하루 마감할 시간이에요</strong><span>못 끝낸 일 넘기기 · 오늘 저장한 파일 정리 · 한 줄 회고</span></a>`
        : ''}

      <form method="post" action="/quick-add" class="quick-add" data-keep-focus="text">
        ${csrfInput(ctx)}
        <input type="text" name="text" value="${prefill}" placeholder="빠른 추가: 브랜드X 로고 시안 3개 금요일까지 #디자인 !  (단축키 n)" autocomplete="off" required data-preview="/quick-add/preview" data-quick-add ${focusAdd ? raw('autofocus') : ''}>
        <button class="btn btn-primary">추가</button>
      </form>
      <div class="quick-preview" data-preview-out aria-live="polite"></div>
      <details class="multi-add">
        <summary>여러 개 한 번에 추가</summary>
        <form method="post" action="/quick-add" class="stack">
          ${csrfInput(ctx)}
          <textarea name="lines" rows="5" placeholder="한 줄에 하나씩. AI가 준 체크리스트를 그대로 붙여 넣어도 돼요.\n- 상세페이지 시안 3종 금요일까지\n- 인쇄 견적 받기 #운영"></textarea>
          <div class="form-inline wrap">
            <label class="inline-label">프로젝트 <select name="project">${projectOptions(refs, null, '줄마다 자동')}</select></label>
            <button class="btn btn-primary">모두 추가</button>
          </div>
        </form>
      </details>
      <p class="hint">프로젝트 이름, <code>#분야</code>, 날짜(오늘·내일·금요일·10/3), 반복(매주 월·매월 10일), <code>!</code>(긴급)을 알아서 읽어요.</p>

      <div class="grid-today">
        <div>
          ${onboarding
            ? html`<section class="card onboarding">
                <h3>시작하기</h3>
                <ol>
                  <li class="${profile.about ? 'done' : ''}"><a href="/settings#profile">프로필 작성</a> — AI가 나를 알게 하는 소개와 작업 선호</li>
                  <li class="${projects.length ? 'done' : ''}"><a href="/projects">프로젝트 추가</a> 또는 <a href="/import">노션에서 가져오기</a></li>
                  <li><a href="/settings#connect">AI 연결</a> — Claude, ChatGPT, Grok, Muse에 Hub 주소 등록</li>
                  <li><a href="/settings#calendar">캘린더 구독</a> — 마감을 휴대폰 캘린더 알림으로</li>
                </ol>
              </section>`
            : ''}
          ${section(ctx, '지난 마감', board.overdue, today, refs, 'danger')}
          ${section(ctx, '오늘 마감', board.today, today, refs, 'accent')}
          ${section(ctx, '진행 중', board.doing, today, refs)}
          ${section(ctx, '7일 안', board.week, today, refs)}
          ${section(ctx, '대기 중', board.waiting, today, refs, 'quiet')}
          ${section(ctx, '나중에', board.later.slice(0, 15), today, refs, 'quiet')}
          ${board.later.length > 15 ? html`<p class="small muted">나중 마감 ${board.later.length - 15}개 더 — <a href="/calendar">월간 달력</a>에서 보세요.</p>` : ''}
          ${section(ctx, '마감 없음', board.backlog.slice(0, 20), today, refs, 'quiet')}
          ${board.backlog.length > 20 ? html`<p class="small muted">마감 없는 일 ${board.backlog.length - 20}개 더 — <a href="/projects">프로젝트</a>에서 보세요.</p>` : ''}
          ${empty && !onboarding ? html`<p class="empty">${role ? `${ROLE_LABEL[role]} 할 일이 없어요.` : '열린 할 일이 없어요. 위에서 빠르게 추가해 보세요.'}</p>` : ''}
          ${done.length
            ? html`<details class="board-section done-today"><summary>오늘 완료 ${done.length}</summary>
                <ul class="tasks">${done.map((t) => taskItem(ctx, t, today, { showProject: true, projects: refs }))}</ul></details>`
            : ''}
        </div>
        <aside>
          ${pending.length
            ? html`<section class="card inbox-mini">
                <h3><a href="/inbox">인박스</a> <span class="count">${pending.length}</span></h3>
                <ul class="plain">${pending.slice(0, 4).map((p) => {
                  const d = describeProposal(app.db, p);
                  return html`<li>
                    <div class="small"><span class="chip kind">${PROPOSAL_KIND_LABEL[p.kind]}</span> <span class="muted">${p.source}</span></div>
                    <div>${clip(d.title, 70)}</div>
                    <div class="form-inline">
                      <form method="post" action="/inbox/${p.id}/approve" class="inline">${csrfInput(ctx)}<input type="hidden" name="_back" value="/"><button class="btn btn-primary btn-small">승인</button></form>
                      <form method="post" action="/inbox/${p.id}/reject" class="inline">${csrfInput(ctx)}<input type="hidden" name="_back" value="/"><button class="btn btn-ghost btn-small">거절</button></form>
                    </div>
                  </li>`;
                })}</ul>
                ${pending.length > 4 ? html`<a class="small" href="/inbox">나머지 ${pending.length - 4}건 보기</a>` : ''}
              </section>`
            : ''}
          ${aiChanges.length
            ? html`<a class="card note-card" href="/inbox#activity"><strong>AI가 바로 반영한 변경 ${aiChanges.length}건</strong><span>지난 24시간 · 확인하고 되돌릴 수 있어요</span></a>`
            : ''}
          <section class="card">
            <h3>브리핑 복사</h3>
            <p class="small muted">MCP가 없는 AI에 붙여 넣을 맥락이에요.</p>
            <div class="form-inline wrap">
              ${copyUrlButton('/brief.txt?size=S', '전체 S')}
              ${copyUrlButton('/brief.txt?size=M', '전체 M')}
              ${copyUrlButton('/activity.txt?days=7', '지난 7일 요약')}
            </div>
            ${projects.length
              ? html`<ul class="plain brief-list">${projects.map(
                  (p) => html`<li><a href="/projects/${p.id}">${p.name}</a>
                    <span class="muted small">할 일 ${p.open_tasks} · ${formatAgo(p.last_activity)}</span>
                    ${copyUrlButton(`/projects/${p.id}/brief.txt?size=M`, '복사', 'btn btn-ghost btn-small')}
                    ${p.resume_note ? html`<div class="small muted">↳ ${clip(p.resume_note, 60)}</div>` : ''}</li>`,
                )}</ul>`
              : html`<p class="muted">아직 프로젝트가 없어요. <a href="/projects">추가하기</a></p>`}
          </section>
          <section class="card">
            <h3>최근 AI 세션</h3>
            ${logs.length
              ? html`<ul class="plain logs">${logs.map(
                  (l) => html`<li><div class="small"><strong>${l.source}</strong> ${l.project_name ? html`· <a href="/projects/${l.project_id}">${l.project_name}</a>` : ''} <span class="muted">${formatAgo(l.created_at)}</span></div>
                    <div class="small">${clip(l.summary, 120)}</div></li>`,
                )}</ul>`
              : html`<p class="muted small">AI가 log_session을 호출하거나 붙여넣기로 기록하면 여기에 보여요.</p>`}
          </section>
        </aside>
      </div>`;
    sendHtml(ctx, page(ctx, { title: '오늘', active: 'today', pending: pendingCount(app.db) }, body));
  };
}

function addOne(app: AppCtx, line: string, today: string, defaultProject: number | null): TaskWithProject {
  const projects = listProjects(app.db, 'active');
  const q = parseQuickAdd(line, projects, today);
  return createTask(
    app.db,
    { project_id: q.projectId ?? defaultProject, title: q.title, role: q.role, priority: q.priority, due_date: q.due_date, repeat: q.repeat },
    '나',
  );
}

function describeAdded(t: TaskWithProject, today: string): string {
  const bits = [t.project_name ?? '프로젝트 없음', ROLE_LABEL[t.role], t.due_date ? `마감 ${formatDue(t.due_date, today)}` : '마감 없음'];
  if (t.repeat) bits.push(`🔁 ${describeRepeat(t.repeat)}`);
  return `${t.title} (${bits.join(' · ')})`;
}

export function quickAdd(app: AppCtx) {
  return (ctx: Ctx) =>
    formAction(ctx, '/', (form) => {
      const today = currentDay(app.db);
      const multi = form.get('lines');
      if (multi !== null) {
        const lines = multi
          .split(/\r?\n/)
          .map((l) => l.replace(/^\s*(?:[-*•·]|\d+[.)]|\[[ xX]\])\s*/, '').trim())
          .filter(Boolean)
          .slice(0, 100);
        if (!lines.length) throw new UserError('추가할 줄을 적어 주세요');
        const project = field(form, 'project');
        const added = lines.map((l) => addOne(app, l, today, project ? Number(project) : null));
        flash(ctx, `할 일 ${added.length}개를 추가했어요`);
        return '/';
      }
      const text = field(form, 'text');
      if (!text) throw new UserError('내용을 입력해 주세요');
      flash(ctx, `추가했어요: ${describeAdded(addOne(app, text, today, null), today)}`);
      return '/';
    });
}

/** 빠른 추가 미리보기 (입력하면서 보여 줌) */
export function quickAddPreview(app: AppCtx) {
  return (ctx: Ctx): void => {
    const text = (ctx.url.searchParams.get('text') ?? '').trim();
    if (!text) return sendJson(ctx, { empty: true });
    const today = currentDay(app.db);
    const projects = listProjects(app.db, 'active');
    const q = parseQuickAdd(text, projects, today);
    sendJson(ctx, {
      title: q.title,
      project: projects.find((p) => p.id === q.projectId)?.name ?? null,
      role: ROLE_LABEL[q.role],
      priority: q.priority === 1 ? '긴급' : null,
      due: q.due_date ? formatDue(q.due_date, today) : null,
      repeat: q.repeat ? describeRepeat(q.repeat) : null,
    });
  };
}

export function taskStatus(app: AppCtx) {
  return (ctx: Ctx) =>
    formAction(ctx, '/', (form) => {
      const status = toTaskStatus(field(form, 'status'));
      if (!status) throw new UserError('상태 값이 올바르지 않아요');
      const r = updateTask(app.db, idParam(ctx), { status });
      if (r.spawned?.due_date) flash(ctx, `반복 할 일이라 다음 차례를 만들었어요: ${formatDue(r.spawned.due_date, currentDay(app.db))}`);
    });
}

export function taskDelete(app: AppCtx) {
  return (ctx: Ctx) =>
    formAction(ctx, '/', () => {
      deleteTask(app.db, idParam(ctx));
      flash(ctx, '할 일을 삭제했어요');
    });
}

export function taskEdit(app: AppCtx) {
  return (ctx: Ctx) =>
    formAction(ctx, '/', (form) => {
      const today = currentDay(app.db);
      const changes: Parameters<typeof updateTask>[2] = {
        title: field(form, 'title'),
        role: toRole(field(form, 'role')) ?? 'etc',
        priority: toPriority(field(form, 'priority')) ?? 2,
        due_date: field(form, 'due_date') || null,
        note: form.get('note') ?? '',
        repeat: normalizeRepeat(field(form, 'repeat'), today),
      };
      if (form.has('project_id')) changes.project_id = field(form, 'project_id') ? Number(field(form, 'project_id')) : null;
      updateTask(app.db, idParam(ctx), changes);
      flash(ctx, '할 일을 고쳤어요');
    });
}

export function taskSnooze(app: AppCtx) {
  return (ctx: Ctx) =>
    formAction(ctx, '/', (form) => {
      const to = field(form, 'to') as SnoozeTarget;
      if (!['today', 'tomorrow', 'nextweek', 'none'].includes(to)) throw new UserError('미룰 날짜가 올바르지 않아요');
      const today = currentDay(app.db);
      const due = snoozeDate(to, today);
      updateTask(app.db, idParam(ctx), { due_date: due });
      flash(ctx, due ? `마감을 ${formatDue(due, today)}(${formatDate(due)})로 옮겼어요` : '마감을 없앴어요');
    });
}

export function taskWaiting(app: AppCtx) {
  return (ctx: Ctx) =>
    formAction(ctx, '/', (form) => {
      if (field(form, 'mode') === 'clear') {
        updateTask(app.db, idParam(ctx), { waiting: '' });
        flash(ctx, '대기를 풀었어요');
        return;
      }
      const w = field(form, 'waiting') || '대기 중';
      updateTask(app.db, idParam(ctx), { waiting: w });
      flash(ctx, `대기로 옮겼어요: ${w}`);
    });
}
