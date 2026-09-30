import { createReadStream } from 'node:fs';
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
import { getAutoApprove, getProfile, getSetting, saveProfile, setAutoApprove, setSetting } from '../../domain/profile.ts';
import { pendingCount } from '../../domain/proposals.ts';
import { PROPOSAL_KINDS, PROPOSAL_KIND_LABEL, type ProposalKind } from '../../domain/types.ts';
import { html, raw, type SafeHtml } from '../../lib/html.ts';
import { field, readForm, redirect, sendHtml, type Ctx } from '../../lib/http.ts';
import { formatAgo, formatDateTime, todayIn } from '../../lib/time.ts';
import { formAction } from '../actions.ts';
import { copyBlock, csrfInput, flash, page } from '../layout.ts';

export const INSTRUCTION_SNIPPET = `나는 'Hub'라는 개인 작업 허브를 연결해 두었어.
- 프로젝트 이야기를 시작하면 먼저 Hub의 get_brief로 그 프로젝트의 맥락을 확인해 줘. 어떤 프로젝트인지 모르면 list_projects를 호출해.
- 중요한 결정이 나오면 propose_decision, 할 일이 생기거나 끝나면 propose_task로 Hub에 제안해 줘.
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
      <h3>AI 연결</h3>
      <p>아래 주소를 각 AI에 <strong>원격 MCP 서버</strong>로 등록하세요.</p>
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

function settingsView(app: AppCtx, ctx: Ctx, newToken?: { name: string; token: string }): SafeHtml {
  const profile = getProfile(app.db);
  const pats = listPats(app.db);
  const clients = listConnectedClients(app.db);
  const auto = getAutoApprove(app.db);
  const calls = app.db.all<McpCallRow>('SELECT * FROM mcp_calls ORDER BY id DESC LIMIT 30');
  const mcpUrl = `${ctx.baseUrl}/mcp`;
  const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(ctx.baseUrl);
  const httpsOk = ctx.baseUrl.startsWith('https://');
  const tz = app.config.timezone;

  return html`
    <div class="page-head"><h1>설정</h1></div>
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

    <section class="card" id="auto">
      <h3>자동 승인</h3>
      <p class="small muted">체크한 종류는 AI가 제안하는 즉시 반영돼요. 믿을 수 있을 때만 켜 주세요.</p>
      <form method="post" action="/settings/auto-approve" class="stack">
        ${csrfInput(ctx)}
        <div class="checks">
          ${PROPOSAL_KINDS.map(
            (k) => html`<label class="inline-label"><input type="checkbox" name="kinds" value="${k}" ${auto.has(k) ? raw('checked') : ''}> ${PROPOSAL_KIND_LABEL[k]}</label>`,
          )}
        </div>
        <button class="btn">저장</button>
      </form>
    </section>

    <section class="card" id="calls">
      <h3>MCP 호출 기록</h3>
      ${calls.length
        ? html`<table class="table small"><thead><tr><th>시각</th><th>AI</th><th>요청</th><th>결과</th></tr></thead><tbody>
            ${calls.map(
              (c) => html`<tr><td>${formatDateTime(c.at, tz)}</td><td>${c.client}</td><td>${c.tool ?? c.method}</td>
                <td>${c.ok ? html`<span class="ok-text">성공</span>` : html`<span class="error-text" title="${c.error ?? ''}">실패</span>`} <span class="muted">${c.duration_ms}ms</span>${!c.ok && c.error ? html`<div class="muted">${c.error}</div>` : ''}</td></tr>`,
            )}</tbody></table>`
        : html`<p class="muted small">아직 호출이 없어요. AI를 연결하면 여기서 동작을 확인할 수 있어요.</p>`}
    </section>

    <section class="card">
      <h3>데이터·보안</h3>
      <p class="small">모든 데이터는 SQLite 파일 하나(<code>${app.config.dataDir}/hub.db</code>)에 있어요.</p>
      <div class="form-inline wrap">
        <a class="btn" href="/settings/backup">백업 다운로드</a>
        <form method="post" action="/settings/logout-all" class="inline" data-confirm="모든 기기에서 로그아웃할까요?">${csrfInput(ctx)}<button class="btn btn-ghost">모든 기기 로그아웃</button></form>
      </div>
      <p class="small muted">오늘 ${todayIn(tz)} · 시간대 ${tz} · Hub ${app.version}</p>
    </section>`;
}

export function settingsPage(app: AppCtx) {
  return (ctx: Ctx): void => {
    sendHtml(ctx, page(ctx, { title: '설정', active: 'settings', pending: pendingCount(app.db) }, settingsView(app, ctx)));
  };
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
    autoApprove: (ctx: Ctx) =>
      formAction(ctx, '/settings#auto', (form) => {
        const kinds = form.getAll('kinds').filter((k): k is ProposalKind => (PROPOSAL_KINDS as readonly string[]).includes(k));
        setAutoApprove(app.db, kinds);
        flash(ctx, kinds.length ? `자동 승인: ${kinds.map((k) => PROPOSAL_KIND_LABEL[k]).join(', ')}` : '자동 승인을 모두 껐어요');
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
      const name = `hub-${todayIn(app.config.timezone)}.db`;
      ctx.res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
      });
      const stream = createReadStream(file);
      stream.pipe(ctx.res);
      await new Promise<void>((resolve) => {
        stream.on('close', () => resolve());
        stream.on('error', () => resolve());
      });
      await rm(file, { force: true });
    },
  };
}
