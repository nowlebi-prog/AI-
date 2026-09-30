import { html, raw, type SafeHtml } from '../lib/html.ts';
import type { Ctx } from '../lib/http.ts';
import { formatDue } from '../lib/time.ts';
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

export function roleOptions(selected: Role | '' = ''): SafeHtml {
  return html`${ROLES.map((r) => html`<option value="${r}" ${r === selected ? raw('selected') : ''}>${ROLE_LABEL[r]}</option>`)}`;
}

export function priorityOptions(selected: Priority = 2): SafeHtml {
  return html`${([1, 2, 3] as Priority[]).map(
    (p) => html`<option value="${p}" ${p === selected ? raw('selected') : ''}>${PRIORITY_LABEL[p]}</option>`,
  )}`;
}

export function copyBlock(id: string, text: string, label = '복사'): SafeHtml {
  return html`<div class="copy-block">
    <button type="button" class="btn btn-small copy-btn" data-copy-target="${id}">${label}</button>
    <pre id="${id}" class="pre">${text}</pre>
  </div>`;
}

/** 할 일 한 줄 (상태 버튼 포함) */
export function taskItem(
  ctx: Ctx,
  t: TaskWithProject,
  today: string,
  opts: { showProject?: boolean; allowDelete?: boolean } = {},
): SafeHtml {
  const back = currentPath(ctx);
  const overdue = t.due_date !== null && t.due_date < today && t.status !== 'done';
  const next = t.status === 'todo' ? 'doing' : 'todo';
  return html`<li class="task ${t.status === 'done' ? 'is-done' : ''}" id="task-${t.id}">
    <form method="post" action="/tasks/${t.id}/status" class="inline">
      ${csrfInput(ctx)}${backInput(back)}
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
        ${t.status === 'doing' ? html`<span class="chip doing">진행 중</span>` : ''}
        ${opts.showProject && t.project_name ? html`<a class="proj-link" href="/projects/${t.project_id}">${t.project_name}</a>` : ''}
        ${t.source !== '나' ? html`<span class="muted small">· ${t.source}</span>` : ''}
      </div>
    </div>
    <div class="task-actions">
      ${t.status !== 'done'
        ? html`<form method="post" action="/tasks/${t.id}/status" class="inline">
            ${csrfInput(ctx)}${backInput(back)}
            <input type="hidden" name="status" value="${next}">
            <button class="btn btn-ghost btn-small">${next === 'doing' ? '시작' : '멈춤'}</button>
          </form>`
        : ''}
      ${opts.allowDelete
        ? html`<form method="post" action="/tasks/${t.id}/delete" class="inline" data-confirm="이 할 일을 삭제할까요?">
            ${csrfInput(ctx)}${backInput(back)}
            <button class="btn btn-ghost btn-small danger" title="삭제">삭제</button>
          </form>`
        : ''}
    </div>
  </li>`;
}

// ─── 페이지 틀 ─────────────────────────────────────────────────

export type NavKey = 'today' | 'projects' | 'inbox' | 'capture' | 'import' | 'settings';

const NAV: Array<[NavKey, string, string]> = [
  ['today', '/', '오늘'],
  ['projects', '/projects', '프로젝트'],
  ['inbox', '/inbox', '인박스'],
  ['capture', '/capture', '붙여넣기'],
  ['import', '/import', '가져오기'],
  ['settings', '/settings', '설정'],
];

export interface PageOpts {
  title: string;
  active?: NavKey;
  pending?: number;
}

export function page(ctx: Ctx, opts: PageOpts, body: SafeHtml): SafeHtml {
  const f = takeFlash(ctx);
  return html`<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${opts.title} · Hub</title>
  <link rel="stylesheet" href="/static/app.css">
  <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
  <script src="/static/app.js" defer></script>
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
        </nav>
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
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${title} · Hub</title>
  <link rel="stylesheet" href="/static/app.css">
  <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
  <script src="/static/app.js" defer></script>
</head>
<body class="bare">
  <main class="bare-card">${body}</main>
</body>
</html>`;
}
