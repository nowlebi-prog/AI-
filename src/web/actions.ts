import { UserError } from '../domain/types.ts';
import { field, readForm, redirect, safeLocalPath, type Ctx } from '../lib/http.ts';
import { flash } from './layout.ts';

/**
 * 폼 처리 공통 흐름: 실행 → 성공/오류 메시지 → 돌아가기.
 * fn이 문자열을 돌려주면 그 경로로 이동한다.
 */
export async function formAction(
  ctx: Ctx,
  fallback: string,
  fn: (form: URLSearchParams) => string | void | Promise<string | void>,
): Promise<void> {
  const form = await readForm(ctx);
  let dest = safeLocalPath(field(form, '_back'), fallback);
  try {
    const to = await fn(form);
    if (typeof to === 'string') dest = to;
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    flash(ctx, err.message, 'error');
  }
  redirect(ctx, dest);
}

export function idParam(ctx: Ctx, name = 'id'): number {
  const n = Number(ctx.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw new UserError('잘못된 번호예요');
  return n;
}
