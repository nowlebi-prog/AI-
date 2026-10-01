import type { AppCtx } from '../../app-context.ts';
import { AIS, AI_IDS, CATEGORIES, getAiApps, isAiId, mcpConnected, type AiId } from '../../domain/ais.ts';
import { clip } from '../../domain/brief.ts';
import { listProjects } from '../../domain/projects.ts';
import { pendingCount } from '../../domain/proposals.ts';
import type { Target } from '../../domain/router.ts';
import {
  canUseApi,
  composePrompt,
  createRun,
  deleteRun,
  handoffUrl,
  listRuns,
  markHandoff,
  planOf,
  requireRun,
  resultOf,
  startApiRun,
  type RunView,
} from '../../domain/runs.ts';
import { getTask } from '../../domain/tasks.ts';
import { UserError } from '../../domain/types.ts';
import { html, multiline, raw, type SafeHtml } from '../../lib/html.ts';
import { field, readForm, redirect, sendHtml, type Ctx } from '../../lib/http.ts';
import { formatAgo } from '../../lib/time.ts';
import { formAction, idParam } from '../actions.ts';
import { copyBlock, csrfInput, flash, page, projectOptions } from '../layout.ts';

const STATUS_LABEL: Record<RunView['status'], string> = {
  planned: '추천 완료',
  running: '실행 중',
  done: '완료',
  handed_off: '앱에서 열림',
  failed: '실패',
};

function keysSummary(app: AppCtx): SafeHtml {
  const k = app.config.ai;
  const items: Array<[string, boolean]> = [
    ['Jev(추천)', Boolean(k.typesafe)],
    ['ChatGPT', Boolean(k.openai)],
    ['Claude', Boolean(k.anthropic)],
    ['Grok', Boolean(k.xai)],
    ['Muse', Boolean(k.meta && k.metaBaseUrl)],
  ];
  return html`<div class="key-status small">${items.map(([n, ok]) => html`<span class="chip ${ok ? 'approved' : ''}">${ok ? '✓' : '—'} ${n}</span>`)}
    <a href="/settings#ai-run">설정</a></div>`;
}

export function runHomePage(app: AppCtx) {
  return (ctx: Ctx): void => {
    const projects = listProjects(app.db, 'active').map((p) => ({ id: p.id, name: p.name }));
    const taskId = Number(ctx.url.searchParams.get('task') ?? '');
    const task = Number.isInteger(taskId) && taskId > 0 ? getTask(app.db, taskId) : undefined;
    const projectParam = Number(ctx.url.searchParams.get('project') ?? '');
    const projectId = task?.project_id ?? (Number.isInteger(projectParam) && projectParam > 0 ? projectParam : null);
    const text = task ? `${task.title}${task.note ? `\n\n메모: ${task.note}` : ''}` : (ctx.url.searchParams.get('text') ?? '');
    const runs = listRuns(app.db, 15);
    const body = html`
      <div class="page-head"><h1>AI에게 맡기기</h1></div>
      <p class="hint">할 일을 적으면 어떤 AI·모델이 맞는지 추천해요. 확인하고 실행하면 그 AI가 Hub 맥락을 받아 처리하고, 결과의 [Hub 메모]는 자동으로 기록·인박스로 들어가요.</p>
      <form method="post" action="/run" class="card stack">
        ${csrfInput(ctx)}
        <textarea name="request" rows="5" placeholder="예: 브랜드X 런칭용 인스타 카피 5개 뽑아줘 / 예약 앱 로그인 API 에러 원인 찾아줘 / 요즘 비건 화장품 패키지 트렌드 조사해줘" required autofocus>${text}</textarea>
        <div class="form-inline wrap">
          <label class="inline-label">프로젝트 <select name="project">${projectOptions(projects, projectId, '자동으로 찾기')}</select></label>
          <button class="btn btn-primary">추천 받기</button>
          ${keysSummary(app)}
        </div>
      </form>
      ${runs.length
        ? html`<section class="card"><h3>최근 실행</h3><ul class="plain runs">${runs.map(
            (r) => html`<li><a href="/run/${r.id}">${clip(r.request, 70)}</a>
              <span class="chip ${r.status === 'done' ? 'approved' : r.status === 'failed' ? 'overdue-chip' : ''}">${STATUS_LABEL[r.status]}</span>
              <span class="muted small">${r.ai ? AIS[r.ai].label : AIS[planOf(r).primary.ai].label}${r.project_name ? ` · ${r.project_name}` : ''} · ${formatAgo(r.created_at)}</span></li>`,
          )}</ul></section>`
        : ''}`;
    sendHtml(ctx, page(ctx, { title: 'AI 실행', active: 'run', pending: pendingCount(app.db) }, body));
  };
}

export function runCreateAction(app: AppCtx) {
  return (ctx: Ctx) =>
    formAction(ctx, '/run', async (form) => {
      const project = field(form, 'project');
      const id = await createRun(app.db, app.config.ai, form.get('request') ?? '', project ? Number(project) : null);
      return `/run/${id}`;
    });
}

function targetCard(app: AppCtx, ctx: Ctx, run: RunView, t: Target, primary: boolean): SafeHtml {
  const api = canUseApi(app.config.ai, t.ai, run);
  const prompt = composePrompt(app.db, run, t.ai, 'app');
  const handoff = handoffUrl(app.db, t.ai, prompt);
  const connected = mcpConnected(app.db, t.ai);
  const promptId = `prompt-${t.ai}`;
  return html`<div class="target ${primary ? 'is-primary' : ''}">
    <div class="target-head">
      <strong>${AIS[t.ai].label}</strong> <span class="muted small">${t.model}</span>
      ${primary ? html`<span class="chip kind">추천</span>` : ''}
      ${connected ? html`<span class="chip approved" title="최근 MCP 연결 확인">Hub 연결됨</span>` : ''}
    </div>
    ${t.why ? html`<div class="small muted">${t.why}</div>` : ''}
    <div class="form-inline wrap target-actions">
      <form method="post" action="/run/${run.id}/execute" class="inline">
        ${csrfInput(ctx)}<input type="hidden" name="ai" value="${t.ai}"><input type="hidden" name="model" value="${t.model}">
        <button class="btn ${primary ? 'btn-primary' : ''}" ${api.ok ? '' : raw('disabled')} title="${api.ok ? 'Hub가 API로 바로 실행하고 결과를 보여줘요' : api.reason}">API로 실행</button>
      </form>
      <a class="btn" href="${handoff.url}" target="_blank" rel="noopener" data-handoff data-copy-source="${promptId}" data-mark="/run/${run.id}/handoff" data-ai="${t.ai}" data-model="${t.model}">
        ${AIS[t.ai].label} 앱에서 열기</a>
    </div>
    <div class="small muted">${!api.ok ? html`API: ${api.reason}. ` : ''}${handoff.inUrl ? '앱에서 열면 프롬프트가 채워져요.' : '앱에서 열면 프롬프트가 복사돼요 — 붙여넣기(⌘V/Ctrl+V) 하세요.'}${connected ? ' Hub가 연결돼 있어 짧은 요청만 보내요.' : ''}</div>
    <pre id="${promptId}" class="hidden-text">${prompt}</pre>
  </div>`;
}

export function runDetailPage(app: AppCtx) {
  return (ctx: Ctx): void => {
    const run = requireRun(app.db, idParam(ctx));
    const plan = planOf(run);
    const result = resultOf(run);
    const cat = CATEGORIES[plan.category];
    const targets = [plan.primary, ...plan.alternatives];
    const apps = getAiApps(app.db);
    const body = html`
      <div class="page-head">
        <div>
          <div class="crumbs"><a href="/run">AI 실행</a> / #${run.id}</div>
          <h1>${clip(run.request, 40)} <span class="chip">${STATUS_LABEL[run.status]}</span></h1>
        </div>
        <form method="post" action="/run/${run.id}/delete" class="inline" data-confirm="이 실행 기록을 지울까요?">${csrfInput(ctx)}<button class="btn btn-ghost btn-small danger">기록 삭제</button></form>
      </div>
      <section class="card">
        <h3>요청</h3>
        <div>${multiline(run.request)}</div>
        <p class="small muted">${run.project_name ? html`프로젝트: <a href="/projects/${run.project_id}">${run.project_name}</a> · ` : '프로젝트 없음 · '}${formatAgo(run.created_at)}</p>
      </section>

      ${run.status === 'running'
        ? html`<section class="card running" data-poll="2500"><h3>⏳ ${run.ai ? AIS[run.ai].label : ''} 실행 중…</h3><p class="small muted">보통 수십 초 걸려요. 이 화면은 자동으로 새로 고쳐져요.</p></section>`
        : ''}

      ${run.status === 'done' && run.response
        ? html`<section class="card">
            <h3>결과 <span class="muted small">${run.ai ? AIS[run.ai].label : ''} · ${run.model ?? ''}${result?.usage ? ` · ${result.usage}` : ''}</span></h3>
            ${copyBlock('run-response', run.response, '결과 복사')}
            ${result && (result.applied.length || result.pending.length || result.errors.length)
              ? html`<ul class="plain small">
                  ${result.applied.map((x) => html`<li>✅ ${x}</li>`)}
                  ${result.pending.map((x) => html`<li>📥 인박스: ${x}</li>`)}
                  ${result.errors.map((x) => html`<li class="error-text">⚠️ ${x}</li>`)}
                </ul>
                ${result.pending.length ? html`<a class="btn btn-primary btn-small" href="/inbox">인박스에서 승인하기</a>` : ''}`
              : html`<p class="small muted">결과에 [Hub 메모]가 없어서 자동 기록은 하지 않았어요.</p>`}
          </section>`
        : ''}

      ${run.status === 'failed' ? html`<div class="flash flash-error">실행하지 못했어요: ${run.error ?? ''}</div>` : ''}
      ${run.status === 'handed_off' && run.ai
        ? html`<div class="flash flash-ok">${AIS[run.ai].label}에서 열었어요. 대화가 끝나면 ${mcpConnected(app.db, run.ai) ? 'AI가 log_session으로 기록하거나, ' : ''}마지막의 [Hub 메모]를 <a href="/capture">붙여넣기</a> 하세요.</div>`
        : ''}

      ${run.status !== 'running'
        ? html`<section class="card">
            <div class="card-head">
              <h3>추천</h3>
              <span class="small muted">${cat.label} · ${plan.router === 'jev' ? 'Jev 판단' : '규칙 판단'} · 확신 ${Math.round(plan.confidence * 100)}%</span>
            </div>
            ${plan.notes.length ? html`<ul class="details">${plan.notes.map((n) => html`<li>${n}</li>`)}</ul>` : ''}
            <div class="targets">${targets.map((t, i) => targetCard(app, ctx, run, t, i === 0))}</div>
            <details class="custom-target"><summary>다른 AI·모델로 직접 고르기</summary>
              <form method="post" action="/run/${run.id}/execute" class="form-inline wrap">
                ${csrfInput(ctx)}
                <select name="ai">${AI_IDS.map((id) => html`<option value="${id}">${AIS[id].label}</option>`)}</select>
                <input type="text" name="model" placeholder="모델 (비우면 기본값)">
                <button class="btn">API로 실행</button>
              </form>
              <p class="small muted">앱에서 열기는 위 카드의 버튼을 쓰세요. 앱 주소는 설정에서 바꿀 수 있어요 (지금: ${AI_IDS.map((id) => `${AIS[id].label} ${apps[id].openUrl ? '프롬프트 채우기' : '복사 후 열기'}`).join(', ')}).</p>
            </details>
          </section>`
        : ''}`;
    sendHtml(ctx, page(ctx, { title: 'AI 실행', active: 'run', pending: pendingCount(app.db) }, body));
  };
}

export function runActions(app: AppCtx) {
  return {
    execute: (ctx: Ctx) =>
      formAction(ctx, `/run/${ctx.params.id}`, (form) => {
        const id = idParam(ctx);
        const ai = field(form, 'ai');
        if (!isAiId(ai)) throw new UserError('AI를 선택해 주세요');
        void startApiRun(app.db, app.config.ai, id, ai as AiId, field(form, 'model')).catch(() => undefined);
        return `/run/${id}`;
      }),
    handoff: async (ctx: Ctx): Promise<void> => {
      const form = await readForm(ctx);
      const ai = field(form, 'ai');
      if (isAiId(ai)) markHandoff(app.db, idParam(ctx), ai, field(form, 'model') || AIS[ai].defaultModel);
      if (String(ctx.req.headers['x-requested-with'] ?? '') === 'fetch') {
        ctx.res.writeHead(204);
        ctx.res.end();
        return;
      }
      redirect(ctx, `/run/${ctx.params.id}`);
    },
    remove: (ctx: Ctx) =>
      formAction(ctx, '/run', () => {
        deleteRun(app.db, idParam(ctx));
        flash(ctx, '실행 기록을 지웠어요');
        return '/run';
      }),
  };
}
