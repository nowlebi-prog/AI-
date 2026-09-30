import type { AppCtx } from '../../app-context.ts';
import { clip } from '../../domain/brief.ts';
import { currentDay } from '../../domain/clock.ts';
import { dueHistogram, projectStats, roleStats, type ProjectStat } from '../../domain/dashboard.ts';
import { progressOf } from '../../domain/projects.ts';
import { pendingCount } from '../../domain/proposals.ts';
import { dashboardTabs, progressBar, step5 } from './month.ts';
import { ROLES, ROLE_LABEL, toRole, type Role } from '../../domain/types.ts';
import { html, type SafeHtml } from '../../lib/html.ts';
import { sendHtml, type Ctx } from '../../lib/http.ts';
import { formatAgo, formatDate, formatDue } from '../../lib/time.ts';
import { page, roleChip } from '../layout.ts';

function projectRow(p: ProjectStat, today: string): SafeHtml {
  return html`<li class="dash-project">
    <div class="dash-project-head">
      <a href="/projects/${p.id}"><strong>${p.name}</strong></a>
      ${p.overdue ? html`<span class="chip overdue-chip">지난 마감 ${p.overdue}</span>` : ''}
      <span class="muted small">${formatAgo(p.last_activity)}</span>
    </div>
    ${p.stage ? html`<div class="small muted">단계: ${p.stage}</div>` : ''}
    ${p.nextTask
      ? html`<div class="small">다음: <a href="/projects/${p.id}#task-${p.nextTask.id}">${clip(p.nextTask.title, 50)}</a>${p.nextTask.due_date ? html` <span class="due ${p.nextTask.due_date < today ? 'overdue' : ''}">${formatDue(p.nextTask.due_date, today)}</span>` : ''}</div>`
      : html`<div class="small muted">열린 할 일 없음</div>`}
    ${p.resume_note ? html`<div class="small resume">↳ ${clip(p.resume_note, 70)}</div>` : ''}
    <div class="role-mini">${ROLES.filter((r) => p.byRole[r]).map((r) => html`<span class="chip role-${r}">${ROLE_LABEL[r]} ${p.byRole[r]}</span>`)}</div>
    ${progressBar(progressOf(p), `${p.done_tasks}/${p.total_tasks} 완료`)}
  </li>`;
}

export function dashboardPage(app: AppCtx) {
  return (ctx: Ctx): void => {
    const today = currentDay(app.db);
    const stats = roleStats(app.db, today).filter((s) => s.role !== 'etc' || s.open > 0);
    const projects = projectStats(app.db, today);
    const hist = dueHistogram(app.db, today, 14);
    const maxCount = Math.max(1, ...hist.map((h) => h.count));
    const groups: Array<{ kind: Role | null; items: ProjectStat[] }> = [];
    for (const r of ROLES) {
      const items = projects.filter((p) => toRole(p.kind) === r);
      if (items.length) groups.push({ kind: r, items });
    }
    const unassigned = projects.filter((p) => !toRole(p.kind) || toRole(p.kind) === 'etc');
    if (unassigned.length) groups.push({ kind: null, items: unassigned });

    const body = html`
      <div class="page-head"><div>${dashboardTabs('status')}<h1>대시보드 <span class="muted small">${formatDate(today)}</span></h1></div></div>

      <div class="role-grid">
        ${stats.map(
          (s) => html`<a class="card role-card role-border-${s.role}" href="/?role=${s.role}">
            <div class="role-card-head">${roleChip(s.role)}<span class="big">${s.open}</span></div>
            <div class="role-card-stats small">
              ${s.overdue ? html`<span class="error-text">지난 마감 ${s.overdue}</span>` : ''}
              <span>7일 안 ${s.week}</span>
              ${s.doing ? html`<span>진행 중 ${s.doing}</span>` : ''}
              ${s.waiting ? html`<span>대기 ${s.waiting}</span>` : ''}
              <span class="muted">7일 완료 ${s.doneWeek}</span>
            </div>
          </a>`,
        )}
      </div>

      <section class="card">
        <h3>다가오는 마감 (14일)</h3>
        <div class="histogram">
          ${hist.map(
            (h) => html`<div class="bar ${h.overdue ? 'is-overdue' : ''} ${h.date === today ? 'is-today' : ''}" title="${h.overdue ? '지난 마감' : formatDate(h.date)} · ${h.count}개">
              <span class="bar-count">${h.count || ''}</span>
              <span class="bar-fill h-${step5((h.count / maxCount) * 100)}"></span>
              <span class="bar-label">${h.overdue ? '지남' : h.date === today ? '오늘' : `${Number(h.date.slice(8))}`}</span>
            </div>`,
          )}
        </div>
      </section>

      ${groups.length
        ? html`<div class="dash-groups">${groups.map(
            (g) => html`<section class="card">
              <h3>${g.kind ? roleChip(g.kind) : html`<span class="chip">분야 없음</span>`} 프로젝트 <span class="count">${g.items.length}</span></h3>
              <ul class="plain dash-projects">${g.items.map((p) => projectRow(p, today))}</ul>
            </section>`,
          )}</div>`
        : html`<p class="empty">진행 중인 프로젝트가 없어요. <a href="/projects">프로젝트 만들기</a></p>`}

      ${projects.length
        ? html`<section class="card">
            <h3>프로젝트 × 분야 (열린 할 일)</h3>
            <div class="table-wrap"><table class="table matrix">
              <thead><tr><th>프로젝트</th>${ROLES.map((r) => html`<th>${ROLE_LABEL[r]}</th>`)}<th>지난 마감</th></tr></thead>
              <tbody>${projects.map(
                (p) => html`<tr><td><a href="/projects/${p.id}">${p.name}</a></td>${ROLES.map(
                  (r) => html`<td class="num">${p.byRole[r] ?? ''}</td>`,
                )}<td class="num ${p.overdue ? 'error-text' : ''}">${p.overdue || ''}</td></tr>`,
              )}</tbody>
            </table></div>
            <p class="small muted">프로젝트의 분야는 프로젝트 카드에서, 할 일의 분야는 할 일 ⋯ 메뉴에서 바꿀 수 있어요.</p>
          </section>`
        : ''}`;
    sendHtml(ctx, page(ctx, { title: '대시보드', active: 'dashboard', pending: pendingCount(app.db) }, body));
  };
}
