import type { AppCtx } from '../../app-context.ts';
import { getTimezone } from '../../domain/clock.ts';
import { pendingCount } from '../../domain/proposals.ts';
import { search, type SearchHit } from '../../domain/search.ts';
import { html } from '../../lib/html.ts';
import { sendHtml, type Ctx } from '../../lib/http.ts';
import { dateOf, formatDate } from '../../lib/time.ts';
import { page } from '../layout.ts';

const GROUPS: Array<[string, string]> = [
  ['project', '프로젝트'],
  ['decision', '결정'],
  ['task', '할 일'],
  ['ref', '레퍼런스'],
  ['log', 'AI 세션 기록'],
  ['import', '가져온 문서'],
];

export function searchPage(app: AppCtx) {
  return (ctx: Ctx): void => {
    const q = (ctx.url.searchParams.get('q') ?? '').trim();
    const tz = getTimezone(app.db);
    const hits = q ? search(app.db, q, ctx.baseUrl, 100) : [];
    const byType = new Map<string, SearchHit[]>();
    for (const h of hits) {
      const type = h.id.split(':')[0] ?? '';
      byType.set(type, [...(byType.get(type) ?? []), h]);
    }
    const body = html`
      <div class="page-head"><h1>검색</h1></div>
      <form method="get" action="/search" class="card form-inline" role="search">
        <input type="search" name="q" value="${q}" placeholder="프로젝트·결정·할 일·레퍼런스·AI 기록을 한 번에 찾아요" class="grow" autofocus data-search-input>
        <button class="btn btn-primary">찾기</button>
      </form>
      ${q
        ? hits.length
          ? html`<p class="small muted">“${q}” 결과 ${hits.length}개</p>
              ${GROUPS.filter(([t]) => byType.has(t)).map(
                ([t, label]) => html`<section class="card">
                  <h3>${label} <span class="count">${byType.get(t)?.length ?? 0}</span>${t === 'ref' ? html` <a class="small" href="/refs?q=${encodeURIComponent(q)}">레퍼런스에서 보기</a>` : ''}</h3>
                  <ul class="plain search-hits">${(byType.get(t) ?? []).map(
                    (h) => html`<li>
                      <a href="${h.url}" ${t === 'ref' ? html`target="_blank" rel="noopener noreferrer"` : ''}>${h.title}</a>
                      <span class="muted small">${formatDate(dateOf(h.created_at, tz))}</span>
                      ${h.text ? html`<div class="small muted">${h.text}</div>` : ''}
                    </li>`,
                  )}</ul>
                </section>`,
              )}`
          : html`<p class="empty">“${q}”에 맞는 결과가 없어요. 띄어쓰기를 줄이거나 다른 단어로 찾아보세요.</p>`
        : html`<p class="hint">여러 단어를 넣으면 모두 들어간 것만 찾아요. 단축키 <code>/</code>로 어디서든 검색창으로 올 수 있어요.</p>`}`;
    sendHtml(ctx, page(ctx, { title: q ? `“${q}” 검색` : '검색', active: 'search', pending: pendingCount(app.db) }, body));
  };
}
