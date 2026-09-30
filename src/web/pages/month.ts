import type { AppCtx } from '../../app-context.ts';
import { clip } from '../../domain/brief.ts';
import { currentDay } from '../../domain/clock.ts';
import { monthView, type MonthItem } from '../../domain/month.ts';
import { listProjects } from '../../domain/projects.ts';
import { pendingCount } from '../../domain/proposals.ts';
import { ROLES, ROLE_LABEL, toRole } from '../../domain/types.ts';
import { html, type SafeHtml } from '../../lib/html.ts';
import { sendHtml, type Ctx } from '../../lib/http.ts';
import { formatDate } from '../../lib/time.ts';
import { page, roleChip } from '../layout.ts';

const WEEK = ['월', '화', '수', '목', '금', '토', '일'];

/** CSP 때문에 인라인 style 대신 5% 단위 클래스 */
export function step5(pct: number): number {
  return Math.min(100, Math.max(0, Math.round(pct / 5) * 5));
}

export function progressBar(pct: number, label = ''): SafeHtml {
  return html`<div class="progress-row"><div class="progress"><span class="w-${step5(pct)}"></span></div><span class="pct">${pct}%</span>${label ? html`<span class="muted small">${label}</span>` : ''}</div>`;
}

/** 대시보드 위쪽 탭 (현황 | 월간) */
export function dashboardTabs(active: 'status' | 'month'): SafeHtml {
  return html`<div class="view-tabs">
    <a href="/dashboard" class="${active === 'status' ? 'active' : ''}">현황</a>
    <a href="/calendar" class="${active === 'month' ? 'active' : ''}">월간 달력</a>
  </div>`;
}

function qs(p: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

function itemChip(it: MonthItem): SafeHtml {
  const cls = ['cal-item', `role-line-${it.role}`, it.status === 'done' ? 'is-done' : '', it.virtual ? 'is-virtual' : '', it.overdue ? 'is-overdue' : '', it.waiting ? 'is-waiting' : '']
    .filter(Boolean)
    .join(' ');
  const title = `${it.project_name ? `[${it.project_name}] ` : ''}${it.title}${it.virtual ? ' (반복 예정)' : ''}`;
  const href = it.project_id ? `/projects/${it.project_id}#task-${it.id}` : `/#task-${it.id}`;
  return html`<a class="${cls}" href="${href}" title="${title}">${it.project_name ? html`<span class="cal-proj">${clip(it.project_name, 8)}</span>` : ''}${clip(it.title, 22)}</a>`;
}

export function monthPage(app: AppCtx) {
  return (ctx: Ctx): void => {
    const today = currentDay(app.db);
    const role = toRole(ctx.url.searchParams.get('role') ?? '') ?? undefined;
    const pParam = Number(ctx.url.searchParams.get('project') ?? '');
    const projectId = Number.isInteger(pParam) && pParam > 0 ? pParam : undefined;
    const v = monthView(app.db, ctx.url.searchParams.get('month'), today, { role, projectId });
    const projects = listProjects(app.db, 'active');
    const keep = { role, project: projectId };
    const MAX = 4;

    const body = html`
      <div class="page-head">
        <div>
          ${dashboardTabs('month')}
          <h1>${v.label}
            <span class="month-nav">
              <a class="btn btn-small" href="/calendar${qs({ ...keep, month: v.prev })}" aria-label="이전 달">‹</a>
              <a class="btn btn-small" href="/calendar${qs(keep)}">오늘</a>
              <a class="btn btn-small" href="/calendar${qs({ ...keep, month: v.next })}" aria-label="다음 달">›</a>
            </span>
          </h1>
        </div>
        <div class="filters">
          <a href="/calendar${qs({ month: v.month, project: projectId })}" class="pill ${!role ? 'active' : ''}">전체</a>
          ${ROLES.filter((r) => r !== 'etc').map(
            (r) => html`<a href="/calendar${qs({ month: v.month, project: projectId, role: r })}" class="pill pill-${r} ${role === r ? 'active' : ''}">${ROLE_LABEL[r]}</a>`,
          )}
        </div>
      </div>

      <div class="grid-month">
        <div>
          <div class="calendar" role="grid" aria-label="${v.label} 달력">
            ${WEEK.map((w, i) => html`<div class="cal-head ${i >= 5 ? 'weekend' : ''}">${w}</div>`)}
            ${v.weeks.flat().map(
              (c) => html`<div class="cal-cell ${c.inMonth ? '' : 'out'} ${c.isToday ? 'today' : ''} ${c.weekend ? 'weekend' : ''}">
                <div class="cal-date"><span>${Number(c.date.slice(8))}</span>
                  <a class="cal-add" href="/?focus=add&amp;prefill=${encodeURIComponent(`${Number(c.date.slice(5, 7))}/${Number(c.date.slice(8))} `)}" title="${formatDate(c.date)}에 할 일 추가">＋</a></div>
                ${c.items.slice(0, MAX).map(itemChip)}
                ${c.items.length > MAX ? html`<details class="cal-more"><summary>+${c.items.length - MAX}</summary>${c.items.slice(MAX).map(itemChip)}</details>` : ''}
              </div>`,
            )}
          </div>
          <div class="agenda">
            ${v.weeks.flat().filter((c) => c.inMonth && c.items.length).map(
              (c) => html`<section class="agenda-day ${c.isToday ? 'today' : ''}"><h4>${formatDate(c.date)}${c.isToday ? ' · 오늘' : ''}</h4>${c.items.map(itemChip)}</section>`,
            )}
            ${v.weeks.flat().some((c) => c.inMonth && c.items.length) ? '' : html`<p class="empty">이 달에 마감인 할 일이 없어요.</p>`}
          </div>
          <p class="small muted">마감일이 있는 할 일이 보여요. 흐린 칸은 반복 할 일의 다음 차례예요. 날짜의 ＋를 누르면 그날 마감으로 바로 추가할 수 있어요.</p>
        </div>

        <aside>
          <section class="card">
            <h3>이번 달 진행도</h3>
            ${progressBar(v.total.pct, `마감 ${v.total.due}개 중 ${v.total.done}개 완료`)}
            ${v.roles.length
              ? html`<ul class="plain role-progress">${v.roles.map(
                  (r) => html`<li><a href="/calendar${qs({ month: v.month, role: r.role, project: projectId })}">${roleChip(r.role)}</a>${progressBar(r.pct, `${r.done}/${r.due}`)}</li>`,
                )}</ul>`
              : html`<p class="muted small">이 달에 마감인 할 일이 없어요.</p>`}
          </section>
          <section class="card">
            <h3>프로젝트 진행도</h3>
            <p class="small muted">반복이 아닌 할 일 중 완료 비율이에요.</p>
            ${v.projects.length
              ? html`<ul class="plain project-progress">${v.projects.map((p) => {
                  const k = toRole(p.kind);
                  return html`<li class="${projectId === p.id ? 'active' : ''}">
                    <div class="pp-head"><a href="/calendar${qs({ month: v.month, project: projectId === p.id ? undefined : p.id, role })}">${p.name}</a>${k && k !== 'etc' ? roleChip(k) : ''}</div>
                    ${progressBar(p.pct, `${p.done}/${p.total}`)}
                    ${p.monthDue ? html`<div class="small muted">이번 달 마감 ${p.monthDone}/${p.monthDue}</div>` : ''}
                  </li>`;
                })}</ul>`
              : html`<p class="muted small">진행 중인 프로젝트가 없어요.</p>`}
            ${projectId ? html`<a class="small" href="/calendar${qs({ month: v.month, role })}">프로젝트 필터 지우기</a>` : ''}
          </section>
          <p class="small muted">휴대폰 캘린더에서도 보려면 <a href="/settings#calendar">캘린더 구독</a>을 켜세요.</p>
          ${projects.length ? '' : html`<p class="small"><a href="/projects">프로젝트 만들기</a></p>`}
        </aside>
      </div>`;
    sendHtml(ctx, page(ctx, { title: `${v.label} 달력`, active: 'dashboard', pending: pendingCount(app.db) }, body));
  };
}
