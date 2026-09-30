import type { AppCtx } from '../../app-context.ts';
import { listLogs } from '../../domain/decisions.ts';
import { getProfile } from '../../domain/profile.ts';
import { listProjects } from '../../domain/projects.ts';
import { pendingCount } from '../../domain/proposals.ts';
import { parseQuickAdd } from '../../domain/quickadd.ts';
import { createTask, deleteTask, todayBoard, updateTask } from '../../domain/tasks.ts';
import { ROLE_LABEL, ROLES, toRole, toTaskStatus, UserError, type TaskWithProject } from '../../domain/types.ts';
import { html, type SafeHtml } from '../../lib/html.ts';
import { field, readForm, redirect, safeLocalPath, sendHtml, type Ctx } from '../../lib/http.ts';
import { formatAgo, formatDate, formatDue, todayIn } from '../../lib/time.ts';
import { clip } from '../../domain/brief.ts';
import { csrfInput, flash, page, taskItem } from '../layout.ts';

function section(ctx: Ctx, title: string, tasks: TaskWithProject[], today: string, cls = ''): SafeHtml {
  if (!tasks.length) return html``;
  return html`<section class="board-section ${cls}">
    <h3>${title} <span class="count">${tasks.length}</span></h3>
    <ul class="tasks">${tasks.map((t) => taskItem(ctx, t, today, { showProject: true }))}</ul>
  </section>`;
}

export function todayPage(app: AppCtx) {
  return (ctx: Ctx): void => {
    const today = todayIn(app.config.timezone);
    const role = toRole(ctx.url.searchParams.get('role') ?? '') ?? undefined;
    const board = todayBoard(app.db, today, role);
    const projects = listProjects(app.db, 'active');
    const logs = listLogs(app.db, { limit: 6 });
    const pending = pendingCount(app.db);
    const profile = getProfile(app.db);
    const empty = !board.overdue.length && !board.today.length && !board.doing.length && !board.week.length && !board.backlog.length;
    const onboarding = !projects.length || !profile.about;

    const body = html`
      <div class="page-head">
        <h1>오늘 <span class="muted small">${formatDate(today)}</span></h1>
        <div class="filters">
          <a href="/" class="pill ${!role ? 'active' : ''}">전체</a>
          ${ROLES.filter((r) => r !== 'etc').map(
            (r) => html`<a href="/?role=${r}" class="pill ${role === r ? 'active' : ''}">${ROLE_LABEL[r]}</a>`,
          )}
        </div>
      </div>

      <form method="post" action="/quick-add" class="quick-add">
        ${csrfInput(ctx)}
        <input type="text" name="text" placeholder="빠른 추가: 브랜드X 로고 시안 3개 금요일까지 #디자인 !" autocomplete="off" required>
        <button class="btn btn-primary">추가</button>
      </form>
      <p class="hint">프로젝트 이름, <code>#역할</code>, 날짜 표현(오늘·내일·금요일·10/3), <code>!</code>(긴급)을 알아서 읽어요.</p>

      <div class="grid-today">
        <div>
          ${onboarding
            ? html`<section class="card onboarding">
                <h3>시작하기</h3>
                <ol>
                  <li class="${profile.about ? 'done' : ''}"><a href="/settings#profile">프로필 작성</a> — AI가 나를 알게 하는 소개와 작업 선호</li>
                  <li class="${projects.length ? 'done' : ''}"><a href="/projects">프로젝트 추가</a> 또는 <a href="/import">노션에서 가져오기</a></li>
                  <li><a href="/settings#connect">AI 연결</a> — Claude, ChatGPT, Grok, Muse에 Hub 주소 등록</li>
                </ol>
              </section>`
            : ''}
          ${section(ctx, '지난 마감', board.overdue, today, 'danger')}
          ${section(ctx, '오늘 마감', board.today, today, 'accent')}
          ${section(ctx, '진행 중', board.doing, today)}
          ${section(ctx, '이번 주', board.week, today)}
          ${section(ctx, '마감 없음', board.backlog.slice(0, 15), today, 'quiet')}
          ${empty && !onboarding ? html`<p class="empty">${role ? `${ROLE_LABEL[role]} 할 일이 없어요.` : '열린 할 일이 없어요. 위에서 빠르게 추가해 보세요.'}</p>` : ''}
        </div>
        <aside>
          ${pending
            ? html`<a class="card inbox-card" href="/inbox"><strong>인박스 ${pending}건</strong><span>AI가 올린 제안이 승인을 기다려요</span></a>`
            : ''}
          <section class="card">
            <h3>진행 중인 프로젝트</h3>
            ${projects.length
              ? html`<ul class="plain">${projects.map(
                  (p) => html`<li><a href="/projects/${p.id}">${p.name}</a> <span class="muted small">할 일 ${p.open_tasks} · ${formatAgo(p.last_activity)}</span>
                    ${p.resume_note ? html`<div class="small muted">↳ ${clip(p.resume_note, 60)}</div>` : ''}</li>`,
                )}</ul>`
              : html`<p class="muted">아직 없어요. <a href="/projects">추가하기</a></p>`}
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
    sendHtml(ctx, page(ctx, { title: '오늘', active: 'today', pending }, body));
  };
}

export function quickAdd(app: AppCtx) {
  return async (ctx: Ctx): Promise<void> => {
    const form = await readForm(ctx);
    const text = field(form, 'text');
    const today = todayIn(app.config.timezone);
    try {
      if (!text) throw new UserError('내용을 입력해 주세요');
      const q = parseQuickAdd(text, listProjects(app.db, 'active'), today);
      const t = createTask(app.db, { project_id: q.projectId, title: q.title, role: q.role, priority: q.priority, due_date: q.due_date }, '나');
      const bits = [t.project_name ?? '프로젝트 없음', ROLE_LABEL[t.role], t.due_date ? `마감 ${formatDue(t.due_date, today)}` : '마감 없음'];
      flash(ctx, `추가했어요: ${t.title} (${bits.join(' · ')})`);
    } catch (err) {
      flash(ctx, err instanceof Error ? err.message : String(err), 'error');
    }
    redirect(ctx, '/');
  };
}

export function taskStatus(app: AppCtx) {
  return async (ctx: Ctx): Promise<void> => {
    const form = await readForm(ctx);
    const status = toTaskStatus(field(form, 'status'));
    try {
      if (!status) throw new UserError('상태 값이 올바르지 않아요');
      updateTask(app.db, Number(ctx.params.id), { status });
    } catch (err) {
      flash(ctx, err instanceof Error ? err.message : String(err), 'error');
    }
    redirect(ctx, safeLocalPath(field(form, '_back'), '/'));
  };
}

export function taskDelete(app: AppCtx) {
  return async (ctx: Ctx): Promise<void> => {
    const form = await readForm(ctx);
    deleteTask(app.db, Number(ctx.params.id));
    flash(ctx, '할 일을 삭제했어요');
    redirect(ctx, safeLocalPath(field(form, '_back'), '/'));
  };
}
