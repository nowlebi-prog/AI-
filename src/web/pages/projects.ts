import type { AppCtx } from '../../app-context.ts';
import { activityReport } from '../../domain/activity.ts';
import { clip, overviewBrief, projectBrief, type BriefSize } from '../../domain/brief.ts';
import { currentDay, getTimezone } from '../../domain/clock.ts';
import { createDecision, deleteDecision, deleteLog, listDecisions, listLogs, updateDecision } from '../../domain/decisions.ts';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  progressOf,
  projectProgress,
  requireProject,
  setResumeNote,
  updateProject,
} from '../../domain/projects.ts';
import { progressBar } from './month.ts';
import { pendingCount } from '../../domain/proposals.ts';
import { parseQuickAdd } from '../../domain/quickadd.ts';
import { listReferences } from '../../domain/references.ts';
import { createTask, listTasks } from '../../domain/tasks.ts';
import {
  PROJECT_FIELDS,
  PROJECT_FIELD_LABEL,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABEL,
  ROLE_LABEL,
  ROLES,
  isProjectStatus,
  toPriority,
  toRole,
  type Decision,
  type ProjectField,
  type Role,
} from '../../domain/types.ts';
import { html, multiline, raw } from '../../lib/html.ts';
import { field, sendHtml, sendText, type Ctx } from '../../lib/http.ts';
import { dateOf, formatAgo, formatDate, formatDateTime } from '../../lib/time.ts';
import { formAction, idParam } from '../actions.ts';
import { backInput, copyBlock, csrfInput, flash, page, priorityOptions, roleChip, roleOptions, taskItem } from '../layout.ts';

const FIELD_HINT: Record<ProjectField, string> = {
  summary: '예: 20대 여성 대상 비건 스킨케어 브랜드 리뉴얼',
  goal: '이 프로젝트로 이루려는 것',
  audience: '누구를 위한 것인지',
  stage: '예: 시안 제작, 개발 2차 스프린트',
  constraints: '예산, 일정, 기술 스택, 클라이언트 요구 등',
  scope: '어디까지 하는지 (계약·작업 범위)',
  links: '피그마, 레포, 문서 링크 (줄마다 하나)',
};

function kindOf(kind: string): Role | null {
  const r = toRole(kind);
  return r && r !== 'etc' ? r : null;
}

export function projectsPage(app: AppCtx) {
  return (ctx: Ctx): void => {
    const all = listProjects(app.db, 'all');
    const kind = toRole(ctx.url.searchParams.get('kind') ?? '');
    const projects = kind ? all.filter((p) => p.kind === kind) : all;
    const body = html`
      <div class="page-head">
        <h1>프로젝트</h1>
        <div class="filters">
          <a href="/projects" class="pill ${!kind ? 'active' : ''}">전체</a>
          ${ROLES.filter((r) => r !== 'etc').map((r) => html`<a href="/projects?kind=${r}" class="pill ${kind === r ? 'active' : ''}">${ROLE_LABEL[r]}</a>`)}
        </div>
      </div>
      <form method="post" action="/projects" class="card form-inline wrap">
        ${csrfInput(ctx)}
        <input type="text" name="name" placeholder="새 프로젝트 이름" required maxlength="80">
        <select name="kind" aria-label="분야">${roleOptions(kind ?? '', { none: '분야 선택' })}</select>
        <input type="text" name="summary" placeholder="한 줄 소개 (선택)" class="grow">
        <button class="btn btn-primary">만들기</button>
      </form>
      ${projects.length
        ? html`<div class="project-grid">${projects.map((p) => {
            const k = kindOf(p.kind);
            return html`<a class="card project-card status-${p.status}" href="/projects/${p.id}">
              <div class="project-card-head"><strong>${p.name}</strong><span class="chip">${PROJECT_STATUS_LABEL[p.status]}</span></div>
              ${k ? html`<div>${roleChip(k)}</div>` : ''}
              <div class="small">${p.summary || html`<span class="muted">한 줄 소개 없음</span>`}</div>
              ${p.stage ? html`<div class="small muted">단계: ${p.stage}</div>` : ''}
              ${p.resume_note ? html`<div class="small resume">↳ ${clip(p.resume_note, 80)}</div>` : ''}
              ${progressBar(progressOf(p), `${p.done_tasks}/${p.total_tasks}`)}
              <div class="small muted">열린 할 일 ${p.open_tasks} · 최근 활동 ${formatAgo(p.last_activity)}</div>
            </a>`;
          })}</div>`
        : html`<p class="empty">${kind ? `${ROLE_LABEL[kind]} 프로젝트가 없어요.` : html`아직 프로젝트가 없어요. 위에서 만들거나 <a href="/import">노션에서 가져오세요</a>.`}</p>`}`;
    sendHtml(ctx, page(ctx, { title: '프로젝트', active: 'projects', pending: pendingCount(app.db) }, body));
  };
}

export function createProjectAction(app: AppCtx) {
  return (ctx: Ctx) =>
    formAction(ctx, '/projects', (form) => {
      const p = createProject(app.db, { name: field(form, 'name'), summary: field(form, 'summary'), kind: field(form, 'kind') });
      flash(ctx, `'${p.name}' 프로젝트를 만들었어요`);
      return `/projects/${p.id}`;
    });
}

function decisionItem(ctx: Ctx, d: Decision, tz: string, back: string) {
  return html`<li class="decision ${d.superseded_by ? 'superseded' : ''}" id="decision-${d.id}">
    <div class="decision-main">
      <div><span class="muted">D${d.id}</span> ${d.content}</div>
      ${d.reason ? html`<div class="small muted">이유: ${d.reason}</div>` : ''}
      <div class="small muted">${formatDate(dateOf(d.created_at, tz))} · ${d.source}${d.superseded_by ? html` · <a href="#decision-${d.superseded_by}">D${d.superseded_by}</a>로 대체됨` : ''}</div>
    </div>
    <details class="menu">
      <summary class="btn btn-ghost btn-small" aria-label="더보기">⋯</summary>
      <div class="menu-panel">
        <form method="post" action="/decisions/${d.id}/edit" class="menu-edit">
          ${csrfInput(ctx)}${backInput(back)}
          <input type="text" name="content" value="${d.content}" required aria-label="결정 내용">
          <input type="text" name="reason" value="${d.reason}" placeholder="이유" aria-label="이유">
          <div class="form-inline"><button class="btn btn-primary btn-small">저장</button></div>
        </form>
        <form method="post" action="/decisions/${d.id}/delete" class="menu-row" data-confirm="이 결정을 삭제할까요?">
          ${csrfInput(ctx)}${backInput(back)}
          <button class="btn btn-ghost btn-small danger">삭제</button>
        </form>
      </div>
    </details>
  </li>`;
}

export function projectDetailPage(app: AppCtx) {
  return (ctx: Ctx): void => {
    const id = idParam(ctx);
    const p = getProject(app.db, id);
    if (!p) {
      flash(ctx, `P${id} 프로젝트가 없어요`, 'error');
      ctx.res.writeHead(303, { Location: '/projects' });
      ctx.res.end();
      return;
    }
    const tz = getTimezone(app.db);
    const today = currentDay(app.db);
    const back = `/projects/${p.id}`;
    const projects = listProjects(app.db, 'active').map((x) => ({ id: x.id, name: x.name }));
    const open = listTasks(app.db, { projectId: p.id, status: 'open', today });
    const done = listTasks(app.db, { projectId: p.id, status: 'done', today, limit: 10 });
    const decisions = listDecisions(app.db, p.id, { includeSuperseded: true });
    const valid = decisions.filter((d) => !d.superseded_by);
    const superseded = decisions.filter((d) => d.superseded_by);
    const logs = listLogs(app.db, { projectId: p.id, limit: 30 });
    const refs = listReferences(app.db, { projectId: p.id, limit: 12 });
    const briefs = (['S', 'M', 'L'] as BriefSize[]).map((size) => ({
      size,
      text: projectBrief(app.db, p.id, { size, mode: 'paste', today, tz }),
    }));
    const kind = kindOf(p.kind);
    const progress = projectProgress(app.db, p.id);

    const body = html`
      <div class="page-head">
        <div>
          <div class="crumbs"><a href="/projects">프로젝트</a> / P${p.id}</div>
          <h1>${p.name} <span class="chip">${PROJECT_STATUS_LABEL[p.status]}</span> ${kind ? roleChip(kind) : ''}</h1>
          ${p.summary ? html`<p class="lead">${p.summary}</p>` : ''}
          <div class="head-progress">${progressBar(progress.pct, `진행도 · 할 일 ${progress.done_tasks}/${progress.total_tasks} 완료`)}</div>
        </div>
        <div class="form-inline wrap">
          <a class="btn" href="/run?project=${p.id}">🤖 AI에게 맡기기</a>
          <a class="btn btn-ghost" href="/refs?project=${p.id}">레퍼런스</a>
        </div>
      </div>

      <div class="grid-detail">
        <div class="col-main">
          <section class="card">
            <div class="card-head">
              <h3>브리핑</h3>
              <div class="tabs" data-tabs>
                ${briefs.map((b) => html`<button type="button" class="tab ${b.size === 'M' ? 'active' : ''}" data-tab="brief-${b.size}">${b.size}</button>`)}
              </div>
            </div>
            <p class="hint">MCP가 연결되지 않은 AI에는 이걸 복사해서 붙여 넣으세요. 대화 끝에 AI가 [Hub 메모]로 정리하면 <a href="/capture">붙여넣기</a>로 반영할 수 있어요.</p>
            ${briefs.map(
              (b) => html`<div class="tab-panel ${b.size === 'M' ? 'active' : ''}" data-panel="brief-${b.size}">
                ${copyBlock(`brief-text-${b.size}`, b.text, `${b.size} 복사`)}
              </div>`,
            )}
          </section>

          <section class="card">
            <h3>마지막 위치</h3>
            <form method="post" action="/projects/${p.id}/resume" class="form-inline">
              ${csrfInput(ctx)}
              <input type="text" name="note" value="${p.resume_note}" placeholder="어디까지 했는지 한 줄 (다음에 이어서 할 지점)" class="grow">
              <button class="btn">저장</button>
            </form>
            ${p.resume_note_at ? html`<p class="small muted">${p.resume_note_source ?? ''} · ${formatDateTime(p.resume_note_at, tz)}</p>` : ''}
          </section>

          <section class="card">
            <h3>할 일 <span class="count">${open.length}</span></h3>
            <form method="post" action="/projects/${p.id}/tasks" class="form-inline wrap" data-keep-focus="title">
              ${csrfInput(ctx)}
              <input type="text" name="title" placeholder="할 일 (예: 시안 3종 금요일까지, 매주 월 리포트)" required class="grow">
              <select name="role" aria-label="분야">${roleOptions('', { auto: true })}</select>
              <select name="priority" aria-label="우선순위">${priorityOptions(2)}</select>
              <input type="date" name="due_date" aria-label="마감일">
              <button class="btn btn-primary">추가</button>
            </form>
            <ul class="tasks">${open.map((t) => taskItem(ctx, t, today, { projects }))}</ul>
            ${!open.length ? html`<p class="empty small">열린 할 일이 없어요</p>` : ''}
            ${done.length
              ? html`<details class="done-list"><summary>최근 완료 ${done.length}</summary>
                  <ul class="tasks">${done.map((t) => taskItem(ctx, t, today, { projects }))}</ul></details>`
              : ''}
          </section>

          <section class="card">
            <h3>결정 <span class="count">${valid.length}</span></h3>
            <form method="post" action="/projects/${p.id}/decisions" class="stack">
              ${csrfInput(ctx)}
              <input type="text" name="content" placeholder="정한 것 (예: 메인 컬러는 네이비)" required>
              <div class="form-inline wrap">
                <input type="text" name="reason" placeholder="이유 (선택)" class="grow">
                <select name="supersedes" aria-label="대체할 결정">
                  <option value="">대체하는 결정 없음</option>
                  ${valid.map((d) => html`<option value="${d.id}">D${d.id} ${clip(d.content, 40)} 대체</option>`)}
                </select>
                <button class="btn btn-primary">기록</button>
              </div>
            </form>
            <ul class="decisions">${valid.map((d) => decisionItem(ctx, d, tz, back))}</ul>
            ${superseded.length
              ? html`<details><summary>대체된 결정 ${superseded.length}</summary>
                  <ul class="decisions">${superseded.map((d) => decisionItem(ctx, d, tz, back))}</ul></details>`
              : ''}
          </section>

          <section class="card">
            <h3>레퍼런스 <span class="count">${refs.length}</span> <a class="small" href="/refs?project=${p.id}">모두 보기</a></h3>
            <form method="post" action="/refs" class="form-inline wrap">
              ${csrfInput(ctx)}${backInput(back)}<input type="hidden" name="project" value="${p.id}">
              <input type="url" name="url" placeholder="링크 붙여넣기" required class="grow">
              <input type="text" name="note" placeholder="메모 (선택)">
              <button class="btn">저장</button>
            </form>
            ${refs.length
              ? html`<ul class="plain">${refs.map(
                  (r) => html`<li><a href="${r.url}" target="_blank" rel="noopener noreferrer">${r.title || r.site}</a>
                    <span class="chip">${r.category}</span> <span class="muted small">${r.site}</span>
                    ${r.note ? html`<div class="small muted">${clip(r.note, 100)}</div>` : ''}</li>`,
                )}</ul>`
              : ''}
          </section>

          <section class="card">
            <h3>세션 기록 <span class="count">${logs.length}</span></h3>
            ${logs.length
              ? html`<ul class="logs">${logs.map(
                  (l) => html`<li id="log-${l.id}">
                    <div class="small"><strong>${l.source}</strong> <span class="muted">${formatDateTime(l.created_at, tz)} · L${l.id}</span>
                      <form method="post" action="/logs/${l.id}/delete" class="inline" data-confirm="이 기록을 삭제할까요?">
                        ${csrfInput(ctx)}${backInput(back)}<button class="btn btn-ghost btn-small danger">삭제</button>
                      </form>
                    </div>
                    <div>${multiline(l.summary)}</div>
                  </li>`,
                )}</ul>`
              : html`<p class="muted small">AI가 대화를 마칠 때 log_session을 호출하면 여기에 쌓여요.</p>`}
          </section>
        </div>

        <aside class="col-side">
          <section class="card">
            <h3>프로젝트 카드</h3>
            <form method="post" action="/projects/${p.id}/card" class="stack">
              ${csrfInput(ctx)}
              <label>이름<input type="text" name="name" value="${p.name}" required maxlength="80"></label>
              <div class="form-inline">
                <label class="grow">상태
                  <select name="status">
                    ${PROJECT_STATUSES.map((s) => html`<option value="${s}" ${s === p.status ? raw('selected') : ''}>${PROJECT_STATUS_LABEL[s]}</option>`)}
                  </select>
                </label>
                <label class="grow">분야<select name="kind">${roleOptions(kind ?? '', { none: '없음' })}</select></label>
              </div>
              ${PROJECT_FIELDS.map(
                (f) => html`<label>${PROJECT_FIELD_LABEL[f]}
                  ${f === 'summary' || f === 'stage'
                    ? html`<input type="text" name="${f}" value="${p[f]}" placeholder="${FIELD_HINT[f]}">`
                    : html`<textarea name="${f}" rows="${f === 'scope' ? 4 : 2}" placeholder="${FIELD_HINT[f]}">${p[f]}</textarea>`}
                </label>`,
              )}
              <button class="btn btn-primary">카드 저장</button>
              <p class="small muted">마지막 수정 ${formatAgo(p.updated_at)}</p>
            </form>
          </section>
          <form method="post" action="/projects/${p.id}/delete" class="danger-zone" data-confirm="프로젝트와 할 일·결정·기록을 모두 삭제할까요? 되돌릴 수 없어요.">
            ${csrfInput(ctx)}
            <button class="btn btn-ghost danger">프로젝트 삭제</button>
          </form>
        </aside>
      </div>`;
    sendHtml(ctx, page(ctx, { title: p.name, active: 'projects', pending: pendingCount(app.db) }, body));
  };
}

function briefSize(ctx: Ctx): BriefSize {
  const s = (ctx.url.searchParams.get('size') ?? 'M').toUpperCase();
  return s === 'S' || s === 'L' ? s : 'M';
}

/** 복사 버튼용 텍스트 */
export function briefText(app: AppCtx) {
  return {
    project: (ctx: Ctx): void => {
      const p = requireProject(app.db, idParam(ctx));
      sendText(ctx, projectBrief(app.db, p.id, { size: briefSize(ctx), mode: 'paste', today: currentDay(app.db), tz: getTimezone(app.db) }), 200, { 'Cache-Control': 'no-store' });
    },
    overview: (ctx: Ctx): void => {
      sendText(ctx, overviewBrief(app.db, { size: briefSize(ctx), mode: 'paste', today: currentDay(app.db), tz: getTimezone(app.db) }), 200, { 'Cache-Control': 'no-store' });
    },
    activity: (ctx: Ctx): void => {
      const days = Math.min(60, Math.max(1, Number(ctx.url.searchParams.get('days') ?? 7) || 7));
      sendText(ctx, activityReport(app.db, { days }), 200, { 'Cache-Control': 'no-store' });
    },
  };
}

export function projectActions(app: AppCtx) {
  return {
    card: (ctx: Ctx) =>
      formAction(ctx, `/projects/${ctx.params.id}`, (form) => {
        const id = idParam(ctx);
        const changes: Record<string, string> = {};
        for (const f of PROJECT_FIELDS) if (form.has(f)) changes[f] = field(form, f);
        const status = field(form, 'status');
        updateProject(app.db, id, {
          ...changes,
          name: form.has('name') ? field(form, 'name') : undefined,
          status: isProjectStatus(status) ? status : undefined,
          kind: form.has('kind') ? field(form, 'kind') : undefined,
        });
        flash(ctx, '프로젝트 카드를 저장했어요');
      }),
    resume: (ctx: Ctx) =>
      formAction(ctx, `/projects/${ctx.params.id}`, (form) => {
        setResumeNote(app.db, idParam(ctx), field(form, 'note'), '나');
        flash(ctx, '마지막 위치를 저장했어요');
      }),
    addTask: (ctx: Ctx) =>
      formAction(ctx, `/projects/${ctx.params.id}`, (form) => {
        const today = currentDay(app.db);
        const q = parseQuickAdd(field(form, 'title'), [], today);
        const pickedRole = toRole(field(form, 'role'));
        const pickedPriority = toPriority(field(form, 'priority')) ?? 2;
        createTask(
          app.db,
          {
            project_id: idParam(ctx),
            title: q.title,
            role: pickedRole ?? q.role,
            priority: pickedPriority !== 2 ? pickedPriority : q.priority,
            due_date: field(form, 'due_date') || q.due_date,
            repeat: q.repeat,
          },
          '나',
        );
      }),
    addDecision: (ctx: Ctx) =>
      formAction(ctx, `/projects/${ctx.params.id}`, (form) => {
        const sup = field(form, 'supersedes');
        createDecision(
          app.db,
          { project_id: idParam(ctx), content: field(form, 'content'), reason: field(form, 'reason'), supersedes: sup ? Number(sup) : null },
          '나',
        );
        flash(ctx, '결정을 기록했어요');
      }),
    editDecision: (ctx: Ctx) =>
      formAction(ctx, '/projects', (form) => {
        updateDecision(app.db, idParam(ctx), { content: field(form, 'content'), reason: field(form, 'reason') });
        flash(ctx, '결정을 고쳤어요');
      }),
    deleteDecision: (ctx: Ctx) =>
      formAction(ctx, '/projects', () => {
        deleteDecision(app.db, idParam(ctx));
        flash(ctx, '결정을 삭제했어요');
      }),
    deleteLog: (ctx: Ctx) =>
      formAction(ctx, '/projects', () => {
        deleteLog(app.db, idParam(ctx));
        flash(ctx, '기록을 삭제했어요');
      }),
    remove: (ctx: Ctx) =>
      formAction(ctx, '/projects', () => {
        deleteProject(app.db, idParam(ctx));
        flash(ctx, '프로젝트를 삭제했어요');
        return '/projects';
      }),
  };
}
