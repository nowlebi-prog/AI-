import type { Db } from '../db.ts';
import { nowIso } from '../lib/time.ts';
import {
  PROJECT_FIELDS,
  UserError,
  isProjectStatus,
  type Project,
  type ProjectField,
  type ProjectStatus,
} from './types.ts';

export interface ProjectListItem extends Project {
  open_tasks: number;
  last_activity: string;
}

export function listProjects(db: Db, status: ProjectStatus | 'all' = 'all'): ProjectListItem[] {
  const where = status === 'all' ? '' : 'WHERE p.status = ?';
  const params = status === 'all' ? [] : [status];
  return db.all<ProjectListItem>(
    `SELECT p.*,
       (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.status != 'done') AS open_tasks,
       max(p.updated_at,
           coalesce((SELECT max(t.updated_at) FROM tasks t WHERE t.project_id = p.id), p.updated_at),
           coalesce((SELECT max(l.created_at) FROM session_logs l WHERE l.project_id = p.id), p.updated_at),
           coalesce((SELECT max(d.created_at) FROM decisions d WHERE d.project_id = p.id), p.updated_at),
           coalesce(p.resume_note_at, p.updated_at)) AS last_activity
     FROM projects p ${where}
     ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, last_activity DESC, p.id DESC`,
    ...params,
  );
}

export function getProject(db: Db, id: number): Project | undefined {
  return db.get<Project>('SELECT * FROM projects WHERE id = ?', id);
}

export function requireProject(db: Db, id: number): Project {
  const p = getProject(db, id);
  if (!p) throw new UserError(`프로젝트 P${id}를 찾을 수 없어요`);
  return p;
}

export type ProjectInput = { name: string } & Partial<Record<ProjectField, string>> & { status?: ProjectStatus };

function cleanName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim();
  if (!n) throw new UserError('프로젝트 이름을 입력해 주세요');
  if (n.length > 80) throw new UserError('프로젝트 이름은 80자 이내로 해 주세요');
  return n;
}

export function findProjectByName(db: Db, name: string): Project | undefined {
  return db.get<Project>('SELECT * FROM projects WHERE name = ? COLLATE NOCASE', name.trim());
}

export function createProject(db: Db, input: ProjectInput): Project {
  const name = cleanName(input.name);
  if (findProjectByName(db, name)) throw new UserError(`'${name}' 프로젝트가 이미 있어요`);
  const now = nowIso();
  const status = input.status && isProjectStatus(input.status) ? input.status : 'active';
  const vals = PROJECT_FIELDS.map((f) => (input[f] ?? '').trim());
  const r = db.run(
    `INSERT INTO projects (name, status, ${PROJECT_FIELDS.join(', ')}, created_at, updated_at)
     VALUES (?, ?, ${PROJECT_FIELDS.map(() => '?').join(', ')}, ?, ?)`,
    name,
    status,
    ...vals,
    now,
    now,
  );
  return requireProject(db, r.lastInsertRowid);
}

export type ProjectChanges = Partial<Record<ProjectField, string>> & { name?: string; status?: ProjectStatus };

export function updateProject(db: Db, id: number, changes: ProjectChanges): Project {
  const p = requireProject(db, id);
  const sets: string[] = [];
  const vals: string[] = [];
  if (changes.name !== undefined) {
    const name = cleanName(changes.name);
    const other = findProjectByName(db, name);
    if (other && other.id !== id) throw new UserError(`'${name}' 프로젝트가 이미 있어요`);
    sets.push('name = ?');
    vals.push(name);
  }
  if (changes.status !== undefined) {
    if (!isProjectStatus(changes.status)) throw new UserError('프로젝트 상태가 올바르지 않아요');
    sets.push('status = ?');
    vals.push(changes.status);
  }
  for (const f of PROJECT_FIELDS) {
    const v = changes[f];
    if (v === undefined) continue;
    sets.push(`${f} = ?`);
    vals.push(v.trim());
  }
  if (!sets.length) return p;
  db.run(`UPDATE projects SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...vals, nowIso(), id);
  return requireProject(db, id);
}

export function setResumeNote(db: Db, id: number, note: string, source: string): void {
  requireProject(db, id);
  db.run(
    'UPDATE projects SET resume_note = ?, resume_note_at = ?, resume_note_source = ? WHERE id = ?',
    note.trim(),
    note.trim() ? nowIso() : null,
    note.trim() ? source : null,
    id,
  );
}

export function deleteProject(db: Db, id: number): void {
  db.run('DELETE FROM projects WHERE id = ?', id);
}

function norm(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase();
}

/**
 * AI가 넘긴 프로젝트 참조('P3', '3', '브랜드X', '브랜드')를 찾는다.
 * 못 찾거나 애매하면 후보를 담아 UserError.
 */
export function resolveProject(db: Db, ref: unknown): Project {
  if (typeof ref === 'number' && Number.isInteger(ref)) return requireProject(db, ref);
  const s = typeof ref === 'string' ? ref.trim() : '';
  if (!s) throw new UserError('프로젝트를 지정해 주세요 (이름 또는 P번호)');
  const idMatch = /^[Pp]?(\d+)$/.exec(s);
  if (idMatch) {
    const p = getProject(db, Number(idMatch[1]));
    if (p) return p;
  }
  const exact = findProjectByName(db, s);
  if (exact) return exact;
  const all = listProjects(db, 'all');
  const key = norm(s);
  const same = all.filter((p) => norm(p.name) === key);
  if (same.length === 1 && same[0]) return same[0];
  const partial = all.filter((p) => norm(p.name).includes(key) || key.includes(norm(p.name)));
  if (partial.length === 1 && partial[0]) return partial[0];
  const names = (partial.length ? partial : all.filter((p) => p.status === 'active'))
    .slice(0, 15)
    .map((p) => `P${p.id} ${p.name}`)
    .join(', ');
  if (partial.length > 1) throw new UserError(`'${s}'에 해당하는 프로젝트가 여러 개예요: ${names}`);
  throw new UserError(`'${s}' 프로젝트를 찾을 수 없어요.${names ? ` 진행 중인 프로젝트: ${names}` : ' 등록된 프로젝트가 없어요.'}`);
}
