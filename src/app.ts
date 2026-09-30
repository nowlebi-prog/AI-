import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { VERSION, type AppCtx } from './app-context.ts';
import type { Config } from './config.ts';
import { Db } from './db.ts';
import { runDailyBackup } from './backup.ts';
import { safeEqual } from './auth/crypto.ts';
import {
  authorizationServerMetadata,
  authorizeGet,
  authorizePost,
  protectedResourceMetadata,
  registerHandler,
  revokeHandler,
  tokenHandler,
} from './auth/oauth.ts';
import { LoginLimiter, SESSION_COOKIE, SESSION_MAX_AGE, needsRenewal, renewSession, verifySession } from './auth/session.ts';
import { buildIcs } from './domain/calendar.ts';
import { getSetting, setSetting } from './domain/profile.ts';
import { recoverStaleRuns } from './domain/runs.ts';
import { UserError } from './domain/types.ts';
import { html } from './lib/html.ts';
import {
  HttpError,
  Router,
  baseUrlOf,
  corsHeaders,
  field,
  parseCookies,
  readForm,
  redirect,
  sendHtml,
  sendJson,
  sendText,
  setCookie,
  type Ctx,
  type Handler,
} from './lib/http.ts';
import { iconPng } from './lib/png.ts';
import { handleMcp } from './mcp/server.ts';
import { barePage, page } from './web/layout.ts';
import { capturePage, captureAction } from './web/pages/capture.ts';
import { dashboardPage } from './web/pages/dashboard.ts';
import { monthPage } from './web/pages/month.ts';
import { wrapupActions, wrapupPage } from './web/pages/wrapup.ts';
import { importDeleteAction, importDetailPage, importNotionAction, importTextAction, importsPage } from './web/pages/imports.ts';
import { inboxActions, inboxPage } from './web/pages/inbox.ts';
import { loginAction, loginPage, logoutAction, sessionEpoch } from './web/pages/login.ts';
import { briefText, createProjectAction, projectActions, projectDetailPage, projectsPage } from './web/pages/projects.ts';
import { refsActions, refsPage } from './web/pages/refs.ts';
import { runActions, runCreateAction, runDetailPage, runHomePage } from './web/pages/run.ts';
import { searchPage } from './web/pages/search.ts';
import { settingsActions, settingsPage } from './web/pages/settings.ts';
import { quickAdd, quickAddPreview, taskDelete, taskEdit, taskSnooze, taskStatus, taskWaiting, todayPage } from './web/pages/today.ts';

export interface App {
  server: Server;
  db: Db;
  ctx: AppCtx;
  close(): Promise<void>;
}

const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');
const STATIC_TYPES: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
};
const CORS_PATHS = /^\/(mcp\/?$|\.well-known\/|oauth\/(token|register|revoke)$)/;

function ensureSecret(db: Db, config: Config): string {
  if (config.secret) return config.secret;
  const saved = getSetting(db, 'secret');
  if (saved) return saved;
  const secret = randomBytes(32).toString('base64url');
  setSetting(db, 'secret', secret);
  return secret;
}

function manifest(): Record<string, unknown> {
  return {
    name: 'Hub',
    short_name: 'Hub',
    description: '프로젝트·할 일·결정·레퍼런스를 모으고 여러 AI와 맥락을 공유하는 개인 작업 허브',
    lang: 'ko',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f6f6f8',
    theme_color: '#4f46e5',
    icons: [
      { src: '/static/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/static/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/static/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: '빠른 추가', url: '/?focus=add' },
      { name: 'AI에게 맡기기', url: '/run' },
      { name: '월간 달력', url: '/calendar' },
      { name: '레퍼런스', url: '/refs' },
      { name: '하루 마감', url: '/wrapup' },
    ],
  };
}

export function createApp(config: Config): App {
  const dbPath = config.dataDir === ':memory:' ? ':memory:' : join(config.dataDir, 'hub.db');
  const db = new Db(dbPath);
  setSetting(db, 'timezone', config.timezone);
  recoverStaleRuns(db);
  const app: AppCtx = { db, config, secret: ensureSecret(db, config), limiter: new LoginLimiter(), version: VERSION };
  const router = new Router();
  const staticCache = new Map<string, Buffer>();

  const auth =
    (h: Handler): Handler =>
    (ctx) => {
      if (ctx.session) return h(ctx);
      if (ctx.method === 'GET' || ctx.method === 'HEAD') {
        return redirect(ctx, `/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`);
      }
      return sendText(ctx, '로그인이 필요해요', 401);
    };
  const csrf =
    (h: Handler): Handler =>
    async (ctx) => {
      const form = await readForm(ctx);
      if (!ctx.session || !safeEqual(field(form, '_csrf'), ctx.session.csrf)) {
        return sendHtml(
          ctx,
          barePage('요청 만료', html`<h1>요청이 만료됐어요</h1><p>페이지를 새로 고친 뒤 다시 시도해 주세요.</p><p><a href="/">Hub로 가기</a></p>`),
          403,
        );
      }
      return h(ctx);
    };
  const get = (path: string, h: Handler) => router.get(path, auth(h));
  const post = (path: string, h: Handler) => router.post(path, auth(csrf(h)));

  // 공개
  router.get('/healthz', (ctx) => sendText(ctx, 'ok'));
  router.get('/robots.txt', (ctx) => sendText(ctx, 'User-agent: *\nDisallow: /\n'));
  router.get('/manifest.webmanifest', (ctx) => sendJson(ctx, manifest(), 200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }));
  router.get('/login', loginPage(app));
  router.post('/login', loginAction(app));
  post('/logout', logoutAction());
  // 캘린더 구독 (비밀 주소로만 접근)
  router.get('/calendar/:file', (ctx) => {
    const token = getSetting(db, 'calendar_token') ?? '';
    const given = (ctx.params.file ?? '').replace(/\.ics$/, '');
    if (!token || !safeEqual(given, token)) return sendText(ctx, 'Not found', 404);
    sendText(ctx, buildIcs(db, ctx.baseUrl), 200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' });
  });

  // OAuth 2.1 (MCP 인가)
  router.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
  router.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata);
  router.get('/.well-known/oauth-authorization-server', authorizationServerMetadata);
  router.get('/.well-known/oauth-authorization-server/mcp', authorizationServerMetadata);
  router.post('/oauth/register', registerHandler(app));
  router.get('/oauth/authorize', authorizeGet(app));
  router.post('/oauth/authorize', authorizePost(app));
  router.post('/oauth/token', tokenHandler(app));
  router.post('/oauth/revoke', revokeHandler(app));

  // 오늘·할 일
  get('/', todayPage(app));
  get('/quick-add/preview', quickAddPreview(app));
  post('/quick-add', quickAdd(app));
  post('/tasks/:id/status', taskStatus(app));
  post('/tasks/:id/edit', taskEdit(app));
  post('/tasks/:id/snooze', taskSnooze(app));
  post('/tasks/:id/waiting', taskWaiting(app));
  post('/tasks/:id/delete', taskDelete(app));

  // 대시보드(현황·월간)·검색
  get('/dashboard', dashboardPage(app));
  get('/calendar', monthPage(app));
  get('/search', searchPage(app));

  // 하루 마감
  const wa = wrapupActions(app);
  get('/wrapup', wrapupPage(app));
  post('/wrapup/snooze', wa.snooze);
  post('/wrapup/hub-cleanup', wa.hubCleanup);
  post('/wrapup/files', wa.addFiles);
  post('/wrapup/files/decide', wa.decide);
  post('/wrapup/files/clear', wa.clear);
  post('/wrapup/done', wa.done);

  // 브리핑 텍스트 (복사 버튼용)
  const bt = briefText(app);
  get('/brief.txt', bt.overview);
  get('/activity.txt', bt.activity);

  // 프로젝트
  const pa = projectActions(app);
  get('/projects', projectsPage(app));
  post('/projects', createProjectAction(app));
  get('/projects/:id', projectDetailPage(app));
  get('/projects/:id/brief.txt', bt.project);
  post('/projects/:id/card', pa.card);
  post('/projects/:id/resume', pa.resume);
  post('/projects/:id/tasks', pa.addTask);
  post('/projects/:id/decisions', pa.addDecision);
  post('/projects/:id/delete', pa.remove);
  post('/decisions/:id/edit', pa.editDecision);
  post('/decisions/:id/delete', pa.deleteDecision);
  post('/logs/:id/delete', pa.deleteLog);

  // 레퍼런스
  const ra = refsActions(app);
  get('/refs', refsPage(app));
  post('/refs', ra.create);
  post('/refs/bulk', ra.bulk);
  post('/refs/:id/edit', ra.edit);
  post('/refs/:id/delete', ra.remove);

  // AI 실행
  const runs = runActions(app);
  get('/run', runHomePage(app));
  post('/run', runCreateAction(app));
  get('/run/:id', runDetailPage(app));
  post('/run/:id/execute', runs.execute);
  post('/run/:id/handoff', runs.handoff);
  post('/run/:id/delete', runs.remove);

  // 인박스·변경 기록
  const ia = inboxActions(app);
  get('/inbox', inboxPage(app));
  post('/inbox/approve-all', ia.approveAll);
  post('/inbox/:id/approve', ia.approve);
  post('/inbox/:id/reject', ia.reject);
  post('/activity/:id/undo', ia.undo);

  // 붙여넣기·가져오기
  get('/capture', capturePage(app));
  post('/capture', captureAction(app));
  get('/import', importsPage(app));
  post('/import/notion', importNotionAction(app));
  post('/import/text', importTextAction(app));
  get('/import/:id', importDetailPage(app));
  post('/import/:id/delete', importDeleteAction(app));

  // 설정
  const sa = settingsActions(app);
  get('/settings', settingsPage(app));
  get('/settings/backup', sa.backup);
  get('/settings/backups/:name', sa.backupFile);
  post('/settings/profile', sa.profile);
  post('/settings/tokens', sa.createToken);
  post('/settings/tokens/:id/revoke', sa.revokeToken);
  post('/settings/clients/:id/rename', sa.renameClient);
  post('/settings/clients/:id/revoke', sa.revokeClient);
  post('/settings/automation', sa.automation);
  post('/settings/calendar', sa.calendar);
  post('/settings/routes', sa.routes);
  post('/settings/ai-apps', sa.aiApps);
  post('/settings/logout-all', sa.logoutAll);

  const GENERATED: Record<string, () => Buffer> = {
    'icon-192.png': () => iconPng(192),
    'icon-512.png': () => iconPng(512),
    'icon-maskable-512.png': () => iconPng(512, { maskable: true }),
  };

  async function serveStatic(ctx: Ctx): Promise<void> {
    const name = ctx.path.slice('/static/'.length);
    const ext = name.split('.').pop() ?? '';
    if (!/^[a-z0-9._-]+$/i.test(name) || name.includes('..') || !STATIC_TYPES[ext]) return notFound(ctx);
    let buf = staticCache.get(name);
    if (!buf) {
      const gen = GENERATED[name];
      if (gen) buf = gen();
      else {
        try {
          buf = await readFile(join(PUBLIC_DIR, name));
        } catch {
          return notFound(ctx);
        }
      }
      staticCache.set(name, buf);
    }
    ctx.res.writeHead(200, {
      'Content-Type': STATIC_TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    ctx.res.end(ctx.method === 'HEAD' ? undefined : buf);
  }

  function notFound(ctx: Ctx): void {
    if (ctx.session && (ctx.method === 'GET' || ctx.method === 'HEAD')) {
      sendHtml(ctx, page(ctx, { title: '없는 페이지' }, html`<h1>페이지를 찾을 수 없어요</h1><p><a href="/">오늘로 가기</a></p>`), 404);
      return;
    }
    sendText(ctx, 'Not found', 404);
  }

  function errorResponse(ctx: Ctx, status: number, message: string): void {
    if (ctx.res.headersSent) {
      ctx.res.end();
      return;
    }
    const accept = String(ctx.req.headers.accept ?? '');
    if (ctx.session && accept.includes('text/html')) {
      sendHtml(ctx, page(ctx, { title: '오류' }, html`<h1>문제가 생겼어요</h1><p>${message}</p><p><a href="/">오늘로 가기</a></p>`), status);
      return;
    }
    sendText(ctx, message, status);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ctx: Ctx = {
      req,
      res,
      method: (req.method ?? 'GET').toUpperCase(),
      url,
      path: url.pathname,
      params: {},
      cookies: parseCookies(req.headers.cookie),
      baseUrl: baseUrlOf(req, config.publicUrl),
      session: null,
    };
    try {
      const epoch = sessionEpoch(app);
      ctx.session = verifySession(ctx.cookies[SESSION_COOKIE], app.secret, epoch);
      // 쓰는 동안에는 로그인이 풀리지 않게 만료를 연장한다 (CSRF 토큰은 그대로)
      if (ctx.session && ctx.method === 'GET' && needsRenewal(ctx.session)) {
        setCookie(ctx, SESSION_COOKIE, renewSession(app.secret, epoch, ctx.session.nonce), {
          maxAge: SESSION_MAX_AGE,
          secure: ctx.baseUrl.startsWith('https://'),
          sameSite: 'Lax',
        });
      }
      if (ctx.method === 'OPTIONS' && CORS_PATHS.test(ctx.path)) {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
      }
      if (ctx.path === '/mcp' || ctx.path === '/mcp/') {
        await handleMcp(ctx, { db, version: VERSION });
        return;
      }
      if (ctx.path.startsWith('/static/')) {
        await serveStatic(ctx);
        return;
      }
      const m = router.match(ctx.method, ctx.path);
      if (m.kind === 'found') {
        ctx.params = m.params;
        await m.handler(ctx);
        return;
      }
      if (m.kind === 'method-not-allowed') {
        res.writeHead(405, { Allow: [...new Set(m.allow)].join(', ') });
        res.end();
        return;
      }
      notFound(ctx);
    } catch (err) {
      if (err instanceof UserError) return errorResponse(ctx, 400, err.message);
      if (err instanceof HttpError) return errorResponse(ctx, err.status, err.message);
      console.error('[hub]', err);
      errorResponse(ctx, 500, '서버 오류가 발생했어요');
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error('[hub] 처리 실패', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  // 매일 자동 백업 (시작할 때 한 번, 이후 6시간마다 확인)
  let backupTimer: ReturnType<typeof setInterval> | null = null;
  if (config.dataDir !== ':memory:') {
    const tryBackup = () => {
      try {
        runDailyBackup(db, config.dataDir);
      } catch (err) {
        console.error('[hub] 자동 백업 실패', err);
      }
    };
    tryBackup();
    backupTimer = setInterval(tryBackup, 6 * 3_600_000);
    backupTimer.unref();
  }

  return {
    server,
    db,
    ctx: app,
    close: () =>
      new Promise<void>((resolve) => {
        if (backupTimer) clearInterval(backupTimer);
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections?.();
      }),
  };
}
