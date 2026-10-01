import type { Db, Param } from '../db.ts';
import { dateOf, formatDate, formatDateTime, nowIso } from '../lib/time.ts';
import { getTimezone } from './clock.ts';
import { deleteDecision, deleteLog, getDecision } from './decisions.ts';
import { deleteProject, getProject } from './projects.ts';
import { deleteTask, getTask, restoreTask, type TaskSnapshot } from './tasks.ts';
import { PROJECT_FIELDS, UserError, type ProjectField, type ProjectStatus } from './types.ts';

/** AI가 만든 변경의 기록. 되돌리기(undo)에 쓴다. */

export type ActivityAction =
  | 'task.create'
  | 'task.update'
  | 'decision.create'
  | 'project.create'
  | 'project.update'
  | 'log.create'
  | 'resume.update'
  | 'reference.create';

export type ActivityVia = 'direct' | 'auto' | 'approved' | 'session';

export const VIA_LABEL: Record<ActivityVia, string> = {
  direct: '직접 요청',
  auto: '자동 승인',
  approved: '승인',
  session: '세션 기록',
};

export interface Activity {
  id: number;
  at: string;
  source: string;
  action: ActivityAction;
  entity_id: number | null;
  project_id: number | null;
  summary: string;
  before: string | null;
  via: ActivityVia;
  undone_at: string | null;
}

export interface ActivityView extends Activity {
  project_name: string | null;
}

export interface ActivityInput {
  source: string;
  action: ActivityAction;
  entity_id: number | null;
  project_id: number | null;
  summary: string;
  before?: unknown;
  via: ActivityVia;
}

export function recordActivity(db: Db, a: ActivityInput): number {
  const r = db.run(
    'INSERT INTO activity (at, source, action, entity_id, project_id, summary, before, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    nowIso(),
    a.source,
    a.action,
    a.entity_id,
    a.project_id,
    a.summary.slice(0, 300),
    a.before === undefined ? null : JSON.stringify(a.before),
    a.via,
  );
  if (r.lastInsertRowid % 200 === 0) db.run('DELETE FROM activity WHERE id <= ?', r.lastInsertRowid - 3000);
  return r.lastInsertRowid;
}

export function listActivity(db: Db, opts: { limit?: number; sinceIso?: string; vias?: ActivityVia[] } = {}): ActivityView[] {
  const where: string[] = [];
  const vals: Param[] = [];
  if (opts.sinceIso) {
    where.push('a.at >= ?');
    vals.push(opts.sinceIso);
  }
  if (opts.vias?.length) {
    where.push(`a.via IN (${opts.vias.map(() => '?').join(', ')})`);
    vals.push(...opts.vias);
  }
  vals.push(opts.limit ?? 50);
  return db.all<ActivityView>(
    `SELECT a.*, p.name AS project_name FROM activity a LEFT JOIN projects p ON p.id = a.project_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ?`,
    ...vals,
  );
}

export type ProjectSnapshot = { name: string; status: ProjectStatus; kind: string } & Record<ProjectField, string>;

export function snapshotProject(p: ProjectSnapshot): ProjectSnapshot {
  const s = { name: p.name, status: p.status, kind: p.kind } as ProjectSnapshot;
  for (const f of PROJECT_FIELDS) s[f] = p[f];
  return s;
}

function restoreProject(db: Db, id: number, s: ProjectSnapshot): void {
  db.run(
    `UPDATE projects SET name = ?, status = ?, kind = ?, ${PROJECT_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    s.name,
    s.status,
    s.kind ?? '',
    ...PROJECT_FIELDS.map((f) => s[f] ?? ''),
    nowIso(),
    id,
  );
}

export function undoActivity(db: Db, id: number): string {
  return db.tx(() => {
    const a = db.get<Activity>('SELECT * FROM activity WHERE id = ?', id);
    if (!a) throw new UserError('기록을 찾을 수 없어요');
    if (a.undone_at) throw new UserError('이미 되돌렸어요');
    const before = a.before ? (JSON.parse(a.before) as Record<string, unknown>) : {};
    const eid = a.entity_id;
    let msg: string;
    switch (a.action) {
      case 'task.create':
        if (eid && getTask(db, eid)) deleteTask(db, eid);
        msg = '추가된 할 일을 지웠어요';
        break;
      case 'task.update': {
        if (!eid || !getTask(db, eid)) throw new UserError('할 일이 이미 삭제됐어요');
        const { spawned, ...snap } = before as TaskSnapshot & { spawned?: number | null };
        restoreTask(db, eid, snap as TaskSnapshot);
        if (spawned && getTask(db, spawned)) deleteTask(db, spawned);
        msg = '할 일을 이전 상태로 되돌렸어요';
        break;
      }
      case 'decision.create':
        if (eid && getDecision(db, eid)) deleteDecision(db, eid);
        msg = '결정을 지웠어요. 이 결정이 대체했던 결정은 다시 유효해져요';
        break;
      case 'project.create':
        if (eid && getProject(db, eid)) deleteProject(db, eid);
        msg = '프로젝트를 지웠어요';
        break;
      case 'project.update':
        if (!eid || !getProject(db, eid)) throw new UserError('프로젝트가 이미 삭제됐어요');
        restoreProject(db, eid, before as ProjectSnapshot);
        msg = '프로젝트 카드를 되돌렸어요';
        break;
      case 'log.create':
        if (eid) deleteLog(db, eid);
        msg = '세션 기록을 지웠어요';
        break;
      case 'resume.update':
        if (!eid || !getProject(db, eid)) throw new UserError('프로젝트가 이미 삭제됐어요');
        db.run(
          'UPDATE projects SET resume_note = ?, resume_note_at = ?, resume_note_source = ? WHERE id = ?',
          String(before.resume_note ?? ''),
          (before.resume_note_at as string | null) ?? null,
          (before.resume_note_source as string | null) ?? null,
          eid,
        );
        msg = '마지막 위치를 되돌렸어요';
        break;
      case 'reference.create':
        if (eid) db.run('DELETE FROM refs WHERE id = ?', eid);
        msg = '저장된 레퍼런스를 지웠어요';
        break;
    }
    db.run('UPDATE activity SET undone_at = ? WHERE id = ?', nowIso(), id);
    return msg;
  });
}

/** 최근 N일 활동 요약 (주간 리뷰, recent_activity 도구) */
export function activityReport(db: Db, opts: { days: number; projectId?: number; now?: Date }): string {
  const tz = getTimezone(db);
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - opts.days * 86_400_000).toISOString();
  const pf = (alias: string) => (opts.projectId !== undefined ? `AND ${alias}.project_id = ?` : '');
  const pv = opts.projectId !== undefined ? [opts.projectId] : [];
  const project = opts.projectId !== undefined ? getProject(db, opts.projectId) : undefined;

  const sessions = db.all<{ id: number; source: string; summary: string; created_at: string; name: string | null }>(
    `SELECT l.id, l.source, l.summary, l.created_at, p.name FROM session_logs l LEFT JOIN projects p ON p.id = l.project_id
     WHERE l.created_at >= ? ${pf('l')} ORDER BY l.created_at DESC LIMIT 30`,
    since,
    ...pv,
  );
  const decisions = db.all<{ id: number; content: string; source: string; created_at: string; name: string; superseded_by: number | null }>(
    `SELECT d.id, d.content, d.source, d.created_at, d.superseded_by, p.name FROM decisions d JOIN projects p ON p.id = d.project_id
     WHERE d.created_at >= ? ${pf('d')} ORDER BY d.created_at DESC LIMIT 30`,
    since,
    ...pv,
  );
  const done = db.all<{ id: number; title: string; done_at: string; name: string | null }>(
    `SELECT t.id, t.title, t.done_at, p.name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.status = 'done' AND t.done_at >= ? ${pf('t')} ORDER BY t.done_at DESC LIMIT 50`,
    since,
    ...pv,
  );
  const created = db.all<{ id: number; title: string; created_at: string; due_date: string | null; name: string | null }>(
    `SELECT t.id, t.title, t.created_at, t.due_date, p.name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.created_at >= ? AND t.status != 'done' ${pf('t')} ORDER BY t.created_at DESC LIMIT 30`,
    since,
    ...pv,
  );

  const tag = (name: string | null) => (name && opts.projectId === undefined ? `[${name}] ` : '');
  const d = (iso: string) => formatDate(dateOf(iso, tz));
  const lines = [`# 최근 ${opts.days}일 활동${project ? ` · ${project.name}` : ''}`, `${formatDateTime(now.toISOString(), tz)} 기준`, ''];
  if (!sessions.length && !decisions.length && !done.length && !created.length) {
    lines.push('기록된 활동이 없어요.');
    return lines.join('\n');
  }
  if (done.length) lines.push(`## 완료한 할 일 (${done.length})`, ...done.map((t) => `- [T${t.id}] ${tag(t.name)}${t.title} (${d(t.done_at)})`), '');
  if (decisions.length) {
    lines.push(
      `## 새 결정 (${decisions.length})`,
      ...decisions.map((x) => `- [D${x.id}] ${tag(x.name)}${x.content}${x.superseded_by ? ` (이후 D${x.superseded_by}로 대체)` : ''} (${d(x.created_at)} · ${x.source})`),
      '',
    );
  }
  if (created.length) {
    lines.push(`## 새로 생긴 할 일 (${created.length})`, ...created.map((t) => `- [T${t.id}] ${tag(t.name)}${t.title}${t.due_date ? ` · 마감 ${formatDate(t.due_date)}` : ''}`), '');
  }
  if (sessions.length) {
    lines.push(
      `## AI 세션 (${sessions.length})`,
      ...sessions.map((l) => `- ${d(l.created_at)} ${l.source}${l.name && opts.projectId === undefined ? ` [${l.name}]` : ''}: ${l.summary.replace(/\s+/g, ' ').slice(0, 200)}`),
      '',
    );
  }
  return lines.join('\n').trim();
}
