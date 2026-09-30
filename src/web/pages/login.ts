import type { AppCtx } from '../../app-context.ts';
import { SESSION_COOKIE, SESSION_MAX_AGE, checkPassword, signSession } from '../../auth/session.ts';
import { getSetting } from '../../domain/profile.ts';
import { html } from '../../lib/html.ts';
import { field, readForm, redirect, safeLocalPath, sendHtml, setCookie, type Ctx } from '../../lib/http.ts';
import { barePage } from '../layout.ts';

export function sessionEpoch(app: AppCtx): string {
  return getSetting(app.db, 'session_epoch') ?? '0';
}

function loginView(next: string, error: string | null, configured: boolean) {
  return barePage(
    '로그인',
    html`<h1 class="brand-lg">Hub</h1>
      ${!configured
        ? html`<div class="flash flash-error">비밀번호가 설정되지 않았어요. <code>HUB_PASSWORD</code> 환경변수를 설정한 뒤 다시 실행해 주세요.</div>`
        : html`<form method="post" action="/login" class="stack" data-no-ajax>
            <input type="hidden" name="next" value="${next}">
            <label>비밀번호<input type="password" name="password" autocomplete="current-password" required autofocus></label>
            ${error ? html`<div class="flash flash-error">${error}</div>` : ''}
            <button class="btn btn-primary">로그인</button>
          </form>`}`,
  );
}

export function loginPage(app: AppCtx) {
  return (ctx: Ctx): void => {
    const next = safeLocalPath(ctx.url.searchParams.get('next'), '/');
    if (ctx.session) return redirect(ctx, next);
    sendHtml(ctx, loginView(next, null, Boolean(app.config.password)));
  };
}

export function loginAction(app: AppCtx) {
  return async (ctx: Ctx): Promise<void> => {
    const form = await readForm(ctx);
    const next = safeLocalPath(field(form, 'next'), '/');
    if (!app.config.password) return sendHtml(ctx, loginView(next, null, false), 503);
    if (app.limiter.blocked()) {
      return sendHtml(ctx, loginView(next, '로그인 시도가 너무 많아요. 15분 뒤에 다시 시도해 주세요.', true), 429);
    }
    if (!checkPassword(form.get('password') ?? '', app.config.password)) {
      app.limiter.fail();
      return sendHtml(ctx, loginView(next, '비밀번호가 맞지 않아요.', true), 401);
    }
    app.limiter.reset();
    setCookie(ctx, SESSION_COOKIE, signSession(app.secret, sessionEpoch(app)), {
      maxAge: SESSION_MAX_AGE,
      secure: ctx.baseUrl.startsWith('https://'),
      sameSite: 'Lax',
    });
    redirect(ctx, next);
  };
}

export function logoutAction() {
  return (ctx: Ctx): void => {
    setCookie(ctx, SESSION_COOKIE, '', { maxAge: 0, secure: ctx.baseUrl.startsWith('https://') });
    redirect(ctx, '/login');
  };
}
