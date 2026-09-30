import type { Db } from '../db.ts';
import type { AiKeys } from '../config.ts';
import { callLlm } from '../integrations/llm.ts';
import { nowIso } from '../lib/time.ts';
import { AIS, CATEGORIES, apiKeyFor, getAiApps, isAiId, mcpConnected, type AiId } from './ais.ts';
import { overviewBrief, projectBrief } from './brief.ts';
import { applyMemo, parseMemos } from './capture.ts';
import { currentDay, getTimezone } from './clock.ts';
import { getProject, listProjects } from './projects.ts';
import { planRoute, type RoutePlan } from './router.ts';
import { UserError } from './types.ts';

/** 'AI에게 맡기기' 실행 기록 */

export type RunStatus = 'planned' | 'running' | 'done' | 'handed_off' | 'failed';
export type RunMode = 'api' | 'app';

export interface Run {
  id: number;
  created_at: string;
  project_id: number | null;
  request: string;
  plan: string;
  ai: AiId | null;
  model: string | null;
  mode: RunMode | null;
  status: RunStatus;
  prompt: string | null;
  response: string | null;
  error: string | null;
  result: string | null;
  finished_at: string | null;
}

export interface RunView extends Run {
  project_name: string | null;
}

export interface RunResult {
  usage: string;
  applied: string[];
  pending: string[];
  errors: string[];
}

export const SYSTEM_PROMPT = [
  '너는 여러 프로젝트를 혼자 운영하는 사용자를 돕는 AI야.',
  '사용자의 작업 허브(Hub) 맥락이 함께 주어져. 한국어로, 바로 쓸 수 있는 결과물 위주로 답해.',
  '답의 맨 끝에는 맥락에 적힌 [Hub 메모] 형식으로 이번 작업에서 정한 것·새 할 일·마지막 위치를 정리해 줘. 해당 없는 줄은 빼도 돼.',
].join('\n');

export function getRun(db: Db, id: number): RunView | undefined {
  return db.get<RunView>('SELECT r.*, p.name AS project_name FROM runs r LEFT JOIN projects p ON p.id = r.project_id WHERE r.id = ?', id);
}

export function requireRun(db: Db, id: number): RunView {
  const r = getRun(db, id);
  if (!r) throw new UserError('실행 기록을 찾을 수 없어요');
  return r;
}

export function listRuns(db: Db, limit = 20): RunView[] {
  return db.all<RunView>(
    'SELECT r.*, p.name AS project_name FROM runs r LEFT JOIN projects p ON p.id = r.project_id ORDER BY r.id DESC LIMIT ?',
    limit,
  );
}

export function planOf(run: Run): RoutePlan {
  return JSON.parse(run.plan) as RoutePlan;
}

export function resultOf(run: Run): RunResult | null {
  return run.result ? (JSON.parse(run.result) as RunResult) : null;
}

/** 요청 문장 속 프로젝트 이름 (긴 이름 우선) */
export function detectProject(db: Db, text: string): number | null {
  const lower = text.toLowerCase();
  const hit = listProjects(db, 'active')
    .sort((a, b) => b.name.length - a.name.length)
    .find((p) => lower.includes(p.name.toLowerCase()));
  return hit?.id ?? null;
}

export async function createRun(db: Db, keys: AiKeys, request: string, projectId: number | null): Promise<number> {
  const req = request.trim();
  if (!req) throw new UserError('맡길 일을 적어 주세요');
  if (req.length > 20_000) throw new UserError('요청이 너무 길어요 (2만 자 이내)');
  if (projectId !== null && !getProject(db, projectId)) throw new UserError('프로젝트를 찾을 수 없어요');
  const pid = projectId ?? detectProject(db, req);
  const plan = await planRoute(db, req, keys);
  return db.run('INSERT INTO runs (created_at, project_id, request, plan) VALUES (?, ?, ?, ?)', nowIso(), pid, req, JSON.stringify(plan))
    .lastInsertRowid;
}

/** 실제로 AI에 보낼 프롬프트 */
export function composePrompt(db: Db, run: Run, ai: AiId, mode: RunMode): string {
  const project = run.project_id !== null ? getProject(db, run.project_id) : undefined;
  if (mode === 'app' && mcpConnected(db, ai)) {
    const hint = project
      ? `(Hub 연결됨: 먼저 get_brief("${project.name}")로 맥락을 확인하고 진행해 줘. 끝나면 log_session으로 요약과 마지막 위치를 남겨 줘.)`
      : '(Hub 연결됨: 필요하면 get_brief로 맥락을 확인하고, 끝나면 log_session으로 기록해 줘.)';
    return `${run.request}\n\n${hint}`;
  }
  const today = currentDay(db);
  const tz = getTimezone(db);
  const brief = project
    ? projectBrief(db, project.id, { size: 'M', mode: 'paste', today, tz })
    : overviewBrief(db, { size: 'S', mode: 'paste', today, tz });
  return ['아래는 내 작업 허브(Hub)의 최신 맥락이야. 참고해서 요청을 처리해 줘.', '', '<hub-context>', brief, '</hub-context>', '', `요청: ${run.request}`].join('\n');
}

export const MAX_URL_PROMPT = 6000;

/** 앱에서 열 주소. 프롬프트가 길면 주소에 넣지 않고 복사해서 붙여 넣게 한다 */
export function handoffUrl(db: Db, ai: AiId, prompt: string): { url: string; inUrl: boolean } {
  const app = getAiApps(db)[ai];
  const encoded = encodeURIComponent(prompt);
  if (app.openUrl.includes('{q}') && encoded.length <= MAX_URL_PROMPT) return { url: app.openUrl.replace('{q}', encoded), inUrl: true };
  return { url: app.homeUrl, inUrl: false };
}

export function markHandoff(db: Db, id: number, ai: AiId, model: string): void {
  const run = requireRun(db, id);
  db.run(
    "UPDATE runs SET ai = ?, model = ?, mode = 'app', status = 'handed_off', prompt = ?, finished_at = ? WHERE id = ?",
    ai,
    model,
    composePrompt(db, run, ai, 'app'),
    nowIso(),
    id,
  );
}

export function canUseApi(keys: AiKeys, ai: AiId, run: Run): { ok: boolean; reason: string } {
  const plan = planOf(run);
  if (CATEGORIES[plan.category].appOnly) return { ok: false, reason: `${CATEGORIES[plan.category].label}은(는) 앱에서만 할 수 있어요` };
  if (!apiKeyFor(keys, ai)) {
    const env = ai === 'muse' ? 'META_API_KEY와 META_API_BASE_URL' : AIS[ai].keyEnv;
    return { ok: false, reason: `${env}를 설정하면 Hub에서 바로 실행돼요` };
  }
  return { ok: true, reason: '' };
}

/** API 실행을 시작한다 (결과는 비동기로 저장). 완료 Promise를 돌려준다 */
export function startApiRun(db: Db, keys: AiKeys, id: number, ai: AiId, model: string): Promise<void> {
  const run = requireRun(db, id);
  if (run.status === 'running') throw new UserError('이미 실행 중이에요');
  if (!isAiId(ai)) throw new UserError('AI를 선택해 주세요');
  const check = canUseApi(keys, ai, run);
  if (!check.ok) throw new UserError(check.reason);
  const m = model.trim() || AIS[ai].defaultModel;
  const prompt = composePrompt(db, run, ai, 'api');
  db.run(
    "UPDATE runs SET ai = ?, model = ?, mode = 'api', status = 'running', prompt = ?, response = NULL, error = NULL, result = NULL, finished_at = NULL WHERE id = ?",
    ai,
    m,
    prompt,
    id,
  );
  const key = apiKeyFor(keys, ai);
  return (async () => {
    try {
      if (!key) throw new UserError('API 키가 없어요');
      const res = await callLlm({ ai, apiKey: key.key, baseUrl: key.baseUrl, model: m, system: SYSTEM_PROMPT, prompt });
      const today = currentDay(db);
      const out: RunResult = { usage: res.usage, applied: [], pending: [], errors: [] };
      for (const memo of parseMemos(res.text, today)) {
        try {
          const r = applyMemo(db, memo, `${AIS[ai].label} (API)`, run.project_id);
          if (r.logId) out.applied.push(`세션 기록 L${r.logId}`);
          if (r.resumeSaved) out.applied.push('마지막 위치');
          for (const p of r.proposals) {
            if (p.result.duplicate) continue;
            (p.result.applied ? out.applied : out.pending).push(p.label);
          }
          out.errors.push(...r.errors);
        } catch (err) {
          out.errors.push(err instanceof Error ? err.message : String(err));
        }
      }
      db.run("UPDATE runs SET status = 'done', response = ?, result = ?, finished_at = ? WHERE id = ?", res.text, JSON.stringify(out), nowIso(), id);
    } catch (err) {
      db.run("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", err instanceof Error ? err.message : String(err), nowIso(), id);
    }
  })();
}

/** 서버가 재시작돼서 멈춘 실행 정리 */
export function recoverStaleRuns(db: Db): void {
  db.run("UPDATE runs SET status = 'failed', error = '서버가 다시 시작돼서 실행이 중단됐어요', finished_at = ? WHERE status = 'running'", nowIso());
}

export function deleteRun(db: Db, id: number): void {
  db.run('DELETE FROM runs WHERE id = ?', id);
}
