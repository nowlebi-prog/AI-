import type { AppCtx } from '../../app-context.ts';
import { clip } from '../../domain/brief.ts';
import { getTimezone } from '../../domain/clock.ts';
import { listProjects } from '../../domain/projects.ts';
import { pendingCount } from '../../domain/proposals.ts';
import {
  DEFAULT_REF_CATEGORIES,
  createReference,
  deleteReference,
  listReferences,
  refCategories,
  refTags,
  suggestCategory,
  updateReference,
  type ReferenceView,
} from '../../domain/references.ts';
import { UserError } from '../../domain/types.ts';
import { fetchPageMeta } from '../../integrations/pagemeta.ts';
import { html, type SafeHtml } from '../../lib/html.ts';
import { field, sendHtml, type Ctx } from '../../lib/http.ts';
import { dateOf, formatDate } from '../../lib/time.ts';
import { formAction, idParam } from '../actions.ts';
import { backInput, csrfInput, currentPath, flash, page, projectOptions } from '../layout.ts';

function qs(params: Record<string, string | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
}

function refCard(ctx: Ctx, r: ReferenceView, tz: string, projects: Array<{ id: number; name: string }>, categories: string[]): SafeHtml {
  const back = currentPath(ctx);
  return html`<li class="ref-card card" id="ref-${r.id}">
    ${r.image_url ? html`<a class="ref-thumb" href="${r.url}" target="_blank" rel="noopener noreferrer"><img src="${r.image_url}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>` : ''}
    <div class="ref-body">
      <div class="ref-head">
        <a class="ref-title" href="${r.url}" target="_blank" rel="noopener noreferrer">${r.title || r.site}</a>
        <details class="menu">
          <summary class="btn btn-ghost btn-small" aria-label="더보기">⋯</summary>
          <div class="menu-panel">
            <form method="post" action="/refs/${r.id}/edit" class="menu-edit">
              ${csrfInput(ctx)}${backInput(back)}
              <input type="text" name="title" value="${r.title}" placeholder="제목" aria-label="제목">
              <div class="form-inline wrap">
                <input type="text" name="category" value="${r.category}" list="ref-categories" aria-label="카테고리">
                <select name="project" aria-label="프로젝트">${projectOptions(projects, r.project_id)}</select>
              </div>
              <input type="text" name="tags" value="${r.tags}" placeholder="태그 (띄어쓰기)" aria-label="태그">
              <textarea name="note" rows="2" placeholder="메모" aria-label="메모">${r.note}</textarea>
              <div class="form-inline"><button class="btn btn-primary btn-small">저장</button></div>
            </form>
            <form method="post" action="/refs/${r.id}/delete" class="menu-row" data-confirm="이 레퍼런스를 삭제할까요?">
              ${csrfInput(ctx)}${backInput(back)}<button class="btn btn-ghost btn-small danger">삭제</button>
            </form>
          </div>
        </details>
      </div>
      <div class="small muted">${r.site} · ${formatDate(dateOf(r.created_at, tz))}${r.source !== '나' ? ` · ${r.source}` : ''}</div>
      ${r.note ? html`<div class="ref-note">${r.note}</div>` : ''}
      ${r.description ? html`<div class="small muted">${clip(r.description, 160)}</div>` : ''}
      <div class="ref-meta">
        <a class="chip" href="/refs${qs({ cat: r.category })}">${r.category}</a>
        ${r.project_name ? html`<a class="proj-link small" href="/projects/${r.project_id}">${r.project_name}</a>` : ''}
        ${r.tags ? r.tags.split(' ').map((t) => html`<a class="tag" href="/refs${qs({ tag: t })}">#${t}</a>`) : ''}
      </div>
    </div>
  </li>`;
}

export function refsPage(app: AppCtx) {
  return (ctx: Ctx): void => {
    const q = (ctx.url.searchParams.get('q') ?? '').trim();
    const cat = (ctx.url.searchParams.get('cat') ?? '').trim();
    const tag = (ctx.url.searchParams.get('tag') ?? '').trim();
    const projectParam = ctx.url.searchParams.get('project');
    const projectId = projectParam ? Number(projectParam) : undefined;
    const tz = getTimezone(app.db);
    const projects = listProjects(app.db, 'all').map((p) => ({ id: p.id, name: p.name }));
    const cats = refCategories(app.db);
    const catNames = [...new Set([...DEFAULT_REF_CATEGORIES, ...cats.map((c) => c.category)])];
    const tags = refTags(app.db);
    const refs = listReferences(app.db, { q, category: cat || undefined, tag: tag || undefined, projectId, limit: 300 });
    const total = cats.reduce((s, c) => s + c.n, 0);
    const filtered = Boolean(q || cat || tag || projectId);
    const projectName = projectId ? projects.find((p) => p.id === projectId)?.name : undefined;

    const body = html`
      <div class="page-head">
        <h1>레퍼런스 <span class="count">${total}</span></h1>
        <form method="get" action="/refs" class="form-inline ref-search" role="search">
          ${cat ? html`<input type="hidden" name="cat" value="${cat}">` : ''}
          ${projectId ? html`<input type="hidden" name="project" value="${projectId}">` : ''}
          <input type="search" name="q" value="${q}" placeholder="기억나는 단어로 찾기 (제목·메모·태그·주소)" class="grow" autofocus>
          <button class="btn">찾기</button>
        </form>
      </div>

      <section class="card ref-add">
        <form method="post" action="/refs" class="stack" data-keep-focus="url">
          ${csrfInput(ctx)}
          <div class="form-inline wrap">
            <input type="url" name="url" placeholder="링크를 붙여 넣으면 제목·설명·카테고리를 알아서 채워요" required class="grow">
            <input type="text" name="category" placeholder="카테고리 (비우면 자동)" list="ref-categories" value="${cat}">
            <select name="project" aria-label="프로젝트">${projectOptions(projects, projectId ?? null)}</select>
          </div>
          <div class="form-inline wrap">
            <input type="text" name="note" placeholder="메모: 어디가 좋았는지, 어디에 쓸지" class="grow">
            <input type="text" name="tags" placeholder="태그 (띄어쓰기)">
            <button class="btn btn-primary">저장</button>
          </div>
        </form>
        <details><summary>여러 링크 한 번에</summary>
          <form method="post" action="/refs/bulk" class="stack">
            ${csrfInput(ctx)}
            <textarea name="urls" rows="4" placeholder="한 줄에 링크 하나"></textarea>
            <div class="form-inline"><button class="btn">모두 저장</button></div>
          </form>
        </details>
      </section>
      <datalist id="ref-categories">${catNames.map((c) => html`<option value="${c}">`)}</datalist>

      <div class="grid-refs">
        <aside class="ref-side">
          <nav class="ref-cats">
            <a href="/refs" class="${!filtered ? 'active' : ''}">전체 <span class="count">${total}</span></a>
            ${cats.map((c) => html`<a href="/refs${qs({ cat: c.category })}" class="${cat === c.category ? 'active' : ''} ${c.n ? '' : 'empty-cat'}">${c.category} <span class="count">${c.n}</span></a>`)}
          </nav>
          ${tags.length
            ? html`<div class="ref-tags"><div class="small muted">태그</div>${tags.map((t) => html`<a class="tag ${tag === t.tag ? 'active' : ''}" href="/refs${qs({ tag: t.tag })}">#${t.tag} <span class="muted">${t.n}</span></a>`)}</div>`
            : ''}
        </aside>
        <div>
          ${filtered
            ? html`<p class="small">
                ${q ? html`“${q}” ` : ''}${cat ? html`<span class="chip">${cat}</span> ` : ''}${tag ? html`<span class="tag">#${tag}</span> ` : ''}${projectName ? html`<span class="chip">${projectName}</span> ` : ''}
                결과 ${refs.length}개 · <a href="/refs">필터 지우기</a></p>`
            : ''}
          ${refs.length
            ? html`<ul class="ref-grid">${refs.map((r) => refCard(ctx, r, tz, projects, catNames))}</ul>`
            : html`<p class="empty">${filtered ? '찾는 레퍼런스가 없어요. 다른 단어로 찾아보세요.' : '저장한 레퍼런스가 없어요. 위에 링크를 붙여 넣어 보세요.'}</p>`}
        </div>
      </div>`;
    sendHtml(ctx, page(ctx, { title: '레퍼런스', active: 'refs', pending: pendingCount(app.db) }, body));
  };
}

async function saveOne(app: AppCtx, input: { url: string; category?: string; note?: string; tags?: string; project_id?: number | null }): Promise<{ title: string; created: boolean }> {
  const url = /^https?:\/\//i.test(input.url.trim()) ? input.url.trim() : `https://${input.url.trim()}`;
  const meta = await fetchPageMeta(url);
  const title = meta?.title ?? '';
  const { ref, created } = createReference(
    app.db,
    {
      url,
      title,
      description: meta?.description ?? '',
      image_url: meta?.image ?? '',
      category: input.category || suggestCategory(url, title),
      note: input.note,
      tags: input.tags,
      project_id: input.project_id ?? null,
    },
    '나',
  );
  return { title: ref.title || ref.site, created };
}

export function refsActions(app: AppCtx) {
  return {
    create: (ctx: Ctx) =>
      formAction(ctx, '/refs', async (form) => {
        const project = field(form, 'project');
        const r = await saveOne(app, {
          url: field(form, 'url'),
          category: field(form, 'category'),
          note: form.get('note') ?? '',
          tags: field(form, 'tags'),
          project_id: project ? Number(project) : null,
        });
        flash(ctx, r.created ? `저장했어요: ${r.title}` : `이미 저장된 링크예요: ${r.title}`);
      }),
    bulk: (ctx: Ctx) =>
      formAction(ctx, '/refs', async (form) => {
        const urls = (form.get('urls') ?? '')
          .split(/\s+/)
          .map((u) => u.trim())
          .filter((u) => /^(https?:\/\/)?[^\s/]+\.[^\s]+/i.test(u))
          .slice(0, 30);
        if (!urls.length) throw new UserError('저장할 링크가 없어요');
        let created = 0;
        const failed: string[] = [];
        for (const url of urls) {
          try {
            if ((await saveOne(app, { url })).created) created++;
          } catch (err) {
            failed.push(`${url} (${err instanceof Error ? err.message : String(err)})`);
          }
        }
        flash(ctx, `${created}개 저장${urls.length - created - failed.length ? `, ${urls.length - created - failed.length}개는 이미 있었어요` : ''}${failed.length ? ` · 실패: ${failed.join(', ')}` : ''}`, failed.length ? 'error' : 'ok');
      }),
    edit: (ctx: Ctx) =>
      formAction(ctx, '/refs', (form) => {
        const project = field(form, 'project');
        updateReference(app.db, idParam(ctx), {
          title: field(form, 'title'),
          category: field(form, 'category'),
          tags: field(form, 'tags'),
          note: form.get('note') ?? '',
          project_id: project ? Number(project) : null,
        });
        flash(ctx, '레퍼런스를 고쳤어요');
      }),
    remove: (ctx: Ctx) =>
      formAction(ctx, '/refs', () => {
        deleteReference(app.db, idParam(ctx));
        flash(ctx, '레퍼런스를 삭제했어요');
      }),
  };
}
