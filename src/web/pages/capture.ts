import type { AppCtx } from '../../app-context.ts';
import { applyMemo, parseMemos, type MemoApplyResult } from '../../domain/capture.ts';
import { listProjects } from '../../domain/projects.ts';
import { pendingCount } from '../../domain/proposals.ts';
import { html, raw, type SafeHtml } from '../../lib/html.ts';
import { field, readForm, sendHtml, type Ctx } from '../../lib/http.ts';
import { todayIn } from '../../lib/time.ts';
import { copyBlock, csrfInput, page } from '../layout.ts';

const SOURCES = ['ChatGPT', 'Claude', 'Grok', 'Muse', '기타 AI'];

const TEMPLATE = `[Hub 메모]
프로젝트: 브랜드X
요약: 로고 방향을 B안으로 정하고 상세페이지 구성을 논의했다.
결정: 로고는 B안 | 이유: 타깃 선호도가 높음
결정: 메인 컬러는 네이비 | 대체: D3
할 일: 상세페이지 시안 3종 | 디자인 | 2026-10-03
완료: T5
위치: 시안 2까지 완료, 3번 컬러 검토 중
[/Hub 메모]`;

function formView(app: AppCtx, ctx: Ctx, values: { text: string; source: string; project: string }, error?: string): SafeHtml {
  const projects = listProjects(app.db, 'active');
  return html`
    <div class="page-head"><h1>붙여넣기</h1></div>
    <p class="hint">MCP로 연결하지 않은(또는 쓰기가 막힌) AI의 대화 끝에 나온 <strong>[Hub 메모]</strong>를 붙여 넣으면,
      요약·마지막 위치는 바로 저장하고 결정·할 일은 인박스에 올려요. 대화 전체를 붙여 넣어도 메모 부분만 찾아 읽어요.</p>
    ${error ? html`<div class="flash flash-error">${error}</div>` : ''}
    <div class="grid-detail">
      <form method="post" action="/capture" class="card stack col-main">
        ${csrfInput(ctx)}
        <textarea name="text" rows="14" placeholder="[Hub 메모] … [/Hub 메모]" required>${values.text}</textarea>
        <div class="form-inline wrap">
          <label class="inline-label">어느 AI에서?
            <select name="source">${SOURCES.map((s) => html`<option ${s === values.source ? raw('selected') : ''}>${s}</option>`)}</select>
          </label>
          <label class="inline-label">프로젝트
            <select name="project">
              <option value="">메모에 적힌 프로젝트</option>
              ${projects.map((p) => html`<option value="${p.id}" ${String(p.id) === values.project ? raw('selected') : ''}>${p.name}</option>`)}
            </select>
          </label>
          <button class="btn btn-primary">반영하기</button>
        </div>
      </form>
      <aside class="col-side card">
        <h3>메모 형식</h3>
        <p class="small muted">프로젝트 페이지의 브리핑을 복사해 AI에 주면, 이 형식으로 정리해 달라는 안내가 함께 들어가요.</p>
        ${copyBlock('memo-template', TEMPLATE)}
      </aside>
    </div>`;
}

export function capturePage(app: AppCtx) {
  return (ctx: Ctx): void => {
    sendHtml(ctx, page(ctx, { title: '붙여넣기', active: 'capture', pending: pendingCount(app.db) }, formView(app, ctx, { text: '', source: 'ChatGPT', project: '' })));
  };
}

function resultView(results: MemoApplyResult[]): SafeHtml {
  return html`${results.map((r) => {
    const pending = r.proposals.filter((p) => !p.result.applied);
    const applied = r.proposals.filter((p) => p.result.applied);
    return html`<section class="card">
      <h3>${r.projectName ?? '프로젝트 없음'}</h3>
      <ul class="plain">
        ${r.logId ? html`<li>✅ 세션 요약 저장 (L${r.logId})</li>` : ''}
        ${r.resumeSaved ? html`<li>✅ 마지막 위치 저장</li>` : ''}
        ${applied.map((p) => html`<li>✅ 자동 승인: ${p.label}</li>`)}
        ${pending.map((p) => html`<li>📥 인박스: ${p.label}</li>`)}
        ${r.errors.map((e) => html`<li class="error-text">⚠️ ${e}</li>`)}
      </ul>
    </section>`;
  })}`;
}

export function captureAction(app: AppCtx) {
  return async (ctx: Ctx): Promise<void> => {
    const form = await readForm(ctx);
    const values = { text: form.get('text') ?? '', source: field(form, 'source') || '기타 AI', project: field(form, 'project') };
    const source = SOURCES.includes(values.source) ? values.source : '기타 AI';
    const pending = () => pendingCount(app.db);
    const memos = parseMemos(values.text, todayIn(app.config.timezone));
    if (!memos.length) {
      const msg = '[Hub 메모] 블록을 찾지 못했어요. AI에게 "위 형식의 [Hub 메모]로 정리해 줘"라고 요청한 뒤 다시 붙여 넣어 주세요.';
      sendHtml(ctx, page(ctx, { title: '붙여넣기', active: 'capture', pending: pending() }, formView(app, ctx, values, msg)), 422);
      return;
    }
    const defaultProject = values.project ? Number(values.project) : null;
    const results: MemoApplyResult[] = [];
    const errors: string[] = [];
    for (const m of memos) {
      try {
        results.push(applyMemo(app.db, m, source, defaultProject));
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (!results.length) {
      sendHtml(ctx, page(ctx, { title: '붙여넣기', active: 'capture', pending: pending() }, formView(app, ctx, values, errors.join(' / '))), 422);
      return;
    }
    const n = pending();
    const body = html`
      <div class="page-head"><h1>반영했어요</h1></div>
      ${errors.length ? html`<div class="flash flash-error">${errors.join(' / ')}</div>` : ''}
      ${resultView(results)}
      <p>${n ? html`<a class="btn btn-primary" href="/inbox">인박스에서 승인하기 (${n})</a>` : ''} <a class="btn" href="/capture">하나 더 붙여넣기</a></p>`;
    sendHtml(ctx, page(ctx, { title: '붙여넣기', active: 'capture', pending: n }, body));
  };
}
