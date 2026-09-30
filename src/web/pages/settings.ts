import { createReadStream, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AppCtx } from '../../app-context.ts';
import {
  SCOPE_LABEL,
  clientLabel,
  createPat,
  deleteClient,
  listConnectedClients,
  listPats,
  parseScopes,
  renameClient,
  revokePat,
  type Scope,
} from '../../auth/tokens.ts';
import { backupDir, isBackupName, listBackups } from '../../backup.ts';
import { AIS, AI_IDS, CATEGORIES, CATEGORY_IDS, getAiApps, getRoutes, isAiId, mcpSeen, saveAiApps, saveRoutes } from '../../domain/ais.ts';
import { currentDay, getDayStartHour, getTimezone } from '../../domain/clock.ts';
import { getAutoApprove, getProfile, getSetting, saveProfile, setAutoApprove, setSetting } from '../../domain/profile.ts';
import { getDirectApply, pendingCount } from '../../domain/proposals.ts';
import { PROPOSAL_KINDS, PROPOSAL_KIND_LABEL, UserError, type ProposalKind } from '../../domain/types.ts';
import { html, raw, type SafeHtml } from '../../lib/html.ts';
import { field, readForm, redirect, sendHtml, type Ctx } from '../../lib/http.ts';
import { formatAgo, formatDateTime } from '../../lib/time.ts';
import { formAction } from '../actions.ts';
import { copyBlock, csrfInput, flash, page } from '../layout.ts';

export const INSTRUCTION_SNIPPET = `나는 'Hub'라는 개인 작업 허브를 연결해 두었어.
- 프로젝트 이야기를 시작하면 먼저 Hub의 get_brief로 그 프로젝트의 맥락을 확인해 줘. 어떤 프로젝트인지 모르면 list_projects를 호출해.
- 중요한 결정이 나오면 propose_decision, 할 일이 생기거나 끝나면 propose_task로 Hub에 제안해 줘.
- 내가 직접 "추가해 줘", "완료 처리해 줘"라고 시킨 건 direct=true로 보내서 바로 반영해 줘.
- 링크를 저장해 달라고 하면 save_reference, 예전에 본 사이트를 찾으면 find_references를 써 줘.
- 하루 마감 때 파일 목록을 올려 달라고 하면 submit_files로 보내 줘. 파일은 내가 확인하기 전에는 절대 지우지 마.
- 대화를 마무리할 때는 log_session으로 요약과 '마지막 위치'(다음에 이어서 할 지점)를 남겨 줘.
- Hub에 연결할 수 없으면 대화 끝에 [Hub 메모] 형식(프로젝트/요약/결정/할 일/완료/위치)으로 정리해 줘.`;

interface McpCallRow {
  id: number;
  at: string;
  client: string;
  method: string;
  tool: string | null;
  ok: number;
  error: string | null;
  duration_ms: number;
}

function connectGuide(mcpUrl: string, httpsOk: boolean, local: boolean): SafeHtml {
  return html`
    <section class="card" id="connect">
      <h3>AI 연결 (MCP)</h3>
      <p>아래 주소를 각 AI에 <strong>원격 MCP 서버</strong>로 등록하세요. 연결하면 AI가 새 창에서도 Hub 맥락을 스스로 읽고 기록해요.</p>
      ${copyBlock('mcp-url', mcpUrl, '주소 복사')}
      ${!httpsOk
        ? html`<div class="flash flash-error">${local
            ? '지금은 이 컴퓨터(localhost)에서 실행 중이에요. Claude·ChatGPT·Grok·Muse는 AI 회사 서버에서 접속하기 때문에, HTTPS 주소로 배포한 뒤에 연결할 수 있어요.'
            : '지금 주소가 HTTPS가 아니에요. AI 서비스가 접속하려면 HTTPS 주소로 배포하고 HUB_PUBLIC_URL을 설정해야 해요.'}</div>`
        : ''}
      <div class="guides">
        <details open><summary><strong>Claude</strong> (데스크톱·웹)</summary>
          <ol class="small">
            <li>설정 → 커넥터 → <em>커스텀 커넥터 추가</em></li>
            <li>이름 <code>Hub</code>, URL에 위 주소 입력 → 연결</li>
            <li>Hub 로그인 화면에서 비밀번호 입력 → <em>허용</em></li>
          </ol></details>
        <details><summary><strong>ChatGPT</strong> (Pro)</summary>
          <ol class="small">
            <li>웹(chatgpt.com)에서 설정 → Apps &amp; Connectors → Advanced settings → <em>Developer mode</em> 켜기</li>
            <li>커넥터(앱) 만들기 → URL에 위 주소, 인증은 <em>OAuth</em> → Hub에서 허용</li>
            <li>웹에서 등록하면 데스크톱 앱에도 동기화돼요. 대화할 때 Developer mode에서 Hub를 켜세요.</li>
            <li>요금제나 정책에 따라 쓰기(제안) 도구가 막힐 수 있어요. 그럴 땐 브리핑은 MCP로 받고, 끝에 [Hub 메모]를 받아 <a href="/capture">붙여넣기</a> 하세요.</li>
          </ol></details>
        <details><summary><strong>Grok</strong> · Grok Bot</summary>
          <ol class="small">
            <li>Grok: grok.com → 커넥터 → New Connector → <em>Custom</em> → 위 주소 입력 → OAuth 로그인·허용</li>
            <li>Grok Bot: Settings → Plugins → 커스텀 MCP 서버 추가 → 위 주소 + 헤더 <code>Authorization: Bearer (개인 토큰)</code></li>
          </ol></details>
        <details><summary><strong>Meta Muse</strong></summary>
          <ol class="small">
            <li>아래 <a href="#tokens">개인 토큰</a>을 <code>Muse</code> 이름으로 만드세요.</li>
            <li>Muse에게 요청: “Streamable HTTP MCP 서버 ${mcpUrl} 에 헤더 Authorization: Bearer (토큰)으로 연결하는 스킬을 만들어 저장해 줘. 도구 목록을 먼저 확인해 줘.”</li>
            <li>잘 안 되면 프로젝트 페이지의 브리핑 복사 + <a href="/capture">붙여넣기</a>로 쓰면 돼요.</li>
          </ol></details>
      </div>
      <h4>AI 지침에 넣을 문구</h4>
      <p class="small muted">각 AI의 커스텀 지침(맞춤 설정, 프로젝트 지침 등)에 한 번만 넣어 두세요.</p>
      ${copyBlock('instruction-snippet', INSTRUCTION_SNIPPET)}
    </section>`;
}

function aiRunSection(app: AppCtx, ctx: Ctx): SafeHtml {
  const k = app.config.ai;
  const routes = getRoutes(app.db);
  const apps = getAiApps(app.db);
  const keys: Array<[string, string, boolean]> = [
    ['TYPESAFE_API_KEY', 'Jev — 어떤 AI로 할지 판단 (없으면 규칙으로 추천)', Boolean(k.typesafe)],
    ['OPENAI_API_KEY', 'ChatGPT(OpenAI) API 실행', Boolean(k.openai)],
    ['ANTHROPIC_API_KEY', 'Claude API 실행', Boolean(k.anthropic)],
    ['XAI_API_KEY', 'Grok API 실행', Boolean(k.xai)],
    ['META_API_KEY + META_API_BASE_URL', 'Muse(Meta Model API) 실행', Boolean(k.meta && k.metaBaseUrl)],
  ];
  const aiSelect = (name: string, selected: string) =>
    html`<select name="${name}">${AI_IDS.map((id) => html`<option value="${id}" ${id === selected ? raw('selected') : ''}>${AIS[id].label}</option>`)}</select>`;
  return html`<section class="card" id="ai-run">
    <h3>AI 실행 (추천·실행)</h3>
    <p class="small">구독 중인 앱으로 여는 건 키 없이 돼요. Hub 안에서 바로 실행하려면 서버 환경변수에 API 키를 넣으세요 (API 사용료는 별도예요).</p>
    <table class="table small"><tbody>${keys.map(
      ([env, what, ok]) => html`<tr><td><code>${env}</code></td><td>${what}</td><td>${ok ? html`<span class="ok-text">설정됨</span>` : html`<span class="muted">없음</span>`}</td></tr>`,
    )}</tbody></table>

    <h4>종류별 추천표</h4>
    <form method="post" action="/settings/routes" class="stack">
      ${csrfInput(ctx)}
      <div class="table-wrap"><table class="table small routes"><thead><tr><th>종류</th><th>추천 AI</th><th>모델</th><th>대안</th><th>대안 모델</th><th>이유</th></tr></thead><tbody>
        ${CATEGORY_IDS.map((c) => {
          const r = routes[c];
          return html`<tr><td>${CATEGORIES[c].label}${CATEGORIES[c].appOnly ? html` <span class="muted">(앱 전용)</span>` : ''}</td>
            <td>${aiSelect(`${c}.ai`, r.ai)}</td>
            <td><input type="text" name="${c}.model" value="${r.model}"></td>
            <td>${aiSelect(`${c}.alt`, r.alt)}</td>
            <td><input type="text" name="${c}.altModel" value="${r.altModel}"></td>
            <td><input type="text" name="${c}.why" value="${r.why}"></td></tr>`;
        })}
      </tbody></table></div>
      <div class="form-inline"><button class="btn">추천표 저장</button><span class="small muted">모델 이름은 2026년 9월 기준 기본값이에요. 새 모델이 나오면 여기서 바꾸세요.</span></div>
    </form>

    <h4>앱에서 열기</h4>
    <form method="post" action="/settings/ai-apps" class="stack">
      ${csrfInput(ctx)}
      <div class="table-wrap"><table class="table small"><thead><tr><th>AI</th><th>새 대화 주소 ({q}=프롬프트)</th><th>홈 주소</th><th>Hub MCP 연결</th></tr></thead><tbody>
        ${AI_IDS.map(
          (id) => html`<tr><td>${AIS[id].label}</td>
            <td><input type="text" name="${id}.openUrl" value="${apps[id].openUrl}" placeholder="비우면 복사 후 홈 열기"></td>
            <td><input type="text" name="${id}.homeUrl" value="${apps[id].homeUrl}"></td>
            <td><select name="${id}.mcp">
              <option value="auto" ${apps[id].mcp === 'auto' ? raw('selected') : ''}>자동 (${mcpSeen(app.db, id) ? '연결 확인됨' : '기록 없음'})</option>
              <option value="yes" ${apps[id].mcp === 'yes' ? raw('selected') : ''}>연결됨</option>
              <option value="no" ${apps[id].mcp === 'no' ? raw('selected') : ''}>안 됨</option>
            </select></td></tr>`,
        )}
      </tbody></table></div>
      <div class="form-inline"><button class="btn">저장</button><span class="small muted">MCP가 연결된 AI에는 브리핑 대신 “Hub에서 확인해 줘”라는 짧은 요청만 보내요.</span></div>
    </form>
  </section>`;
}

function settingsView(app: AppCtx, ctx: Ctx, newToken?: { name: string; token: string }): SafeHtml {
  const profile = getProfile(app.db);
  const pats = listPats(app.db);
  const clients = listConnectedClients(app.db);
  const auto = getAutoApprove(app.db);
  const calls = app.db.all<McpCallRow>('SELECT * FROM mcp_calls ORDER BY id DESC LIMIT 30');
  const mcpUrl = `${ctx.baseUrl}/mcp`;
  const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(ctx.baseUrl);
  const httpsOk = ctx.baseUrl.startsWith('https://');
  const tz = getTimezone(app.db);
  const calToken = getSetting(app.db, 'calendar_token');
  const calUrl = calToken ? `${ctx.baseUrl}/calendar/${calToken}.ics` : '';
  const backups = app.config.dataDir === ':memory:' ? [] : listBackups(app.config.dataDir);
  const lastBackup = getSetting(app.db, 'last_backup_at');
  const dayStart = getDayStartHour(app.db);
  const wrapupHour = getSetting(app.db, 'wrapup_hour') || '18';

  return html`
    <div class="page-head"><h1>설정</h1>
      <nav class="filters">
        ${[['profile', '프로필'], ['connect', 'AI 연결'], ['ai-run', 'AI 실행'], ['auto', '자동화'], ['calendar', '캘린더'], ['tokens', '토큰'], ['data', '데이터']].map(
          ([id, label]) => html`<a class="pill" href="#${id}">${label}</a>`,
        )}
      </nav>
    </div>
    ${!app.config.publicUrl && !local
      ? html`<div class="flash flash-error">배포 환경이면 <code>HUB_PUBLIC_URL</code>을 설정해 주세요. 지금은 요청 헤더로 주소를 추정하고 있어요 (${ctx.baseUrl}).</div>`
      : ''}

    <section class="card" id="profile">
      <h3>프로필</h3>
      <p class="small muted">모든 브리핑 맨 위에 들어가요. AI가 나를 알도록 짧고 구체적으로 적어 주세요.</p>
      <form method="post" action="/settings/profile" class="stack">
        ${csrfInput(ctx)}
        <label>이름·호칭<input type="text" name="name" value="${profile.name}" placeholder="예: 민지 (1인 스튜디오 운영)"></label>
        <label>소개<textarea name="about" rows="3" placeholder="예: 개발·기획·디자인·마케팅을 혼자 하는 1인 사업자. 주로 웹 서비스와 브랜딩 프로젝트.">${profile.about}</textarea></label>
        <label>작업 선호<textarea name="preferences" rows="3" placeholder="예: 답은 한국어로 짧게, 선택지는 표로. 스택은 Next.js·Supabase. 디자인은 미니멀.">${profile.preferences}</textarea></label>
        <button class="btn btn-primary">프로필 저장</button>
      </form>
    </section>

    ${connectGuide(mcpUrl, httpsOk, local)}
    ${aiRunSection(app, ctx)}

    <section class="card" id="auto">
      <h3>자동화</h3>
      <form method="post" action="/settings/automation" class="stack">
        ${csrfInput(ctx)}
        <label class="inline-label"><input type="checkbox" name="direct_apply" value="1" ${getDirectApply(app.db) ? raw('checked') : ''}>
          AI에게 <strong>직접 시킨</strong> 변경("추가해 줘", "완료 처리해 줘")은 바로 반영 (변경 기록에서 되돌리기 가능)</label>
        <div>
          <div class="small muted">아래 종류는 AI가 스스로 정리해 올린 제안도 바로 반영해요. 믿을 수 있을 때만 켜 주세요.</div>
          <div class="checks">
            ${PROPOSAL_KINDS.map(
              (k) => html`<label class="inline-label"><input type="checkbox" name="kinds" value="${k}" ${auto.has(k) ? raw('checked') : ''}> ${PROPOSAL_KIND_LABEL[k]}</label>`,
            )}
          </div>
        </div>
        <label class="inline-label">하루 시작 시각
          <select name="day_start_hour">${[0, 1, 2, 3, 4, 5, 6].map((h) => html`<option value="${h}" ${h === dayStart ? raw('selected') : ''}>${h === 0 ? '자정 (기본)' : `새벽 ${h}시`}</option>`)}</select>
          <span class="small muted">새벽까지 일하면 이 시각 전까지는 '오늘'을 전날로 쳐요</span>
        </label>
        <label class="inline-label">하루 마감 알림
          <select name="wrapup_hour">
            <option value="off" ${wrapupHour === 'off' ? raw('selected') : ''}>끄기</option>
            ${[16, 17, 18, 19, 20, 21, 22, 23].map((h) => html`<option value="${h}" ${String(h) === wrapupHour ? raw('selected') : ''}>${h}시부터</option>`)}
          </select>
          <span class="small muted">이 시각이 지나면 '오늘' 화면에 하루 마감 안내가 떠요</span>
        </label>
        <button class="btn">저장</button>
      </form>
    </section>

    <section class="card" id="calendar">
      <h3>캘린더 구독</h3>
      <p class="small">마감이 있는 할 일을 구글·애플 캘린더에서 구독하면 휴대폰에서도 알림을 받을 수 있어요. 반복 할 일은 반복 일정으로 보여요.</p>
      ${calUrl
        ? html`${copyBlock('cal-url', calUrl, '주소 복사')}
            <ol class="small">
              <li>구글 캘린더(웹): 다른 캘린더 ＋ → <em>URL로 추가</em> → 위 주소 (반영까지 몇 시간 걸릴 수 있어요)</li>
              <li>애플 캘린더: 파일 → <em>새로운 캘린더 구독</em> → 위 주소 · 아이폰: 설정 → 캘린더 → 계정 → 구독 캘린더 추가</li>
              <li>알림은 캘린더 앱에서 이 캘린더의 기본 알림(예: 당일 오전 9시)으로 정해 두세요.</li>
            </ol>
            <form method="post" action="/settings/calendar" class="form-inline wrap">
              ${csrfInput(ctx)}
              <button class="btn" name="action" value="rotate" data-confirm="새 주소를 만들면 지금 주소는 더 이상 동작하지 않아요. 계속할까요?">새 주소 만들기</button>
              <button class="btn btn-ghost danger" name="action" value="off">구독 끄기</button>
            </form>
            ${!httpsOk ? html`<p class="small error-text">캘린더 서비스가 접속하려면 인터넷에서 열리는 주소로 배포해야 해요.</p>` : ''}`
        : html`<form method="post" action="/settings/calendar" class="form-inline">${csrfInput(ctx)}<button class="btn btn-primary" name="action" value="create">구독 주소 만들기</button></form>
            <p class="small muted">주소를 아는 사람은 할 일 제목과 마감을 볼 수 있어요. 주소는 언제든 바꾸거나 끌 수 있어요.</p>`}
    </section>

    <section class="card" id="tokens">
      <h3>개인 토큰</h3>
      <p class="small muted">OAuth를 못 쓰는 곳(Muse, Grok Bot 등)에서 <code>Authorization: Bearer</code> 헤더로 쓰는 토큰이에요.</p>
      ${newToken
        ? html`<div class="flash flash-ok"><strong>${newToken.name}</strong> 토큰을 만들었어요. 지금만 보여요 — 바로 복사해 두세요.</div>
            ${copyBlock('new-token', newToken.token, '토큰 복사')}`
        : ''}
      <form method="post" action="/settings/tokens" class="form-inline wrap">
        ${csrfInput(ctx)}
        <input type="text" name="name" placeholder="이름 (예: Muse)" required maxlength="60">
        <label class="inline-label"><input type="checkbox" name="write" value="1" checked> 제안(쓰기) 허용</label>
        <button class="btn btn-primary">토큰 만들기</button>
      </form>
      ${pats.length
        ? html`<table class="table"><thead><tr><th>이름</th><th>권한</th><th>마지막 사용</th><th></th></tr></thead><tbody>
            ${pats.map(
              (t) => html`<tr class="${t.revoked_at ? 'revoked' : ''}">
                <td>${t.name} <span class="muted small">${t.prefix}…</span></td>
                <td class="small">${[...parseScopes(t.scopes)].map((s) => SCOPE_LABEL[s as Scope]).join(', ')}</td>
                <td class="small">${t.revoked_at ? '폐기됨' : t.last_used_at ? formatAgo(t.last_used_at) : '사용 전'}</td>
                <td>${t.revoked_at
                  ? ''
                  : html`<form method="post" action="/settings/tokens/${t.id}/revoke" class="inline" data-confirm="이 토큰을 폐기할까요?">${csrfInput(ctx)}<button class="btn btn-ghost btn-small danger">폐기</button></form>`}</td>
              </tr>`,
            )}</tbody></table>`
        : ''}
    </section>

    <section class="card" id="apps">
      <h3>연결된 앱 (OAuth)</h3>
      ${clients.length
        ? html`<table class="table"><thead><tr><th>이름</th><th>등록</th><th>마지막 사용</th><th></th></tr></thead><tbody>
            ${clients.map(
              (c) => html`<tr>
                <td><form method="post" action="/settings/clients/${c.client_id}/rename" class="form-inline">
                  ${csrfInput(ctx)}<input type="text" name="label" value="${clientLabel(c)}" maxlength="60" aria-label="이름"><button class="btn btn-ghost btn-small">이름 변경</button>
                </form><span class="muted small">${c.client_name}${c.active_tokens ? '' : ' · 만료됨'}</span></td>
                <td class="small">${formatDateTime(c.created_at, tz)}</td>
                <td class="small">${c.last_used_at ? formatAgo(c.last_used_at) : '—'}</td>
                <td><form method="post" action="/settings/clients/${c.client_id}/revoke" class="inline" data-confirm="이 앱의 연결을 끊을까요?">${csrfInput(ctx)}<button class="btn btn-ghost btn-small danger">연결 끊기</button></form></td>
              </tr>`,
            )}</tbody></table>
            <p class="small muted">여기 이름이 세션 기록·제안의 출처로 표시돼요.</p>`
        : html`<p class="muted small">아직 OAuth로 연결된 AI가 없어요.</p>`}
    </section>

    <section class="card" id="calls">
      <h3>MCP 호출 기록</h3>
      ${calls.length
        ? html`<div class="table-wrap"><table class="table small"><thead><tr><th>시각</th><th>AI</th><th>요청</th><th>결과</th></tr></thead><tbody>
            ${calls.map(
              (c) => html`<tr><td>${formatDateTime(c.at, tz)}</td><td>${c.client}</td><td>${c.tool ?? c.method}</td>
                <td>${c.ok ? html`<span class="ok-text">성공</span>` : html`<span class="error-text" title="${c.error ?? ''}">실패</span>`} <span class="muted">${c.duration_ms}ms</span>${!c.ok && c.error ? html`<div class="muted">${c.error}</div>` : ''}</td></tr>`,
            )}</tbody></table></div>`
        : html`<p class="muted small">아직 호출이 없어요. AI를 연결하면 여기서 동작을 확인할 수 있어요.</p>`}
    </section>

    <section class="card" id="data">
      <h3>데이터·보안</h3>
      <p class="small">모든 데이터는 SQLite 파일 하나(<code>${app.config.dataDir}/hub.db</code>)에 있어요. 매일 자동 백업을 7개까지 보관해요${lastBackup ? ` (마지막 ${formatAgo(lastBackup)})` : ''}.</p>
      <div class="form-inline wrap">
        <a class="btn" href="/settings/backup">지금 백업 다운로드</a>
        <a class="btn btn-ghost" href="/import">노션·텍스트 가져오기</a>
        <form method="post" action="/settings/logout-all" class="inline" data-confirm="모든 기기에서 로그아웃할까요?">${csrfInput(ctx)}<button class="btn btn-ghost">모든 기기 로그아웃</button></form>
      </div>
      ${backups.length
        ? html`<ul class="plain small">${backups.map((b) => html`<li><a href="/settings/backups/${b.name}">${b.name}</a> <span class="muted">${Math.round(b.size / 1024).toLocaleString()} KB</span></li>`)}</ul>`
        : ''}
      <p class="small muted">오늘 ${currentDay(app.db)} · 시간대 ${tz} · Hub ${app.version}</p>
    </section>`;
}

export function settingsPage(app: AppCtx) {
  return (ctx: Ctx): void => {
    sendHtml(ctx, page(ctx, { title: '설정', active: 'settings', pending: pendingCount(app.db) }, settingsView(app, ctx)));
  };
}

function streamFile(ctx: Ctx, file: string, name: string, cleanup = false): Promise<void> {
  ctx.res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
  const stream = createReadStream(file);
  stream.pipe(ctx.res);
  return new Promise<void>((resolve) => {
    const done = () => {
      if (cleanup) void rm(file, { force: true });
      resolve();
    };
    stream.on('close', done);
    stream.on('error', done);
  });
}

export function settingsActions(app: AppCtx) {
  return {
    profile: (ctx: Ctx) =>
      formAction(ctx, '/settings#profile', (form) => {
        saveProfile(app.db, { name: field(form, 'name'), about: form.get('about') ?? '', preferences: form.get('preferences') ?? '' });
        flash(ctx, '프로필을 저장했어요');
        return '/settings#profile';
      }),
    createToken: async (ctx: Ctx) => {
      const form = await readForm(ctx);
      const scopes = new Set<Scope>(['read']);
      if (field(form, 'write') === '1') scopes.add('write');
      try {
        const { token } = createPat(app.db, field(form, 'name'), scopes);
        sendHtml(ctx, page(ctx, { title: '설정', active: 'settings', pending: pendingCount(app.db) }, settingsView(app, ctx, { name: field(form, 'name'), token })));
      } catch (err) {
        flash(ctx, err instanceof Error ? err.message : String(err), 'error');
        redirect(ctx, '/settings#tokens');
      }
    },
    revokeToken: (ctx: Ctx) =>
      formAction(ctx, '/settings#tokens', () => {
        revokePat(app.db, Number(ctx.params.id));
        flash(ctx, '토큰을 폐기했어요');
      }),
    renameClient: (ctx: Ctx) =>
      formAction(ctx, '/settings#apps', (form) => {
        renameClient(app.db, ctx.params.id ?? '', field(form, 'label'));
        flash(ctx, '이름을 바꿨어요');
      }),
    revokeClient: (ctx: Ctx) =>
      formAction(ctx, '/settings#apps', () => {
        deleteClient(app.db, ctx.params.id ?? '');
        flash(ctx, '연결을 끊었어요');
      }),
    automation: (ctx: Ctx) =>
      formAction(ctx, '/settings#auto', (form) => {
        const kinds = form.getAll('kinds').filter((k): k is ProposalKind => (PROPOSAL_KINDS as readonly string[]).includes(k));
        setAutoApprove(app.db, kinds);
        setSetting(app.db, 'direct_apply', field(form, 'direct_apply') === '1' ? '1' : '0');
        const h = Number(field(form, 'day_start_hour') || '0');
        setSetting(app.db, 'day_start_hour', String(Number.isInteger(h) && h >= 0 && h <= 6 ? h : 0));
        if (form.has('wrapup_hour')) {
          const w = field(form, 'wrapup_hour');
          const wn = Number(w);
          setSetting(app.db, 'wrapup_hour', w === 'off' ? 'off' : Number.isInteger(wn) && wn >= 0 && wn <= 23 ? String(wn) : '18');
        }
        flash(ctx, '자동화 설정을 저장했어요');
        return '/settings#auto';
      }),
    calendar: (ctx: Ctx) =>
      formAction(ctx, '/settings#calendar', (form) => {
        const action = field(form, 'action');
        if (action === 'off') {
          setSetting(app.db, 'calendar_token', '');
          flash(ctx, '캘린더 구독을 껐어요');
        } else {
          setSetting(app.db, 'calendar_token', randomBytes(24).toString('base64url'));
          flash(ctx, action === 'rotate' ? '새 구독 주소를 만들었어요. 캘린더 앱에 다시 등록해 주세요' : '구독 주소를 만들었어요');
        }
        return '/settings#calendar';
      }),
    routes: (ctx: Ctx) =>
      formAction(ctx, '/settings#ai-run', (form) => {
        const routes = getRoutes(app.db);
        for (const c of CATEGORY_IDS) {
          const ai = field(form, `${c}.ai`);
          const alt = field(form, `${c}.alt`);
          if (isAiId(ai)) routes[c].ai = ai;
          if (isAiId(alt)) routes[c].alt = alt;
          if (form.has(`${c}.model`)) routes[c].model = field(form, `${c}.model`);
          if (form.has(`${c}.altModel`)) routes[c].altModel = field(form, `${c}.altModel`);
          if (form.has(`${c}.why`)) routes[c].why = field(form, `${c}.why`);
        }
        saveRoutes(app.db, routes);
        flash(ctx, '추천표를 저장했어요');
        return '/settings#ai-run';
      }),
    aiApps: (ctx: Ctx) =>
      formAction(ctx, '/settings#ai-run', (form) => {
        const apps = getAiApps(app.db);
        for (const id of AI_IDS) {
          const open = field(form, `${id}.openUrl`);
          const home = field(form, `${id}.homeUrl`);
          for (const u of [open, home]) {
            if (u && !/^https:\/\//i.test(u)) throw new UserError(`${AIS[id].label} 주소는 https:// 로 시작해야 해요`);
          }
          if (open && !open.includes('{q}')) throw new UserError(`${AIS[id].label} 새 대화 주소에 {q}를 넣어 주세요 (프롬프트 자리)`);
          apps[id].openUrl = open;
          apps[id].homeUrl = home || AIS[id].homeUrl;
          const mcp = field(form, `${id}.mcp`);
          apps[id].mcp = mcp === 'yes' || mcp === 'no' ? mcp : 'auto';
        }
        saveAiApps(app.db, apps);
        flash(ctx, 'AI 앱 설정을 저장했어요');
        return '/settings#ai-run';
      }),
    logoutAll: (ctx: Ctx) =>
      formAction(ctx, '/login', () => {
        const epoch = Number(getSetting(app.db, 'session_epoch') ?? '0') + 1;
        setSetting(app.db, 'session_epoch', String(epoch));
        return '/login';
      }),
    backup: async (ctx: Ctx): Promise<void> => {
      const file = join(tmpdir(), `hub-backup-${randomBytes(6).toString('hex')}.db`);
      app.db.backupTo(file);
      await streamFile(ctx, file, `hub-${currentDay(app.db)}.db`, true);
    },
    backupFile: async (ctx: Ctx): Promise<void> => {
      const name = ctx.params.name ?? '';
      const file = join(backupDir(app.config.dataDir), name);
      if (!isBackupName(name) || !existsSync(file)) throw new UserError('백업 파일을 찾을 수 없어요');
      await streamFile(ctx, file, name);
    },
  };
}
