import type { AppCtx } from '../../app-context.ts';
import { clip } from '../../domain/brief.ts';
import { currentDay } from '../../domain/clock.ts';
import { getSetting } from '../../domain/profile.ts';
import { pendingCount } from '../../domain/proposals.ts';
import { snoozeDate, updateTask } from '../../domain/tasks.ts';
import { UserError } from '../../domain/types.ts';
import {
  GROK_MCP_PROMPT,
  LIST_COMMANDS,
  addDayFiles,
  cleanupPlan,
  clearDayFiles,
  daySummary,
  decideDayFiles,
  deleteHubItems,
  finishDay,
  grokInstruction,
  listDayFiles,
  parseFileList,
  trashScript,
} from '../../domain/wrapup.ts';
import { html, raw } from '../../lib/html.ts';
import { sendHtml, type Ctx } from '../../lib/http.ts';
import { formatDate, formatDue } from '../../lib/time.ts';
import { formAction } from '../actions.ts';
import { copyBlock, csrfInput, flash, page, roleChip } from '../layout.ts';

export function wrapupPage(app: AppCtx) {
  return (ctx: Ctx): void => {
    const day = currentDay(app.db);
    const s = daySummary(app.db, day);
    const files = listDayFiles(app.db, day);
    const plan = cleanupPlan(app.db, day);
    const finished = getSetting(app.db, 'wrapup_done') === day;
    const hubItems = s.refs.length + s.imports.length + s.runs.length;
    const body = html`
      <div class="page-head">
        <h1>하루 마감 <span class="muted small">${formatDate(day)}</span> ${finished ? html`<span class="chip approved">마감 완료</span>` : ''}</h1>
        <div class="form-inline wrap">
          <a class="btn btn-ghost" href="/run?text=${encodeURIComponent('오늘 한 일을 바탕으로 내일 가장 먼저 할 일 3개를 골라 주고, 이유를 한 줄씩 적어 줘.')}">🤖 내일 계획 AI에게 맡기기</a>
        </div>
      </div>
      <p class="hint">① 오늘 한 일 확인 → ② 못 끝낸 일 넘기기 → ③ 오늘 저장한 것·파일 정리 → ④ 한 줄 회고로 마감. 끝내면 내일 아침 '오늘'이 깔끔하게 시작돼요.</p>

      <div class="grid-detail">
        <div class="col-main">
          <section class="card">
            <h3>① 오늘 한 일</h3>
            <div class="stat-row">
              <span><strong>${s.done.length}</strong> 완료</span>
              <span><strong>${s.decisions.length}</strong> 결정</span>
              <span><strong>${s.logs.length}</strong> AI 세션</span>
              <span><strong>${s.refs.length}</strong> 레퍼런스</span>
            </div>
            ${s.done.length
              ? html`<ul class="plain small">${s.done.map((t) => html`<li>✅ ${t.title} ${roleChip(t.role)} ${t.project_name ? html`<span class="muted">${t.project_name}</span>` : ''}</li>`)}</ul>`
              : html`<p class="muted small">오늘 완료한 할 일이 없어요.</p>`}
            ${s.decisions.length ? html`<h4>정한 것</h4><ul class="plain small">${s.decisions.map((d) => html`<li>D${d.id} [${d.project_name}] ${d.content}</li>`)}</ul>` : ''}
            ${s.logs.length ? html`<h4>AI와 한 일</h4><ul class="plain small">${s.logs.map((l) => html`<li><strong>${l.source}</strong> ${l.project_name ? `[${l.project_name}] ` : ''}${clip(l.summary, 120)}</li>`)}</ul>` : ''}
          </section>

          <section class="card">
            <h3>② 못 끝낸 일 <span class="count">${s.leftover.length}</span></h3>
            ${s.leftover.length
              ? html`<form method="post" action="/wrapup/snooze" class="stack">
                  ${csrfInput(ctx)}
                  <ul class="plain checklist">${s.leftover.map(
                    (t) => html`<li><label class="inline-label"><input type="checkbox" name="ids" value="${t.id}" checked>
                      ${t.title} ${roleChip(t.role)} <span class="due ${t.due_date && t.due_date < day ? 'overdue' : ''}">${t.due_date ? formatDue(t.due_date, day) : ''}</span>
                      ${t.project_name ? html`<span class="muted small">${t.project_name}</span>` : ''}</label></li>`,
                  )}</ul>
                  <div class="form-inline wrap">
                    <button class="btn btn-primary" name="to" value="tomorrow">체크한 것 내일로</button>
                    <button class="btn" name="to" value="nextweek">다음 주 월요일로</button>
                  </div>
                </form>`
              : html`<p class="muted small">오늘까지 마감인 일은 다 끝났어요 👏</p>`}
            ${s.tomorrow.length ? html`<h4>내일 마감</h4><ul class="plain small">${s.tomorrow.map((t) => html`<li>${t.title} ${roleChip(t.role)} ${t.project_name ? html`<span class="muted">${t.project_name}</span>` : ''}</li>`)}</ul>` : ''}
          </section>

          <section class="card" id="files">
            <h3>③ 파일 정리 — 남길 것만 체크</h3>
            ${hubItems
              ? html`<h4>Hub에 오늘 저장한 것</h4>
                <form method="post" action="/wrapup/hub-cleanup" class="stack" data-confirm="체크하지 않은 항목을 Hub에서 삭제할까요?">
                  ${csrfInput(ctx)}
                  <ul class="plain checklist">
                    ${s.refs.map((r) => html`<li><input type="hidden" name="all_ref" value="${r.id}"><label class="inline-label"><input type="checkbox" name="keep_ref" value="${r.id}" checked> 🔗 ${r.title || r.site} <span class="chip">${r.category}</span></label></li>`)}
                    ${s.imports.map((d) => html`<li><input type="hidden" name="all_import" value="${d.id}"><label class="inline-label"><input type="checkbox" name="keep_import" value="${d.id}" checked> 📄 ${d.title} <span class="muted small">가져온 문서</span></label></li>`)}
                    ${s.runs.map((r) => html`<li><input type="hidden" name="all_run" value="${r.id}"><label class="inline-label"><input type="checkbox" name="keep_run" value="${r.id}" checked> 🤖 ${clip(r.request, 60)} <span class="muted small">AI 실행 기록</span></label></li>`)}
                  </ul>
                  <div class="form-inline"><button class="btn">체크 안 한 것 Hub에서 삭제</button></div>
                </form>`
              : ''}

            <h4>내 컴퓨터 파일 <span class="muted small">(드라이브 앱으로 동기화되는 폴더 포함)</span></h4>
            <details class="how" ${files.length ? '' : raw('open')}><summary>오늘 생긴 파일 목록 가져오기</summary>
              <div class="tabs" data-tabs>
                <button type="button" class="tab active" data-tab="list-mac">Mac</button>
                <button type="button" class="tab" data-tab="list-win">Windows</button>
                <button type="button" class="tab" data-tab="list-ai">AI에게</button>
              </div>
              <div class="tab-panel active" data-panel="list-mac"><p class="small">터미널에 붙여 넣으면 다운로드·바탕화면·문서 폴더에서 24시간 안에 생기거나 바뀐 파일 목록이 복사돼요 (읽기만 해요). 처음엔 폴더 접근 허용 창이 뜰 수 있어요.</p>${copyBlock('cmd-mac', LIST_COMMANDS.mac)}</div>
              <div class="tab-panel" data-panel="list-win"><p class="small">PowerShell에 붙여 넣으면 오늘 생기거나 바뀐 파일 목록이 복사돼요 (읽기만 해요).</p>${copyBlock('cmd-win', LIST_COMMANDS.windows)}</div>
              <div class="tab-panel" data-panel="list-ai"><p class="small">내 파일을 볼 수 있는 AI(예: 파일 접근을 연결한 Claude 데스크톱)에게 보내면 목록이 Hub로 바로 들어와요.</p>${copyBlock('cmd-ai', LIST_COMMANDS.ai)}</div>
            </details>
            <form method="post" action="/wrapup/files" class="stack">
              ${csrfInput(ctx)}
              <textarea name="text" rows="3" placeholder="복사한 파일 목록을 붙여 넣으세요 (한 줄에 경로 하나)"></textarea>
              <div class="form-inline"><button class="btn">목록에 추가</button></div>
            </form>

            ${files.length
              ? html`<form method="post" action="/wrapup/files/decide" class="stack">
                  ${csrfInput(ctx)}
                  <div class="form-inline wrap small"><span class="muted">${files.length}개 · 체크한 파일만 남기고 나머지는 삭제 목록으로 가요</span>
                    <button type="button" class="btn btn-ghost btn-small" data-check-all="keep">모두 체크</button>
                    <button type="button" class="btn btn-ghost btn-small" data-check-none="keep">모두 해제</button></div>
                  <ul class="plain checklist files">${files.map(
                    (f) => html`<li class="${f.decision === 'delete' ? 'will-delete' : ''}"><label class="inline-label"><input type="checkbox" name="keep" value="${f.id}" ${f.decision === 'keep' ? raw('checked') : ''}>
                      <code>${f.path}</code>${f.source !== '나' ? html` <span class="muted small">${f.source}</span>` : ''}</label></li>`,
                  )}</ul>
                  <div class="form-inline wrap">
                    <button class="btn btn-primary">정리 목록 만들기</button>
                    <button class="btn btn-ghost danger" formaction="/wrapup/files/clear" data-confirm="파일 목록을 비울까요? (실제 파일은 그대로예요)">목록 비우기</button>
                  </div>
                </form>`
              : ''}

            ${plan.decided
              ? html`<div class="cleanup-out">
                  <p><strong>삭제 ${plan.remove.length}개 · 남김 ${plan.keep.length}개</strong></p>
                  ${plan.remove.length
                    ? html`<h4>Grok Bot에게 보낼 요청문</h4>
                      ${copyBlock('grok-text', grokInstruction(plan), '요청문 복사')}
                      <p class="small muted">Grok Bot이 Hub에 연결돼 있으면 이렇게만 보내도 돼요:</p>
                      ${copyBlock('grok-mcp', GROK_MCP_PROMPT)}
                      <details><summary>내 컴퓨터에서 직접 휴지통으로 옮기기 (명령)</summary>
                        <p class="small muted">Grok Bot은 클라우드 컴퓨터에서 동작해서 내 PC 파일엔 접근하지 못할 수 있어요. 그럴 땐 이 명령을 직접 실행하세요. 영구 삭제가 아니라 휴지통으로 옮겨요.</p>
                        <div class="tabs" data-tabs>
                          <button type="button" class="tab active" data-tab="trash-mac">Mac 터미널</button>
                          <button type="button" class="tab" data-tab="trash-win">Windows PowerShell</button>
                        </div>
                        <div class="tab-panel active" data-panel="trash-mac">${copyBlock('trash-mac', trashScript(plan, 'mac'))}</div>
                        <div class="tab-panel" data-panel="trash-win">${copyBlock('trash-win', trashScript(plan, 'windows'))}</div>
                      </details>`
                    : html`<p class="small">지울 파일이 없어요. 모두 남겨요.</p>`}
                </div>`
              : ''}
          </section>
        </div>

        <aside class="col-side">
          <section class="card">
            <h3>④ 마감</h3>
            <form method="post" action="/wrapup/done" class="stack">
              ${csrfInput(ctx)}
              <textarea name="note" rows="4" placeholder="오늘 한 줄 회고 (선택): 잘된 것, 막힌 것, 내일 먼저 할 것"></textarea>
              <button class="btn btn-primary">${finished ? '다시 마감하기' : '하루 마감하기'}</button>
            </form>
            <p class="small muted">회고는 세션 기록으로 남아서 AI 브리핑·주간 요약에도 들어가요. 마감 알림 시각은 <a href="/settings#auto">설정</a>에서 바꿀 수 있어요.</p>
          </section>
        </aside>
      </div>`;
    sendHtml(ctx, page(ctx, { title: '하루 마감', active: 'today', pending: pendingCount(app.db) }, body));
  };
}

function ids(form: URLSearchParams, name: string): number[] {
  return form.getAll(name).map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

export function wrapupActions(app: AppCtx) {
  return {
    snooze: (ctx: Ctx) =>
      formAction(ctx, '/wrapup', (form) => {
        const to = form.get('to') === 'nextweek' ? 'nextweek' : 'tomorrow';
        const list = ids(form, 'ids');
        if (!list.length) throw new UserError('넘길 할 일을 체크해 주세요');
        const due = snoozeDate(to, currentDay(app.db));
        for (const id of list) updateTask(app.db, id, { due_date: due });
        flash(ctx, `${list.length}개를 ${to === 'tomorrow' ? '내일' : '다음 주 월요일'}로 넘겼어요`);
      }),
    hubCleanup: (ctx: Ctx) =>
      formAction(ctx, '/wrapup#files', (form) => {
        const pick = (all: string, keep: string) => {
          const k = new Set(ids(form, keep));
          return ids(form, all).filter((id) => !k.has(id));
        };
        const n = deleteHubItems(app.db, { refs: pick('all_ref', 'keep_ref'), imports: pick('all_import', 'keep_import'), runs: pick('all_run', 'keep_run') });
        flash(ctx, n ? `Hub에서 ${n}개를 삭제했어요` : '삭제할 항목이 없었어요 (모두 남겼어요)');
      }),
    addFiles: (ctx: Ctx) =>
      formAction(ctx, '/wrapup#files', (form) => {
        const paths = parseFileList(form.get('text') ?? '');
        if (!paths.length) throw new UserError('파일 경로를 찾지 못했어요. 한 줄에 경로 하나씩 붙여 넣어 주세요');
        const r = addDayFiles(app.db, paths, '나', currentDay(app.db));
        flash(ctx, `${r.added}개를 추가했어요 (전체 ${r.total}개). 남길 파일을 체크해 주세요`);
        return '/wrapup#files';
      }),
    decide: (ctx: Ctx) =>
      formAction(ctx, '/wrapup#files', (form) => {
        const r = decideDayFiles(app.db, ids(form, 'keep'), currentDay(app.db));
        flash(ctx, `정리 목록을 만들었어요: 삭제 ${r.remove}개 · 남김 ${r.keep}개`);
        return '/wrapup#files';
      }),
    clear: (ctx: Ctx) =>
      formAction(ctx, '/wrapup#files', () => {
        clearDayFiles(app.db, currentDay(app.db));
        flash(ctx, '파일 목록을 비웠어요');
        return '/wrapup#files';
      }),
    done: (ctx: Ctx) =>
      formAction(ctx, '/', (form) => {
        const logId = finishDay(app.db, form.get('note') ?? '', currentDay(app.db));
        flash(ctx, `오늘 하루 마감했어요${logId ? ' — 회고를 기록했어요' : ''}. 수고했어요!`);
        return '/';
      }),
  };
}
