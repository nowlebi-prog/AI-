import type { Db, Param } from '../db.ts';
import { addDays, isValidDate, nowIso } from '../lib/time.ts';
import {
  UserError,
  isRole,
  isTaskStatus,
  type Priority,
  type Role,
  type Task,
  type TaskStatus,
  type TaskWithProject,
} from './types.ts';

const SELECT = `SELECT t.*, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id`;
const ORDER = `ORDER BY (t.status = 'doing') DESC, (t.due_date IS NULL), t.due_date, t.priority, t.id`;

export interface TaskInput {
  project_id: number | null;
  title: string;
  role?: Role;
  status?: TaskStatus;
  priority?: Priority;
  due_date?: string | null;
  note?: string;
}

function cleanTitle(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  if (!t) throw new UserError('할 일 제목을 입력해 주세요');
  if (t.length > 300) throw new UserError('할 일 제목은 300자 이내로 해 주세요');
  return t;
}

function checkDue(due: string | null | undefined): string | null {
  if (due === undefined || due === null || due === '') return null;
  if (!isValidDate(due)) throw new UserError(`마감일 형식이 올바르지 않아요: ${due} (YYYY-MM-DD)`);
  return due;
}

export function getTask(db: Db, id: number): TaskWithProject | undefined {
  return db.get<TaskWithProject>(`${SELECT} WHERE t.id = ?`, id);
}

export function requireTask(db: Db, id: number): TaskWithProject {
  const t = getTask(db, id);
  if (!t) throw new UserError(`할 일 T${id}를 찾을 수 없어요`);
  return t;
}

export function createTask(db: Db, input: TaskInput, source: string): TaskWithProject {
  if (input.project_id !== null && !db.get('SELECT 1 FROM projects WHERE id = ?', input.project_id)) {
    throw new UserError(`프로젝트 P${input.project_id}를 찾을 수 없어요`);
  }
  const role = input.role && isRole(input.role) ? input.role : 'etc';
  const status = input.status && isTaskStatus(input.status) ? input.status : 'todo';
  const priority = input.priority ?? 2;
  const now = nowIso();
  const r = db.run(
    `INSERT INTO tasks (project_id, title, role, status, priority, due_date, note, source, created_at, updated_at, done_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.project_id,
    cleanTitle(input.title),
    role,
    status,
    priority,
    checkDue(input.due_date),
    (input.note ?? '').trim(),
    source,
    now,
    now,
    status === 'done' ? now : null,
  );
  return requireTask(db, r.lastInsertRowid);
}

export interface TaskChanges {
  title?: string;
  role?: Role;
  status?: TaskStatus;
  priority?: Priority;
  due_date?: string | null;
  note?: string;
  project_id?: number | null;
}

export function updateTask(db: Db, id: number, changes: TaskChanges): TaskWithProject {
  const cur = requireTask(db, id);
  const sets: string[] = [];
  const vals: Param[] = [];
  if (changes.title !== undefined) {
    sets.push('title = ?');
    vals.push(cleanTitle(changes.title));
  }
  if (changes.role !== undefined) {
    if (!isRole(changes.role)) throw new UserError('역할 값이 올바르지 않아요');
    sets.push('role = ?');
    vals.push(changes.role);
  }
  if (changes.priority !== undefined) {
    sets.push('priority = ?');
    vals.push(changes.priority);
  }
  if (changes.due_date !== undefined) {
    sets.push('due_date = ?');
    vals.push(checkDue(changes.due_date));
  }
  if (changes.note !== undefined) {
    sets.push('note = ?');
    vals.push(changes.note.trim());
  }
  if (changes.project_id !== undefined) {
    if (changes.project_id !== null && !db.get('SELECT 1 FROM projects WHERE id = ?', changes.project_id)) {
      throw new UserError(`프로젝트 P${changes.project_id}를 찾을 수 없어요`);
    }
    sets.push('project_id = ?');
    vals.push(changes.project_id);
  }
  if (changes.status !== undefined && changes.status !== cur.status) {
    if (!isTaskStatus(changes.status)) throw new UserError('상태 값이 올바르지 않아요');
    sets.push('status = ?', 'done_at = ?');
    vals.push(changes.status, changes.status === 'done' ? nowIso() : null);
  }
  if (!sets.length) return cur;
  db.run(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...vals, nowIso(), id);
  return requireTask(db, id);
}

export function deleteTask(db: Db, id: number): void {
  db.run('DELETE FROM tasks WHERE id = ?', id);
}

export interface TaskFilter {
  projectId?: number;
  status?: 'open' | TaskStatus | 'all';
  role?: Role;
  due?: 'today' | 'overdue' | 'week';
  today: string;
  limit?: number;
  /** 진행 중이 아닌(보류·완료) 프로젝트의 할 일도 포함할지 */
  includeInactiveProjects?: boolean;
}

export function listTasks(db: Db, f: TaskFilter): TaskWithProject[] {
  const where: string[] = [];
  const vals: Param[] = [];
  if (f.projectId !== undefined) {
    where.push('t.project_id = ?');
    vals.push(f.projectId);
  } else if (!f.includeInactiveProjects) {
    where.push("(t.project_id IS NULL OR p.status = 'active')");
  }
  const status = f.status ?? 'open';
  if (status === 'open') where.push("t.status != 'done'");
  else if (status !== 'all') {
    where.push('t.status = ?');
    vals.push(status);
  }
  if (f.role) {
    where.push('t.role = ?');
    vals.push(f.role);
  }
  if (f.due === 'today') {
    where.push('t.due_date = ?');
    vals.push(f.today);
  } else if (f.due === 'overdue') {
    where.push("t.due_date < ? AND t.status != 'done'");
    vals.push(f.today);
  } else if (f.due === 'week') {
    where.push('t.due_date >= ? AND t.due_date <= ?');
    vals.push(f.today, addDays(f.today, 6));
  }
  const order = status === 'done' ? 'ORDER BY t.done_at DESC, t.id DESC' : ORDER;
  const sql = `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${order} LIMIT ?`;
  vals.push(f.limit ?? 200);
  return db.all<TaskWithProject>(sql, ...vals);
}

export interface TodayBoard {
  overdue: TaskWithProject[];
  today: TaskWithProject[];
  doing: TaskWithProject[];
  week: TaskWithProject[];
  backlog: TaskWithProject[];
}

export function todayBoard(db: Db, today: string, role?: Role): TodayBoard {
  const open = listTasks(db, { status: 'open', role, today, limit: 500 });
  const weekEnd = addDays(today, 6);
  const board: TodayBoard = { overdue: [], today: [], doing: [], week: [], backlog: [] };
  for (const t of open) {
    if (t.due_date && t.due_date < today) board.overdue.push(t);
    else if (t.due_date === today) board.today.push(t);
    else if (t.status === 'doing') board.doing.push(t);
    else if (t.due_date && t.due_date <= weekEnd) board.week.push(t);
    else board.backlog.push(t);
  }
  board.backlog.sort((a, b) => a.priority - b.priority || a.id - b.id);
  return board;
}

export function recentDone(db: Db, projectId: number, sinceIso: string, limit = 10): Task[] {
  return db.all<Task>(
    "SELECT * FROM tasks WHERE project_id = ? AND status = 'done' AND done_at >= ? ORDER BY done_at DESC LIMIT ?",
    projectId,
    sinceIso,
    limit,
  );
}
