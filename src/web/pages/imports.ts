import type { AppCtx } from '../../app-context.ts';
import { createImport, deleteImport, fetchNotionPage, getImport, listImports, organizePrompt } from '../../domain/imports.ts';
import { pendingCount } from '../../domain/proposals.ts';
import { UserError } from '../../domain/types.ts';
import { html } from '../../lib/html.ts';
import { field, readForm, redirect, sendHtml, type Ctx } from '../../lib/http.ts';
import { formatDateTime } from '../../lib/time.ts';
import { formAction, idParam } from '../actions.ts';
import { copyBlock, csrfInput, flash, page } from '../layout.ts';

export function importsPage(app: AppCtx) {
  return (ctx: Ctx): void => {
    const list = listImports(app.db);
    const hasEnvToken = Boolean(app.config.notionToken);
    const body = html`
      <div class="page-head"><h1>가져오기</h1></div>
      <p class="hint">기존 노션 페이지나 메모를 Hub로 옮겨요. 가져온 문서는 AI가 읽고 프로젝트·결정·할 일로 나눠 <strong>제안</strong>하면, 인박스에서 승인해 반영해요.</p>
      <div class="grid-2">
        <form method="post" action="/import/notion" class="card stack">
          ${csrfInput(ctx)}
          <h3>노션 페이지</h3>
          <label>페이지 주소 또는 ID<input type="text" name="page" placeholder="https://www.notion.so/…" required></label>
          <label>통합(Integration) 토큰
            <input type="password" name="token" autocomplete="off" placeholder="${hasEnvToken ? '비워 두면 NOTION_TOKEN 환경변수를 써요' : 'ntn_… 또는 secret_…'}">
          </label>
          <p class="small muted">토큰은 이번 요청에만 쓰고 저장하지 않아요. 노션에서 해당 페이지를 통합에 연결(… → 연결)해 두어야 읽을 수 있어요.</p>
          <button class="btn btn-primary">가져오기</button>
        </form>
        <form method="post" action="/import/text" class="card stack">
          ${csrfInput(ctx)}
          <h3>텍스트 붙여넣기</h3>
          <label>제목<input type="text" name="title" placeholder="예: 노션 작업 로그"></label>
          <textarea name="content" rows="8" placeholder="노션에서 전체 선택 → 복사한 내용, 또는 기존 메모" required></textarea>
          <button class="btn btn-primary">저장</button>
        </form>
      </div>
      ${list.length
        ? html`<section class="card"><h3>가져온 문서</h3><ul class="plain">${list.map(
            (d) => html`<li><a href="/import/${d.id}">I${d.id} ${d.title}</a> <span class="small muted">${d.source} · ${d.length.toLocaleString()}자 · ${formatDateTime(d.created_at, app.config.timezone)}</span></li>`,
          )}</ul></section>`
        : ''}`;
    sendHtml(ctx, page(ctx, { title: '가져오기', active: 'import', pending: pendingCount(app.db) }, body));
  };
}

export function importNotionAction(app: AppCtx) {
  return async (ctx: Ctx): Promise<void> => {
    const form = await readForm(ctx);
    try {
      const token = field(form, 'token') || app.config.notionToken;
      const { title, markdown } = await fetchNotionPage(field(form, 'page'), token);
      const id = createImport(app.db, { source: 'notion', title, content: markdown });
      flash(ctx, `노션 페이지 '${title}'를 가져왔어요`);
      redirect(ctx, `/import/${id}`);
    } catch (err) {
      const msg = err instanceof UserError ? err.message : `가져오지 못했어요: ${err instanceof Error ? err.message : String(err)}`;
      flash(ctx, msg, 'error');
      redirect(ctx, '/import');
    }
  };
}

export function importTextAction(app: AppCtx) {
  return (ctx: Ctx) =>
    formAction(ctx, '/import', (form) => {
      const id = createImport(app.db, { source: 'text', title: field(form, 'title'), content: form.get('content') ?? '' });
      flash(ctx, '문서를 저장했어요');
      return `/import/${id}`;
    });
}

export function importDetailPage(app: AppCtx) {
  return (ctx: Ctx): void => {
    const doc = getImport(app.db, idParam(ctx));
    if (!doc) throw new UserError('문서를 찾을 수 없어요');
    const body = html`
      <div class="page-head">
        <div>
          <div class="crumbs"><a href="/import">가져오기</a> / I${doc.id}</div>
          <h1>${doc.title}</h1>
          <p class="small muted">${doc.source} · ${doc.content.length.toLocaleString()}자 · ${formatDateTime(doc.created_at, app.config.timezone)}</p>
        </div>
      </div>
      <section class="card">
        <h3>AI에게 정리 맡기기</h3>
        <p class="small">Hub를 연결한 AI(Claude, ChatGPT 등)에 아래 문장을 보내세요. AI가 문서를 읽고 프로젝트·결정·할 일을 제안하면 <a href="/inbox">인박스</a>에서 승인하면 돼요.</p>
        ${copyBlock('organize-prompt', organizePrompt(doc.id))}
      </section>
      <section class="card">
        <details><summary>문서 내용 보기</summary>${copyBlock('import-content', doc.content)}</details>
      </section>
      <form method="post" action="/import/${doc.id}/delete" class="danger-zone" data-confirm="이 문서를 삭제할까요?">
        ${csrfInput(ctx)}<button class="btn btn-ghost danger">문서 삭제</button>
      </form>`;
    sendHtml(ctx, page(ctx, { title: doc.title, active: 'import', pending: pendingCount(app.db) }, body));
  };
}

export function importDeleteAction(app: AppCtx) {
  return (ctx: Ctx) =>
    formAction(ctx, '/import', () => {
      deleteImport(app.db, idParam(ctx));
      flash(ctx, '문서를 삭제했어요');
      return '/import';
    });
}
