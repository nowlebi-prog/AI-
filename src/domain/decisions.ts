import type { Db } from '../db.ts';
import { nowIso } from '../lib/time.ts';
import { UserError, type Decision, type SessionLog, type SessionLogWithProject } from './types.ts';

export interface DecisionInput {
  project_id: number;
  content: string;
  reason?: string;
  supersedes?: number | null;
}

export function getDecision(db: Db, id: number): Decision | undefined {
  return db.get<Decision>('SELECT * FROM decisions WHERE id = ?', id);
}

/** 대체할 결정이 같은 프로젝트의 유효한 결정인지 확인 */
export function checkSupersedes(db: Db, projectId: number, supersedes: number | null | undefined): void {
  if (supersedes === null || supersedes === undefined) return;
  const d = getDecision(db, supersedes);
  if (!d || d.project_id !== projectId) throw new UserError(`D${supersedes}는 이 프로젝트의 결정이 아니에요`);
  if (d.superseded_by !== null) throw new UserError(`D${supersedes}는 이미 D${d.superseded_by}로 대체됐어요`);
}

export function createDecision(db: Db, input: DecisionInput, source: string): Decision {
  const content = input.content.trim();
  if (!content) throw new UserError('결정 내용을 입력해 주세요');
  if (content.length > 2000) throw new UserError('결정 내용은 2000자 이내로 해 주세요');
  if (!db.get('SELECT 1 FROM projects WHERE id = ?', input.project_id)) {
    throw new UserError(`프로젝트 P${input.project_id}를 찾을 수 없어요`);
  }
  return db.tx(() => {
    checkSupersedes(db, input.project_id, input.supersedes);
    const r = db.run(
      'INSERT INTO decisions (project_id, content, reason, source, created_at) VALUES (?, ?, ?, ?, ?)',
      input.project_id,
      content,
      (input.reason ?? '').trim(),
      source,
      nowIso(),
    );
    const id = r.lastInsertRowid;
    if (input.supersedes) db.run('UPDATE decisions SET superseded_by = ? WHERE id = ?', id, input.supersedes);
    return getDecision(db, id) as Decision;
  });
}

export function listDecisions(
  db: Db,
  projectId: number,
  opts: { includeSuperseded?: boolean; limit?: number } = {},
): Decision[] {
  const where = opts.includeSuperseded ? '' : 'AND superseded_by IS NULL';
  return db.all<Decision>(
    `SELECT * FROM decisions WHERE project_id = ? ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    projectId,
    opts.limit ?? 500,
  );
}

export function updateDecision(db: Db, id: number, changes: { content?: string; reason?: string }): Decision {
  const d = getDecision(db, id);
  if (!d) throw new UserError(`결정 D${id}를 찾을 수 없어요`);
  const content = changes.content !== undefined ? changes.content.trim() : d.content;
  if (!content) throw new UserError('결정 내용을 입력해 주세요');
  if (content.length > 2000) throw new UserError('결정 내용은 2000자 이내로 해 주세요');
  const reason = changes.reason !== undefined ? changes.reason.trim() : d.reason;
  db.run('UPDATE decisions SET content = ?, reason = ? WHERE id = ?', content, reason, id);
  return getDecision(db, id) as Decision;
}

export function deleteDecision(db: Db, id: number): void {
  db.run('DELETE FROM decisions WHERE id = ?', id);
}

export function createLog(db: Db, input: { project_id: number | null; summary: string }, source: string): SessionLog {
  const summary = input.summary.trim();
  if (!summary) throw new UserError('세션 요약을 입력해 주세요');
  if (summary.length > 5000) throw new UserError('세션 요약은 5000자 이내로 해 주세요');
  const r = db.run(
    'INSERT INTO session_logs (project_id, source, summary, created_at) VALUES (?, ?, ?, ?)',
    input.project_id,
    source,
    summary,
    nowIso(),
  );
  return db.get<SessionLog>('SELECT * FROM session_logs WHERE id = ?', r.lastInsertRowid) as SessionLog;
}

export function getLog(db: Db, id: number): SessionLogWithProject | undefined {
  return db.get<SessionLogWithProject>(
    'SELECT l.*, p.name AS project_name FROM session_logs l LEFT JOIN projects p ON p.id = l.project_id WHERE l.id = ?',
    id,
  );
}

export function listLogs(db: Db, opts: { projectId?: number; limit?: number } = {}): SessionLogWithProject[] {
  const where = opts.projectId !== undefined ? 'WHERE l.project_id = ?' : '';
  const params = opts.projectId !== undefined ? [opts.projectId] : [];
  return db.all<SessionLogWithProject>(
    `SELECT l.*, p.name AS project_name FROM session_logs l LEFT JOIN projects p ON p.id = l.project_id
     ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
    ...params,
    opts.limit ?? 20,
  );
}

export function deleteLog(db: Db, id: number): void {
  db.run('DELETE FROM session_logs WHERE id = ?', id);
}
