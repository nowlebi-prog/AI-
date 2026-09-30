import { html, raw, type SafeHtml } from '../lib/html.ts';
import type { Ctx } from '../lib/http.ts';
import { formatDue } from '../lib/time.ts';
import { describeRepeat } from '../domain/repeat.ts';
import { PRIORITY_LABEL, ROLE_LABEL, ROLES, type Priority, type Role, type TaskWithProject } from '../domain/types.ts';

// ─── 플래시 메시지 (세션별, 메모리) ──────────────────────────────

interface Flash {
  kind: 'ok' | 'error';
  text: string;
  at: number;
}

const flashes = new Map<string, Flash>();

export function flash(ctx: Ctx, text: string, kind: 'ok' | 'error' = 'ok'): void {
  if (!ctx.session) return;
  const now = Date.now();
  for (const [k, v] of flashes) if (now - v.at > 60_000) flashes.delete(k);
  flashes.set(ctx.session.nonce, { kind, text, at: now });
}

function takeFlash(ctx: Ctx): Flash | null {
  if (!ctx.session) return null;
  const f = flashes.get(ctx.session.nonce) ?? null;
  flashes.delete(ctx.session.nonce);
  return f;
}

// ─── 공통 조각 ──────────────────────────────────────────────────

export function csrfInput(ctx: Ctx): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${ctx.session?.csrf ?? ''}">`;
}

export function backInput(path: string): SafeHtml {
  return html`<input type="hidden" name="_back" value="${path}">`;
}

export function currentPath(ctx: Ctx): string {
  return ctx.url.pathname + ctx.url.search;
}

export function roleChip(role: Role): SafeHtml {
  return html`<span class="chip role-${role}">${ROLE_LABEL[role]}</span>`;
}

export function priorityMark(p: Priority): SafeHtml {
  if (p === 2) return html``;
  return html`<span class="prio prio-${p}" title="우선순위 ${PRIORITY_LABEL[p]}">${p === 1 ? '높음' : '낮음'}</span>`;
}

export function roleOptions(selected: Role | '' = '', opts: { auto?: boolean; none?: string } = {}): SafeHtml {
  return html`${opts.auto ? html`<option value="" ${selected === '' ? raw('selected') : ''}>자동</option>` : ''}${
    opts.none !== undefined ? html`<option value="" ${selected === '' ? raw('selected') : ''}>${opts.none}</option>` : ''
  }${ROLES.map((r) => html`<option value="${r}" ${r === selected ? raw('selected') : ''}>${ROLE_LABEL[r]}</option>`)}`;
}

export function priorityOptions(selected: Priority = 2): SafeHtml {
  return html`${([1, 2, 3] as Priority[]).map(
    (p) => html`<option value="${p}" ${p === selected ? raw('selected') : ''}>${PRIORITY_LABEL[p]}</option>`,
  )}`;
}

export function projectOptions(projects: Array<{ id: number; name: string }>, selected: number | null, none = '프로젝트 없음'): SafeHtml {
  return html`<option value="" ${selected === null ? raw('selected') : ''}>${none}</option>${projects.map(
    (p) => html`<option value="${p.id}" ${p.id === selected ? raw('selected') : ''}>${p.name}</option>`,
  )}`;
}

export function copyBlock(id: string, text: string, label = '복사'): SafeHtml {
  return html`<div class="copy-block">
    <button type="button" class="btn btn-small copy-btn" data-copy-target="${id}">${label}</button>
    <pre id="${id}" class="pre">${text}</pre>
  </div>`;
}

/** 서버에서 텍스트를 받아 복사하는 버튼 */
export function copyUrlButton(url: string, label: string, cls = 'btn btn-small'): SafeHtml {
  return html`<button type="button" class="${cls}" data-copy-url="${url}">${label}</button>`;
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

export interface TaskItemOpts {
  showProject?: boolean;
  /** 편집 화면에서 프로젝트를 바꿀 수 있게 */
  projects?: Array<{ id: number; name: string }>;
}

/** 할 일 한 줄 (상태 버튼, ⋯ 메뉴: 미루기·대기·AI에게 맡기기·편집·삭제) */
export function taskItem(ctx: Ctx, t: TaskWithProject, today: string, opts: TaskItemOpts = {}): SafeHtml {
  const back = currentPath(ctx);
  const overdue = t.due_date !== null && t.due_date < today && t.status !== 'done';
  const next = t.status === 'todo' ? 'doing' : 'todo';
  const hidden = html`${csrfInput(ctx)}${backInput(back)}`;
  const snooze = (to: string, label: string) =>
    html`<form method="post" action="/tasks/${t.id}/snooze" class="inline">${hidden}<input type="hidden" name="to" value="${to}"><button class="btn btn-small">${label}</button></form>`;
  return html`<li class="task ${t.status === 'done' ? 'is-done' : ''} ${t.waiting ? 'is-waiting' : ''}" id="task-${t.id}">
    <form method="post" action="/tasks/${t.id}/status" class="inline">
      ${hidden}
      <input type="hidden" name="status" value="${t.status === 'done' ? 'todo' : 'done'}">
      <button class="check ${t.status === 'done' ? 'checked' : ''}" title="${t.status === 'done' ? '되돌리기' : '완료'}" aria-label="완료 전환"></button>
    </form>
    <div class="task-main">
      <div class="task-title">${t.title}</div>
      <div class="task-meta">
        <span class="muted">T${t.id}</span>
        ${roleChip(t.role)}
        ${priorityMark(t.priority)}
        ${t.due_date ? html`<span class="due ${overdue ? 'overdue' : ''}">${formatDue(t.due_date, today)}${overdue ? ' 지남' : ''}</span>` : ''}
        ${t.repeat ? html`<span class="chip repeat" title="반복">🔁 ${describeRepeat(t.repeat)}</span>` : ''}
        ${t.waiting ? html`<span class="chip waiting" title="대기 중">⏸ ${t.waiting}</span>` : ''}
        ${t.status === 'doing' ? html`<span class="chip doing">진행 중</span>` : ''}
        ${opts.showProject && t.project_name ? html`<a class="proj-link" href="/projects/${t.project_id}">${t.project_name}</a>` : ''}
        ${t.source !== '나' ? html`<span class="muted small">· ${t.source}</span>` : ''}
      </div>
      ${t.note ? html`<div class="task-note">${clip(t.note, 140)}</div>` : ''}
    </div>
    <div class="task-actions">
      ${t.status !== 'done' && !t.waiting
        ? html`<form method="post" action="/tasks/${t.id}/status" class="inline">
            ${hidden}<input type="hidden" name="status" value="${next}">
            <button class="btn btn-ghost btn-small">${next === 'doing' ? '시작' : '멈춤'}</button>
          </form>`
        : ''}
      <details class="menu">
        <summary class="btn btn-ghost btn-small" aria-label="더보기">⋯</summary>
        <div class="menu-panel">
          ${t.status !== 'done'
            ? html`<div class="menu-row"><span class="menu-label">미루기</span>${snooze('today', '오늘')}${snooze('tomorrow', '내일')}${snooze('nextweek', '다음 주')}${snooze('none', '마감 없음')}</div>
              <form method="post" action="/tasks/${t.id}/waiting" class="menu-row">
                ${hidden}
                ${t.waiting
                  ? html`<input type="hidden" name="mode" value="clear"><button class="btn btn-small">대기 풀기</button>`
                  : html`<input type="hidden" name="mode" value="set"><input type="text" name="waiting" placeholder="무엇을 기다리나요? (예: 피드백)" class="grow"><button class="btn btn-small">대기로</button>`}
              </form>
              <div class="menu-row"><a class="btn btn-small" href="/run?task=${t.id}">🤖 AI에게 맡기기</a></div>`
            : ''}
          <form method="post" action="/tasks/${t.id}/edit" class="menu-edit">
            ${hidden}
            <input type="text" name="title" value="${t.title}" required aria-label="제목">
            <div class="form-inline wrap">
              ${opts.projects ? html`<select name="project_id" aria-label="프로젝트">${projectOptions(opts.projects, t.project_id)}</select>` : ''}
              <select name="role" aria-label="분야">${roleOptions(t.role)}</select>
              <select name="priority" aria-label="우선순위">${priorityOptions(t.priority)}</select>
              <input type="date" name="due_date" value="${t.due_date ?? ''}" aria-label="마감일">
            </div>
            <input type="text" name="repeat" value="${describeRepeat(t.repeat)}" placeholder="반복 (예: 매주 월, 매월 10일, 평일마다)" aria-label="반복">
            <textarea name="note" rows="2" placeholder="메모" aria-label="메모">${t.note}</textarea>
            <div class="form-inline"><button class="btn btn-primary btn-small">저장</button></div>
          </form>
          <form method="post" action="/tasks/${t.id}/delete" class="menu-row" data-confirm="이 할 일을 삭제할까요?">
            ${hidden}<button class="btn btn-ghost btn-small danger">삭제</button>
          </form>
        </div>
      </details>
    </div>
  </li>`;
}

// ─── 페이지 틀 ─────────────────────────────────────────────────

export type NavKey = 'today' | 'dashboard' | 'projects' | 'refs' | 'run' | 'inbox' | 'capture' | 'settings' | 'search';

const NAV: Array<[NavKey, string, string]> = [
  ['today', '/', '오늘'],
  ['dashboard', '/dashboard', '대시보드'],
  ['projects', '/projects', '프로젝트'],
  ['refs', '/refs', '레퍼런스'],
  ['run', '/run', 'AI 실행'],
  ['inbox', '/inbox', '인박스'],
  ['capture', '/capture', '붙여넣기'],
  ['settings', '/settings', '설정'],
];

export interface PageOpts {
  title: string;
  active?: NavKey;
  pending?: number;
}

function head(title: string): SafeHtml {
  return html`<meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#4f46e5">
  <title>${title}</title>
  <link rel="stylesheet" href="/static/app.css">
  <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/static/icon-192.png">
  <link rel="manifest" href="/manifest.webmanifest">
  <script src="/static/app.js" defer></script>`;
}

export function page(ctx: Ctx, opts: PageOpts, body: SafeHtml): SafeHtml {
  const f = takeFlash(ctx);
  const q = ctx.url.pathname === '/search' ? ctx.url.searchParams.get('q') ?? '' : '';
  return html`<!doctype html>
<html lang="ko">
<head>
  ${head(`${opts.pending ? `(${opts.pending}) ` : ''}${opts.title} · Hub`)}
</head>
<body>
  ${ctx.session
    ? html`<header class="topbar">
        <a class="brand" href="/">Hub</a>
        <nav class="nav">
          ${NAV.map(
            ([key, href, label]) =>
              html`<a href="${href}" class="${opts.active === key ? 'active' : ''}">${label}${key === 'inbox' && opts.pending ? html`<span class="badge">${opts.pending}</span>` : ''}</a>`,
          )}
          <a href="/search" class="nav-search-link ${opts.active === 'search' ? 'active' : ''}">검색</a>
        </nav>
        <form method="get" action="/search" class="top-search" role="search">
          <input type="search" name="q" value="${q}" placeholder="검색  /" aria-label="검색" data-search-input>
        </form>
        <form method="post" action="/logout" class="inline logout">${csrfInput(ctx)}<button class="btn btn-ghost btn-small">로그아웃</button></form>
      </header>`
    : ''}
  <main class="container">
    ${f ? html`<div class="flash flash-${f.kind}" role="status">${f.text}</div>` : ''}
    ${body}
  </main>
</body>
</html>`;
}

/** 로그인 없이 보여주는 단순 화면 (로그인, 동의, 오류) */
export function barePage(title: string, body: SafeHtml): SafeHtml {
  return html`<!doctype html>
<html lang="ko">
<head>
  ${head(`${title} · Hub`)}
</head>
<body class="bare">
  <main class="bare-card">${body}</main>
</body>
</html>`;
}
