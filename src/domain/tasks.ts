import type { Db, Param } from '../db.ts';
import { addDays, dateOf, isValidDate, nowIso } from '../lib/time.ts';
import { currentDay, getTimezone } from './clock.ts';
import { isValidRule, koIndex, nextOccurrence } from './repeat.ts';
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
  waiting?: string;
  repeat?: string;
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

function checkRepeat(rule: string | undefined): string {
  const r = (rule ?? '').trim();
  if (!isValidRule(r)) throw new UserError(`반복 규칙이 올바르지 않아요: ${r}`);
  return r;
}

function cleanWaiting(w: string | undefined): string {
  return (w ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function checkProject(db: Db, projectId: number | null): void {
  if (projectId !== null && !db.get('SELECT 1 FROM projects WHERE id = ?', projectId)) {
    throw new UserError(`프로젝트 P${projectId}를 찾을 수 없어요`);
  }
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
  checkProject(db, input.project_id);
  const role = input.role && isRole(input.role) ? input.role : 'etc';
  const status = input.status && isTaskStatus(input.status) ? input.status : 'todo';
  const priority = input.priority ?? 2;
  const now = nowIso();
  const r = db.run(
    `INSERT INTO tasks (project_id, title, role, status, priority, due_date, note, source, created_at, updated_at, done_at, waiting, repeat)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    cleanWaiting(input.waiting),
    checkRepeat(input.repeat),
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
  waiting?: string;
  repeat?: string;
}

export interface TaskUpdateResult {
  task: TaskWithProject;
  /** 반복 할 일을 완료해서 새로 만든 다음 할 일 */
  spawned: TaskWithProject | null;
  /** 완료를 취소해서 지운 다음 할 일 번호 */
  removedSpawn: number | null;
}

/** 이전 상태를 되돌릴 때 쓰는 스냅샷 */
export type TaskSnapshot = Pick<
  Task,
  'title' | 'role' | 'status' | 'priority' | 'due_date' | 'note' | 'project_id' | 'waiting' | 'repeat' | 'done_at' | 'next_task_id'
>;

export function snapshotTask(t: Task): TaskSnapshot {
  return {
    title: t.title,
    role: t.role,
    status: t.status,
    priority: t.priority,
    due_date: t.due_date,
    note: t.note,
    project_id: t.project_id,
    waiting: t.waiting,
    repeat: t.repeat,
    done_at: t.done_at,
    next_task_id: t.next_task_id,
  };
}

export function restoreTask(db: Db, id: number, s: TaskSnapshot): void {
  db.run(
    `UPDATE tasks SET title = ?, role = ?, status = ?, priority = ?, due_date = ?, note = ?, project_id = ?,
       waiting = ?, repeat = ?, done_at = ?, next_task_id = ?, updated_at = ? WHERE id = ?`,
    s.title,
    s.role,
    s.status,
    s.priority,
    s.due_date,
    s.note,
    s.project_id,
    s.waiting,
    s.repeat,
    s.done_at,
    s.next_task_id,
    nowIso(),
    id,
  );
}

/** 반복 할 일의 다음 차례 */
function spawnNext(db: Db, cur: TaskWithProject, repeat: string): TaskWithProject | null {
  const today = currentDay(db);
  const base = cur.due_date && cur.due_date > today ? cur.due_date : today;
  const next = nextOccurrence(repeat, base);
  if (!next) return null;
  return createTask(
    db,
    { project_id: cur.project_id, title: cur.title, role: cur.role, priority: cur.priority, note: cur.note, repeat, due_date: next },
    cur.source,
  );
}

export function updateTask(db: Db, id: number, changes: TaskChanges): TaskUpdateResult {
  return db.tx(() => {
    const cur = requireTask(db, id);
    const sets: string[] = [];
    const vals: Param[] = [];
    let spawned: TaskWithProject | null = null;
    let removedSpawn: number | null = null;
    const set = (col: string, v: Param) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };

    if (changes.title !== undefined) set('title', cleanTitle(changes.title));
    if (changes.role !== undefined) {
      if (!isRole(changes.role)) throw new UserError('역할 값이 올바르지 않아요');
      set('role', changes.role);
    }
    if (changes.priority !== undefined) set('priority', changes.priority);
    if (changes.due_date !== undefined) set('due_date', checkDue(changes.due_date));
    if (changes.note !== undefined) set('note', changes.note.trim());
    if (changes.waiting !== undefined) set('waiting', cleanWaiting(changes.waiting));
    const repeat = changes.repeat !== undefined ? checkRepeat(changes.repeat) : cur.repeat;
    if (changes.repeat !== undefined) set('repeat', repeat);
    if (changes.project_id !== undefined) {
      checkProject(db, changes.project_id);
      set('project_id', changes.project_id);
    }
    if (changes.status !== undefined && changes.status !== cur.status) {
      if (!isTaskStatus(changes.status)) throw new UserError('상태 값이 올바르지 않아요');
      set('status', changes.status);
      if (changes.status === 'done') {
        set('done_at', nowIso());
        set('waiting', '');
        const existing = cur.next_task_id ? getTask(db, cur.next_task_id) : undefined;
        if (repeat && !existing) {
          spawned = spawnNext(db, { ...cur, ...(changes.due_date !== undefined ? { due_date: checkDue(changes.due_date) } : {}) }, repeat);
          if (spawned) set('next_task_id', spawned.id);
        }
      } else {
        set('done_at', null);
        if (cur.status === 'done' && cur.next_task_id) {
          const next = getTask(db, cur.next_task_id);
          // 손대지 않은 다음 차례만 지운다
          if (next && next.status === 'todo' && next.created_at === next.updated_at) {
            db.run('DELETE FROM tasks WHERE id = ?', next.id);
            removedSpawn = next.id;
          }
          set('next_task_id', null);
        }
      }
    }
    if (!sets.length) return { task: cur, spawned: null, removedSpawn: null };
    db.run(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...vals, nowIso(), id);
    return { task: requireTask(db, id), spawned, removedSpawn };
  });
}

export function deleteTask(db: Db, id: number): void {
  db.run('DELETE FROM tasks WHERE id = ?', id);
}

export type SnoozeTarget = 'today' | 'tomorrow' | 'nextweek' | 'none';

/** 마감 미루기: 내일 / 다음 주 월요일 / 오늘 / 마감 없음 */
export function snoozeDate(to: SnoozeTarget, today: string): string | null {
  switch (to) {
    case 'today':
      return today;
    case 'tomorrow':
      return addDays(today, 1);
    case 'nextweek':
      return addDays(today, 7 - koIndex(today));
    case 'none':
      return null;
  }
}

export interface TaskFilter {
  projectId?: number;
  status?: 'open' | 'waiting' | TaskStatus | 'all';
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
  else if (status === 'waiting') where.push("t.status != 'done' AND t.waiting != ''");
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
  waiting: TaskWithProject[];
  /** 마감이 7일보다 뒤인 일 */
  later: TaskWithProject[];
  /** 마감이 없는 일 */
  backlog: TaskWithProject[];
}

export function todayBoard(db: Db, today: string, role?: Role): TodayBoard {
  const open = listTasks(db, { status: 'open', role, today, limit: 500 });
  const weekEnd = addDays(today, 6);
  const board: TodayBoard = { overdue: [], today: [], doing: [], week: [], waiting: [], later: [], backlog: [] };
  for (const t of open) {
    if (t.waiting) board.waiting.push(t);
    else if (t.due_date && t.due_date < today) board.overdue.push(t);
    else if (t.due_date === today) board.today.push(t);
    else if (t.status === 'doing') board.doing.push(t);
    else if (t.due_date && t.due_date <= weekEnd) board.week.push(t);
    else if (t.due_date) board.later.push(t);
    else board.backlog.push(t);
  }
  board.later.sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '') || a.priority - b.priority || a.id - b.id);
  board.backlog.sort((a, b) => a.priority - b.priority || a.id - b.id);
  return board;
}

/** 해당 날짜(앱 기준 오늘)에 완료한 할 일 */
export function doneOn(db: Db, day: string, role?: Role): TaskWithProject[] {
  const tz = getTimezone(db);
  const since = new Date(Date.parse(`${day}T00:00:00Z`) - 36 * 3_600_000).toISOString();
  const rows = db.all<TaskWithProject>(
    `${SELECT} WHERE t.status = 'done' AND t.done_at >= ? ${role ? 'AND t.role = ?' : ''} ORDER BY t.done_at DESC LIMIT 200`,
    ...(role ? [since, role] : [since]),
  );
  return rows.filter((t) => t.done_at && dateOf(t.done_at, tz) === day);
}

export function recentDone(db: Db, projectId: number, sinceIso: string, limit = 10): Task[] {
  return db.all<Task>(
    "SELECT * FROM tasks WHERE project_id = ? AND status = 'done' AND done_at >= ? ORDER BY done_at DESC LIMIT ?",
    projectId,
    sinceIso,
    limit,
  );
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 같은 프로젝트에 제목이 같은 열린 할 일이 있는지 */
export function findOpenTaskByTitle(db: Db, projectId: number | null, title: string): TaskWithProject | undefined {
  const key = norm(title);
  if (!key) return undefined;
  const rows = db.all<TaskWithProject>(
    `${SELECT} WHERE t.status != 'done' AND ${projectId === null ? 't.project_id IS NULL' : 't.project_id = ?'} LIMIT 1000`,
    ...(projectId === null ? [] : [projectId]),
  );
  return rows.find((t) => norm(t.title) === key);
}

export { norm as normalizeForMatch };
