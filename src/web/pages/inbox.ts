import type { AppCtx } from '../../app-context.ts';
import { VIA_LABEL, listActivity, undoActivity } from '../../domain/activity.ts';
import {
  approveProposal,
  describeProposal,
  listProposals,
  rejectProposal,
  type DecisionPayload,
  type ProposalView,
  type TaskPayload,
} from '../../domain/proposals.ts';
import { PROPOSAL_KIND_LABEL } from '../../domain/types.ts';
import { html } from '../../lib/html.ts';
import { field, sendHtml, type Ctx } from '../../lib/http.ts';
import { formatAgo } from '../../lib/time.ts';
import { formAction, idParam } from '../actions.ts';
import { csrfInput, flash, page, priorityOptions, roleOptions } from '../layout.ts';

function editForm(ctx: Ctx, p: ProposalView) {
  if (p.kind === 'decision') {
    const d = JSON.parse(p.payload) as DecisionPayload;
    return html`<details class="edit"><summary>고쳐서 승인</summary>
      <form method="post" action="/inbox/${p.id}/approve" class="stack">
        ${csrfInput(ctx)}<input type="hidden" name="edit" value="1">
        <input type="text" name="content" value="${d.content}" required>
        <input type="text" name="reason" value="${d.reason}" placeholder="이유">
        <button class="btn btn-primary btn-small">이대로 승인</button>
      </form></details>`;
  }
  if (p.kind === 'task') {
    const t = JSON.parse(p.payload) as TaskPayload;
    return html`<details class="edit"><summary>고쳐서 승인</summary>
      <form method="post" action="/inbox/${p.id}/approve" class="form-inline wrap">
        ${csrfInput(ctx)}<input type="hidden" name="edit" value="1">
        <input type="text" name="title" value="${t.title}" required class="grow">
        <select name="role">${roleOptions(t.role)}</select>
        <select name="priority">${priorityOptions(t.priority)}</select>
        <input type="date" name="due_date" value="${t.due_date ?? ''}">
        <button class="btn btn-primary btn-small">이대로 승인</button>
      </form></details>`;
  }
  return html``;
}

function proposalCard(app: AppCtx, ctx: Ctx, p: ProposalView) {
  const d = describeProposal(app.db, p);
  return html`<li class="proposal kind-${p.kind}">
    <div class="proposal-head">
      <span class="chip kind">${PROPOSAL_KIND_LABEL[p.kind]}</span>
      <span class="small muted">#${p.id} · ${p.source} · ${formatAgo(p.created_at)}</span>
    </div>
    <div class="proposal-title">${d.title}</div>
    ${d.details.length ? html`<ul class="details">${d.details.map((x) => html`<li>${x}</li>`)}</ul>` : ''}
    <div class="proposal-actions">
      <form method="post" action="/inbox/${p.id}/approve" class="inline">${csrfInput(ctx)}<button class="btn btn-primary btn-small">승인</button></form>
      <form method="post" action="/inbox/${p.id}/reject" class="inline">${csrfInput(ctx)}<button class="btn btn-ghost btn-small">거절</button></form>
    </div>
    ${editForm(ctx, p)}
  </li>`;
}

export function inboxPage(app: AppCtx) {
  return (ctx: Ctx): void => {
    const pending = listProposals(app.db, 'pending');
    const resolved = listProposals(app.db, 'resolved', 20);
    const activity = listActivity(app.db, { limit: 40 });
    const groups = new Map<string, { projectId: number | null; items: ProposalView[] }>();
    for (const p of pending) {
      const key = p.kind === 'project' ? '새 프로젝트' : p.project_name ?? '프로젝트 없음';
      const g = groups.get(key) ?? { projectId: p.kind === 'project' ? null : p.project_id, items: [] };
      g.items.push(p);
      groups.set(key, g);
    }
    const body = html`
      <div class="page-head">
        <h1>인박스 <span class="count">${pending.length}</span></h1>
        ${pending.length > 1
          ? html`<form method="post" action="/inbox/approve-all" class="inline" data-confirm="대기 중인 제안 ${pending.length}건을 모두 승인할까요?">
              ${csrfInput(ctx)}<button class="btn">모두 승인</button></form>`
          : ''}
      </div>
      <p class="hint">AI가 올린 결정·할 일·프로젝트 변경이에요. 승인해야 Hub에 반영돼요. AI에게 직접 시킨 변경과 자동 승인은 아래 <a href="#activity">변경 기록</a>에서 되돌릴 수 있어요.</p>
      ${pending.length
        ? [...groups.entries()].map(
            ([name, g]) => html`<section class="inbox-group">
              <h3>${name} <span class="count">${g.items.length}</span>
                ${g.items.length > 1 && g.projectId !== null
                  ? html`<form method="post" action="/inbox/approve-all" class="inline">${csrfInput(ctx)}<input type="hidden" name="project" value="${g.projectId}"><button class="btn btn-ghost btn-small">이 프로젝트 모두 승인</button></form>`
                  : ''}
              </h3>
              <ul class="proposals">${g.items.map((p) => proposalCard(app, ctx, p))}</ul>
            </section>`,
          )
        : html`<p class="empty">승인을 기다리는 제안이 없어요.</p>`}

      <section class="card" id="activity">
        <h3>변경 기록 <span class="muted small">AI가 만든 변경 · 최근 40건</span></h3>
        ${activity.length
          ? html`<ul class="plain activity">${activity.map(
              (a) => html`<li class="${a.undone_at ? 'undone' : ''}">
                <span class="chip">${VIA_LABEL[a.via]}</span>
                <span>${a.summary}</span>
                <span class="muted small">${a.source} · ${formatAgo(a.at)}</span>
                ${a.undone_at
                  ? html`<span class="muted small">되돌림</span>`
                  : html`<form method="post" action="/activity/${a.id}/undo" class="inline" data-confirm="이 변경을 되돌릴까요?">${csrfInput(ctx)}<button class="btn btn-ghost btn-small">되돌리기</button></form>`}
              </li>`,
            )}</ul>`
          : html`<p class="muted small">아직 기록이 없어요.</p>`}
      </section>

      ${resolved.length
        ? html`<details class="card history"><summary>최근 처리한 제안 ${resolved.length}</summary>
            <ul class="plain">${resolved.map((p) => {
              const d = describeProposal(app.db, p);
              return html`<li class="small"><span class="chip ${p.status}">${p.status === 'approved' ? '승인' : '거절'}</span>
                ${PROPOSAL_KIND_LABEL[p.kind]} · ${d.title} <span class="muted">· ${p.source} · ${formatAgo(p.resolved_at ?? p.created_at)}</span></li>`;
            })}</ul></details>`
        : ''}`;
    sendHtml(ctx, page(ctx, { title: '인박스', active: 'inbox', pending: pending.length }, body));
  };
}

export function inboxActions(app: AppCtx) {
  return {
    approve: (ctx: Ctx) =>
      formAction(ctx, '/inbox', (form) => {
        let overrides: Record<string, string> | undefined;
        if (field(form, 'edit') === '1') {
          overrides = {};
          for (const k of ['content', 'reason', 'title', 'role', 'priority', 'due_date']) {
            if (form.has(k)) overrides[k] = field(form, k);
          }
        }
        approveProposal(app.db, idParam(ctx), { overrides, via: 'approved' });
        flash(ctx, '승인해서 반영했어요');
      }),
    reject: (ctx: Ctx) =>
      formAction(ctx, '/inbox', () => {
        rejectProposal(app.db, idParam(ctx));
        flash(ctx, '거절했어요');
      }),
    approveAll: (ctx: Ctx) =>
      formAction(ctx, '/inbox', (form) => {
        const project = field(form, 'project');
        let ok = 0;
        const errors: string[] = [];
        for (const p of listProposals(app.db, 'pending')) {
          if (project && String(p.project_id) !== project) continue;
          try {
            approveProposal(app.db, p.id, { via: 'approved' });
            ok++;
          } catch (err) {
            errors.push(`#${p.id} ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        flash(ctx, errors.length ? `${ok}건 승인, ${errors.length}건 실패: ${errors.join(' / ')}` : `${ok}건 모두 승인했어요`, errors.length ? 'error' : 'ok');
      }),
    undo: (ctx: Ctx) =>
      formAction(ctx, '/inbox#activity', () => {
        flash(ctx, undoActivity(app.db, idParam(ctx)));
        return '/inbox#activity';
      }),
  };
}
